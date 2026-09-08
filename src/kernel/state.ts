/**
 * Operating state: the two small facts that sit beside the data and are read
 * before anything runs - is the platform stopped, and which accounts has the
 * operator switched off.
 *
 * They are not in the config (which is the licensee's file, edited in an
 * editor) and not in the store (which is a day's work, not a switch). They
 * need to be readable and writable by a second process while the daemon runs,
 * and to take effect on the next tick without a restart.
 *
 * This is a port for one reason: on a machine they are files, and on a
 * serverless host there is no writable filesystem. Everything that decides
 * what a stop *means* - fail-closed for the stop, fail-open for deactivation -
 * stays above this line, in `pause.ts` and `venture-state.ts`, so a new
 * adapter cannot quietly change the safety properties.
 *
 * **Reads are synchronous.** The daemon consults them on every tick before it
 * starts a cycle or publishes; an await there is a window in which a stop can
 * be missed. An adapter that cannot read synchronously (a database) loads a
 * snapshot with `refresh()` at the start of an invocation and answers from it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../storage/atomic.ts";

/** The slot names. Each is one file, or one row. */
export const PAUSE_KEY = "paused";
export const VENTURE_STATE_KEY = "venture-state";

export type StateSlot =
  /** Nothing has ever been written here. Not an error. */
  | { readonly kind: "absent" }
  | { readonly kind: "text"; readonly text: string }
  /** Present but unusable. What that means is the caller's decision. */
  | { readonly kind: "unreadable"; readonly detail: string };

export type StateStore = {
  read(key: string): StateSlot;
  write(key: string, text: string): Promise<void>;
  /** Names the slot the way a person would find it: a path, or a row. */
  label(key: string): string;
  /**
   * Reloads the snapshot an async-backed adapter answers from. A no-op for
   * adapters that read the real thing on every call.
   */
  refresh?(): Promise<void>;
};

/** The shipped adapter: one JSON file per slot under the data directory. */
export function fileState(dataDir: string): StateStore {
  const pathOf = (key: string): string => join(dataDir, `${key}.json`);
  return {
    label: pathOf,
    read(key) {
      const path = pathOf(key);
      if (!existsSync(path)) return { kind: "absent" };
      try {
        return { kind: "text", text: readFileSync(path, "utf8") };
      } catch (cause) {
        return { kind: "unreadable", detail: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    async write(key, text) {
      // Atomic: a stop file half-written by a crash reads as corrupt, which
      // fails closed and strands the operator.
      await writeFileAtomic(pathOf(key), text);
    },
  };
}

/** For tests, and for `--dry-run`, where nothing should reach the disk. */
export function memoryState(seed: Readonly<Record<string, string>> = {}): StateStore {
  const slots = new Map<string, string>(Object.entries(seed));
  return {
    label: (key) => `${key} (in memory)`,
    read(key) {
      const text = slots.get(key);
      return text === undefined ? { kind: "absent" } : { kind: "text", text };
    },
    async write(key, text) {
      slots.set(key, text);
    },
  };
}
