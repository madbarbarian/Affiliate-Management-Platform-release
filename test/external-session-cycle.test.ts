/**
 * The whole day under `llm.provider: external-session`, including the cycle's
 * own `schedule` step, and what happens when the provider ends the run part-way.
 *
 * The publisher's comment call is `context.llm.completeJson` inside the
 * `schedule` step (`orchestrator.ts` `case "schedule"`), so it reaches the
 * provider like every other call, on the same serial slot, in the same run.
 * These tests use the real provider and a routine simulated by the mock
 * provider's demo answers, because a fake provider here would prove only that
 * the fake works.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { sequentialIds } from "../src/core/ids.ts";
import { silentLogger } from "../src/core/logger.ts";
import { fail } from "../src/core/result.ts";
import { isLiveJob, type ExternalSessionJob, type ExternalSessionJobStore, type ExternalSessionSlot } from "../src/kernel/external-session.ts";
import { FAILURE_SUMMARIES } from "../src/console/labels.ts";
import { createDemoHandlers } from "../src/llm/demo.ts";
import { EXTERNAL_SESSION_ERROR, createExternalSessionProvider } from "../src/llm/external-session.ts";
import { createMockProvider, type MockProvider } from "../src/llm/mock.ts";
import type { LlmJsonRequest } from "../src/llm/provider.ts";
import { advancingClock, createTestCompany, testConfig } from "./helpers.ts";

const START_ISO = "2026-09-30T00:00:00Z";
/** The routine answers at the first poll, so every call costs exactly one poll interval of the run's budget. */
const POLL_MS = 5_000;
const JOB_TIMEOUT_MS = 60_000;
/** Longer than the run's idle gap and shorter than the scheduler's 10-minute retry backoff. */
const RETRY_AFTER_MS = 10 * 60_000;
const UNLIMITED_BUDGET_MS = 24 * 3_600_000;
const FIRE_TIMEOUT_MS = 25;
const SCHEDULE_PURPOSE = "schedule.comments";
const WRITE_PURPOSE = "write.draft";
const INSPECT_PURPOSE = "inspect.review";
/** analyze, research and plan: one call each, at most, before the proposal gate. */
const CALLS_BEFORE_THE_GATE = 3;
const CYCLE_ID = "cyc_main_2026-04-02";

class MemoryJobStore implements ExternalSessionJobStore {
  job: ExternalSessionJob | undefined;
  async refresh(): Promise<void> {}
  read(): ExternalSessionSlot {
    return this.job ? { kind: "job", job: this.job } : { kind: "none" };
  }
  async write(job: ExternalSessionJob): Promise<void> {
    this.job = job;
  }
}

/**
 * A company whose model is the real external-session provider and whose
 * routine is the demo mock: on each fire it computes the answer the mock would
 * give for the call that is waiting, and writes it into the slot one poll later.
 *
 * `setBudget` changes the run budget between attempts (the provider reads it on
 * every call), and `failNext(purpose)` makes the next call with that purpose fail
 * with an ordinary, retryable error that does *not* end the run.
 */
