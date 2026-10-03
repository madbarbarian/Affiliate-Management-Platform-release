/**
 * `llm.provider: external-session` - generation by the licensee's own Claude
 * Code Routine (`docs/3-development/external-generation-design.md`, phase 1b).
 *
 * The port does not change: a call blocks, polls, and returns a `Result`. Per
 * call the provider puts one job in the single job slot, fires the routine,
 * and polls the slot until an answer for *that job id* appears.
 *
 * Every failure is a retryable `Err`, so it rides the cycle's existing retry
 * budget (`cycle.retry_abandoned`); nothing new is built for waiting.
 *
 * What the shape below protects, and what it does not, is written next to each
 * mechanism - the repo rule is that a protection with no stated range is read
 * as protecting more than it does.
 */

import { fail, ok, type Err, type PlatformError, type Result } from "../core/result.ts";
import type { Clock } from "../core/clock.ts";
import type { IdGenerator } from "../core/ids.ts";
import type { Logger } from "../core/logger.ts";
import {
  consumeJob,
  isConsumedJob,
  isLiveJob,
  tombstoneJob,
  type ExternalSessionJob,
  type ExternalSessionJobStore,
  type ExternalSessionSlot,
} from "../kernel/external-session.ts";
import type { LlmCallStats, LlmJsonRequest, LlmProvider, LlmRequest } from "./provider.ts";
import { buildFireRequest, interpretFireResponse, type FetchLike } from "./routine-fire.ts";
import { object, string, type JsonSchema } from "./schema.ts";
import { validate } from "./validate.ts";

export const EXTERNAL_SESSION_PROVIDER_NAME = "external-session";

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;

/** How many schema issues an error message quotes; the rest would bury the fix. */
const MAX_QUOTED_ISSUES = 3;

/**
 * On the Node daemon, a quiet gap this long between two calls means a new run
 * began.
 *
 * The per-invocation budget and the timeout latch are scoped to one run. A
 * Worker builds a fresh provider for every invocation, so there one provider is
 * one run and the gap does not apply (`wallLimited`: the gap is infinite and the
 * run starts when the provider is built). A machine's daemon builds one
 * provider and keeps it across ticks, and without this it would be latched shut
 * by one old timeout forever.
 */
export const INVOCATION_IDLE_GAP_MS = 2 * MS_PER_MINUTE;

/** Exponent ceiling for the poll backoff, so `2 ** attempt` can never reach Infinity. */
const MAX_BACKOFF_DOUBLINGS = 20;

/** `completeText` has no schema of its own; the routine is asked for `{ text }` and this returns `.text`. */
export const TEXT_WRAPPER_SCHEMA: JsonSchema = object(
  { text: string("The complete answer, as plain text.") },
  { required: ["text"] },
);

/** Longest fire-response body quoted in an error message. */
const MAX_QUOTED_BODY_CHARS = 200;

export const EXTERNAL_SESSION_ERROR = {
  busy: "external_session.busy",
  aborted: "external_session.aborted",
  budgetExhausted: "external_session.budget_exhausted",
  storeUnreadable: "external_session.store_unreadable",
  storeWriteFailed: "external_session.store_write_failed",
  fireRefused: "external_session.fire_refused",
  fireUnreachable: "external_session.fire_unreachable",
  fireTimeout: "external_session.fire_timeout",
  timeout: "external_session.timeout",
  superseded: "external_session.superseded",
  schemaViolation: "external_session.schema_violation",
} as const;

/**
 * The failures after which the next item in the same loop cannot be expected
 * to succeed: the latch, a spent wait budget, a routine that did not answer, a
 * fire that hung, and the single slot held by another caller (`busy` - from the
 * slot check and from the in-process guard alike, which share the code - and
 * `superseded`). They carry `abortsRun`, and the orchestrator stops a loop over
 * independent items on that one field (`write`, `inspect`) instead of skipping
 * the item: skipping would end the day with those items dropped, while stopping
 * fails the step retryably and the scheduler resumes it. Every other failure is
 * about one call, and the loop moves on from it. The orchestrator never reads
 * these codes: it imports nothing from here.
 */
