import test from "node:test";
import assert from "node:assert/strict";

import { BASE_CONFIG, createTestCompany, DAY_MS, HOUR_MS, testConfig } from "./helpers.ts";
import { unwrap } from "../src/core/result.ts";

test("a cycle runs to the first gate and stops there", async () => {
  const company = createTestCompany();
  const cycle = unwrap(await company.orchestrator.runCycle("main"));

  assert.equal(cycle.status, "awaiting_approval");
  assert.equal(cycle.nextStep, "proposal_approval");
  assert.ok(cycle.pendingDecisionId, "a decision should be waiting");
  assert.deepEqual(
    cycle.completed.map((record) => record.step),
    ["analyze", "research", "plan"],
  );
  assert.ok((cycle.artifacts.plan?.ideas.length ?? 0) > 0, "the planner should have proposed something");
});

test("running twice does not start a second day or re-run completed steps", async () => {
  const company = createTestCompany();
  const first = unwrap(await company.orchestrator.runCycle("main"));
  const callsAfterFirst = company.llm.calls.length;

  const second = unwrap(await company.orchestrator.runCycle("main"));
  assert.equal(second.id, first.id);
  assert.equal(second.completed.length, first.completed.length);
  assert.equal(
    company.llm.calls.length,
    callsAfterFirst,
    "resuming at a gate must not re-run the roles that already finished",
  );
});

test("approving carries the cycle through to the publishing gate and then to done", async () => {
  const company = createTestCompany();
  const atProposal = unwrap(await company.orchestrator.runCycle("main"));
  const proposalId = atProposal.pendingDecisionId as string;

  const proposals = await company.store.decisions.get(proposalId);
  const recommended = proposals!.items.filter((item) => item.recommended).map((item) => item.id);
  assert.ok(recommended.length > 0, "the platform should recommend something");

  const atPublish = unwrap(
    await company.orchestrator.resolveGate(proposalId, {
      decidedBy: "tester",
      selectedIds: recommended,
      nowIso: company.clock.nowIso(),
    }),
  );
  assert.equal(atPublish.status, "awaiting_approval");
  assert.equal(atPublish.nextStep, "publish_approval");

  const publishId = atPublish.pendingDecisionId as string;
  const publishDecision = await company.store.decisions.get(publishId);
  const postItems = publishDecision!.items;
  assert.equal(postItems.length, recommended.length);

  const done = unwrap(
    await company.orchestrator.resolveGate(publishId, {
      decidedBy: "tester",
      selectedIds: postItems.map((item) => item.id),
      // Reverse the platform's proposed order - the operator's call.
      ordering: [...postItems].reverse().map((item) => item.id),
      nowIso: company.clock.nowIso(),
    }),
  );
  assert.equal(done.status, "completed");

  const posts = await company.store.posts.all();
  assert.equal(posts.length, postItems.length);
  const ordered = [...posts].sort((a, b) => a.order - b.order);
  assert.equal(ordered[0]?.id, postItems.at(-1)?.refId, "the operator's ordering must win");
});

test("rejecting the whole slate ends the day without writing anything", async () => {
  const company = createTestCompany();
  const cycle = unwrap(await company.orchestrator.runCycle("main"));

  const done = unwrap(
    await company.orchestrator.resolveGate(cycle.pendingDecisionId as string, {
      decidedBy: "tester",
      selectedIds: [],
      nowIso: company.clock.nowIso(),
    }),
  );
  assert.equal(done.status, "completed");
  assert.equal((await company.store.drafts.all()).length, 0);
  assert.equal((await company.store.posts.all()).length, 0);
});

test("posts the operator did not pick are cancelled, not left to leak out later", async () => {
  const company = createTestCompany();
  const atProposal = unwrap(await company.orchestrator.runCycle("main"));
  const proposals = await company.store.decisions.get(atProposal.pendingDecisionId as string);
  const chosen = proposals!.items.slice(0, 2).map((item) => item.id);

  const atPublish = unwrap(
    await company.orchestrator.resolveGate(atProposal.pendingDecisionId as string, {
      decidedBy: "tester",
      selectedIds: chosen,
      nowIso: company.clock.nowIso(),
    }),
  );

  const publishDecision = await company.store.decisions.get(atPublish.pendingDecisionId as string);
  const keep = publishDecision!.items[0]!;
  unwrap(
    await company.orchestrator.resolveGate(publishDecision!.id, {
      decidedBy: "tester",
      selectedIds: [keep.id],
      nowIso: company.clock.nowIso(),
    }),
  );

  const posts = await company.store.posts.all();
  const kept = posts.find((post) => post.id === keep.refId);
  const dropped = posts.filter((post) => post.id !== keep.refId);
  assert.notEqual(kept?.status, "cancelled");
  for (const post of dropped) assert.equal(post.status, "cancelled");
});

