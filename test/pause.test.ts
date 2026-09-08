/**
 * The emergency stop.
 *
 * These assert the two properties the stop is worth having for: it fails
 * closed, and it delays rather than cancels. Everything else about it is
 * convenience.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPause,
  applyResume,
  isPaused,
  pausedBy,
  pausedVentures,
  pauseFilePath,
  readPause,
} from "../src/kernel/pause.ts";
import { BASE_CONFIG, createTestCompany, HOUR_MS, testConfig } from "./helpers.ts";
import { unwrap } from "../src/core/result.ts";
import { fileState } from "../src/kernel/state.ts";
import type { VentureId } from "../src/core/types.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "amp-pause-"));
}

test("nothing is stopped when no stop has been recorded", async () => {
  const dir = await scratch();
  try {
    const state = readPause(fileState(dir));
    assert.equal(isPaused(state), false);
    assert.equal(isPaused(state, "main" as VentureId), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stop file nobody can parse counts as stopped", async () => {
  const dir = await scratch();
  try {
    // Someone in a hurry types STOP into the file, or a crash truncates a
    // write. Both must stop the machine, not be shrugged off as noise.
    await writeFile(pauseFilePath(dir), "STOP", "utf8");
    const state = readPause(fileState(dir));

    assert.equal(isPaused(state), true, "an unparseable stop file must fail closed");
    assert.match(
      pausedBy(state)?.reason ?? "",
      /paused\.json/,
      "the reason should name the file to fix, not just say it failed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("valid JSON of a shape we do not write counts as stopped", async () => {
  // Worse than an unparseable file, because it looks deliberate: someone wrote
  // `{"all": true}` meaning to stop everything, and reading it as "running"
  // was the exact fail-open this module exists to rule out.
  for (const body of ['{"all":true}', '{"paused":true}', '["STOP"]', '{"all":"yes","ventures":{}}']) {
    const dir = await scratch();
    try {
      await writeFile(pauseFilePath(dir), body, "utf8");
      assert.equal(isPaused(readPause(fileState(dir))), true, `${body} must fail closed`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("stopping one venture on a corrupt file refuses rather than starting the others", async () => {
  // The regression this locks was introduced by the fix for the previous one:
  // discarding the fail-closed sentinel before writing meant `pause --venture X`
  // silently resumed every other venture. A command whose whole job is stopping
  // things must never start any.
  const dir = await scratch();
  try {
    await writeFile(pauseFilePath(dir), "STOP", "utf8");
    const outcome = await applyPause({
      state: fileState(dir),
      ventureId: "beauty" as VentureId,
      reason: "r",
      by: "t",
      at: "t",
    });

    assert.equal(outcome.ok, false, "a partial stop cannot be applied on a file we cannot read");
    assert.equal(
      isPaused(readPause(fileState(dir)), "parenting" as VentureId),
      true,
      "everything that was stopped must stay stopped",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopping everything on a corrupt file still works", async () => {
  const dir = await scratch();
  try {
    await writeFile(pauseFilePath(dir), "STOP", "utf8");
    const outcome = await applyPause({ state: fileState(dir), reason: "r", by: "t", at: "t" });
    assert.equal(outcome.ok, true, "a global stop can only add, so it is always safe");
    assert.equal(isPaused(readPause(fileState(dir))), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the shape resume writes reads as running", async () => {
  const dir = await scratch();
  try {
    await applyPause({ state: fileState(dir), reason: "x", by: "t", at: "t" });
    await applyResume({ state: fileState(dir) });
    assert.equal(isPaused(readPause(fileState(dir))), false, "fail-closed must not mean stuck closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty stop file counts as stopped", async () => {
  const dir = await scratch();
  try {
    await writeFile(pauseFilePath(dir), "", "utf8");
    assert.equal(isPaused(readPause(fileState(dir))), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopping one venture leaves the others running", async () => {
  const dir = await scratch();
  try {
    await applyPause({
      state: fileState(dir),
      ventureId: "beauty" as VentureId,
      reason: "wrong offer went out",
      by: "test",
      at: "2026-09-01T09:00:00.000Z",
    });

    const state = readPause(fileState(dir));
    assert.equal(isPaused(state, "beauty" as VentureId), true);
    assert.equal(isPaused(state, "parenting" as VentureId), false);
    assert.deepEqual(pausedVentures(state), ["beauty"]);
    assert.equal(pausedBy(state, "beauty" as VentureId)?.reason, "wrong offer went out");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopping everything stops a venture that was never named", async () => {
  const dir = await scratch();
  try {
    await applyPause({ state: fileState(dir), reason: "something is wrong", by: "test", at: "2026-09-01T09:00:00.000Z" });
    assert.equal(isPaused(readPause(fileState(dir)), "never-mentioned" as VentureId), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resuming one venture is refused while everything is stopped", async () => {
  const dir = await scratch();
  try {
    await applyPause({ state: fileState(dir), reason: "all stop", by: "test", at: "2026-09-01T09:00:00.000Z" });
    const outcome = await applyResume({ state: fileState(dir), ventureId: "beauty" as VentureId });

    // Reporting "resumed" and then publishing nothing is how someone stops
    // trusting the stop button.
    assert.equal(outcome.ok, false, "resuming one venture under a global stop must not claim success");
    assert.equal(isPaused(readPause(fileState(dir)), "beauty" as VentureId), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resuming clears every stop, including ones set per venture", async () => {
  const dir = await scratch();
  try {
    await applyPause({ state: fileState(dir), ventureId: "beauty" as VentureId, reason: "a", by: "test", at: "t" });
    await applyPause({ state: fileState(dir), ventureId: "parenting" as VentureId, reason: "b", by: "test", at: "t" });
    await applyPause({ state: fileState(dir), reason: "c", by: "test", at: "t" });

    const outcome = await applyResume({ state: fileState(dir) });
    assert.equal(outcome.ok, true);
    assert.equal(isPaused(readPause(fileState(dir))), false);
    assert.deepEqual(pausedVentures(readPause(fileState(dir))), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Walks a venture from a fresh cycle to posts approved for publishing. */
