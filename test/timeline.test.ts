/**
 * The timeline, built from a day that really ran.
 *
 * Every source here comes out of the orchestrator rather than a fixture. The
 * whole claim of this screen is "this is what actually happened", and a fixture
 * would let it keep saying that on the day a role stops recording something.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTimeline, type Timeline } from "../src/console/timeline.ts";
import { unwrap } from "../src/core/result.ts";
import { createTestCompany, type TestCompany } from "./helpers.ts";
import type { Cycle, Decision } from "../src/core/types.ts";

/** Runs a day to the first gate, answers both, and reads the day back. */
async function ranADay(company: TestCompany, options: { approveAll?: boolean } = {}): Promise<Timeline> {
  const atProposal = unwrap(await company.orchestrator.runCycle("main"));
  const proposalId = atProposal.pendingDecisionId as string;
  const proposal = await company.store.decisions.get(proposalId);
  const picked = options.approveAll
    ? proposal!.items.map((item) => item.id)
    : proposal!.items.filter((item) => item.recommended).map((item) => item.id);

  const atPublish = unwrap(
    await company.orchestrator.resolveGate(proposalId, {
      decidedBy: "みどり",
      selectedIds: picked,
      nowIso: company.clock.nowIso(),
    }),
  );
  const publishId = atPublish.pendingDecisionId as string;
  const publishDecision = await company.store.decisions.get(publishId);
  const cycle = unwrap(
    await company.orchestrator.resolveGate(publishId, {
      decidedBy: "みどり",
      selectedIds: publishDecision!.items.map((item) => item.id),
      nowIso: company.clock.nowIso(),
    }),
  );

  const drafts = await company.store.drafts.find((draft) => draft.cycleId === cycle.id);
  return buildTimeline({
    cycle,
    ideas: await company.store.ideas.find((idea) => idea.cycleId === cycle.id),
    drafts,
    inspections: await company.store.inspections.forCycle(drafts.map((draft) => draft.id)),
    posts: await company.store.posts.find((post) => post.cycleId === cycle.id),
    decisions: await company.store.decisions.find((decision) => decision.cycleId === cycle.id),
  });
}

test("a finished day reads back as every step that ran, in the order it ran", async () => {
  const timeline = await ranADay(createTestCompany());

  const steps = timeline.entries.map((entry) => entry.step);
  assert.deepEqual(steps, [
    "analyze",
    "research",
    "plan",
    "proposal_approval",
    "write",
    "inspect",
    "schedule",
    "publish_approval",
    "dispatch",
  ]);

  // Ordered by when, not by the canonical list - a resumed day runs its
  // remaining steps later, and the reader wants what happened when.
  const times = timeline.entries.map((entry) => entry.startedAt);
  assert.deepEqual([...times].sort(), times);
});

test("why it proposed that is readable, which is the reason this screen exists", async () => {
  const timeline = await ranADay(createTestCompany());
  const plan = timeline.entries.find((entry) => entry.step === "plan");

  assert.ok(plan, "the planning step is in the day");
  assert.ok((plan.items?.length ?? 0) > 0, "the ideas themselves, not just a count");

  // Each idea carries the past data point it was argued from. Without this the
  // screen is a progress bar, and the operating promise - that a person can
  // audit why a post was proposed - is still unmet.
  const first = plan.items?.[0];
  assert.match(first?.detail ?? "", /根拠:/, "the rationale comes with the idea");
  assert.match(first?.title ?? "", /^1\. /, "ranked as the planner ranked them");
});

test("a gate shows everything that was offered, not only what was taken", async () => {
  // Two approved posts hide that eight were proposed, and "what was rejected"
  // is as much of why the day looks like this as what was kept.
  const company = createTestCompany();
  const timeline = await ranADay(company);
  const gate = timeline.entries.find((entry) => entry.step === "proposal_approval");

  assert.ok(gate);
  assert.equal(gate.byHuman, true, "a person decided this, and the screen says so");

  const items = gate.items ?? [];
  const chosen = items.filter((item) => item.chosen);
  assert.ok(items.length > chosen.length, "the ones not picked are still listed");
  assert.ok(chosen.length > 0);
  assert.match(gate.said.join(" "), /みどり/, "whose decision it was");
});

test("the inspection says what it refused and how machine-written it read", async () => {
  const timeline = await ranADay(createTestCompany());
  const inspect = timeline.entries.find((entry) => entry.step === "inspect");

  assert.ok(inspect);
  assert.match(inspect.said.join(" "), /AIっぽさ/);
  assert.ok((inspect.items?.length ?? 0) > 0);
});

