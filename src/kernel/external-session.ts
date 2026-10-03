/**
 * Phase 1a's job storage: one pending (or answered) job, in the `StateStore`
 * slot `EXTERNAL_SESSION_JOB_KEY`. See
 * `docs/3-development/external-generation-design.md`.
 *
 * Not wired to the orchestrator's cycle - nothing downstream reads this yet.
 * That is why `readExternalSessionJob` fails to `undefined` ("no job") on
 * anything it cannot make sense of, rather than `pause.ts`'s fail-to-stopped:
 * there is nothing running that a fabricated job would need to protect.
 */

import { EXTERNAL_SESSION_JOB_KEY, type StateStore } from "./state.ts";
import type { JsonSchema } from "../llm/schema.ts";

export type ExternalSessionResult = {
  /** ISO timestamp, from the clock - never `Date.now()` (CLAUDE.md: time is injected). */
  readonly receivedAt: string;
  readonly value: unknown;
};

export type ExternalSessionJob = {
  readonly id: string;
  readonly prompt: string;
  readonly schema: JsonSchema;
  readonly createdAt: string;
  readonly result?: ExternalSessionResult;
  /**
   * Set when the platform gave up on this job (phase 1b). A tombstone, not a
   * deletion: the slot is one JSON row with no compare-and-set, so a late
   * answer to a discarded job has to find something that refuses it (409)
   * rather than an empty slot it could be written into.
   */
  readonly discardedAt?: string;
  /**
   * Set when the provider handed this job's answer to a caller (phase 1b). An
   * answer is adopted by a later identical prompt only while this is unset: a
   * retry with the same prompt is usually a retry *because* that answer was not
   * usable (the planner's `plan.no_ideas`), and adopting it again would fail
   * the retry the same way every time. Kept apart from `discardedAt` on
   * purpose: the job was answered and used, and the poller must keep being
   * told `done`, not `discarded`.
   */
  readonly consumedAt?: string;
};

/** Unanswered and not discarded: the only state in which an answer may still land. */
export function isLiveJob(job: ExternalSessionJob): boolean {
  return job.result === undefined && job.discardedAt === undefined;
}

/** The same job, marked as given up on at `atIso`. Never mutates. */
export function tombstoneJob(job: ExternalSessionJob, atIso: string): ExternalSessionJob {
  return { ...job, discardedAt: atIso };
}

/** The same job, marked as having had its answer handed to a caller at `atIso`. Never mutates. */
export function consumeJob(job: ExternalSessionJob, atIso: string): ExternalSessionJob {
  return { ...job, consumedAt: atIso };
}

/** Its answer has already been returned to a caller, so it must not be adopted again. */
export function isConsumedJob(job: ExternalSessionJob): boolean {
  return job.consumedAt !== undefined;
}

/**
 * What a reader can learn about the slot. `unreadable` (the database could not
 * be reached) is kept apart from `none` because a poller must keep waiting
 * through a transient failure but must stop when the job is genuinely gone.
 * A slot holding something that is not a job counts as `none`: there is nothing
 * valid in it to protect.
 */
export type ExternalSessionSlot =
  | { readonly kind: "none" }
  | { readonly kind: "job"; readonly job: ExternalSessionJob }
  | { readonly kind: "unreadable"; readonly detail: string };

export function readExternalSessionSlot(state: StateStore): ExternalSessionSlot {
  const slot = state.read(EXTERNAL_SESSION_JOB_KEY);
  if (slot.kind === "absent") return { kind: "none" };
  if (slot.kind === "unreadable") return { kind: "unreadable", detail: slot.detail };
  try {
    const parsed: unknown = JSON.parse(slot.text);
    return isJob(parsed) ? { kind: "job", job: parsed } : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

/** `undefined` for absent, unreadable, or unparsable state - never a fabricated job. */
export function readExternalSessionJob(state: StateStore): ExternalSessionJob | undefined {
  const slot = readExternalSessionSlot(state);
  return slot.kind === "job" ? slot.job : undefined;
}

/**
 * What `ExternalSessionProvider` talks to. Async and refreshing because the
 * routine's answer arrives in a different invocation from the one polling: on
 * D1 a read answers from a snapshot only `refresh()` updates, so a poller that
 * reads without refreshing never sees the answer and waits out its timeout.
 *
 * **`refresh` and `read` must not throw**: a database that cannot be reached is
 * `read()` returning `{ kind: "unreadable" }`, which the provider waits through.
 * The provider also catches a throw from either and treats it the same way, so
 * an adapter that breaks this rule costs a retry, not the day's work - but that
 * catch is the backstop, not the contract. `write` may throw; the provider
 * turns that into `external_session.store_write_failed`.
 */
export type ExternalSessionJobStore = {
  refresh(): Promise<void>;
  read(): ExternalSessionSlot;
  write(job: ExternalSessionJob): Promise<void>;
};

export function createStateJobStore(state: StateStore): ExternalSessionJobStore {
  return {
    async refresh() {
      await state.refresh?.();
    },
    read: () => readExternalSessionSlot(state),
    write: (job) => writeExternalSessionJob(state, job),
  };
}

export async function writeExternalSessionJob(state: StateStore, job: ExternalSessionJob): Promise<void> {
  await state.write(EXTERNAL_SESSION_JOB_KEY, JSON.stringify(job));
}

function isJob(value: unknown): value is ExternalSessionJob {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["prompt"] === "string" &&
    typeof record["createdAt"] === "string" &&
    typeof record["schema"] === "object" &&
    record["schema"] !== null &&
    (record["discardedAt"] === undefined || typeof record["discardedAt"] === "string") &&
    (record["consumedAt"] === undefined || typeof record["consumedAt"] === "string")
  );
}
