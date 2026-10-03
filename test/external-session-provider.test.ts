/**
 * `ExternalSessionProvider` (`src/llm/external-session.ts`).
 *
 * Every named failure case below is a real-world way a call goes wrong, and
 * each has a one-line mutation in `docs/6-testing/mutate.md`'s phase 1b table
 * that must turn it red. The rig models the two facts that make polling hard
 * on Cloudflare: the routine's answer is written by a *different* invocation,
 * and a read only sees it after `refresh()`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { sequentialIds } from "../src/core/ids.ts";
import { silentLogger } from "../src/core/logger.ts";
import { abortsRun, fail } from "../src/core/result.ts";
import { isLiveJob, type ExternalSessionJob, type ExternalSessionJobStore, type ExternalSessionSlot } from "../src/kernel/external-session.ts";
import {
  EXTERNAL_SESSION_ERROR,
  INVOCATION_IDLE_GAP_MS,
  TEXT_WRAPPER_SCHEMA,
  UNLIMITED_INVOCATION_BUDGET_MS,
  createExternalSessionProvider,
  foldPrompt,
  invocationBudgetFor,
  pollDelayMs,
  type ExternalSessionProviderOptions,
} from "../src/llm/external-session.ts";
import { object, string } from "../src/llm/schema.ts";
import type { LlmProvider } from "../src/llm/provider.ts";
import { advancingClock } from "./helpers.ts";

const START_ISO = "2026-09-30T00:00:00Z";
const JOB_TIMEOUT_MS = 20_000;
/** Flat polling, so the deadline lands on an exact poll and the boundary can be asserted. */
const POLL_MS = 5_000;
const BUDGET_MS = 60_000;
/** Real milliseconds: `AbortSignal.timeout` does not run on the injected clock. */
const FIRE_TIMEOUT_MS = 25;
/** A poll loop that never advances time is a bug; fail loudly instead of hanging the runner. */
const RUNAWAY_SLEEPS = 1_000;
const ANSWER_SCHEMA = object({ answer: string() }, { required: ["answer"] });
const REQUEST = { system: "SYS", user: "USER", purpose: "test.call", schema: ANSWER_SCHEMA };
/** A different question: its prompt differs, so an answer to `REQUEST` is never adopted for it. */
const REQUEST_OTHER = { ...REQUEST, user: "ANOTHER USER" };
/** A job created exactly one job timeout before the rig's first call: as old as a job can be and still be stale. */
const STALE_CREATED_AT = new Date(Date.parse(START_ISO) - JOB_TIMEOUT_MS).toISOString();
const FIRED = () => new Response(JSON.stringify({ claude_code_session_id: "s-1", claude_code_session_url: "https://claude.ai/code/s-1" }), { status: 200 });

/**
 * D1 as the provider sees it: `remote` is the table, `snapshot` is what `read()`
 * answers from, and only `refresh()` copies one to the other. `write()` updates
 * both, the way `sql-state.ts` keeps a write visible to its own invocation.
 */
class FakeJobStore implements ExternalSessionJobStore {
  remote: ExternalSessionJob | undefined;
  snapshot: ExternalSessionJob | undefined;
  refreshCount = 0;
  readonly writes: ExternalSessionJob[] = [];
  /** Makes the next `write()` throw, like a D1 error. */
  failNextWrite = false;
  /** Refresh numbers (1-based) that fail like a database outage. */
  readonly failingRefreshes = new Set<number>();
  /** Refresh numbers (1-based) that throw instead of reporting the outage: a store that breaks the port's no-throw rule. */
  readonly throwingRefreshes = new Set<number>();
  /** Runs at the start of the numbered refresh, before the snapshot is copied: another invocation acting. */
  readonly beforeRefresh = new Map<number, () => void>();
  private unreadable = false;

  async refresh(): Promise<void> {
    this.refreshCount += 1;
    this.beforeRefresh.get(this.refreshCount)?.();
    if (this.throwingRefreshes.has(this.refreshCount)) throw new Error("D1_ERROR: network connection lost");
    this.unreadable = this.failingRefreshes.has(this.refreshCount);
    if (!this.unreadable) this.snapshot = this.remote;
  }
  read(): ExternalSessionSlot {
    if (this.unreadable) return { kind: "unreadable", detail: "D1 is down" };
    return this.snapshot ? { kind: "job", job: this.snapshot } : { kind: "none" };
  }
  async write(job: ExternalSessionJob): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("D1_ERROR: write failed");
    }
    this.writes.push(job);
    this.remote = job;
    this.snapshot = job;
  }
}

