/**
 * The emergency stop.
 *
 * Everything else in this platform is designed so a person only has to make two
 * decisions a day. This is the third thing they can do, and it exists because
 * the other two are approvals: once something is approved, the machine will
 * publish it on time whether or not anyone is still comfortable with that.
 * "Stop, now, everything" needs to be one command that works even when the
 * operator cannot articulate what is wrong yet.
 *
 * It is its own slot of operating state (`src/kernel/state.ts`) rather than a
 * field in the config or a row in the store:
 *
 * - It takes effect on the next daemon tick without a restart, so the operator
 *   does not have to find and kill a process.
 * - It works from a second terminal while the daemon holds the data lock.
 * - It can be created by hand (`touch`, an editor, a text file over SSH) by
 *   someone who has forgotten the command and is in a hurry.
 *
 * **An unreadable or corrupt file counts as paused.** A kill switch that fails
 * open is not a kill switch. The cost of a wrong "stopped" is a day of missed
 * posts; the cost of a wrong "running" is a post that should never have gone
 * out, on someone else's account.
 */

import { join } from "node:path";

import type { VentureId } from "../core/types.ts";
import { PAUSE_KEY, type StateStore } from "./state.ts";

export const PAUSE_FILE = "paused.json";

export type PauseRecord = {
  /** ISO timestamp of when the stop was applied. */
  readonly at: string;
  readonly reason: string;
  /** Which command or surface applied it, for the audit trail. */
  readonly by: string;
};

export type PauseState = {
  /** Set when every venture is stopped. */
  readonly all?: PauseRecord;
  /** Ventures stopped individually. */
  readonly ventures: Readonly<Record<string, PauseRecord>>;
};

const RUNNING: PauseState = { ventures: {} };

/** Where the shipped file-backed adapter keeps it. Used by `doctor` and tests. */
export function pauseFilePath(dataDir: string): string {
  return join(dataDir, PAUSE_FILE);
}

/**
 * Reads the stop. Synchronous on purpose: the daemon consults this on every
 * tick before it starts a cycle or publishes anything, and an await there is a
 * window in which a stop can be missed.
 */
export function readPause(state: StateStore): PauseState {
  const slot = state.read(PAUSE_KEY);
  const where = state.label(PAUSE_KEY);
  if (slot.kind === "absent") return RUNNING;
  if (slot.kind === "unreadable") return unreadable(`the stop could not be read (${slot.detail})`, where);

  const raw = slot.text;

  // Anything that is not a stop record we understand - an empty file, the word
  // STOP typed in by hand, a truncated write - lands in `unreadable`, which
  // reports a stop. That is the behaviour someone in a hurry expects from
  // creating this file by any means they can think of.
  if (raw.trim() === "") return unreadable("the stop file is empty", where);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable("the stop file is not valid JSON — it was treated as a stop", where);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unreadable("the stop file does not contain an object", where);
  }

  const record = parsed as { all?: unknown; ventures?: unknown };

  // Valid JSON of a shape we do not recognise is still a file somebody wrote
  // in order to stop the machine. Reading `{"all": true}` or `{"paused": true}`
  // as "running" was the same fail-open this module exists to rule out - worse
  // than the unparseable case, because it looks deliberate and reads as fine.
  // Everything this module writes carries a `ventures` object; anything that
  // does not is a hand-written stop, however it is spelled.
  if (typeof record.ventures !== "object" || record.ventures === null || Array.isArray(record.ventures)) {
    return unreadable("the stop file is not a shape this version writes", where);
  }

  const ventures: Record<string, PauseRecord> = {};
  for (const [id, value] of Object.entries(record.ventures as Record<string, unknown>)) {
    const entry = toRecord(value);
    if (entry) ventures[id] = entry;
  }

  // `all` present but not a record we understand: someone meant to stop
  // everything and wrote it a way we cannot read. Honour the intent.
  if (record.all !== undefined) {
    const all = toRecord(record.all);
    return all ? { all, ventures } : unreadable(`"all" is set but is not a stop record`, where);
  }
  return { ventures };
}

/** The record that stops `ventureId`, or undefined when it may run. */
export function pausedBy(state: PauseState, ventureId?: VentureId): PauseRecord | undefined {
  if (state.all) return state.all;
  if (ventureId === undefined) return undefined;
  return state.ventures[ventureId];
}

export function isPaused(state: PauseState, ventureId?: VentureId): boolean {
  return pausedBy(state, ventureId) !== undefined;
}

/** Every venture id currently stopped individually. */
export function pausedVentures(state: PauseState): readonly VentureId[] {
  return Object.keys(state.ventures) as VentureId[];
}

export type PauseRequest = {
  readonly state: StateStore;
  /** Omit to stop every venture. */
  readonly ventureId?: VentureId;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
};

export type PauseOutcome =
  | { readonly ok: true; readonly state: PauseState }
  /** The file on disk cannot be read, so a partial stop cannot be applied safely. */
  | { readonly ok: false; readonly unreadable: PauseRecord };

/**
 * Applies a stop.
 *
 * The awkward case is an unreadable file, where `readPause` reports a synthetic
 * global stop. Two wrong answers were tried before this one: seeding from that
 * sentinel wrote a stop nobody asked for, and discarding it silently *resumed*
 * every other venture when someone stopped a single one. The second is worse -
 * a command whose entire job is stopping things must never start any.
 *
 * So a whole-platform stop always works (it can only add), and a per-venture
 * stop on an unreadable file is refused with the reason. Refusing never reduces
 * what is stopped, which is the property that has to hold under uncertainty.
 */