test("money is never summed across currencies, here either", async () => {
  // A cross-border account earns in more than one, and the demo data does not -
  // so the two currencies are put in deliberately. Asserted against a day that
  // only ever had one, this test passes with the bug in, which is the whole
  // difference between a guard and a comment.
  const company = createTestCompany();
  const ran = unwrap(await company.orchestrator.runCycle("main"));
  const report = ran.artifacts.analyze!;
  const cycle = {
    ...ran,
    artifacts: {
      ...ran.artifacts,
      analyze: {
        ...report,
        revenue: {
          ...report.revenue,
          approved: [
            { currency: "JPY", amount: 4200 },
            { currency: "USD", amount: 31 },
          ],
        },
      },
    },
  };
  const timeline = buildTimeline({ cycle, ideas: [], drafts: [], inspections: [], posts: [], decisions: [] });
  const analyze = timeline.entries.find((entry) => entry.step === "analyze");
  assert.ok(analyze);

  const lines = analyze.said.filter((line) => line.includes("確定した報酬"));
  assert.equal(lines.length, 2, "one line each, never added together");
  assert.ok(lines.some((line) => line.includes("4200") && line.includes("JPY")));
  assert.ok(lines.some((line) => line.includes("31") && line.includes("USD")));
  // 4231 is the number this rule exists to keep off the screen.
  assert.ok(!analyze.said.some((line) => line.includes("4231")), "no combined total anywhere");
});

test("a day nobody answered says so, rather than looking half-run", async () => {
  const company = createTestCompany();
  const cycle = unwrap(await company.orchestrator.runCycle("main"));

  // The day lapses the way it does in production: the sweep expires it.
  company.clock.advance(2 * 86_400_000);
  await company.orchestrator.expireStaleGates();

  const after = (await company.store.cycles.get(cycle.id))!;
  const timeline = buildTimeline({
    cycle: after,
    ideas: await company.store.ideas.find((idea) => idea.cycleId === after.id),
    drafts: [],
    inspections: [],
    posts: [],
    decisions: await company.store.decisions.find((decision) => decision.cycleId === after.id),
  });

  const gate = timeline.entries.find((entry) => entry.step === "proposal_approval");
  // The gate never completed, so it is not among the steps that ran. What the
  // reader needs is the cycle's own state saying the day was cancelled.
  assert.equal(gate, undefined);
  assert.equal(timeline.status, "cancelled");
  assert.ok(timeline.entries.some((entry) => entry.step === "plan"), "the work it did do is still readable");
});

test("a gate the machine resolved is not reported as a person's decision", async () => {
  // Under `autonomy: auto` nobody opens the console, and this screen is the
  // record of who decided. Marking those as human is the one lie it must not
  // tell - an operator reading a day back would see their own name implied on
  // a day they never saw.
  const company = createTestCompany();
  const cycle = unwrap(await company.orchestrator.runCycle("main"));
  const decisions = await company.store.decisions.find((d) => d.cycleId === cycle.id);
  const auto = decisions.map((d) => ({ ...d, autoResolved: true }));

  const timeline = buildTimeline({
    cycle: { ...cycle, artifacts: { ...cycle.artifacts, proposal_approval: { decisionId: auto[0]!.id, approvedIdeaIds: [] } },
      completed: [...cycle.completed, { step: "proposal_approval", startedAt: cycle.createdAt, finishedAt: cycle.createdAt, durationMs: 0, note: "" }] },
    ideas: [], drafts: [], inspections: [], posts: [], decisions: auto,
  });

  const gate = timeline.entries.find((entry) => entry.step === "proposal_approval");
  assert.ok(gate);
  assert.equal(gate.byHuman, false, "the machine decided this one");
  assert.match(gate.said.join(" "), /自動/, "and the sentence says so");
});

test("the day read back says which of the two ways its gate ended", () => {
  // `expired` is the only status either can take, so the decision alone cannot
  // tell them apart. The cycle's failure code is what does.
  const decision: Decision = {
    id: "dec_1",
    cycleId: "cyc_main_2026-04-01",
    ventureId: "main",
    gate: "proposal_approval",
    createdAt: "2026-04-01T00:00:00Z",
    items: [{ id: "di_1", refId: "idea_1", title: "案", summary: "", recommended: true, detail: {} }],
    selectionHint: { min: 0, max: 2 },
    status: "expired",
    autoResolved: false,
  };
  const cycleWith = (failure?: Cycle["failure"]): Cycle => ({
    id: "cyc_main_2026-04-01",
    ventureId: "main",
    date: "2026-04-01",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    status: failure ? "failed" : "cancelled",
    completed: [
      {
        step: "proposal_approval",
        startedAt: "2026-04-01T00:00:00Z",
        finishedAt: "2026-04-01T00:00:00Z",
        durationMs: 0,
        note: "",
      },
    ],
    artifacts: { proposal_approval: { decisionId: "dec_1", approvedIdeaIds: [] } },
    ...(failure ? { failure } : {}),
  });
  const said = (failure?: Cycle["failure"]) =>
    buildTimeline({
      cycle: cycleWith(failure),
      ideas: [],
      drafts: [],
      inspections: [],
      posts: [],
      decisions: [decision],
    }).entries[0]?.said.join(" ") ?? "";

  assert.match(said(), /日付が変わり/, "a day nobody answered");
  assert.match(
    said({ step: "proposal_approval", message: "switched off", code: "venture.deactivated", retryable: false }),
    /アカウントを止めたので/,
    "and a day the operator ended",
  );
});