type Rig = {
  readonly provider: LlmProvider;
  readonly store: FakeJobStore;
  readonly clock: ReturnType<typeof advancingClock>;
  readonly fires: { count: number; requests: { url: string; init: RequestInit }[] };
  /** What the simulated routine does after each fire. `undefined` means it never answers. */
  routine: { answerAfterMs: number; value: unknown } | undefined;
  /** Writes an answer the way the answer route would: only to the job that is still live. */
  answer(jobId: string, value: unknown): void;
};

function makeRig(
  overrides: Partial<ExternalSessionProviderOptions> = {},
  fetchScript?: (call: number, init: RequestInit) => Promise<Response>,
): Rig {
  const store = new FakeJobStore();
  const base = advancingClock(START_ISO);
  let due: { atMs: number; jobId: string; value: unknown }[] = [];
  let sleeps = 0;
  const clock = {
    ...base,
    sleep: async (ms: number) => {
      sleeps += 1;
      if (sleeps > RUNAWAY_SLEEPS) throw new Error("runaway poll loop: sleep was called without time ever running out");
      base.advance(ms);
      const ready = due.filter((entry) => entry.atMs <= base.now());
      due = due.filter((entry) => entry.atMs > base.now());
      for (const entry of ready) rig.answer(entry.jobId, entry.value);
    },
  };
  const fires: Rig["fires"] = { count: 0, requests: [] };
  const rig: Rig = {
    store,
    clock,
    fires,
    routine: { answerAfterMs: POLL_MS, value: { answer: "hi" } },
    answer(jobId, value) {
      if (store.remote?.id === jobId && isLiveJob(store.remote)) {
        store.remote = { ...store.remote, result: { receivedAt: clock.nowIso(), value } };
      }
    },
    provider: undefined as never,
  };
  const fetchDouble = async (url: string, init: RequestInit): Promise<Response> => {
    fires.count += 1;
    fires.requests.push({ url, init });
    if (fetchScript) return fetchScript(fires.count, init);
    if (rig.routine && store.remote) due.push({ atMs: clock.now() + rig.routine.answerAfterMs, jobId: store.remote.id, value: rig.routine.value });
    return FIRED();
  };
  (rig as { provider: LlmProvider }).provider = createExternalSessionProvider({
    store,
    clock,
    ids: sequentialIds(),
    logger: silentLogger,
    fetch: fetchDouble,
    fireUrl: "https://api.anthropic.com/v1/claude_code/routines/r-1/fire",
    routineToken: "sk-ant-oat01-fake",
    jobTimeoutMs: JOB_TIMEOUT_MS,
    pollIntervalMs: POLL_MS,
    pollMaxIntervalMs: POLL_MS,
    invocationBudgetMs: BUDGET_MS,
    fireTimeoutMs: FIRE_TIMEOUT_MS,
    ...overrides,
  });
  return rig;
}

function errorOf<T>(result: { ok: boolean; error?: T }): T {
  assert.equal(result.ok, false, "expected an Err");
  return result.error as T;
}

test("a call returns the answer that another invocation wrote, seen only because every poll refreshes first", async () => {
  const rig = makeRig();
  const started = rig.clock.now();
  const result = await rig.provider.completeJson<{ answer: string }>(REQUEST);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.deepEqual(result.ok && result.value, { answer: "hi" });
  assert.equal(rig.fires.count, 1);
  assert.equal(rig.store.writes.length, 2, "the provider wrote the job, then only the mark that its answer was returned");
  assert.equal(rig.store.writes[0]!.result, undefined, "the answer came from outside, not from the provider's own write");
  assert.ok(rig.store.writes[1]!.consumedAt);
  assert.equal(rig.clock.now() - started, POLL_MS);
});

test("the fire request carries the routine token and both version headers", async () => {
  const rig = makeRig();
  await rig.provider.completeJson(REQUEST);
  const request = rig.fires.requests[0]!;
  assert.equal(request.url, "https://api.anthropic.com/v1/claude_code/routines/r-1/fire");
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], "Bearer sk-ant-oat01-fake");
  assert.ok(headers["anthropic-beta"]);
  assert.ok(headers["anthropic-version"]);
});

test("the job holds system and user in framed tags and the schema in its own field, and nothing of the purpose", async () => {
  const rig = makeRig();
  await rig.provider.completeJson(REQUEST);
  const job = rig.store.writes[0]!;
  assert.equal(job.prompt, foldPrompt("SYS", "USER"));
  assert.match(job.prompt, /^<background>\nSYS\n<\/background>\n\n<task>\nUSER\n<\/task>$/);
  assert.deepEqual(job.schema, ANSWER_SCHEMA);
  assert.doesNotMatch(job.prompt, /additionalProperties|test\.call/);
});

