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
};

/** `undefined` for absent, unreadable, or unparsable state - never a fabricated job. */
export function readExternalSessionJob(state: StateStore): ExternalSessionJob | undefined {
  const slot = state.read(EXTERNAL_SESSION_JOB_KEY);
  if (slot.kind !== "text") return undefined;
  try {
    const parsed: unknown = JSON.parse(slot.text);
    return isJob(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
    record["schema"] !== null
  );
}