const ABORTS_RUN_CODES: ReadonlySet<string> = new Set([
  EXTERNAL_SESSION_ERROR.aborted,
  EXTERNAL_SESSION_ERROR.budgetExhausted,
  EXTERNAL_SESSION_ERROR.timeout,
  EXTERNAL_SESSION_ERROR.fireTimeout,
  EXTERNAL_SESSION_ERROR.busy, EXTERNAL_SESSION_ERROR.superseded,
]);

/**
 * Fire refusals no retry inside the same run can clear: a revoked or wrong
 * routine token (401, 403) or a fire URL that names no routine (404). Every
 * later call would be refused the same way, so they end the run too. A 429 or a
 * 5xx may clear on the next call and does not.
 */
const RUN_ENDING_FIRE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

export type ExternalSessionProviderOptions = {
  readonly store: ExternalSessionJobStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** Injected. On Cloudflare pass an arrow that calls the global `fetch`: passing `fetch` itself throws "Illegal invocation". */
  readonly fetch: FetchLike;
  readonly fireUrl: string;
  readonly routineToken: string;
  readonly jobTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly pollMaxIntervalMs: number;
  /** Pass `invocationBudgetFor(...)`, not the raw config value: on Node this is `UNLIMITED_INVOCATION_BUDGET_MS`. */
  readonly invocationBudgetMs: number;
  readonly fireTimeoutMs: number;
  /** Overridable for tests; defaults to `INVOCATION_IDLE_GAP_MS`. Ignored when `wallLimited`. */
  readonly invocationGapMs?: number;
  /**
   * The host builds one provider per invocation and kills the invocation at a
   * wall cap (the Worker). Then the whole provider is one run: its window opens
   * when it is built - everything the invocation did before the first model
   * call is on the same wall clock - and no idle gap ever starts a new one,
   * because a pause inside one invocation does not give its wall time back.
   * Absent or false (the Node daemon): the window opens at the first call and an
   * idle gap of `invocationGapMs` starts a new one.
   */
  readonly wallLimited?: boolean;
};

/**
 * The wait before poll number `attempt` (0-based): `baseMs`, doubling, capped at
 * `maxMs`. Backing off is what keeps a polling wait inside Cloudflare's
 * subrequest limit (50 on the free plan, where every poll is a D1 call).
 */
export function pollDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const doublings = Math.min(Math.max(attempt, 0), MAX_BACKOFF_DOUBLINGS);
  return Math.min(maxMs, baseMs * 2 ** doublings);
}

/** No budget: what a host without a wall cap gets. */
export const UNLIMITED_INVOCATION_BUDGET_MS = Number.POSITIVE_INFINITY;

/**
 * The wait budget a host actually enforces. A Cloudflare invocation is killed at
 * a wall cap, so the Worker holds to the configured budget; the Node daemon has
 * no such cap, and a budget there would only end days early. The per-call
 * timeout, the latch and the idle gap apply on both.
 */
export function invocationBudgetFor(wallLimited: boolean, configuredMs: number): number {
  return wallLimited ? configuredMs : UNLIMITED_INVOCATION_BUDGET_MS;
}

/**
 * `system` and `user` only, in tags that cannot be mistaken for each other.
 * The schema is not folded in: it travels in the job's own field, which is
 * where the routine's saved instructions already look for it.
 */
export function foldPrompt(system: string, user: string): string {
  return `<background>\n${system}\n</background>\n\n<task>\n${user}\n</task>`;
}

type Verdict =
  | { readonly kind: "pending" }
  | { readonly kind: "answer"; readonly value: unknown }
  | { readonly kind: "superseded"; readonly why: string };

/**
 * What the slot says about *our* job. The id is checked first, so an answer
 * that belongs to another job is never returned as ours; a vanished or
 * replaced slot is an immediate `superseded`, not a wait for the timeout.
 * An unreadable slot is a transient database failure: keep waiting.
 */