test("completeText asks for the {text} wrapper and returns just the text", async () => {
  const rig = makeRig();
  rig.routine = { answerAfterMs: POLL_MS, value: { text: "hello there" } };
  const result = await rig.provider.completeText({ system: "SYS", user: "USER", purpose: "test.text" });
  assert.deepEqual(result, { ok: true, value: "hello there" });
  assert.deepEqual(rig.store.writes[0]!.schema, TEXT_WRAPPER_SCHEMA);
});

test("timeout: no answer within the limit is a retryable Err at exactly the limit, not a poll later", async () => {
  const rig = makeRig();
  rig.routine = undefined;
  const started = rig.clock.now();
  const error = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(error.code, EXTERNAL_SESSION_ERROR.timeout);
  assert.equal(error.retryable, true);
  assert.equal(rig.clock.now() - started, JOB_TIMEOUT_MS, "the deadline is the boundary: elapsed == max is a timeout");
});

test("an answer that arrives at the very last poll still counts", async () => {
  const rig = makeRig();
  rig.routine = { answerAfterMs: JOB_TIMEOUT_MS, value: { answer: "just in time" } };
  const result = await rig.provider.completeJson<{ answer: string }>(REQUEST);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
});

test("the first timeout aborts the rest of the run: later calls fail fast without firing or writing", async () => {
  const rig = makeRig();
  rig.routine = undefined;
  await rig.provider.completeJson(REQUEST);
  const writesAfterFirst = rig.store.writes.length;
  const timeAfterFirst = rig.clock.now();

  const second = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(second.code, EXTERNAL_SESSION_ERROR.aborted);
  assert.equal(second.retryable, true);
  assert.equal(rig.fires.count, 1, "a routine that did not answer is not woken a second time in the same run");
  assert.equal(rig.store.writes.length, writesAfterFirst);
  assert.equal(rig.clock.now(), timeAfterFirst, "and the second call did not wait");
});

test("after a quiet gap the run is a new one: a long-lived provider is not latched shut forever", async () => {
  const rig = makeRig();
  rig.routine = undefined;
  await rig.provider.completeJson(REQUEST);
  rig.routine = { answerAfterMs: POLL_MS, value: { answer: "later" } };
  rig.clock.advance(INVOCATION_IDLE_GAP_MS + 1);
  const result = await rig.provider.completeJson(REQUEST);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
});

test("calls that fail fast do not extend the window: a call more than the idle gap after the last real call opens a fresh one", async () => {
  const rig = makeRig();
  rig.routine = undefined;
  const timedOut = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(timedOut.code, EXTERNAL_SESSION_ERROR.timeout);

  const FAST_FAIL_STEP_MS = INVOCATION_IDLE_GAP_MS * 0.75;
  rig.clock.advance(FAST_FAIL_STEP_MS);
  assert.equal(errorOf(await rig.provider.completeJson(REQUEST)).code, EXTERNAL_SESSION_ERROR.aborted);
  // Each step is inside the gap of the previous fast-fail but past the gap of the last real call.
  rig.clock.advance(FAST_FAIL_STEP_MS);
  rig.routine = { answerAfterMs: POLL_MS, value: { answer: "fresh window" } };
  const result = await rig.provider.completeJson(REQUEST);
  assert.ok(result.ok, "the latched window was not held open by the call that failed fast");
});

test("on the Worker a pause longer than the idle gap does not start a new run: the latch holds for the whole invocation", async () => {
  // One Worker invocation builds one provider. The idle gap exists for the Node
  // daemon, whose provider outlives many runs; inside one invocation a quiet
  // spell (a slow step between two calls) is still the same run.
  const rig = makeRig({ wallLimited: true, invocationBudgetMs: UNLIMITED_INVOCATION_BUDGET_MS });
  rig.routine = undefined;
  assert.equal(errorOf(await rig.provider.completeJson(REQUEST)).code, EXTERNAL_SESSION_ERROR.timeout);
  rig.routine = { answerAfterMs: POLL_MS, value: { answer: "woken again" } };
  rig.clock.advance(INVOCATION_IDLE_GAP_MS + 1);

  assert.equal(errorOf(await rig.provider.completeJson(REQUEST)).code, EXTERNAL_SESSION_ERROR.aborted);
  assert.equal(rig.fires.count, 1, "a routine that did not answer is not woken again in the same invocation");
});

test("on the Worker a pause longer than the idle gap does not restart the wait budget", async () => {
  const rig = makeRig({ wallLimited: true });
  assert.ok((await rig.provider.completeJson(REQUEST)).ok);
  // Past the gap, and past the budget counted from the start of the invocation.
  rig.clock.advance(Math.max(INVOCATION_IDLE_GAP_MS + 1, BUDGET_MS));

  const late = errorOf(await rig.provider.completeJson(REQUEST_OTHER));
  assert.equal(late.code, EXTERNAL_SESSION_ERROR.budgetExhausted, "the invocation's wall clock did not stop during the pause");
  assert.equal(rig.fires.count, 1);
});

