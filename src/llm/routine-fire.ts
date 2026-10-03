/**
 * Firing a Claude Code Routine: the request the Routines API trigger expects
 * and the reading of its answer.
 *
 * Extracted from `scripts/external-session-harness.ts` (phase 1a) so that the
 * harness and `ExternalSessionProvider` (phase 1b) share one copy. `src/` must
 * never import from `scripts/`, so the shared code lives here and the script
 * imports it, not the other way round. The URL and both version headers are the
 * part most likely to change - the Routines API is a research preview - and a
 * second copy is how one caller keeps working while the other quietly breaks.
 */

import { asRecord, stringField } from "./json-shape.ts";

/** Required by the Routines API trigger. Sent on every fire. */
export const ROUTINE_BETA_HEADER = "experimental-cc-routine-2026-04-01";
export const ANTHROPIC_API_VERSION = "2023-06-01";

/** The one part of `fetch` this code needs, so a test can pass a double. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type RoutineFireRequest = {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

/**
 * The fire request. The body is `{}` on purpose: the routine's own saved
 * instructions fetch whichever job is pending, and anything put in `text`
 * arrives wrapped as untrusted data that the routine does not act on.
 */
export function buildFireRequest(input: { readonly fireUrl: string; readonly routineToken: string }): RoutineFireRequest {
  return {
    url: input.fireUrl,
    method: "POST",
    headers: {
      authorization: `Bearer ${input.routineToken}`,
      "anthropic-beta": ROUTINE_BETA_HEADER,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  };
}

export type FireOutcome =
  | { readonly kind: "fired"; readonly sessionId: string | undefined; readonly sessionUrl: string | undefined }
  | { readonly kind: "failed"; readonly status: number; readonly body: unknown };

export function interpretFireResponse(status: number, body: unknown): FireOutcome {
  if (status >= 200 && status < 300) {
    const record = asRecord(body);
    return {
      kind: "fired",
      sessionId: stringField(record, "claude_code_session_id"),
      sessionUrl: stringField(record, "claude_code_session_url"),
    };
  }
  return { kind: "failed", status, body };
}
