import test from "node:test";

/** The account these tests drive. Stores are per-account now. */
const VENTURE = "main";
import assert from "node:assert/strict";

import { createTestCompany, testConfig, BASE_CONFIG } from "./helpers.ts";
import { memoryState } from "../src/kernel/state.ts";
import { applyPause } from "../src/kernel/pause.ts";
import { deactivateVenture } from "../src/kernel/venture-state.ts";
import { createTickMemory, runTick } from "../src/scheduler/tick.ts";
import type { Runtime } from "../src/runtime.ts";
import type { StateStore } from "../src/kernel/state.ts";

/**
 * A Runtime without a process behind it. The console tests build one the same
 * way; the point here is that `runTick` needs nothing else - which is what lets
 * a scheduled trigger call it.
 */
function testRuntime(state: StateStore, startIso = "2026-04-01T00:30:00Z"): Runtime & { company: ReturnType<typeof createTestCompany> } {
  const company = createTestCompany({
    startIso,
    config: testConfig({
      // 09:00 JST, and the clock above is 09:30 JST, so the cycle is due.
      ventures: BASE_CONFIG.ventures.map((venture) => ({
        ...venture,
        cadence: { ...(venture as { cadence: object }).cadence, cycleStartsAt: "09:00" },
      })),
    }),
  });
  return {
    loaded: { config: company.config, path: "test", dataDir: ".amp-test", promptsDir: "prompts" },
    config: company.config,
    state,
    services: company.services,
    orchestrator: company.orchestrator,
    bus: company.services.bus,
    dryRun: false,
    close: async () => {},
    company,
  } as unknown as Runtime & { company: ReturnType<typeof createTestCompany> };
}

test("a tick starts the day's cycle once, and a caller that remembers nothing does not start a second", async () => {
  const runtime = testRuntime(memoryState());
  const nowMs = runtime.services.clock.now();

  await runTick(runtime, createTickMemory(), nowMs);
  const afterFirst = await (await runtime.services.stores.for(VENTURE)).cycles.all();
  assert.equal(afterFirst.length, 1, "one cycle for the day");

  // A cron trigger gets a fresh isolate every time it fires: no `startedToday`,
  // no `retryAfter`. The guard against repeating the day is the orchestrator's
  // cycle id, not the memory, and this is the test that says so.
  await runTick(runtime, createTickMemory(), nowMs + 60_000);
  const afterSecond = await (await runtime.services.stores.for(VENTURE)).cycles.all();
  assert.equal(afterSecond.length, 1, "a second tick with no memory must not open a second cycle");
  assert.equal(afterSecond[0]?.id, afterFirst[0]?.id);
});

test("a stopped platform starts nothing, whoever is calling the tick", async () => {
  const state = memoryState();
  await applyPause({ state, reason: "something is wrong", by: "test", at: "2026-04-01T00:00:00Z" });

  const runtime = testRuntime(state);
  await runTick(runtime, createTickMemory(), runtime.services.clock.now());
  assert.deepEqual(await (await runtime.services.stores.for(VENTURE)).cycles.all(), []);
});

test("a deactivated account starts nothing", async () => {
  const state = memoryState();
  const runtime = testRuntime(state);
  for (const venture of runtime.config.ventures) {
    await deactivateVenture(state, venture.id, { at: "2026-04-01T00:00:00Z", by: "test", reason: "no clicks" });
  }

  await runTick(runtime, createTickMemory(), runtime.services.clock.now());
  assert.deepEqual(await (await runtime.services.stores.for(VENTURE)).cycles.all(), []);
});

test("cycles and dispatch can be asked for separately", async () => {
  // Two schedules, because a host may give the slow half a longer runtime
  // budget than the half that has to hit a slot to the minute.
  const runtime = testRuntime(memoryState());
  await runTick(runtime, createTickMemory(), runtime.services.clock.now(), { dispatch: true, cycles: false });
  assert.deepEqual(await (await runtime.services.stores.for(VENTURE)).cycles.all(), [], "cycles: false means no cycle was started");

  await runTick(runtime, createTickMemory(), runtime.services.clock.now(), { cycles: true, dispatch: false });
  assert.equal((await (await runtime.services.stores.for(VENTURE)).cycles.all()).length, 1);
});

test("the tick closes yesterday's gate before it opens today's", async () => {
  // Everything about expiring a gate is inert unless something calls it, and
  // in a running operation the only thing that ever does is the tick. Removing
  // the call left every other test on this behaviour green.
  const runtime = testRuntime(memoryState());
  const clock = runtime.company.clock;
  const store = await runtime.services.stores.for(VENTURE);

  await runTick(runtime, createTickMemory(), clock.now());
  const first = (await store.cycles.all())[0];
  assert.equal(first?.status, "awaiting_approval", "nobody approved it");

  // The next day, its cycle due. The gate from yesterday is still standing.
  clock.advance(24 * 60 * 60 * 1000);
  await runTick(runtime, createTickMemory(), clock.now());

  const cycles = await store.cycles.all();
  assert.equal(cycles.length, 2, "today opened its own cycle");
  assert.equal(
    cycles.find((cycle) => cycle.id === first?.id)?.status,
    "cancelled",
    "and yesterday's was closed rather than left beside it",
  );

  const waiting = await runtime.orchestrator.pendingDecisions();
  assert.equal(waiting.length, 1, "exactly one gate is waiting: today's");
  assert.equal(waiting[0]?.cycleId, cycles.find((cycle) => cycle.id !== first?.id)?.id);
});