test("on the Worker the budget counts from when the provider was built, so time spent before the first call is not free", async () => {
  // The wall cap runs from the start of the invocation, not from the first
  // model call: analysis, research and database reads all come first.
  const rig = makeRig({ wallLimited: true });
  rig.clock.advance(BUDGET_MS);
  const first = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(first.code, EXTERNAL_SESSION_ERROR.budgetExhausted);
  assert.equal(rig.fires.count, 0);
  assert.equal(rig.store.writes.length, 0);
});

test("budget: a call that starts with the budget already spent returns at once, without firing (elapsed == budget)", async () => {
  const rig = makeRig({ jobTimeoutMs: BUDGET_MS });
  rig.routine = { answerAfterMs: BUDGET_MS, value: { answer: "slow but in time" } };
  const first = await rig.provider.completeJson(REQUEST);
  assert.ok(first.ok, first.ok ? "" : first.error.message);
  assert.equal(rig.clock.now() - Date.parse(START_ISO), BUDGET_MS);

  const second = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(second.code, EXTERNAL_SESSION_ERROR.budgetExhausted);
  assert.equal(second.retryable, true);
  assert.equal(rig.fires.count, 1);
});

test("budget: a wait is cut off at the end of the budget even when the job timeout is longer", async () => {
  const rig = makeRig({ jobTimeoutMs: 50_000, invocationBudgetMs: 60_000 });
  rig.routine = { answerAfterMs: 40_000, value: { answer: "first" } };
  await rig.provider.completeJson(REQUEST);
  rig.routine = undefined;
  const error = errorOf(await rig.provider.completeJson(REQUEST_OTHER));
  assert.equal(error.code, EXTERNAL_SESSION_ERROR.timeout);
  assert.equal((error.details as { reason: string }).reason, "invocation_budget");
  assert.equal(rig.clock.now() - Date.parse(START_ISO), 60_000, "never past the budget, so the invocation is not killed mid-wait");
});

test("a stale unanswered job (exactly as old as the job timeout) is tombstoned before the new one is written", async () => {
  const rig = makeRig();
  rig.store.remote = { id: "extjob_old", prompt: "old", schema: ANSWER_SCHEMA, createdAt: STALE_CREATED_AT };
  const result = await rig.provider.completeJson(REQUEST);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(rig.store.writes[0]!.id, "extjob_old");
  assert.ok(rig.store.writes[0]!.discardedAt, "the old job was tombstoned, not deleted or overwritten");
  assert.notEqual(rig.store.writes[1]!.id, "extjob_old");
});

test("the discard is conditional on the id that was read: a different live job at the second read is left alone", async () => {
  const rig = makeRig();
  rig.store.remote = { id: "extjob_old", prompt: "old", schema: ANSWER_SCHEMA, createdAt: STALE_CREATED_AT };
  const other: ExternalSessionJob = { id: "extjob_other", prompt: "someone else's", schema: ANSWER_SCHEMA, createdAt: START_ISO };
  rig.store.beforeRefresh.set(2, () => {
    rig.store.remote = other;
  });
  const error = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(error.code, EXTERNAL_SESSION_ERROR.busy);
  assert.deepEqual(rig.store.remote, other, "the other caller's job was not clobbered");
  assert.equal(rig.store.writes.length, 0);
  assert.equal(rig.fires.count, 0);
});

test("a live job younger than the job timeout is another caller's: busy, and nothing is written or fired", async () => {
  // Console approvals and the run button reach the provider with no lock (or a
  // 5-minute one) and every Worker request has its own runtime: only the job's
  // own age can say whether its caller is still waiting on it.
  const rig = makeRig();
  const young: ExternalSessionJob = {
    id: "extjob_young",
    prompt: "someone else's",
    schema: ANSWER_SCHEMA,
    createdAt: new Date(Date.parse(START_ISO) - (JOB_TIMEOUT_MS - 1)).toISOString(),
  };
  rig.store.remote = young;
  const error = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(error.code, EXTERNAL_SESSION_ERROR.busy);
  assert.equal(error.retryable, true);
  assert.deepEqual(rig.store.remote, young, "the job of a caller that is still waiting was not tombstoned");
  assert.equal(rig.store.writes.length, 0);
  assert.equal(rig.fires.count, 0);
});