function judgeSlot(slot: ExternalSessionSlot, jobId: string): Verdict {
  if (slot.kind === "unreadable") return { kind: "pending" };
  if (slot.kind === "none") return { kind: "superseded", why: "the job slot is empty" };
  const job = slot.job;
  if (job.id !== jobId) return { kind: "superseded", why: `the slot now holds job ${job.id}` };
  if (job.discardedAt !== undefined) return { kind: "superseded", why: "the job was discarded" };
  if (job.result !== undefined) return { kind: "answer", value: job.result.value };
  return { kind: "pending" };
}

/** An answer taken from the slot instead of being asked for again. */
type Adopted = { readonly jobId: string; readonly value: unknown };
type SlotPreparation = Result<{ readonly adopted: Adopted | undefined }, PlatformError>;

/**
 * The answer a settled job holds, when it answers *this* question: same prompt
 * to the letter, it fits this schema, and no caller has been handed it yet.
 * Only an answer that arrived after its caller gave up is adopted; one that was
 * returned is not, because an identical prompt after that is a retry of an
 * answer the caller could not use.
 */
function adoptable(job: ExternalSessionJob, prompt: string, schema: JsonSchema): Adopted | undefined {
  if (isConsumedJob(job)) return undefined;
  if (job.result === undefined || job.prompt !== prompt) return undefined;
  return validate(schema, job.result.value).ok ? { jobId: job.id, value: job.result.value } : undefined;
}

type Window = {
  readonly startedAtMs: number;
  lastCallEndedAtMs: number;
  /** Set by the first timeout: every later call in this window fails fast. */
  tripped?: PlatformError;
};

