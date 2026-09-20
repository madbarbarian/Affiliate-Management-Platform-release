/**
 * Switching one account off, and back on, as one operation.
 *
 * Switching off is three things that have to happen together: the state file
 * says the account is off, the gate it still has open is closed with a reason,
 * and the account's own trail records that a person did it. They were spread
 * across the two entry points that can do it - the console's button and
 * `amp venture deactivate` - and had already come apart: the console closed
 * the gate and the command did not, so the same decision left the operator
 * with a question nobody could answer depending on which surface they had used.
 * That is this repository's recurring defect, one question with two answers.
 *
 * **It does not live in `venture-state.ts`.** That file is the state slot and
 * nothing more: what "off" means, how it is read when the file is corrupt, how
 * it is undone. Giving it the orchestrator would invert the layering - it
 * would have to know what a gate is. **And it does not live in the
 * orchestrator**, which has no business reading operating state; that is the
 * same rule `guardWithStop` exists to keep. Composing the two is a third job,
 * and this is where it is done.
 */

import { ok, type PlatformError, type Result } from "../core/result.ts";
import type { VentureId } from "../core/types.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { VENTURE_DEACTIVATED_REASON } from "./orchestrator.ts";
import type { Services } from "./role.ts";
import type { StateStore } from "./state.ts";
import {
  deactivateVenture,
  reactivateVenture,
  type VentureState,
} from "./venture-state.ts";

export type VentureSwitchRequest = {
  readonly services: Services;
  readonly state: StateStore;
  readonly orchestrator: Orchestrator;
  readonly ventureId: VentureId;
  /** Whose decision this was. It goes in the state file and in the trail. */
  readonly by: string;
};

export type SwitchedOff = {
  readonly state: VentureState;
  /** Gates that were standing open and have now been closed with a reason. */
  readonly closedGates: number;
};

export async function switchVentureOff(
  request: VentureSwitchRequest & { readonly reason: string },
): Promise<Result<SwitchedOff, PlatformError>> {
  const { services, state, orchestrator, ventureId, by, reason } = request;

  const next = await deactivateVenture(state, ventureId, {
    at: services.clock.nowIso(),
    by,
    reason,
  });

  // After the switch, not before. The gate is closed because the account is
  // off; closing it first would leave a window in which a tick could open
  // another one behind it.
  const closed = await orchestrator.closeOpenGates(ventureId, {
    reason: VENTURE_DEACTIVATED_REASON,
    by,
  });
  if (!closed.ok) return closed;

  await note(request, "venture.deactivated", `Deactivated "${nameOf(request)}"${reason ? `: ${reason}` : ""}.`);
  return ok({ state: next, closedGates: closed.value.closed.length });
}

export type SwitchedOn = {
  readonly state: VentureState;
  /** False when the account was not switched off in the first place. */
  readonly wasInactive: boolean;
};

/**
 * Switching it back on does **not** reopen what was closed. Those ideas were
 * decided against by the act of switching off, and a gate that reappeared
 * hours or weeks later would be asking about a day that has gone. The day it
 * happened on is still reachable from the console's 今日のサイクルを動かす,
 * which is why `closeOpenGates` does not cancel the cycle.
 */
export async function switchVentureOn(
  request: VentureSwitchRequest,
): Promise<Result<SwitchedOn, PlatformError>> {
  const { state, ventureId } = request;
  const { state: next, wasInactive } = await reactivateVenture(state, ventureId);
  await note(request, "venture.activated", `Reactivated "${nameOf(request)}".`);
  return ok({ state: next, wasInactive });
}

function nameOf(request: VentureSwitchRequest): string {
  return (
    request.services.config.ventures.find((venture) => venture.id === request.ventureId)?.name ??
    request.ventureId
  );
}

/**
 * Appended rather than emitted through the bus: this is the account's own
 * durable trail, and the same click has to leave the same line whichever
 * surface it came from. The audit log is append-only, which is why it is safe
 * without the data lock the daemon holds.
 */
async function note(request: VentureSwitchRequest, type: string, summary: string): Promise<void> {
  const store = await request.services.stores.for(request.ventureId);
  await store.audit.append({
    id: request.services.ids.next("evt"),
    at: request.services.clock.nowIso(),
    ventureId: request.ventureId,
    type,
    actor: request.by,
    summary,
    data: {},
  });
}