test("a job whose age cannot be judged is left alone, not discarded", async () => {
  const rig = makeRig();
  const undated: ExternalSessionJob = { id: "extjob_undated", prompt: "x", schema: ANSWER_SCHEMA, createdAt: "not a date" };
  rig.store.remote = undated;
  assert.equal(errorOf(await rig.provider.completeJson(REQUEST)).code, EXTERNAL_SESSION_ERROR.busy);
  assert.deepEqual(rig.store.remote, undated);
});

test("a routine that answered after the call timed out: the retry adopts that answer for the same prompt and does not fire again", async () => {
  const rig = makeRig();
  rig.routine = undefined;
  assert.equal(errorOf(await rig.provider.completeJson(REQUEST)).code, EXTERNAL_SESSION_ERROR.timeout);
  // The slow routine finishes after the platform gave up: the route accepts the
  // answer because the job was never tombstoned.
  rig.answer(rig.store.remote!.id, { answer: "late but good" });
  rig.clock.advance(INVOCATION_IDLE_GAP_MS + 1);

  const retry = await rig.provider.completeJson<{ answer: string }>(REQUEST);
  assert.ok(retry.ok, retry.ok ? "" : retry.error.message);
  assert.deepEqual(retry.ok && retry.value, { answer: "late but good" });
  assert.equal(rig.fires.count, 1, "the routine was not woken a second time for a question it had already answered");
  assert.deepEqual(
    rig.store.writes.map((write) => write.id),
    [rig.store.writes[0]!.id, rig.store.writes[0]!.id],
    "no second job was written: the only later write is the consumed mark on the adopted job",
  );
  assert.ok(rig.store.writes[1]!.consumedAt);
});

test("an answered job for a different prompt is never adopted: the new question is fired", async () => {
  const rig = makeRig();
  rig.routine = undefined;
  await rig.provider.completeJson(REQUEST);
  rig.answer(rig.store.remote!.id, { answer: "the answer to the old question" });
  rig.clock.advance(INVOCATION_IDLE_GAP_MS + 1);
  rig.routine = { answerAfterMs: POLL_MS, value: { answer: "fresh" } };

  const retry = await rig.provider.completeJson<{ answer: string }>(REQUEST_OTHER);
  assert.deepEqual(retry.ok && retry.value, { answer: "fresh" });
  assert.equal(rig.fires.count, 2);
  assert.ok(
    rig.store.writes.every((write) => !(write.result && write.discardedAt)),
    "an answered job is never tombstoned: the isLiveJob guards keep a settled answer intact",
  );
});

test("an answer that no longer fits the schema is not adopted, even for the same prompt", async () => {
  const rig = makeRig();
  rig.routine = undefined;
  await rig.provider.completeJson(REQUEST);
  rig.answer(rig.store.remote!.id, { answer: 5 });
  rig.clock.advance(INVOCATION_IDLE_GAP_MS + 1);
  rig.routine = { answerAfterMs: POLL_MS, value: { answer: "fresh" } };

  const retry = await rig.provider.completeJson<{ answer: string }>(REQUEST);
  assert.deepEqual(retry.ok && retry.value, { answer: "fresh" });
  assert.equal(rig.fires.count, 2);
});

test("an answer already handed to a caller is never adopted again: an identical retry (the planner's plan.no_ideas shape) fires a fresh job", async () => {
  // The planner fails its step when the answer has no ideas, and the scheduler
  // retries the same step with the same inputs, so the same prompt. Adopting
  // the answer it already rejected would fail the retry the same way, every time.
  const rig = makeRig();
  rig.routine = { answerAfterMs: POLL_MS, value: { answer: "rejected by the caller" } };
  const first = await rig.provider.completeJson<{ answer: string }>(REQUEST);
  assert.deepEqual(first.ok && first.value, { answer: "rejected by the caller" });
  assert.ok(rig.store.remote?.consumedAt, "the job records that its answer was returned");

  rig.clock.advance(INVOCATION_IDLE_GAP_MS + 1);
  rig.routine = { answerAfterMs: POLL_MS, value: { answer: "a fresh attempt" } };
  const retry = await rig.provider.completeJson<{ answer: string }>(REQUEST);
  assert.deepEqual(retry.ok && retry.value, { answer: "a fresh attempt" });
  assert.equal(rig.fires.count, 2, "the routine was asked again");
});

