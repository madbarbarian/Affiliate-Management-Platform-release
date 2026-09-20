import test from "node:test";

/** The account these tests drive. Stores are per-account now. */
const VENTURE = "main";
import assert from "node:assert/strict";

import { createTestCompany, refusingProvider, testConfig, BASE_CONFIG } from "./helpers.ts";
import { memoryState } from "../src/kernel/state.ts";
import { applyPause } from "../src/kernel/pause.ts";
import { deactivateVenture } from "../src/kernel/venture-state.ts";
import {
  CYCLE_ABANDONED_EVENT,
  createTickMemory,
  judgeCycleStart,
  judgeScoutStart,
  runTick,
  SCOUT_MAX_ATTEMPTS_PER_DAY,
  SCOUT_RETRY_BACKOFF_MS,
} from "../src/scheduler/tick.ts";
import { cycleIdFor } from "../src/kernel/orchestrator.ts";
import { SCOUT_COMPLETED_EVENT, SCOUT_FAILED_EVENT } from "../src/kernel/exploration.ts";
import type { AuditEvent, Cycle } from "../src/core/types.ts";
import { createMockProvider, type MockProvider } from "../src/llm/mock.ts";
import { createDemoHandlers } from "../src/llm/demo.ts";
import type { Runtime } from "../src/runtime.ts";
import type { StateStore } from "../src/kernel/state.ts";

/**
 * A Runtime without a process behind it. The console tests build one the same
 * way; the point here is that `runTick` needs nothing else - which is what lets
 * a scheduled trigger call it.
 */
