import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileState, memoryState, PAUSE_KEY, VENTURE_STATE_KEY, type StateStore } from "../src/kernel/state.ts";
import { applyPause, isPaused, readPause } from "../src/kernel/pause.ts";
import { readVentureState } from "../src/kernel/venture-state.ts";
import { createSqlState } from "../src/storage/sql-state.ts";
import { createSqliteDriver } from "../src/storage/sqlite-driver.ts";
import { migrate } from "../src/storage/sql-store.ts";

/** A store whose every read fails, the way a database that is down would. */
function brokenState(detail: string): StateStore {
  return {
    label: (key) => `the ${key} row`,
    read: () => ({ kind: "unreadable", detail }),
    async write() {
      throw new Error("unreachable");
    },
  };
}

test("a slot that was never written is absent, not an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amp-state-"));
  try {
    assert.equal(fileState(dir).read(PAUSE_KEY).kind, "absent");
    assert.equal(memoryState().read(PAUSE_KEY).kind, "absent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("what a slot is written with is what comes back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amp-state-"));
  try {
    for (const store of [fileState(dir), memoryState()]) {
      await store.write(PAUSE_KEY, "{}\n");
      const slot = store.read(PAUSE_KEY);
      assert.equal(slot.kind, "text");
      assert.equal(slot.kind === "text" ? slot.text : "", "{}\n");
    }
    assert.equal(fileState(dir).label(PAUSE_KEY), join(dir, "paused.json"), "a person has to be able to find it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The two properties that must survive a change of adapter. They are decided
// above the port on purpose - a storage backend must not be able to turn the
// stop into something that fails open by being slightly broken.
test("a stop that cannot be read counts as stopped, whatever the backing store is", () => {
  const state = readPause(brokenState("connection refused"));
  assert.equal(isPaused(state), true);
  assert.equal(state.all?.by, "fail-closed");
  assert.match(state.all?.reason ?? "", /connection refused/);
  assert.match(state.all?.reason ?? "", /the paused row/, "the message has to name where to look");
});

test("deactivation state that cannot be read leaves every account running, with a warning", () => {
  const state = readVentureState(brokenState("connection refused"));
  assert.deepEqual(state.inactive, {});
  assert.match(state.warning ?? "", /connection refused/);
  assert.match(state.warning ?? "", new RegExp(`the ${VENTURE_STATE_KEY} row`));
});

// The SQL-backed adapter answers from a snapshot, because the port's reads are
// synchronous and a database is not.
test("a SQL-backed state store reports a stop until it has actually been read", async () => {
  const driver = createSqliteDriver({ filename: ":memory:" });
  await migrate(driver);
  const store = createSqlState(driver);

  // Nobody has refreshed. An entry point that forgot must not run unstopped.
  assert.equal(isPaused(readPause(store)), true, "unrefreshed must fail closed");
  assert.equal(readVentureState(store).warning !== undefined, true);

  await store.refresh?.();
  assert.equal(isPaused(readPause(store)), false, "an empty state table means nothing is stopped");
  assert.deepEqual(readVentureState(store).inactive, {});

  await applyPause({ state: store, reason: "hands off", by: "test", at: "2026-09-04T00:00:00Z" });
  assert.equal(isPaused(readPause(store)), true, "a write is visible to the same invocation");

  // A second reader, as a later cron fire would be.
  const later = createSqlState(driver);
  await later.refresh?.();
  const stop = readPause(later);
  assert.equal(stop.all?.reason, "hands off");
  await driver.close?.();
});

test("a SQL-backed state store that cannot reach its database fails closed", async () => {
  const broken = {
    async all(): Promise<never[]> {
      throw new Error("D1_ERROR: no such table");
    },
    async run(): Promise<void> {},
    async batch(): Promise<void> {},
  };
  const store = createSqlState(broken);
  await store.refresh?.();
  const stop = readPause(store);
  assert.equal(isPaused(stop), true);
  assert.match(stop.all?.reason ?? "", /no such table/);
});