function externalSessionCompany(invocationBudgetMs: number) {
  const inner = createMockProvider({ responses: createDemoHandlers() as never });
  const store = new MemoryJobStore();
  const base = advancingClock(START_ISO);
  let budgetMs = invocationBudgetMs;
  const flaky = new Set<string>();
  /** Purposes whose routine run never answers: the call ends in the provider's own `timeout`. */
  const silent = new Set<string>();
  /** Purpose -> which of its calls (1-based) finds a young job of another caller's in the slot. */
  const occupied = new Map<string, number>();
  const seen = new Map<string, number>();
  let waiting: LlmJsonRequest | undefined;
  let due: { atMs: number; value: unknown } | undefined;
  const clock = {
    ...base,
    sleep: async (ms: number) => {
      base.advance(ms);
      if (due && due.atMs <= base.now() && store.job && isLiveJob(store.job)) {
        store.job = { ...store.job, result: { receivedAt: base.nowIso(), value: due.value } };
        due = undefined;
      }
    },
  };
  const external = createExternalSessionProvider({
    store,
    clock,
    ids: sequentialIds(),
    logger: silentLogger,
    fetch: async () => {
      const answer = await inner.completeJson(waiting as LlmJsonRequest);
      assert.ok(answer.ok, "the demo routine answers everything the mock does");
      if (!silent.has((waiting as LlmJsonRequest).purpose)) due = { atMs: clock.now() + POLL_MS, value: answer.value };
      return new Response(JSON.stringify({ claude_code_session_id: "s-1", claude_code_session_url: "https://claude.ai/code/s-1" }), { status: 200 });
    },
    fireUrl: "https://api.anthropic.com/v1/claude_code/routines/r-1/fire",
    routineToken: "sk-ant-oat01-fake",
    jobTimeoutMs: JOB_TIMEOUT_MS,
    pollIntervalMs: POLL_MS,
    pollMaxIntervalMs: POLL_MS,
    get invocationBudgetMs() {
      return budgetMs;
    },
    fireTimeoutMs: FIRE_TIMEOUT_MS,
  });

  /** Every call the cycle *attempted*, including the ones the provider failed fast. */
  const calls: MockProvider["calls"] = [];
  const llm: MockProvider = {
    ...external,
    calls,
    async completeJson<T>(request: LlmJsonRequest) {
      calls.push({ purpose: request.purpose, system: request.system, user: request.user, schema: request.schema });
      waiting = request;
      const nth = (seen.get(request.purpose) ?? 0) + 1;
      seen.set(request.purpose, nth);
      if (occupied.get(request.purpose) === nth) {
        // A console approval, the run button or the scout put its own job in
        // the slot a moment ago and is still waiting on it.
        store.job = { id: "extjob_foreign", prompt: "another caller's question", schema: request.schema, createdAt: clock.nowIso() };
      }
      if (flaky.delete(request.purpose)) {
        return fail("llm", "test.one_item_failed", "The routine could not answer this one item.", { retryable: true });
      }
      return external.completeJson<T>(request);
    },
  };
  const config = testConfig({ company: { name: "Auto Co", operator: "auto", autonomy: "auto" } });
  const company = createTestCompany({ config, llm });
  return {
    company,
    llm,
    calls,
    clock,
    setBudget: (ms: number) => {
      budgetMs = ms;
    },
    failNext: (purpose: string) => {
      flaky.add(purpose);
    },
    neverAnswer: (purpose: string) => {
      silent.add(purpose);
    },
    occupySlotAt: (purpose: string, nth: number) => {
      occupied.set(purpose, nth);
    },
  };
}

const count = (calls: MockProvider["calls"], purpose: string) => calls.filter((call) => call.purpose === purpose).length;

/**
 * How a whole day is laid out in calls on this config, measured rather than
 * hard-coded: how many calls come before the first draft and before the first
 * inspection, and how many drafts there are.
 */
async function measuredDay() {
  const measured = externalSessionCompany(UNLIMITED_BUDGET_MS);
  await measured.company.orchestrator.runCycle("main");
  const purposes = measured.calls.map((call) => call.purpose);
  const drafts = count(measured.calls, WRITE_PURPOSE);
  assert.ok(drafts >= 2, "these tests need a day with at least two drafts, so that a run can end between them");
  return { callsBeforeWrite: purposes.indexOf(WRITE_PURPOSE), callsBeforeInspect: purposes.indexOf(INSPECT_PURPOSE), drafts };
}