function testRuntime(
  state: StateStore,
  startIso = "2026-04-01T00:30:00Z",
  options: { llm?: MockProvider; config?: Record<string, unknown> } = {},
): Runtime & { company: ReturnType<typeof createTestCompany> } {
  const company = createTestCompany({
    startIso,
    ...(options.llm ? { llm: options.llm } : {}),
    config: testConfig({
      // 09:00 JST, and the clock above is 09:30 JST, so the cycle is due.
      ventures: BASE_CONFIG.ventures.map((venture) => ({
        ...venture,
        cadence: { ...(venture as { cadence: object }).cadence, cycleStartsAt: "09:00" },
      })),
      ...(options.config ?? {}),
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

// ---------------------------------------------------------------------------
// Starting a day again - or not
// ---------------------------------------------------------------------------

/**
 * Counts every request before it is delegated.
 *
 * **Outside the provider under test, never inside it.** `refusingProvider`
 * answers a refusal itself and never reaches the mock, so the refused calls
 * never land in `MockProvider.calls` - a test that counted those would stay
 * green with the bug fully present, which is what the first draft of this file
 * did.
 */
function countingProvider(inner: MockProvider): MockProvider & { readonly count: () => number } {
  let seen = 0;
  return {
    ...inner,
    async completeText(request) {
      seen += 1;
      return inner.completeText(request);
    },
    async completeJson(request) {
      seen += 1;
      return inner.completeJson(request);
    },
    count: () => seen,
  };
}

/** A cycle written straight into the store, the way yesterday's process left one. */
async function seedCycle(
  runtime: ReturnType<typeof testRuntime>,
  venture: string,
  date: string,
  overrides: Partial<Cycle>,
): Promise<void> {
  const store = await runtime.services.stores.for(venture);
  await store.cycles.put({
    id: cycleIdFor(venture, date),
    ventureId: venture,
    date,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    status: "failed",
    nextStep: "analyze",
    completed: [],
    artifacts: {},
    ...overrides,
  } as Cycle);
}

test("a day that cannot succeed is not paid for again on every tick", async () => {
  // The whole reason this work exists. A cron fire is a fresh isolate, so the
  // tick's memory of "already started" was always empty on Cloudflare, and a
  // deterministic failure was re-run - and re-billed - every hour until
  // midnight. The count has to come from outside the refusing provider: a
  // refusal never reaches the mock, so MockProvider.calls does not move.
  const llm = countingProvider(refusingProvider({ "plan.ideas": "the model is not available" }));
  const runtime = testRuntime(memoryState(), "2026-04-01T00:30:00Z", { llm });
  const nowMs = runtime.services.clock.now();

  await runTick(runtime, createTickMemory(), nowMs);
  const afterFirst = llm.count();
  assert.ok(afterFirst > 0, "the first tick is supposed to have asked the model");

  await runTick(runtime, createTickMemory(), nowMs + 3_600_000);
  await runTick(runtime, createTickMemory(), nowMs + 7_200_000);
  assert.equal(llm.count(), afterFirst, "the failed day was started again on a later tick");
});

test("giving up on a day is recorded, not silent", async () => {
  // A day that stops quietly is the `decision.expired` problem again: the
  // thirty seconds a day the product promises stop happening and nothing says
  // so. The account's own feed is where a hosted operator would find out.
  const llm = refusingProvider({ "plan.ideas": "the model is not available" });
  const runtime = testRuntime(memoryState(), "2026-04-01T00:30:00Z", { llm });
  const nowMs = runtime.services.clock.now();
  await runTick(runtime, createTickMemory(), nowMs);
  await runTick(runtime, createTickMemory(), nowMs + 3_600_000);

  const store = await runtime.services.stores.for(VENTURE);
  const events = await store.audit.recent(20);
  const abandoned = events.filter((event) => event.type === CYCLE_ABANDONED_EVENT);
  assert.equal(abandoned.length, 1, "the day giving up is recorded exactly once");
  assert.equal(abandoned[0]?.data["reason"], "not_retryable");

  // And not again on the tick after that: an hourly line about the same dead
  // day buries the twelve entries the console shows.
  await runTick(runtime, createTickMemory(), nowMs + 7_200_000);
  assert.equal(
    (await store.audit.recent(20)).filter((event) => event.type === CYCLE_ABANDONED_EVENT).length,
    1,
  );
});

test("a day left running when the process died is resumed", async () => {
  // The case a skip-on-doubt rule would have killed. An isolate that dies
  // mid-step leaves `running` behind; nothing else in the platform picks that
  // up, and the screen goes on saying 動作中 forever.
  const runtime = testRuntime(memoryState());
  await seedCycle(runtime, VENTURE, "2026-04-01", { status: "running", nextStep: "analyze" });

  await runTick(runtime, createTickMemory(), runtime.services.clock.now());
  const cycle = (await (await runtime.services.stores.for(VENTURE)).cycles.all())[0];
  assert.equal(cycle?.status, "awaiting_approval", "the half-finished day did not carry on");
});

test("a day that keeps dying mid-step is restarted, but only up to the limit", async () => {
  // The other half of the test above, and the hole the first version of this
  // work left open. An isolate killed mid-step writes nothing, so the record
  // stays `running` and never passes through the orchestrator's
  // failed -> running branch - which is where the retry used to be counted.
  // The limit therefore could not see it, and a day that died every hour was
  // restarted every hour, forever, at the price of a cycle each time.
  const runtime = testRuntime(memoryState());
  const limit = runtime.config.company.retry.maxCycleAttempts;
  const store = await runtime.services.stores.for(VENTURE);
  const nowMs = runtime.services.clock.now();

  await seedCycle(runtime, VENTURE, "2026-04-01", { status: "running", nextStep: "analyze" });
  await runTick(runtime, createTickMemory(), nowMs);
  assert.equal((await store.cycles.all())[0]?.attempts, 2, "restarting a stuck day was not counted");

  // It dies again, the same way: the record is left exactly where it was.
  await store.cycles.put({
    ...(await store.cycles.all())[0]!,
    status: "running",
    nextStep: "analyze",
    attempts: limit,
    updatedAt: "2026-04-01T00:00:00Z",
  });
  await runTick(runtime, createTickMemory(), nowMs + 3_600_000);

  const after = (await store.cycles.all())[0];
  assert.equal(after?.status, "running", "the stuck day was restarted past its limit");
  assert.equal(after?.updatedAt, "2026-04-01T00:00:00Z", "and something wrote to it");

  // And it said so, rather than going quiet on its own.
  const abandoned = (await store.audit.recent(20)).filter((event) => event.type === CYCLE_ABANDONED_EVENT);
  assert.equal(abandoned[0]?.data["reason"], "attempts_exhausted");
});

test("a step that threw is tried again, because on a host that is usually the network", async () => {
  // `fail()` defaults to retryable: false, and a thrown step used to take that
  // default - so a D1 blip, a fetch TypeError or a prompt that did not load all
  // read as "never again today". Those are the failures that clear by
  // themselves, and they are the common ones on Cloudflare.
  const base = createMockProvider({ responses: createDemoHandlers() as never });
  let thrownOnce = false;
  const flaky: MockProvider = {
    ...base,
    async completeJson(request) {
      if (request.purpose === "plan.ideas" && !thrownOnce) {
        thrownOnce = true;
        // What a dropped D1 connection or a failed `fetch` looks like from
        // inside a role: an exception, not a returned Result.
        throw new TypeError("fetch failed");
      }
      return base.completeJson(request);
    },
  };
  const runtime = testRuntime(memoryState(), "2026-04-01T00:30:00Z", { llm: flaky });
  const store = await runtime.services.stores.for(VENTURE);

  const nowMs = runtime.services.clock.now();
  await runTick(runtime, createTickMemory(), nowMs);
  const failed = (await store.cycles.all())[0];
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.failure?.code, "cycle.step_threw");
  assert.equal(failed?.failure?.retryable, true, "a thrown step has to be worth trying again");

  await runTick(runtime, createTickMemory(), nowMs + 3_600_000);
  const after = (await store.cycles.all())[0];
  assert.equal(after?.status, "awaiting_approval", "the transient failure was never retried");
});

test("an old record with no retryable and no attempts is tried again", async () => {
  // Nothing written before this change carries either field. Reading a missing
  // `retryable` as "do not retry" would have frozen every existing failure, and
  // reading a missing `attempts` as zero would hand each one a free extra try.
  const runtime = testRuntime(memoryState());
  await seedCycle(runtime, VENTURE, "2026-04-01", {
    status: "failed",
    nextStep: "analyze",
    failure: { step: "analyze", message: "whatever went wrong last time", code: "llm.api_error" },
  });

  await runTick(runtime, createTickMemory(), runtime.services.clock.now());
  const cycle = (await (await runtime.services.stores.for(VENTURE)).cycles.all())[0];
  assert.equal(cycle?.status, "awaiting_approval", "the old record was not resumed");
  assert.equal(cycle?.attempts, 2, "the retry has to be counted, or it repeats forever");
});

test("and only within the limit: a day already at it is left alone", async () => {
  const runtime = testRuntime(memoryState());
  const limit = runtime.config.company.retry.maxCycleAttempts;
  await seedCycle(runtime, VENTURE, "2026-04-01", {
    status: "failed",
    nextStep: "analyze",
    attempts: limit,
    failure: { step: "analyze", message: "whatever went wrong last time", code: "llm.api_error" },
  });

  await runTick(runtime, createTickMemory(), runtime.services.clock.now());
  const cycle = (await (await runtime.services.stores.for(VENTURE)).cycles.all())[0];
  assert.equal(cycle?.status, "failed", "a day past its attempts was started again");
  assert.equal(cycle?.updatedAt, "2026-04-01T00:00:00Z", "nothing should have touched it");
});

// ---------------------------------------------------------------------------
// The judgement itself
// ---------------------------------------------------------------------------

test("judgeCycleStart decides from the record alone", () => {
  const base: Cycle = {
    id: cycleIdFor("main", "2026-04-01"),
    ventureId: "main",
    date: "2026-04-01",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    status: "failed",
    completed: [],
    artifacts: {},
  };
  const nowMs = Date.parse("2026-04-01T03:00:00Z");
  const judge = (cycle: Cycle | undefined, maxAttempts = 2, backoffMs = 600_000) =>
    judgeCycleStart({ cycle, date: "2026-04-01", nowMs, backoffMs, maxAttempts });

  assert.deepEqual(judge(undefined), { run: true, reason: "no_record" });
  assert.deepEqual(judge({ ...base, date: "2026-03-31" }), { run: false, reason: "other_day" });
  assert.deepEqual(judge({ ...base, status: "completed" }), { run: false, reason: "already_settled" });
  assert.deepEqual(judge({ ...base, status: "cancelled" }), { run: false, reason: "already_settled" });
  assert.deepEqual(judge({ ...base, status: "awaiting_approval" }), { run: false, reason: "waiting_for_person" });

  const failure = { step: "plan", message: "no", code: "llm.api_error" } as const;
  assert.deepEqual(
    judge({ ...base, failure: { ...failure, retryable: false } }),
    { run: false, reason: "not_retryable" },
    "an explicit no is the only no",
  );
  assert.deepEqual(
    judge({ ...base, failure: { ...failure, retryable: true } }),
    { run: true, reason: "retry_due" },
  );
  assert.deepEqual(
    judge({ ...base, failure }),
    { run: true, reason: "retry_due" },
    "a record with no opinion is unknown, not a refusal",
  );
  assert.deepEqual(
    judge({ ...base, status: "running" }),
    { run: true, reason: "retry_due" },
    "a died-mid-step day has to be recoverable",
  );

  assert.deepEqual(judge({ ...base, attempts: 2 }), { run: false, reason: "attempts_exhausted" });
  assert.deepEqual(judge({ ...base, attempts: 2 }, 3), { run: true, reason: "retry_due" });
  assert.deepEqual(
    judge({ ...base, updatedAt: "2026-04-01T02:55:00Z" }),
    { run: false, reason: "backoff" },
    "five minutes after the last touch, with a ten-minute wait",
  );
  assert.deepEqual(
    judge({ ...base, updatedAt: "yesterday-ish" }),
    { run: false, reason: "unreadable_timestamp" },
    "a day whose backoff cannot be held is a day that runs on every tick",
  );
});

// ---------------------------------------------------------------------------
// The scout, which has the same hole a layer up
// ---------------------------------------------------------------------------

test("judgeScoutStart stops a failing scout without stopping it forever", () => {
  const nowMs = Date.parse("2026-04-08T09:00:00Z");
  const event = (type: string, at: string): AuditEvent => ({
    id: `evt_${at}`,
    at,
    ventureId: "company",
    type,
    actor: "scheduler",
    summary: "",
    data: {},
  });
  const judge = (events: AuditEvent[]) =>
    judgeScoutStart({
      events,
      nowMs,
      everyDays: 7,
      backoffMs: SCOUT_RETRY_BACKOFF_MS,
      maxAttemptsPerDay: SCOUT_MAX_ATTEMPTS_PER_DAY,
    });

  assert.deepEqual(judge([]), { run: true, reason: "never_run" });
  assert.deepEqual(
    judge([event(SCOUT_COMPLETED_EVENT, "2026-04-07T09:00:00Z")]),
    { run: false, reason: "not_due" },
  );
  assert.deepEqual(
    judge([event(SCOUT_COMPLETED_EVENT, "2026-03-01T09:00:00Z")]),
    { run: true, reason: "due" },
  );
  assert.deepEqual(
    judge([event(SCOUT_FAILED_EVENT, "2026-04-08T08:55:00Z")]),
    { run: false, reason: "backoff" },
    "five minutes after a refusal, with a ten-minute wait",
  );
  assert.deepEqual(
    judge([event(SCOUT_FAILED_EVENT, "2026-04-08T07:00:00Z")]),
    { run: true, reason: "never_run" },
    "past the wait it is asked again - a refusal is not a verdict",
  );
  const todaysFailures = Array.from({ length: SCOUT_MAX_ATTEMPTS_PER_DAY }, (_entry, index) =>
    event(SCOUT_FAILED_EVENT, `2026-04-08T0${index}:00:00Z`));
  assert.deepEqual(
    judge(todaysFailures),
    { run: false, reason: "attempts_exhausted" },
    "the cap is what keeps the failures from pushing the completed marker out of the window",
  );
  assert.deepEqual(
    judge(todaysFailures.map((entry) => ({ ...entry, at: entry.at.replace("04-08", "04-07") }))),
    { run: true, reason: "never_run" },
    "yesterday's failures do not hold today shut",
  );
});

test("a scout that could not answer is not asked again on the next minute", async () => {
  // It was: the "try again in ten minutes" mark lived in the tick's memory, and
  // the minutely cron gets a fresh one every time. Off by default, so this was
  // latent - and a licensee who turned exploration on would have paid for it.
  const llm = countingProvider(refusingProvider({ "scout.propose": "the model is not available" }));
  const runtime = testRuntime(memoryState(), "2026-04-01T00:30:00Z", {
    llm,
    config: {
      company: {
        ...BASE_CONFIG.company,
        exploration: { enabled: true, everyDays: 7, proposals: 1, lookbackDays: 30 },
      },
    },
  });
  const nowMs = runtime.services.clock.now();

  // A finished day, so the scout is allowed to run at all.
  await runTick(runtime, createTickMemory(), nowMs);
  const store = await runtime.services.stores.for(VENTURE);
  const cycle = (await store.cycles.all())[0]!;
  await store.cycles.put({ ...cycle, status: "completed", nextStep: undefined });

  await runTick(runtime, createTickMemory(), nowMs + 60_000, { cycles: false, dispatch: true });
  const asked = llm.count();

  await runTick(runtime, createTickMemory(), nowMs + 120_000, { cycles: false, dispatch: true });
  await runTick(runtime, createTickMemory(), nowMs + 180_000, { cycles: false, dispatch: true });
  assert.equal(llm.count(), asked, "the scout was asked again while its refusal was still fresh");

  const company = await runtime.services.stores.for("company");
  assert.equal(
    (await company.audit.recent(20)).filter((event) => event.type === SCOUT_FAILED_EVENT).length,
    1,
    "the refusal has to be recorded once, and once only, or it fills the window it is read from",
  );
});

test("a stop holds the day where it is - it does not close the gate", async () => {
  // 停止 covers two different operations and only one of them ends a day.
  // Deactivating an account is indefinite and deliberate, and closes the gate
  // that is open. A stop is an emergency meant to be undone in ten minutes,
  // and the tick already decided that a gate outlives one (see the comment
  // above `expireStaleGates` in this file): closing it would throw away the
  // day of somebody who stopped the platform to go and look at something.
  const state = memoryState();
  const runtime = testRuntime(state);
  await runTick(runtime, createTickMemory(), runtime.services.clock.now());

  const store = await runtime.services.stores.for(VENTURE);
  const open = await runtime.orchestrator.pendingDecisions();
  assert.equal(open.length, 1, "there has to be a gate for this test to be about anything");

  await applyPause({
    state,
    ventureId: VENTURE,
    reason: "調べたいことがある",
    by: "tester",
    at: runtime.services.clock.nowIso(),
  });
  await runTick(runtime, createTickMemory(), runtime.services.clock.now() + 3_600_000);

  assert.equal((await store.decisions.get(open[0]!.id))?.status, "pending", "the stop closed the gate");
  assert.equal((await store.cycles.all())[0]?.status, "awaiting_approval", "the stop ended the day");
});
