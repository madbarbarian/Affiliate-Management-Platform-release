/**
 * The console's exit from the emergency stop: resuming everything, recorded.
 *
 * This is the same kind of composition `venture-switch.ts` is, for the same
 * reason - the state slot (`pause.ts`) and the account's own trail are two
 * different concerns, and something has to be the one place that does both for
 * the same click. It does not live in `pause.ts`: that module has no
 * dependency on `Services`, the audit trail or an actor's name, on purpose - it
 * has to stay usable from `amp resume`, which runs even when the config could
 * not be loaded (see `cli.ts`'s `stopTarget`) and therefore has no `Services`
 * to write an event through. That is also why this file has one call site, the
 * console, and not two: the CLI's `amp resume` prints to a terminal a licensee
 * is not assumed to have (requirements.md §3.1) and stays exactly as small as
 * it is.
 */

import { COMPANY_SCOPE } from "../core/types.ts";
import { applyResume, type ResumeOutcome } from "./pause.ts";
import type { Services } from "./role.ts";
import type { StateStore } from "./state.ts";

export type ResumeEverythingRequest = {
  readonly services: Services;
  readonly state: StateStore;
  /** Whose decision this was. It goes in the audit trail. */
  readonly by: string;
};

/** The audit event's type. `src/console/router.ts`'s `describeAuditEvent` matches on this string. */
export const PLATFORM_RESUMED_EVENT = "platform.resumed";

/**
 * Resumes the whole platform and records it, in one call.
 *
 * Only ever a whole-platform resume - see `pause.ts`'s `applyResume` for why a
 * per-venture one stays a CLI-only, unrecorded affair, and `docs/` for why the
 * console offers no per-venture resume button to pair with it.
 *
 * The audit line is only written when something was actually cleared.
 * `applyResume` already declines to write `RUNNING` over a state that was not
 * paused; writing an audit entry anyway would tell the operator they undid
 * something that never happened.
 */
export async function resumeEverything(request: ResumeEverythingRequest): Promise<ResumeOutcome> {
  const outcome = await applyResume({ state: request.state });
  if (outcome.ok && outcome.wasPaused) {
    const store = await request.services.stores.for(COMPANY_SCOPE);
    await store.audit.append({
      id: request.services.ids.next("evt"),
      at: request.services.clock.nowIso(),
      ventureId: COMPANY_SCOPE,
      type: PLATFORM_RESUMED_EVENT,
      actor: request.by,
      summary: "Resumed everything.",
      data: {},
    });
  }
  return outcome;
}