test("a venture posting once a day is never proposed an idea built on an untested pattern", async () => {
  // The first-week instructions promise this for `postsPerDay: 1`. The planner
  // used to size exploration by the shortlist (always >= 6), so the promise
  // did not hold and a one-post day could go to a gamble.
  const company = createTestCompany({
    config: testConfig({
      ventures: [
        {
          ...structuredClone(BASE_CONFIG.ventures[0]),
          cadence: { postsPerDay: 1, minMinutesBetweenPosts: 240, cycleStartsAt: "06:30", ideasPerCycle: 10 },
        },
      ],
    }),
  });
  const now = company.clock.nowIso();
  const base = {
    ventureId: "main",
    kind: "hook" as const,
    template: "{a}で{b}",
    whyItWorks: "test",
    createdAt: now,
    updatedAt: now,
  };
  await company.store.patterns.putMany([
    // More proven patterns than the shortlist holds; with fewer, candidates
    // fill the gap regardless of volume (see playbook.test.ts).
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({
      ...base,
      id: `pat_proven_${n}`,
      name: `実績あり${n}`,
      status: "active" as const,
      confidence: 0.8,
      evidence: [{ observedAt: now, source: "own_post" as const, refId: `post_${n}`, liftVsMedian: 1.8, note: "t" }],
    })),
    ...[1, 2, 3].map((n) => ({
      ...base,
      id: `pat_new_${n}`,
      name: `未検証${n}`,
      status: "candidate" as const,
      confidence: 0.5,
      evidence: [],
    })),
  ]);

  const atProposal = unwrap(await company.orchestrator.runCycle("main"));
  const ideas = atProposal.artifacts.plan?.ideas ?? [];
  assert.ok(ideas.length > 0);
  const gambles = ideas.filter((idea) => idea.patternId?.startsWith("pat_new_"));
  assert.deepEqual(gambles.map((idea) => idea.patternId), [], "no idea may cite an untested pattern");
});

test("auto autonomy runs the whole day without a human", async () => {
  const company = createTestCompany({
    config: testConfig({ company: { name: "Auto Co", operator: "auto", autonomy: "auto" } }),
  });
  const cycle = unwrap(await company.orchestrator.runCycle("main"));

  assert.equal(cycle.status, "completed");
  assert.deepEqual(
    cycle.completed.map((record) => record.step),
    ["analyze", "research", "plan", "proposal_approval", "write", "inspect", "schedule", "publish_approval", "dispatch"],
  );
  const decisions = await company.store.decisions.all();
  assert.ok(decisions.every((decision) => decision.autoResolved), "every gate should have resolved itself");
});

test("a draft that fails inspection never becomes a post", async () => {
  const company = createTestCompany({
    responses: {
      // An inspector that finds an unfixable blocking problem.
      "inspect.review": (() => ({
        aiSmellScore: 90,
        revisedAiSmellScore: 90,
        findings: [
          { severity: "blocking", code: "compliance.prohibited_claim", message: "必ず稼げる と書いてある", excerpt: "", suggestion: "" },
        ],
        revised: {
          hook: "これをやれば必ず稼げます",
          body: "必ず稼げる方法です",
          cta: "今すぐ",
          disclosure: "",
          hashtags: [],
          threadParts: [],
        },
        unfixable: "主張を裏づける事実がないため修正できません",
      })) as never,
    },
  });

  const atProposal = unwrap(await company.orchestrator.runCycle("main"));
  const done = unwrap(
    await company.orchestrator.resolveGate(atProposal.pendingDecisionId as string, {
      decidedBy: "tester",
      selectedIds: (await company.store.decisions.get(atProposal.pendingDecisionId as string))!.items
        .filter((item) => item.recommended)
        .map((item) => item.id),
      nowIso: company.clock.nowIso(),
    }),
  );

  assert.equal(done.status, "completed");
  assert.equal((await company.store.posts.all()).length, 0, "nothing may be scheduled");
  const reports = done.artifacts.inspect?.reports ?? [];
  assert.ok(reports.length > 0);
  assert.ok(reports.every((report) => !report.passed));
});

