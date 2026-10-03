/**
 * The job slot as a poller reads it: the three-way `ExternalSessionSlot`, the
 * tombstone, and the refresh that a snapshot-backed store needs before a read
 * can see another invocation's write.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeJob,
  createStateJobStore,
  isConsumedJob,
  isLiveJob,
  readExternalSessionSlot,
  tombstoneJob,
  type ExternalSessionJob,
} from "../src/kernel/external-session.ts";
import { EXTERNAL_SESSION_JOB_KEY, memoryState, type StateSlot, type StateStore } from "../src/kernel/state.ts";
import { createSqlState } from "../src/storage/sql-state.ts";
import { createSqliteDriver } from "../src/storage/sqlite-driver.ts";
import { migrate } from "../src/storage/sql-store.ts";
import { object, string } from "../src/llm/schema.ts";

const JOB: ExternalSessionJob = {
  id: "extjob_000001",
  prompt: "say hi",
  schema: object({ answer: string() }),
  createdAt: "2026-09-30T00:00:00.000Z",
};

function stateOf(slot: StateSlot): StateStore {
  return { read: () => slot, write: async () => {}, label: () => "test slot" };
}

test("the slot is none when absent or when it holds something that is not a job", () => {
  assert.deepEqual(readExternalSessionSlot(memoryState()), { kind: "none" });
  assert.deepEqual(readExternalSessionSlot(stateOf({ kind: "text", text: "not json" })), { kind: "none" });
  assert.deepEqual(readExternalSessionSlot(stateOf({ kind: "text", text: '{"id":5}' })), { kind: "none" });
});

test("consumedAt is read back when it is a string, and a slot with any other consumedAt is not a job", () => {
  const consumed = { ...JOB, result: { receivedAt: "2026-09-30T00:01:00.000Z", value: { answer: "x" } }, consumedAt: "2026-09-30T00:01:05.000Z" };
  const read = readExternalSessionSlot(stateOf({ kind: "text", text: JSON.stringify(consumed) }));
  assert.equal(read.kind === "job" ? read.job.consumedAt : undefined, "2026-09-30T00:01:05.000Z");
  for (const bad of [5, null, true, {}]) {
    const slot = readExternalSessionSlot(stateOf({ kind: "text", text: JSON.stringify({ ...consumed, consumedAt: bad }) }));
    assert.deepEqual(slot, { kind: "none" }, `consumedAt ${JSON.stringify(bad)} is not a timestamp`);
  }
});

test("consumeJob marks the answer as handed out without mutating, and leaves the job settled rather than discarded", () => {
  const answered: ExternalSessionJob = { ...JOB, result: { receivedAt: "2026-09-30T00:01:00.000Z", value: { answer: "x" } } };
  const consumed = consumeJob(answered, "2026-09-30T00:01:05.000Z");
  assert.equal(consumed.consumedAt, "2026-09-30T00:01:05.000Z");
  assert.equal(consumed.discardedAt, undefined, "the poller must keep being told done, not discarded");
  assert.equal(answered.consumedAt, undefined, "consumeJob must not mutate its argument");
  assert.equal(isConsumedJob(consumed), true);
  assert.equal(isConsumedJob(answered), false);
});

test("an unreadable state is unreadable, not none: a poller must keep waiting through it", () => {
  const slot = readExternalSessionSlot(stateOf({ kind: "unreadable", detail: "D1 is down" }));
  assert.deepEqual(slot, { kind: "unreadable", detail: "D1 is down" });
});

test("a live job is unanswered and not discarded; an answered or discarded one is not live", () => {
  assert.equal(isLiveJob(JOB), true);
  assert.equal(isLiveJob({ ...JOB, result: { receivedAt: "2026-09-30T00:01:00.000Z", value: { answer: "x" } } }), false);
  assert.equal(isLiveJob(tombstoneJob(JOB, "2026-09-30T00:02:00.000Z")), false);
  assert.equal(JOB.discardedAt, undefined, "tombstoneJob must not mutate its argument");
});

test("a store over a snapshot-backed state sees another invocation's write only after refresh", async () => {
  const driver = createSqliteDriver({ filename: ":memory:" });
  await migrate(driver);

  const poller = createStateJobStore(createSqlState(driver));
  await poller.refresh();
  assert.deepEqual(poller.read(), { kind: "none" });

  // The routine's answer, written by a different invocation.
  const answering = createSqlState(driver);
  await answering.refresh?.();
  await answering.write(
    EXTERNAL_SESSION_JOB_KEY,
    JSON.stringify({ ...JOB, result: { receivedAt: "2026-09-30T00:00:20.000Z", value: { answer: "hi" } } }),
  );

  assert.deepEqual(poller.read(), { kind: "none" }, "a read without a refresh is a snapshot and cannot see the answer");
  await poller.refresh();
  const slot = poller.read();
  assert.equal(slot.kind, "job");
  assert.deepEqual(slot.kind === "job" ? slot.job.result?.value : undefined, { answer: "hi" });
  await driver.close?.();
});

test("a tombstone survives the SQL round trip, so a later invocation still refuses the late answer", async () => {
  const driver = createSqliteDriver({ filename: ":memory:" });
  await migrate(driver);

  const writer = createStateJobStore(createSqlState(driver));
  await writer.refresh();
  await writer.write(tombstoneJob(JOB, "2026-09-30T00:02:00.000Z"));

  const later = createStateJobStore(createSqlState(driver));
  await later.refresh();
  const slot = later.read();
  assert.equal(slot.kind === "job" ? slot.job.discardedAt : undefined, "2026-09-30T00:02:00.000Z");
  assert.equal(slot.kind === "job" ? isLiveJob(slot.job) : true, false);
  await driver.close?.();
});
