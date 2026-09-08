/**
 * The stop and the deactivation switch, in a SQL row instead of a file.
 *
 * The port's reads are synchronous - the tick consults them before it starts a
 * cycle or publishes, and an await there is a window in which a stop can be
 * missed. A database cannot answer synchronously, so this adapter answers from
 * a snapshot and `refresh()` loads it.
 *
 * **Before the first successful refresh, every read is `unreadable`.** That is
 * the whole safety argument: an entry point that forgets to refresh, or one
 * whose database is down, reports a stop rather than quietly running with no
 * stop in sight. `pause.ts` turns `unreadable` into "stopped" and
 * `venture-state.ts` turns it into "everything is running, with a warning",
 * which is the right pair of answers under the same uncertainty.
 */

import { PAUSE_KEY, VENTURE_STATE_KEY, type StateSlot, type StateStore } from "../kernel/state.ts";
import type { SqlDriver } from "./sql-driver.ts";

const KEYS: readonly string[] = [PAUSE_KEY, VENTURE_STATE_KEY];

export function createSqlState(driver: SqlDriver): StateStore {
  let snapshot: Map<string, string> | undefined;
  let failure: string | undefined;

  return {
    label(key) {
      return `the "${key}" row of the state table`;
    },

    read(key): StateSlot {
      if (!snapshot) {
        return {
          kind: "unreadable",
          detail: failure ?? "the state table has not been read yet in this invocation",
        };
      }
      const text = snapshot.get(key);
      return text === undefined ? { kind: "absent" } : { kind: "text", text };
    },

    async write(key, text) {
      await driver.run(
        `INSERT INTO state (key, json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json`,
        [key, text],
      );
      // Keep the snapshot current so a write followed by a read in the same
      // invocation sees itself, the way a file does - but only when there is a
      // snapshot to update. Building a partial one here would answer "absent"
      // for the rows it does not have, and "absent" for the stop means running.
      snapshot?.set(key, text);
    },

    async refresh() {
      try {
        const rows = await driver.all<{ key: string; json: string }>(
          `SELECT key, json FROM state WHERE key IN (?, ?)`,
          [...KEYS],
        );
        snapshot = new Map(rows.map((row) => [row.key, row.json]));
        failure = undefined;
      } catch (cause) {
        // Leave the snapshot unset: reads go back to reporting `unreadable`,
        // which stops the platform rather than running it blind.
        snapshot = undefined;
        failure = cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
}