test("an adopted answer is consumed too: it is handed out once, and the next identical call asks again", async () => {
  const rig = makeRig();
  rig.routine = undefined;
  assert.equal(errorOf(await rig.provider.completeJson(REQUEST)).code, EXTERNAL_SESSION_ERROR.timeout);
  rig.answer(rig.store.remote!.id, { answer: "late" });
  rig.clock.advance(INVOCATION_IDLE_GAP_MS + 1);
  const adopted = await rig.provider.completeJson<{ answer: string }>(REQUEST);
  assert.deepEqual(adopted.ok && adopted.value, { answer: "late" });
  assert.equal(rig.fires.count, 1);

  rig.routine = { answerAfterMs: POLL_MS, value: { answer: "new" } };
  const again = await rig.provider.completeJson<{ answer: string }>(REQUEST);
  assert.deepEqual(again.ok && again.value, { answer: "new" });
  assert.equal(rig.fires.count, 2);
});

test("marking an answer consumed never overwrites a job another caller has put in the slot since", async () => {
  const rig = makeRig();
  // Refreshes: 1 prepare, 2 first poll (pending), 3 second poll (answer), 4 the re-read before marking.
  const other: ExternalSessionJob = { id: "extjob_other", prompt: "someone else's", schema: ANSWER_SCHEMA, createdAt: START_ISO };
  rig.store.beforeRefresh.set(4, () => {
    rig.store.remote = other;
  });
  const result = await rig.provider.completeJson<{ answer: string }>(REQUEST);
  assert.deepEqual(result.ok && result.value, { answer: "hi" }, "the answer still reaches the caller");
  assert.deepEqual(rig.store.remote, other, "the other caller's job was not clobbered by our mark");
});

test("id mismatch: the slot replaced under a waiting call is an immediate superseded Err, not a wait until the timeout", async () => {
  const rig = makeRig();
  rig.routine = undefined;
  // Refresh 1 is the stale check, 2 is the first poll, 3 the second, 4 the third.
  rig.store.beforeRefresh.set(4, () => {
    rig.store.remote = { id: "extjob_other", prompt: "x", schema: ANSWER_SCHEMA, createdAt: START_ISO };
  });
  const started = rig.clock.now();
  const error = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(error.code, EXTERNAL_SESSION_ERROR.superseded);
  assert.equal(error.retryable, true);
  assert.equal(rig.clock.now() - started, 2 * POLL_MS, "it stopped at the poll that saw the replacement");
});

test("an answer that belongs to a different job is never returned as this call's answer", async () => {
  const rig = makeRig();
  rig.routine = undefined;
  rig.store.beforeRefresh.set(3, () => {
    rig.store.remote = {
      id: "extjob_other",
      prompt: "x",
      schema: ANSWER_SCHEMA,
      createdAt: START_ISO,
      result: { receivedAt: START_ISO, value: { answer: "someone else's answer" } },
    };
  });
  const result = await rig.provider.completeJson(REQUEST);
  assert.equal(result.ok, false);
  assert.equal(errorOf(result).code, EXTERNAL_SESSION_ERROR.superseded);
});

test("a job discarded while waiting is superseded, so a late answer cannot be mistaken for ours", async () => {
  const rig = makeRig();
  rig.routine = undefined;
  rig.store.beforeRefresh.set(3, () => {
    rig.store.remote = { ...rig.store.remote!, discardedAt: START_ISO };
  });
  assert.equal(errorOf(await rig.provider.completeJson(REQUEST)).code, EXTERNAL_SESSION_ERROR.superseded);
});

test("schema violation: an invalid answer written straight into the store is an Err and never reaches the caller", async () => {
  const rig = makeRig();
  rig.routine = { answerAfterMs: POLL_MS, value: { answer: 5 } };
  const result = await rig.provider.completeJson(REQUEST);
  assert.equal(result.ok, false);
  const error = errorOf(result);
  assert.equal(error.code, EXTERNAL_SESSION_ERROR.schemaViolation);
  assert.equal(error.retryable, true);
});

test("fire refused: a non-2xx from the routine API is a retryable Err naming the fix, with no waiting and the job discarded", async () => {
  const rig = makeRig({}, async () => new Response(JSON.stringify({ error: "bad token" }), { status: 401 }));
  const started = rig.clock.now();
  const error = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(error.code, EXTERNAL_SESSION_ERROR.fireRefused);
  assert.equal(error.retryable, true);
  assert.match(error.message, /routine token/);
  assert.equal(rig.clock.now(), started, "no poll was started for a routine that was never woken");
  assert.ok(rig.store.remote?.discardedAt, "the job that would never be answered was not left live");
});

test("fire throws: a network failure is a retryable Err, not an exception", async () => {
  const rig = makeRig({}, async () => {
    throw new TypeError("fetch failed");
  });
  const error = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(error.code, EXTERNAL_SESSION_ERROR.fireUnreachable);
  assert.equal(error.retryable, true);
  assert.match(error.message, /fetch failed/);
  assert.ok(rig.store.remote?.discardedAt, "the job that would never be answered was not left live");
});