async function approveADaysPosts(company: ReturnType<typeof createTestCompany>): Promise<void> {
  const atProposal = unwrap(await company.orchestrator.runCycle("main"));
  const proposalId = atProposal.pendingDecisionId as string;
  const proposals = await company.store.decisions.get(proposalId);
  const recommended = (proposals?.items ?? []).filter((item) => item.recommended).map((item) => item.id);
  assert.ok(recommended.length > 0, "the planner should have recommended something to carry through");

  const atPublish = unwrap(
    await company.orchestrator.resolveGate(proposalId, {
      decidedBy: "tester",
      selectedIds: recommended,
      nowIso: company.clock.nowIso(),
    }),
  );

  const publishId = atPublish.pendingDecisionId as string;
  const publishDecision = await company.store.decisions.get(publishId);
  const postIds = (publishDecision?.items ?? []).map((item) => item.id);
  assert.ok(postIds.length > 0, "the writer and publisher should have produced a post");

  unwrap(
    await company.orchestrator.resolveGate(publishId, {
      decidedBy: "tester",
      selectedIds: postIds,
      nowIso: company.clock.nowIso(),
    }),
  );
}

test("a stop delays a post the platform is holding, it does not cancel it", async () => {
  // A channel without native scheduling leaves the post with us until its slot,
  // which is the window a stop can actually act on.
  const company = createTestCompany({
    config: testConfig({
      channels: [
        {
          ...BASE_CONFIG.channels[0],
          options: { maxCharacters: 500, seed: "test", nativeScheduling: false },
        },
      ],
    }),
  });
  await approveADaysPosts(company);

  const wellPastEverySlot = company.clock.now() + 48 * HOUR_MS;

  const stopped = unwrap(
    await company.orchestrator.dispatchDue(wellPastEverySlot, { skipVentures: ["main" as VentureId] }),
  );
  assert.equal(stopped.published.length, 0, "a stopped venture must not publish");
  assert.ok(stopped.held > 0, "the held count should say how much the stop is holding back");

  const afterResume = unwrap(await company.orchestrator.dispatchDue(wellPastEverySlot));
  assert.ok(
    afterResume.published.length > 0,
    "posts held by a stop must still go out once it is lifted - a stop delays, it never cancels",
  );
});

test("a stop cannot recall a post the channel is already holding", async () => {
  // The honest limitation, asserted so nobody later mistakes it for a bug and
  // "fixes" it into a false promise. A channel with native scheduling has the
  // post on its own clock; it goes live whether or not this platform is
  // stopped, and the only place to cancel it is the channel. `amp pause` says
  // so, and this is the behaviour it is warning about.
  const company = createTestCompany();
  await approveADaysPosts(company);

  const wellPastEverySlot = company.clock.now() + 48 * HOUR_MS;
  const stopped = unwrap(
    await company.orchestrator.dispatchDue(wellPastEverySlot, { skipVentures: ["main" as VentureId] }),
  );

  assert.ok(
    stopped.published.length > 0,
    "a natively scheduled post goes live regardless, and the platform must record that rather than pretend it was held",
  );
  assert.equal(stopped.held, 0, "held counts only what the stop actually held back");

  // But the comments are a separate question, and the answer is different.
  assert.ok(
    stopped.commentsWithheld > 0,
    "a stop must not keep dropping affiliate links under posts it could not recall",
  );
});

