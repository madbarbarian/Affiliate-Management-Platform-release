/**
 * Which ventures are switched off - the operating state that sits beside the
 * config, not inside it.
 *
 * `platform.config.yaml` says what a venture *is*. Whether it is currently
 * running is a decision an operator makes from the console on a Tuesday
 * afternoon because the numbers say so, and that decision must not require
 * editing a file and restarting the daemon. So it lives here, in
 * `.amp/venture-state.json`, the same way a stop lives in `paused.json`.
 *
 * The two are different things. A stop is an emergency: temporary, holds
 * posts, fails closed. Deactivation is a judgement: indefinite, deliberate,
 * and reversible - nothing is deleted, the account's history and playbook
 * stay exactly where they are, and switching it back on is one click. An
 * account that is not earning should stop costing without becoming
 * unrecoverable; that is the whole reason this is not "remove it from the
 * config".
 *
 * Unlike the stop file this fails *open*: an unreadable state file is
 * reported, not treated as "everything is off". A corrupt file must not stop
 * the company, and a deactivation is not a safety measure that has to survive
 * uncertainty - the stop is.
 */

import { join } from "node:path";

import type { Venture, VentureId } from "../core/types.ts";
import { VENTURE_STATE_KEY, type StateStore } from "./state.ts";

export const VENTURE_STATE_FILE = "venture-state.json";

export type DeactivationRecord = {
  readonly at: string;
  readonly by: string;
  readonly reason: string;
};

export type VentureState = {
  /** Ventures the operator has switched off, by id. */
  readonly inactive: Readonly<Record<string, DeactivationRecord>>;
  /** Set when the file exists but could not be read; everything is treated as on. */
  readonly warning?: string;
};

const ALL_ON: VentureState = { inactive: {} };

/** Where the shipped file-backed adapter keeps it. Used by `doctor` and tests. */
export function ventureStatePath(dataDir: string): string {
  return join(dataDir, VENTURE_STATE_FILE);
}

/** Synchronous for the same reason `readPause` is: the daemon consults it every tick. */
export function readVentureState(state: StateStore): VentureState {
  const slot = state.read(VENTURE_STATE_KEY);
  const path = state.label(VENTURE_STATE_KEY);
  if (slot.kind === "absent") return ALL_ON;
  if (slot.kind === "unreadable") {
    return { inactive: {}, warning: `${path} could not be read (${slot.detail}); every venture is treated as active` };
  }
  try {
    const parsed = JSON.parse(slot.text) as { inactive?: unknown };
    if (typeof parsed !== "object" || parsed === null || typeof parsed.inactive !== "object" || parsed.inactive === null) {
      return { inactive: {}, warning: `${path} is not a shape this version writes; every venture is treated as active` };
    }
    const inactive: Record<string, DeactivationRecord> = {};
    for (const [id, value] of Object.entries(parsed.inactive as Record<string, unknown>)) {
      const record = value as Partial<DeactivationRecord> | null;
      if (record && typeof record.at === "string" && typeof record.by === "string") {
        inactive[id] = { at: record.at, by: record.by, reason: typeof record.reason === "string" ? record.reason : "" };
      }
    }
    return { inactive };
  } catch (cause) {
    return {
      inactive: {},
      warning: `${path} could not be read (${cause instanceof Error ? cause.message : String(cause)}); every venture is treated as active`,
    };
  }
}

/** Switched off by the operator, or `undefined` when running (or never touched). */
export function deactivatedBy(state: VentureState, ventureId: VentureId): DeactivationRecord | undefined {
  return state.inactive[ventureId];
}

/**
 * The one definition of "is this venture running". Config `active: false` and
 * an operator's deactivation both mean no; they differ in who said so and how
 * it is undone, which `describeInactive` spells out.
 */
export function isVentureActive(venture: Venture, state: VentureState): boolean {
  return venture.active && deactivatedBy(state, venture.id) === undefined;
}

export function inactiveVentures(state: VentureState): readonly VentureId[] {
  return Object.keys(state.inactive) as VentureId[];
}

export async function deactivateVenture(
  store: StateStore,
  ventureId: VentureId,
  record: DeactivationRecord,
): Promise<VentureState> {
  const current = readVentureState(store);
  const next: VentureState = { inactive: { ...current.inactive, [ventureId]: record } };
  await write(store, next);
  return next;
}

export async function reactivateVenture(
  store: StateStore,
  ventureId: VentureId,
): Promise<{ state: VentureState; wasInactive: boolean }> {
  const current = readVentureState(store);
  const { [ventureId]: removed, ...rest } = current.inactive;
  const next: VentureState = { inactive: rest };
  await write(store, next);
  return { state: next, wasInactive: removed !== undefined };
}

export function describeInactive(venture: Venture, state: VentureState): string {
  const record = deactivatedBy(state, venture.id);
  if (record) {
    return (
      `Venture "${venture.id}" was deactivated by ${record.by} at ${record.at}` +
      `${record.reason ? ` (${record.reason})` : ""}. ` +
      `Nothing runs or publishes for it; its data is kept. \`amp venture activate ${venture.id}\` switches it back on.`
    );
  }
  if (!venture.active) {
    return `Venture "${venture.id}" has active: false in platform.config.yaml. Set it to true and restart the daemon to run it.`;
  }
  return `Venture "${venture.id}" is active.`;
}

async function write(store: StateStore, state: VentureState): Promise<void> {
  await store.write(VENTURE_STATE_KEY, `${JSON.stringify({ inactive: state.inactive }, null, 2)}\n`);
}