// Node's `AbortSignal.timeout` timer is unref'd, so on its own it does not keep
// the event loop alive: if the signal were not wired to the request, the runner
// would see "promise still pending, event loop empty" and fail this test
// rather than hang. `keepAlive` holds the loop open just long enough for the
// real 25 ms abort to fire when it is wired.
test("fire hangs: the request is cut by its own abort signal, and the run is latched shut", { timeout: 5_000 }, async () => {
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    const rig = makeRig(
      {},
      (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const error = errorOf(await rig.provider.completeJson(REQUEST));
    assert.equal(error.code, EXTERNAL_SESSION_ERROR.fireTimeout);
    assert.equal(error.retryable, true);
    assert.equal(abortsRun(error), true, "a hung fire ends the run: the latch is tripped");

    const next = errorOf(await rig.provider.completeJson(REQUEST));
    assert.equal(next.code, EXTERNAL_SESSION_ERROR.aborted, "an endpoint that hung once is not asked again in the same run");
    assert.equal(rig.fires.count, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("an unreadable database before the job is written is a retryable Err and fires nothing", async () => {
  const rig = makeRig();
  rig.store.failingRefreshes.add(1);
  const error = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(error.code, EXTERNAL_SESSION_ERROR.storeUnreadable);
  assert.equal(error.retryable, true);
  assert.equal(rig.fires.count, 0);
});

test("an unreadable database in the middle of a wait is waited through, not treated as a vanished job", async () => {
  const rig = makeRig();
  // Refresh 3 is the second poll, exactly when the answer (due after one poll interval) is first visible.
  rig.store.failingRefreshes.add(3);
  const started = rig.clock.now();
  const result = await rig.provider.completeJson<{ answer: string }>(REQUEST);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(rig.clock.now() - started, 2 * POLL_MS, "found on the next poll after the outage");
});

test("a store whose refresh throws is read as unreadable: a retryable Err before the job is written, not an exception", async () => {
  const rig = makeRig();
  rig.store.throwingRefreshes.add(1);
  const error = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(error.code, EXTERNAL_SESSION_ERROR.storeUnreadable);
  assert.equal(error.retryable, true);
  assert.equal(rig.fires.count, 0);
});

test("a store whose refresh throws in the middle of a wait is waited through, like any unreadable read", async () => {
  const rig = makeRig();
  rig.store.throwingRefreshes.add(2);
  const result = await rig.provider.completeJson(REQUEST);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
});

test("a database write that throws is a retryable Err, not an exception that costs the cycle's work", async () => {
  const rig = makeRig();
  rig.store.failNextWrite = true;
  const error = errorOf(await rig.provider.completeJson(REQUEST));
  assert.equal(error.code, EXTERNAL_SESSION_ERROR.storeWriteFailed);
  assert.equal(error.retryable, true);
  assert.equal(rig.fires.count, 0);
});

test("two concurrent calls on one provider: the second is refused rather than superseding the first's job", async () => {
  const rig = makeRig();
  const [first, second] = await Promise.all([rig.provider.completeJson(REQUEST), rig.provider.completeJson(REQUEST)]);
  assert.ok(first.ok, first.ok ? "" : first.error.message);
  assert.equal(errorOf(second).code, EXTERNAL_SESSION_ERROR.busy);
  assert.equal(rig.fires.count, 1);
});

test("stats report unknown usage and count routine launches as calls", async () => {
  const rig = makeRig();
  await rig.provider.completeJson(REQUEST);
  await rig.provider.completeJson(REQUEST_OTHER);
  assert.deepEqual(rig.provider.stats(), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: rig.fires.count });
  assert.equal(rig.provider.name, "external-session");
});

test("the failures that end a run say so, and the failures about one call do not", async () => {
  // The orchestrator stops a write or inspect loop on this one field and never
  // reads a provider code, so the set has to be exactly the failures that mean
  // the next item in the same loop cannot be expected to succeed: the latch, a
  // spent budget, a timeout, a slot another caller holds (busy, superseded),
  // and a fire refused for a reason no retry in the run can clear (401, 403, 404).
  const timedOut = makeRig();
  timedOut.routine = undefined;
  const timeout = errorOf(await timedOut.provider.completeJson(REQUEST));
  const latched = errorOf(await timedOut.provider.completeJson(REQUEST_OTHER));
  assert.deepEqual([timeout.code, abortsRun(timeout)], [EXTERNAL_SESSION_ERROR.timeout, true]);
  assert.deepEqual([latched.code, abortsRun(latched)], [EXTERNAL_SESSION_ERROR.aborted, true]);

  const spent = makeRig({ jobTimeoutMs: BUDGET_MS });
  spent.routine = { answerAfterMs: BUDGET_MS, value: { answer: "slow" } };
  await spent.provider.completeJson(REQUEST);
  const exhausted = errorOf(await spent.provider.completeJson(REQUEST_OTHER));
  assert.deepEqual([exhausted.code, abortsRun(exhausted)], [EXTERNAL_SESSION_ERROR.budgetExhausted, true]);

  const refusedFor = async (status: number) =>
    errorOf(await makeRig({}, async () => new Response("{}", { status })).provider.completeJson(REQUEST));
  for (const status of [401, 403, 404]) {
    const refused = await refusedFor(status);
    assert.deepEqual([refused.code, abortsRun(refused)], [EXTERNAL_SESSION_ERROR.fireRefused, true], `HTTP ${status} cannot clear within the run`);
  }
  for (const status of [429, 500]) {
    const refused = await refusedFor(status);
    assert.deepEqual([refused.code, abortsRun(refused)], [EXTERNAL_SESSION_ERROR.fireRefused, false], `HTTP ${status} is about this one call`);
  }

  const occupied = makeRig();
  occupied.store.remote = { id: "extjob_young", prompt: "someone else's", schema: ANSWER_SCHEMA, createdAt: START_ISO };
  const busy = errorOf(await occupied.provider.completeJson(REQUEST));
  assert.deepEqual([busy.code, abortsRun(busy)], [EXTERNAL_SESSION_ERROR.busy, true]);

  const concurrent = makeRig();
  const [, refusedInProcess] = await Promise.all([concurrent.provider.completeJson(REQUEST), concurrent.provider.completeJson(REQUEST)]);
  const inProcess = errorOf(refusedInProcess);
  assert.deepEqual([inProcess.code, abortsRun(inProcess)], [EXTERNAL_SESSION_ERROR.busy, true], "the in-process guard ends the loop too");

  const replaced = makeRig();
  replaced.routine = undefined;
  replaced.store.beforeRefresh.set(2, () => {
    replaced.store.remote = { id: "extjob_other", prompt: "x", schema: ANSWER_SCHEMA, createdAt: START_ISO };
  });
  const superseded = errorOf(await replaced.provider.completeJson(REQUEST));
  assert.deepEqual([superseded.code, abortsRun(superseded)], [EXTERNAL_SESSION_ERROR.superseded, true]);
  const invalid = makeRig();
  invalid.routine = { answerAfterMs: POLL_MS, value: { answer: 5 } };
  const violation = errorOf(await invalid.provider.completeJson(REQUEST));
  assert.deepEqual([violation.code, abortsRun(violation)], [EXTERNAL_SESSION_ERROR.schemaViolation, false]);
});

test("abortsRun is true only for a retryable error that carries the flag", () => {
  const flagged = fail("llm", "x", "y", { retryable: true, abortsRun: true });
  const plain = fail("llm", "x", "y", { retryable: true });
  const notRetryable = fail("llm", "x", "y", { abortsRun: true });
  assert.equal(flagged.ok ? false : abortsRun(flagged.error), true);
  assert.equal(plain.ok ? true : abortsRun(plain.error), false);
  assert.equal(notRetryable.ok ? true : abortsRun(notRetryable.error), false, "an error that will not clear itself is not a reason to resume");
});

test("the budget applies where the host has a wall cap, and only there", () => {
  assert.equal(invocationBudgetFor(true, BUDGET_MS), BUDGET_MS);
  assert.equal(invocationBudgetFor(false, BUDGET_MS), UNLIMITED_INVOCATION_BUDGET_MS);
});

test("on a host with no wall cap the run budget never cuts a call: calls that together outrun the configured budget all finish", async () => {
  // Node has no wall cap, so a budget there would only end days early.
  const rig = makeRig({ jobTimeoutMs: BUDGET_MS, invocationBudgetMs: invocationBudgetFor(false, BUDGET_MS) });
  rig.routine = { answerAfterMs: 40_000, value: { answer: "slow" } };
  for (let call = 0; call < 3; call += 1) {
    const result = await rig.provider.completeJson({ ...REQUEST, user: `USER ${call}` });
    assert.ok(result.ok, result.ok ? "" : result.error.message);
  }
  assert.ok(rig.clock.now() - Date.parse(START_ISO) > BUDGET_MS, "three 40 s calls outran the 60 s budget that a Worker would have enforced");
});

test("poll delays double from the base, stop at the cap, and stay finite for any attempt number", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((attempt) => pollDelayMs(attempt, 5_000, 60_000)),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000],
  );
  assert.equal(pollDelayMs(10_000, 5_000, 60_000), 60_000);
  assert.equal(pollDelayMs(-3, 5_000, 60_000), 5_000);
});