test("a whole day completes under the external-session provider, the schedule step's comment calls included", async () => {
  const { company, calls } = externalSessionCompany(UNLIMITED_BUDGET_MS);

  const result = await company.orchestrator.runCycle("main");
  assert.ok(result.ok, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
  assert.equal(result.value.status, "completed");
  assert.ok(result.value.completed.some((record) => record.step === "schedule"), "the schedule step ran, not just the steps before it");

  const posts = await company.store.posts.find(() => true);
  assert.ok(posts.length > 0, "posts were queued");
  assert.ok(
    posts.every((post) => post.commentDrafts.length > 0),
    "each post carries the comments the routine wrote for it",
  );
  assert.ok(count(calls, SCHEDULE_PURPOSE) >= posts.length, "one comment call per post went through the provider");

  // Partial loss is never silent, and a clean day says so too.
  const noteOf = (step: string) => result.value.completed.find((record) => record.step === step)?.note ?? "";
  assert.match(noteOf("write"), /\(0 of \d+ failed\)/);
  assert.match(noteOf("inspect"), /\(0 of \d+ failed\)/);
});

test("a day makes at most 3 + 3C calls, C being what the day may publish: the number the run budget has to cover", async () => {
  const { company, calls } = externalSessionCompany(UNLIMITED_BUDGET_MS);
  const venture = company.config.ventures[0]!;
  await company.orchestrator.runCycle("main");

  // `orchestrator.ts` sizes the proposal gate, and so the drafts, by this.
  const capacity = Math.min(venture.cadence.postsPerDay, company.config.policy.maxPostsPerDay);
  assert.ok(count(calls, WRITE_PURPOSE) <= capacity, "at most one draft call per approved idea");
  assert.ok(count(calls, INSPECT_PURPOSE) <= capacity, "at most one inspection call per draft");
  assert.ok(count(calls, SCHEDULE_PURPOSE) <= capacity, "at most one comment call per post");
  assert.ok(calls.length <= CALLS_BEFORE_THE_GATE + 3 * capacity, "analyze, research and plan, then three calls per post");
});

test("a publisher call after the run budget is spent is a retryable Err, and the cycle resumes at schedule", async () => {
  // Measure how many calls come before the schedule step on this config, so
  // the budget below is spent exactly there without hard-coding a count.
  const measured = externalSessionCompany(UNLIMITED_BUDGET_MS);
  await measured.company.orchestrator.runCycle("main");
  const callsBeforeSchedule = measured.calls.filter((call) => call.purpose !== SCHEDULE_PURPOSE).length;

  const { company, calls, clock } = externalSessionCompany(callsBeforeSchedule * POLL_MS);
  const stopped = await company.orchestrator.runCycle("main");
  assert.equal(stopped.ok, false, "the day cannot finish inside a budget that was spent before schedule");
  if (stopped.ok) return;
  assert.equal(stopped.error.code, EXTERNAL_SESSION_ERROR.budgetExhausted);
  assert.equal(stopped.error.retryable, true, "the scheduler will resume it");

  const stored = await company.store.cycles.get(CYCLE_ID);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.failure?.step, "schedule");
  assert.equal(stored?.failure?.retryable, true);
  assert.ok(stored?.completed.some((record) => record.step === "inspect"), "the work before schedule is kept");
  assert.equal(count(calls, SCHEDULE_PURPOSE), 1, "the failed call was attempted once and nothing else was woken");
  assert.equal((await company.store.posts.find(() => true)).length, 0, "no post was queued without its comments");

  const draftCallsBefore = count(calls, WRITE_PURPOSE);
  clock.advance(RETRY_AFTER_MS);
  const resumed = await company.orchestrator.runCycle("main");
  assert.ok(resumed.ok, resumed.ok ? "" : `${resumed.error.code}: ${resumed.error.message}`);
  assert.equal(resumed.value.status, "completed");
  assert.equal(count(calls, WRITE_PURPOSE), draftCallsBefore, "the resumed run started at schedule, it did not write the day again");
  assert.ok((await company.store.posts.find(() => true)).length > 0);
});