export async function applyPause(request: PauseRequest): Promise<PauseOutcome> {
  const onDisk = readPause(request.state);
  const unreadable = onDisk.all?.by === "fail-closed" ? onDisk.all : undefined;
  const record: PauseRecord = { at: request.at, reason: request.reason, by: request.by };

  if (request.ventureId === undefined) {
    const next: PauseState = { all: record, ventures: onDisk.ventures };
    await write(request.state, next);
    return { ok: true, state: next };
  }

  if (unreadable) return { ok: false, unreadable };

  const next: PauseState = {
    ...(onDisk.all ? { all: onDisk.all } : {}),
    ventures: { ...onDisk.ventures, [request.ventureId]: record },
  };
  await write(request.state, next);
  return { ok: true, state: next };
}

export type ResumeRequest = {
  readonly state: StateStore;
  /**
   * Omit to clear everything, including individual ventures. Resuming one
   * venture while the whole platform is stopped is refused rather than
   * silently doing nothing - see the return value.
   */
  readonly ventureId?: VentureId;
};

export type ResumeOutcome =
  | { readonly ok: true; readonly state: PauseState; readonly wasPaused: boolean }
  | { readonly ok: false; readonly blockedByAll: PauseRecord }
  /**
   * The slot is still unreadable after a forced refresh, on a store where that
   * can mean real content this call simply has not fetched yet (see the guard
   * in `applyResume`). Only reachable for a whole-platform resume against a
   * store that has a `refresh` - `fileState` does not, and never returns this.
   */
  | { readonly ok: false; readonly stillUnreadable: true; readonly detail: string };

/**
 * Applies a resume.
 *
 * The whole-platform branch has a guard the per-venture one does not need, and
 * it only fires on a store that can actually have something hiding behind an
 * `unreadable` read.
 *
 * `applyPause`'s comment describes the mirror-image hazard on the stopping
 * side - "a command whose entire job is stopping things must never start any" -
 * and guards it by refusing a partial stop on an unreadable file. Resuming has
 * the opposite failure mode: "a command whose entire job is resuming things
 * must never erase a stop it could not see." That hazard is real on a
 * snapshot-backed store (`sql-state.ts`): before the first successful
 * `refresh()` in an invocation, or after a failed one, every read reports
 * `unreadable` regardless of what is actually stored in the row - which could
 * be three ventures' worth of real stops this call simply has not fetched yet.
 * Writing `RUNNING` there without re-checking would erase them without anyone
 * having seen them first: a D1 hiccup would make the screen say "everything is
 * stopped", and pressing the one button offered would silently discard
 * whatever was really recorded.
 *
 * It is not real on `fileState`: it has no `refresh` (there is no snapshot to
 * go stale), and its own `unreadable` means `readFileSync` itself threw - bad
 * permissions, the path being a directory, an I/O error. That is the same
 * fact as corrupt content, not a different, hidden one: nothing is behind it
 * to erase. Refusing there anyway was tried and is wrong - a permission error
 * or a bad path does not clear itself, so it would trap `amp resume`, the one
 * command whose entire job is being the escape hatch, behind advice ("try
 * again") that can never work. So the guard is gated on the store actually
 * having a `refresh`: no snapshot means nothing can be hiding behind
 * `unreadable`, and this falls straight through to the same read-and-write
 * `fileState` always did.
 */
export async function applyResume(request: ResumeRequest): Promise<ResumeOutcome> {
  if (request.ventureId === undefined) {
    if (request.state.refresh) {
      await request.state.refresh();
      const slot = request.state.read(PAUSE_KEY);
      if (slot.kind === "unreadable") {
        return { ok: false, stillUnreadable: true, detail: slot.detail };
      }
    }

    const current = readPause(request.state);
    const wasPaused = current.all !== undefined || Object.keys(current.ventures).length > 0;
    // Nothing recorded, nothing to clear - and nothing to write. A resume
    // pressed against a state that has already resolved itself (the phantom
    // from a hiccup that has since recovered) should say so, not add a write
    // that changes nothing.
    if (!wasPaused) return { ok: true, state: current, wasPaused: false };

    await write(request.state, RUNNING);
    return { ok: true, state: RUNNING, wasPaused: true };
  }

  const current = readPause(request.state);

  // Clearing one venture while the global stop is on would report "resumed" and
  // then publish nothing, which is the kind of half-truth that makes someone
  // stop trusting the stop button.
  if (current.all) return { ok: false, blockedByAll: current.all };

  const { [request.ventureId]: removed, ...rest } = current.ventures;
  const next: PauseState = { ventures: rest };
  await write(request.state, next);
  return { ok: true, state: next, wasPaused: removed !== undefined };
}

/** Renders a stop for a person, naming what to run to undo it. */
export function describePause(record: PauseRecord, ventureId?: VentureId): string {
  const scope = ventureId === undefined ? "Everything is stopped" : `Venture "${ventureId}" is stopped`;
  const undo = ventureId === undefined ? "amp resume" : `amp resume --venture ${ventureId}`;
  return `${scope} since ${record.at} (${record.by}): ${record.reason}. Nothing will publish until you run \`${undo}\`.`;
}

async function write(store: StateStore, state: PauseState): Promise<void> {
  await store.write(PAUSE_KEY, `${JSON.stringify(state, null, 2)}\n`);
}

function unreadable(detail: string, where: string): PauseState {
  return {
    all: {
      at: "unknown",
      reason: `${detail}. Fix or delete ${where} to start again.`,
      by: "fail-closed",
    },
    ventures: {},
  };
}

function toRecord(value: unknown): PauseRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as { at?: unknown; reason?: unknown; by?: unknown };
  return {
    at: typeof entry.at === "string" ? entry.at : "unknown",
    reason: typeof entry.reason === "string" && entry.reason !== "" ? entry.reason : "(no reason given)",
    by: typeof entry.by === "string" ? entry.by : "unknown",
  };
}