test("a failing step leaves the finished work in place and can be retried", async () => {
  let planCalls = 0;
  const company = createTestCompany({
    responses: {
      "plan.ideas": (() => {
        planCalls += 1;
        if (planCalls === 1) throw new Error("simulated planner outage");
        return { ideas: [] };
      }) as never,
    },
  });

  const failed = await company.orchestrator.runCycle("main");
  assert.equal(failed.ok, false);

  const stored = await company.store.cycles.get("cyc_main_2026-04-02");
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.failure?.step, "plan");
  assert.deepEqual(
    stored?.completed.map((record) => record.step),
    ["analyze", "research"],
    "the two steps that succeeded must not be lost",
  );

  // Retrying resumes at the failed step rather than starting the day again.
  await company.orchestrator.runCycle("main");
  assert.equal(planCalls, 2);
});

test("the loop closes: published posts feed metrics, which feed the playbook", async () => {
  const company = createTestCompany({
    config: testConfig({ company: { name: "Auto Co", operator: "auto", autonomy: "auto" } }),
  });

  // Day one, start to finish.
  const dayOne = unwrap(await company.orchestrator.runCycle("main"));
  assert.equal(dayOne.status, "completed");
  const scheduled = await company.store.posts.find((post) => post.status === "scheduled");
  assert.ok(scheduled.length > 0, "the mock channel schedules natively");

  const patternsBefore = await company.store.patterns.all();
  assert.ok(patternsBefore.length > 0, "research should have filled the playbook");
  assert.ok(
    patternsBefore.every((pattern) => pattern.evidence.every((entry) => entry.source === "swipe")),
    "before publishing, the only evidence is from other people's posts",
  );

  // Move past every slot, then let the scheduler notice they went live.
  const latest = Math.max(...scheduled.map((post) => post.scheduledFor));
  company.clock.set(new Date(latest + 6 * HOUR_MS).toISOString());
  const dispatched = unwrap(await company.orchestrator.dispatchDue(company.clock.now()));
  assert.equal(dispatched.published.length, scheduled.length);

  const published = await company.store.posts.find((post) => post.status === "published");
  assert.equal(published.length, scheduled.length);
  assert.ok(published.every((post) => post.publishedAt), "a published post must know when it went live");

  // Day two: the analyst reads the numbers and attaches them to the patterns.
  company.clock.set(new Date(latest + DAY_MS).toISOString());
  const dayTwo = unwrap(await company.orchestrator.runCycle("main"));
  assert.notEqual(dayTwo.id, dayOne.id, "a new local day is a new cycle");

  const metrics = await company.store.metrics.all();
  assert.ok(metrics.length > 0, "metrics should have been captured");

  const patternsAfter = await company.store.patterns.all();
  const ownEvidence = patternsAfter.flatMap((pattern) =>
    pattern.evidence.filter((entry) => entry.source === "own_post"),
  );
  assert.ok(ownEvidence.length > 0, "the playbook must learn from the account's own posts");
  assert.ok(
    dayTwo.artifacts.analyze !== undefined && dayTwo.artifacts.analyze.examinedPosts > 0,
    "the analysis step should have examined the published posts",
  );
});

test("revenue is attributed back to the post that earned it", async () => {
  const company = createTestCompany({
    config: testConfig({ company: { name: "Auto Co", operator: "auto", autonomy: "auto" } }),
  });

  unwrap(await company.orchestrator.runCycle("main"));
  const scheduled = await company.store.posts.find((post) => post.status === "scheduled");
  const latest = Math.max(...scheduled.map((post) => post.scheduledFor));

  company.clock.set(new Date(latest + HOUR_MS).toISOString());
  unwrap(await company.orchestrator.dispatchDue(company.clock.now()));

  // The mock network converts every issued link at the rate set in test config.
  company.clock.set(new Date(latest + DAY_MS).toISOString());
  unwrap(await company.orchestrator.runCycle("main"));

  const conversions = await company.store.conversions.all();
  assert.ok(conversions.length > 0, "conversions should have been imported");

  const links = await company.store.links.all();
  const withPost = links.filter((link) => link.postId !== undefined);
  assert.ok(withPost.length > 0, "issued links must be bound to their post");
  for (const conversion of conversions) {
    assert.ok(
      links.some((link) => link.id === conversion.linkId),
      "every stored conversion must point at a link we issued",
    );
  }
});

test("an unknown or inactive venture is refused with a clear reason", async () => {
  const company = createTestCompany();
  const unknown = await company.orchestrator.runCycle("nope");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "cycle.unknown_venture");

  const inactive = createTestCompany({
    config: testConfig({
      ventures: [{ ...JSON.parse(JSON.stringify(testConfig().ventures[0])), active: false }],
    }),
  });
  const result = await inactive.orchestrator.runCycle("main");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "cycle.venture_inactive");
});