export function createExternalSessionProvider(options: ExternalSessionProviderOptions): LlmProvider {
  const { store, clock, ids, logger } = options;
  const wallLimited = options.wallLimited ?? false;
  const gapMs = wallLimited ? Number.POSITIVE_INFINITY : (options.invocationGapMs ?? INVOCATION_IDLE_GAP_MS);
  let launches = 0;
  let busy = false;
  let current: Window | undefined = wallLimited ? { startedAtMs: clock.now(), lastCallEndedAtMs: clock.now() } : undefined;

  const problem = (
    kind: PlatformError["kind"],
    code: string,
    message: string,
    details?: Record<string, unknown>,
    endsRun = ABORTS_RUN_CODES.has(code),
  ): Err<PlatformError> =>
    fail(kind, code, message, { retryable: true, abortsRun: endsRun, ...(details ? { details } : {}) });

  function windowAt(nowMs: number): Window {
    if (!current || nowMs - current.lastCallEndedAtMs > gapMs) {
      current = { startedAtMs: nowMs, lastCallEndedAtMs: nowMs };
    }
    return current;
  }

  /** Writes, turning a thrown database error into a value: a thrown error would cost the day's partial work. */
  async function writeJob(job: ExternalSessionJob): Promise<Result<void, PlatformError>> {
    try {
      await store.write(job);
      return ok(undefined);
    } catch (cause) {
      return fail("storage", EXTERNAL_SESSION_ERROR.storeWriteFailed, `Could not write the external-session job: ${String(cause)}`, {
        retryable: true,
        cause,
      });
    }
  }

  /**
   * Refresh, then read. Every read of the slot goes through here: on D1 a read
   * answers from a snapshot only `refresh()` updates, and the routine's answer
   * (and any other caller's job) is written by a different invocation.
   */
  async function readFresh(): Promise<ExternalSessionSlot> {
    try {
      await store.refresh();
      return store.read();
    } catch (cause) {
      // The port says these never throw. One that does is still a database that
      // could not be read: waited through mid-poll, a retryable Err before the
      // job is written - never an exception that costs the cycle's work.
      return { kind: "unreadable", detail: `the store threw: ${String(cause)}` };
    }
  }

  /**
   * Records that this job's answer has been handed to a caller, so no later
   * identical prompt adopts it. Conditional on the id that was just read, like
   * the stale discard, so it never overwrites another caller's job (it does not
   * close the one-round-trip window before the write either). Best effort: the
   * answer is valid and is returned whether or not the mark lands; a mark that
   * fails leaves the job adoptable, which is the behaviour before marks existed.
   */
  async function markConsumed(jobId: string): Promise<void> {
    const slot = await readFresh();
    if (slot.kind !== "job" || slot.job.id !== jobId || isConsumedJob(slot.job)) return;
    const written = await writeJob(consumeJob(slot.job, clock.nowIso()));
    if (!written.ok) logger.warn("external-session: could not mark the answer as consumed", { jobId, error: written.error.message });
  }

  /**
   * What is in the slot before a new job is written. One of: nothing in the way;
   * an answer to this very question, adopted; or a failure.
   *
   * **Only a stale job is discarded.** A live job younger than `jobTimeoutMs` is
   * another caller's, still being waited on (a console approval, the run button
   * or the scout: none of them holds the cycles lock, and every Worker request
   * has its own runtime, so no flag in this process can say so): it is `busy`,
   * and nothing is written. A job whose age cannot be judged is also `busy`,
   * because an age that cannot be judged must not be allowed to destroy
   * anything.
   *
   * **An answer already in the slot is adopted** when its stored prompt equals
   * this one exactly and it validates against this schema: a routine slower
   * than the job timeout answers after the call gave up (the route accepts it,
   * the job was never tombstoned), and the retry should not pay for the same
   * question twice. Anything else in the slot is treated as before.
   *
   * The stale discard is conditional on the id that was read: the slot is one
   * JSON row with no compare-and-set, so the id is read twice and only
   * tombstoned if it is still the same live job. It does not close the window
   * between the second read and the write - one database round trip - which the
   * store has no primitive to close.
   */
  async function prepareSlot(prompt: string, schema: JsonSchema): Promise<SlotPreparation> {
    const first = await readFresh();
    if (first.kind === "unreadable") return storeUnreadable(first.detail);
    if (first.kind === "none") return ok({ adopted: undefined });
    if (!isLiveJob(first.job)) return ok({ adopted: adoptable(first.job, prompt, schema) });

    const ageMs = clock.now() - Date.parse(first.job.createdAt);
    if (!(ageMs >= options.jobTimeoutMs)) {
      return problem(
        "conflict",
        EXTERNAL_SESSION_ERROR.busy,
        `Job ${first.job.id} is in the external-session slot and is not yet ${Math.round(options.jobTimeoutMs / MS_PER_SECOND)} s old: ` +
          "another caller (the scout, a console run) is still waiting on it, so it is left alone. This step is retried.",
        { jobId: first.job.id },
      );
    }

    const again = await readFresh();
    if (again.kind === "unreadable") return storeUnreadable(again.detail);
    if (again.kind === "none") return ok({ adopted: undefined });
    if (!isLiveJob(again.job)) return ok({ adopted: adoptable(again.job, prompt, schema) });
    if (again.job.id !== first.job.id) {
      return problem(
        "conflict",
        EXTERNAL_SESSION_ERROR.busy,
        `Job ${again.job.id} appeared in the external-session slot while ${first.job.id} was being discarded: ` +
          "something else is using the slot. This step is retried.",
      );
    }
    logger.warn("external-session: discarding a job left by an earlier attempt", { jobId: again.job.id });
    const written = await writeJob(tombstoneJob(again.job, clock.nowIso()));
    return written.ok ? ok({ adopted: undefined }) : written;
  }

  const storeUnreadable = (detail: string): Err<PlatformError> =>
    problem(
      "storage",
      EXTERNAL_SESSION_ERROR.storeUnreadable,
      `The external-session job slot could not be read (${detail}). This step is retried; if it keeps failing, check the database.`,
    );

  /** Best effort: a job whose routine was never woken must not stay live for a later call to trip over. */
  async function discardOwn(jobId: string): Promise<void> {
    try {
      const slot = await readFresh();
      if (slot.kind === "job" && slot.job.id === jobId && isLiveJob(slot.job)) {
        await store.write(tombstoneJob(slot.job, clock.nowIso()));
      }
    } catch (cause) {
      logger.warn("external-session: could not discard the job after a failed fire", { jobId, error: String(cause) });
    }
  }

  async function fire(jobId: string, win: Window): Promise<Result<void, PlatformError>> {
    const request = buildFireRequest({ fireUrl: options.fireUrl, routineToken: options.routineToken });
    let status: number;
    let text: string;
    try {
      // `AbortSignal.timeout` runs on real time, not the injected clock: it is
      // the one place a hung connection is cut, and a fake clock cannot cut it.
      const response = await options.fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        signal: AbortSignal.timeout(options.fireTimeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (cause) {
      const name = (cause as { name?: unknown } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        const error = problem(
          "network",
          EXTERNAL_SESSION_ERROR.fireTimeout,
          `Firing the routine took longer than ${options.fireTimeoutMs} ms and was cut off. ` +
            "Check the fire URL and that api.anthropic.com is reachable from here. Later calls in this run are skipped.",
          { jobId },
        );
        win.tripped = error.error;
        return error;
      }
      return problem(
        "network",
        EXTERNAL_SESSION_ERROR.fireUnreachable,
        `Could not reach the routine's fire URL: ${cause instanceof Error ? cause.message : String(cause)}. ` +
          "Check the fire URL variable and the network. This step is retried.",
        { jobId },
      );
    }

    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }
    const outcome = interpretFireResponse(status, body);
    if (outcome.kind === "failed") {
      const hint =
        outcome.status === 401 || outcome.status === 403
          ? "The routine token was refused: check it is the API trigger's token, not the job token, and has not been revoked."
          : outcome.status === 404
            ? "No such routine: check the fire URL copied from the routine's API trigger."
            : outcome.status === 429
              ? "The routine's launch limit may be reached."
              : "Check the routine's API trigger at claude.ai/code/routines.";
      return problem(
        "llm",
        EXTERNAL_SESSION_ERROR.fireRefused,
        `Firing the routine was refused with HTTP ${outcome.status}: ${JSON.stringify(outcome.body)?.slice(0, MAX_QUOTED_BODY_CHARS) ?? ""}. ${hint}`,
        { jobId, status: outcome.status },
        RUN_ENDING_FIRE_STATUSES.has(outcome.status),
      );
    }
    launches += 1;
    logger.info("external-session: routine fired", { jobId, launches, sessionUrl: outcome.sessionUrl ?? null });
    return ok(undefined);
  }

  async function poll(job: ExternalSessionJob, deadlineMs: number, clampedByBudget: boolean, win: Window): Promise<Result<unknown, PlatformError>> {
    const startedMs = clock.now();
    for (let attempt = 0; ; attempt += 1) {
      const verdict = judgeSlot(await readFresh(), job.id);

      if (verdict.kind === "answer") {
        // Defence in depth. The route answers 422 before anything is stored, so
        // an invalid value here means the store was written some other way.
        const checked = validate(job.schema, verdict.value);
        if (!checked.ok) {
          const first = checked.issues.slice(0, MAX_QUOTED_ISSUES).map((issue) => `${issue.path}: ${issue.message}`).join("; ");
          return problem(
            "validation",
            EXTERNAL_SESSION_ERROR.schemaViolation,
            `The routine's answer to job ${job.id} does not match the schema (${first}). This step is retried.`,
            { jobId: job.id },
          );
        }
        logger.info("external-session: answered", { jobId: job.id, waitedMs: clock.now() - startedMs });
        await markConsumed(job.id);
        return ok(verdict.value);
      }
      if (verdict.kind === "superseded") {
        return problem(
          "conflict",
          EXTERNAL_SESSION_ERROR.superseded,
          `Job ${job.id} was superseded before it was answered (${verdict.why}): another caller is using the single job slot ` +
            "(the scout, or a console run). This step is retried.",
          { jobId: job.id },
        );
      }

      const remainingMs = deadlineMs - clock.now();
      if (remainingMs <= 0) {
        const error = problem(
          "llm",
          EXTERNAL_SESSION_ERROR.timeout,
          `The routine did not answer job ${job.id} within ${Math.round((clock.now() - startedMs) / MS_PER_SECOND)} s` +
            `${clampedByBudget ? " (the invocation's wait budget ran out)" : ""}. ` +
            "Open claude.ai/code/routines and look at the routine's latest run; if it never started, check the fire URL, " +
            "the routine token, and that the console address is reachable from it. The scheduler retries this step; " +
            "later calls in this run are skipped so a hung routine is not woken again.",
          { jobId: job.id, reason: clampedByBudget ? "invocation_budget" : "job_timeout" },
        );
        win.tripped = error.error;
        return error;
      }
      await clock.sleep(Math.min(pollDelayMs(attempt, options.pollIntervalMs, options.pollMaxIntervalMs), remainingMs));
    }
  }

  async function attempt(win: Window, markReal: () => void, request: { system: string; user: string; schema: JsonSchema }): Promise<Result<unknown, PlatformError>> {
    if (win.tripped) {
      return problem(
        "llm",
        EXTERNAL_SESSION_ERROR.aborted,
        `Skipped: an earlier call in this run already failed (${win.tripped.code}), and a routine that did not answer once is not woken again in the same run.`,
      );
    }
    const callStartedMs = clock.now();
    if (callStartedMs - win.startedAtMs >= options.invocationBudgetMs) {
      return problem(
        "llm",
        EXTERNAL_SESSION_ERROR.budgetExhausted,
        `This run has spent its ${Math.round(options.invocationBudgetMs / MS_PER_SECOND)} s external-session wait budget ` +
          "(llm.externalSession.invocationBudgetMs: it keeps a wait inside the host's wall-time cap). " +
          "The scheduler resumes the cycle at this step after the retry backoff.",
      );
    }

    // Past the latch and the budget: from here the call does real work, and only
    // real work may hold the window open (see run).
    markReal();
    const prompt = foldPrompt(request.system, request.user);
    const prepared = await prepareSlot(prompt, request.schema);
    if (!prepared.ok) return prepared;
    if (prepared.value.adopted) {
      logger.info("external-session: adopted the answer already in the slot for this prompt", { jobId: prepared.value.adopted.jobId });
      await markConsumed(prepared.value.adopted.jobId);
      return ok(prepared.value.adopted.value);
    }

    const job: ExternalSessionJob = {
      id: ids.next("extjob"),
      prompt,
      schema: request.schema,
      createdAt: clock.nowIso(),
    };
    const written = await writeJob(job);
    if (!written.ok) return written;

    const fired = await fire(job.id, win);
    if (!fired.ok) {
      await discardOwn(job.id);
      return fired;
    }

    const budgetEndMs = win.startedAtMs + options.invocationBudgetMs;
    const timeoutEndMs = callStartedMs + options.jobTimeoutMs;
    return poll(job, Math.min(timeoutEndMs, budgetEndMs), budgetEndMs < timeoutEndMs, win);
  }

  async function run(request: { system: string; user: string; schema: JsonSchema }): Promise<Result<unknown, PlatformError>> {
    // Serial within one provider: a second concurrent call would supersede the
    // first one's job. Refused rather than queued - queuing would spend the
    // wait budget on a call that has not started.
    if (busy) {
      return problem(
        "conflict",
        EXTERNAL_SESSION_ERROR.busy,
        "Another external-session call is already in progress in this process; there is one job slot. This step is retried.",
      );
    }
    busy = true;
    const win = windowAt(clock.now());
    let didRealWork = false;
    try {
      return await attempt(win, () => { didRealWork = true; }, request);
    } finally {
      // Only a call that got past the latch and the budget extends the window.
      // Fast-failing calls end instantly; if they counted, a steady stream of
      // them would keep a latched or spent window open forever and the daemon
      // would never start a fresh run.
      if (didRealWork) win.lastCallEndedAtMs = clock.now();
      busy = false;
    }
  }

  return {
    name: EXTERNAL_SESSION_PROVIDER_NAME,

    async completeJson<T>(request: LlmJsonRequest): Promise<Result<T, PlatformError>> {
      const result = await run({ system: request.system, user: request.user, schema: request.schema });
      return result.ok ? ok(result.value as T) : result;
    },

    async completeText(request: LlmRequest): Promise<Result<string, PlatformError>> {
      const result = await run({ system: request.system, user: request.user, schema: TEXT_WRAPPER_SCHEMA });
      return result.ok ? ok((result.value as { text: string }).text) : result;
    },

    /** No token source exists for a routine, so usage is unknown (zeros); `calls` counts routine launches. */
    stats(): LlmCallStats {
      return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: launches };
    },
  };
}