test("a provider abort part-way through write stops the step retryably and the cycle resumes at write; the first attempt's drafts are left behind as orphans (the stated cost)", async () => {
  const { callsBeforeWrite, drafts } = await measuredDay();
  // Budget for the calls before write and exactly one draft: the second draft's call starts with the budget spent.
  const { company, calls, clock, setBudget } = externalSessionCompany((callsBeforeWrite + 1) * POLL_MS);

  const stopped = await company.orchestrator.runCycle("main");
  assert.equal(stopped.ok, false, "a day that would drop drafts must not complete");
  if (stopped.ok) return;
  assert.equal(stopped.error.code, EXTERNAL_SESSION_ERROR.budgetExhausted, "the provider's own code survives, so the console has words for it");
  assert.equal(stopped.error.retryable, true);
  assert.match(stopped.error.message, /^1 of \d+ drafts written/, "the message says how far the step got");

  const stored = await company.store.cycles.get(CYCLE_ID);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.failure?.step, "write");
  assert.equal(stored?.failure?.retryable, true);
  assert.equal(count(calls, WRITE_PURPOSE), 2, "the second draft was attempted and ended the step: no third call, no waiting on a spent budget");
  assert.equal((await company.store.drafts.find(() => true)).length, 1, "the first draft was persisted before the step failed");

  setBudget(UNLIMITED_BUDGET_MS);
  clock.advance(RETRY_AFTER_MS);
  const resumed = await company.orchestrator.runCycle("main");
  assert.ok(resumed.ok, resumed.ok ? "" : `${resumed.error.code}: ${resumed.error.message}`);
  assert.equal(resumed.value.status, "completed");
  assert.equal(resumed.value.artifacts.write?.draftIds.length, drafts, "the resumed step drafted every approved idea, not just the missing ones");

  // The cost, pinned so it cannot grow unnoticed: one persisted draft that no cycle refers to.
  const everyDraft = await company.store.drafts.find(() => true);
  assert.equal(everyDraft.length - drafts, 1, "the first attempt's draft is an orphan: stored, never scheduled");
  assert.ok((await company.store.posts.find(() => true)).length > 0);
});

test("a provider abort part-way through inspect stops the step retryably and the cycle resumes at inspect, re-inspecting safely", async () => {
  const { callsBeforeInspect, drafts } = await measuredDay();
  const { company, calls, clock, setBudget } = externalSessionCompany((callsBeforeInspect + 1) * POLL_MS);

  const stopped = await company.orchestrator.runCycle("main");
  assert.equal(stopped.ok, false, "a day that would leave drafts uninspected must not complete");
  if (stopped.ok) return;
  assert.equal(stopped.error.code, EXTERNAL_SESSION_ERROR.budgetExhausted);
  assert.equal(stopped.error.retryable, true);
  assert.match(stopped.error.message, /^1 of \d+ drafts inspected/);

  const stored = await company.store.cycles.get(CYCLE_ID);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.failure?.step, "inspect");
  assert.equal(count(calls, INSPECT_PURPOSE), 2, "the second inspection ended the step");

  setBudget(UNLIMITED_BUDGET_MS);
  clock.advance(RETRY_AFTER_MS);
  const resumed = await company.orchestrator.runCycle("main");
  assert.ok(resumed.ok, resumed.ok ? "" : `${resumed.error.code}: ${resumed.error.message}`);
  assert.equal(resumed.value.status, "completed");
  assert.equal(resumed.value.artifacts.inspect?.reports.length, drafts, "every draft has a report after the resume");

  // Safe: nothing is duplicated (no orphan drafts, one report per draft), and
  // the draft inspected before the abort was inspected again, which only moves
  // its revision on.
  const everyDraft = await company.store.drafts.find(() => true);
  assert.equal(everyDraft.length, drafts, "inspect writes no new drafts");
  assert.ok(everyDraft.some((draft) => draft.revision >= 3), "the draft inspected twice has its revision moved on twice");
  assert.ok((await company.store.posts.find(() => true)).length > 0);
});

test("a timeout ends write the same way a spent budget does: the step fails retryably with the provider's code and no later draft is attempted", async () => {
  const { company, calls, neverAnswer } = externalSessionCompany(UNLIMITED_BUDGET_MS);
  neverAnswer(WRITE_PURPOSE);

  const stopped = await company.orchestrator.runCycle("main");
  assert.equal(stopped.ok, false, "a hung routine must not let the day complete with its drafts dropped");
  if (stopped.ok) return;
  assert.equal(stopped.error.code, EXTERNAL_SESSION_ERROR.timeout);
  assert.equal(stopped.error.retryable, true);
  const stored = await company.store.cycles.get(CYCLE_ID);
  assert.equal(stored?.failure?.step, "write");
  assert.equal(count(calls, WRITE_PURPOSE), 1, "the first timeout latched the run: no second draft was attempted");
});

for (const [step, purpose, unit] of [
  ["write", WRITE_PURPOSE, "drafts written"],
  ["inspect", INSPECT_PURPOSE, "drafts inspected"],
] as const) {
  test(`a slot another caller holds part-way through ${step} stops the step retryably (busy), and the resumed cycle does the whole step instead of finishing short`, async () => {
    const { drafts } = await measuredDay();
    const { company, calls, clock, occupySlotAt } = externalSessionCompany(UNLIMITED_BUDGET_MS);
    occupySlotAt(purpose, 2);

    const stopped = await company.orchestrator.runCycle("main");
    assert.equal(stopped.ok, false, `a day that would skip ${step} items because the slot was busy must not complete`);
    if (stopped.ok) return;
    assert.equal(stopped.error.code, EXTERNAL_SESSION_ERROR.busy);
    assert.equal(stopped.error.retryable, true);
    assert.match(stopped.error.message, new RegExp(`^1 of \\d+ ${unit}`));
    const stored = await company.store.cycles.get(CYCLE_ID);
    assert.equal(stored?.failure?.step, step);
    assert.equal(count(calls, purpose), 2, "no later item was attempted against a slot someone else holds");

    // By the retry the other caller's job is past the job timeout: stale, discarded.
    clock.advance(RETRY_AFTER_MS);
    const resumed = await company.orchestrator.runCycle("main");
    assert.ok(resumed.ok, resumed.ok ? "" : `${resumed.error.code}: ${resumed.error.message}`);
    assert.equal(resumed.value.status, "completed");
    const done = step === "write" ? resumed.value.artifacts.write?.draftIds.length : resumed.value.artifacts.inspect?.reports.length;
    assert.equal(done, drafts, `every item went through ${step} after the resume`);
  });
}

test("a provider error that does not end the run still lets the other ideas through, and the write note says how many failed", async () => {
  const { company, failNext } = externalSessionCompany(UNLIMITED_BUDGET_MS);
  failNext(WRITE_PURPOSE);

  const result = await company.orchestrator.runCycle("main");
  assert.ok(result.ok, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
  assert.equal(result.value.status, "completed", "one idea failing does not cost the others their day");
  const note = result.value.completed.find((record) => record.step === "write")?.note ?? "";
  assert.match(note, /\(1 of \d+ failed\)/);
  assert.ok((await company.store.posts.find(() => true)).length > 0);
});

test("a provider error that does not end the run still lets the other drafts through, and the inspect note says how many failed", async () => {
  const { company, failNext } = externalSessionCompany(UNLIMITED_BUDGET_MS);
  failNext(INSPECT_PURPOSE);

  const result = await company.orchestrator.runCycle("main");
  assert.ok(result.ok, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
  const note = result.value.completed.find((record) => record.step === "inspect")?.note ?? "";
  assert.match(note, /\(1 of \d+ failed\)/);
  assert.ok((await company.store.posts.find(() => true)).length > 0, "the drafts that were inspected still went ahead");
});

test("every failure this provider can put on a cycle has words on the console, so none reaches an operator as its identifier", () => {
  for (const code of Object.values(EXTERNAL_SESSION_ERROR)) {
    assert.ok(FAILURE_SUMMARIES[code], `${code} has no words of its own`);
  }
});
