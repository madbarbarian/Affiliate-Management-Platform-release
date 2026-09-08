import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SCORING,
  nextStatus,
  rescorePatterns,
  scorePattern,
  selectForPlanning,
  withEvidence,
} from "../src/playbook/playbook.ts";
import type { Pattern, PatternEvidence, PatternStatus } from "../src/core/types.ts";

const NOW = Date.parse("2026-04-01T00:00:00Z");
const DAY = 86_400_000;

function pattern(overrides: Partial<Pattern> = {}): Pattern {
  return {
    id: "pat_1",
    ventureId: "main",
    name: "テスト型",
    kind: "hook",
    template: "{a}で{b}",
    whyItWorks: "because",
    evidence: [],
    confidence: 0.5,
    status: "candidate",
    createdAt: new Date(NOW - 10 * DAY).toISOString(),
    updatedAt: new Date(NOW - 10 * DAY).toISOString(),
    ...overrides,
  };
}

function evidence(lift: number, daysAgo: number, refId = `ref_${lift}_${daysAgo}`): PatternEvidence {
  return {
    observedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    source: "own_post",
    refId,
    liftVsMedian: lift,
    note: "test",
  };
}

test("an operation posting once or twice a day is offered no untested patterns, whatever the shortlist size", () => {
  // The shortlist is always six or more (sized by ideas, not posts), so a rule
  // keyed on its length never switched exploration off. The publishing volume
  // is what decides whether there is a spare slot to gamble with.
  //
  // Enough proven patterns to fill the shortlist: when there are not, the
  // remainder is filled with candidates whatever the volume, because a
  // playbook with nothing proven yet has nothing else to offer.
  const proven = [1, 2, 3, 4, 5, 6, 7].map((n) =>
    pattern({ id: `pat_proven_${n}`, status: "active", evidence: [evidence(1.8, n), evidence(1.7, n + 3)] }),
  );
  const untested = [1, 2, 3].map((n) => pattern({ id: `pat_new_${n}`, status: "candidate" }));

  const oneADay = selectForPlanning([...proven, ...untested], 6, NOW, DEFAULT_SCORING, 1);
  assert.deepEqual(
    oneADay.filter((entry) => entry.status === "candidate"),
    [],
    "with one post a day, no idea may rest on an untested pattern",
  );
  assert.equal(oneADay.length, 6, "the shortlist is still full - of proven patterns");

  const threeADay = selectForPlanning([...proven, ...untested], 6, NOW, DEFAULT_SCORING, 3);
  assert.ok(
    threeADay.some((entry) => entry.status === "candidate"),
    "with room to spare, exploration comes back",
  );
});

test("no evidence means 'we do not know', not 'this is bad'", () => {
  const score = scorePattern(pattern(), NOW);
  assert.equal(score.confidence, 0.5);
  assert.equal(score.support, 0);
});

test("one strong observation is not treated as proof", () => {
  const score = scorePattern(pattern({ evidence: [evidence(2.5, 0)] }), NOW);
  assert.ok(score.confidence > 0.5, "should lean positive");
  assert.ok(score.confidence < 0.7, `one data point should stay uncertain, got ${score.confidence}`);
});

test("repeated strong observations build real confidence", () => {
  const strong = pattern({
    evidence: [evidence(2.0, 0), evidence(1.9, 1), evidence(2.2, 2), evidence(1.8, 3), evidence(2.1, 4)],
  });
  const score = scorePattern(strong, NOW);
  assert.ok(score.confidence > 0.8, `expected high confidence, got ${score.confidence}`);
  assert.ok(score.support > 4);
});

test("old evidence decays, so a pattern that stopped working loses its claim", () => {
  const fresh = scorePattern(pattern({ evidence: [evidence(2.0, 0), evidence(2.0, 1)] }), NOW);
  const stale = scorePattern(pattern({ evidence: [evidence(2.0, 90), evidence(2.0, 91)] }), NOW);
  assert.ok(stale.support < fresh.support / 4, "90-day-old evidence should barely count");
  assert.ok(stale.confidence < fresh.confidence);
});

test("promotion needs less evidence than retirement", () => {
  const weakNegative = { confidence: 0.2, support: 2, weightedLift: 0.5 };
  assert.equal(nextStatus("candidate", weakNegative, DEFAULT_SCORING), "candidate", "2 bad posts is not enough to retire");

  const strongNegative = { confidence: 0.2, support: 4, weightedLift: 0.5 };
  assert.equal(nextStatus("candidate", strongNegative, DEFAULT_SCORING), "retired");

  const positive = { confidence: 0.8, support: 2, weightedLift: 1.8 };
  assert.equal(nextStatus("candidate", positive, DEFAULT_SCORING), "active");
});

test("a retired pattern only comes back on stronger evidence than it took to promote", () => {
  const justEnoughToPromote = { confidence: 0.9, support: 2, weightedLift: 2 };
  assert.equal(nextStatus("retired", justEnoughToPromote, DEFAULT_SCORING), "retired");

  const more = { confidence: 0.9, support: 3, weightedLift: 2 };
  assert.equal(nextStatus("retired", more, DEFAULT_SCORING), "active");
});

test("rescoring reports which patterns changed status", () => {
  const winner = pattern({
    id: "pat_win",
    evidence: [evidence(2.0, 0, "a"), evidence(2.2, 1, "b"), evidence(1.9, 2, "c")],
  });
  const loser = pattern({
    id: "pat_lose",
    status: "active",
    evidence: [evidence(0.3, 0, "d"), evidence(0.2, 1, "e"), evidence(0.4, 2, "f"), evidence(0.3, 3, "g")],
  });

  const result = rescorePatterns([winner, loser], NOW);
  assert.deepEqual(result.promoted, ["pat_win"]);
  assert.deepEqual(result.retired, ["pat_lose"]);
  const updated = new Map(result.patterns.map((entry) => [entry.id, entry.status as PatternStatus]));
  assert.equal(updated.get("pat_win"), "active");
  assert.equal(updated.get("pat_lose"), "retired");
});

test("planning never sees retired patterns and always keeps room to explore", () => {
  const proven = Array.from({ length: 8 }, (_unused, index) =>
    pattern({
      id: `pat_active_${index}`,
      status: "active",
      evidence: [evidence(2, 0, `x${index}`), evidence(2, 1, `y${index}`), evidence(2, 2, `z${index}`)],
    }),
  );
  const untested = pattern({ id: "pat_new", status: "candidate" });
  const dead = pattern({ id: "pat_dead", status: "retired" });

  const selected = selectForPlanning([...proven, untested, dead], 6, NOW);
  assert.equal(selected.length, 6);
  assert.ok(!selected.some((entry) => entry.id === "pat_dead"), "retired patterns must not be planned with");
  assert.ok(selected.some((entry) => entry.id === "pat_new"), "an untested candidate must get a slot");
});

test("evidence for the same source is not counted twice", () => {
  const once = withEvidence(pattern(), evidence(2, 0, "same"), NOW);
  const twice = withEvidence(once, evidence(2, 0, "same"), NOW);
  assert.equal(twice.evidence.length, 1);
});

test("evidence is capped so a long-lived pattern does not grow without bound", () => {
  let subject = pattern();
  for (let index = 0; index < 60; index += 1) {
    subject = withEvidence(subject, evidence(1.5, index, `ref_${index}`), NOW, 40);
  }
  assert.equal(subject.evidence.length, 40);
  // The retained window should be the most recent observations.
  assert.equal(subject.evidence[0]?.refId, "ref_0");
});

test("exploration never takes the only slot", () => {
  // At one post a day the old reserve took the whole slate, so an operation
  // running at low volume - which is how a careful one starts - would have
  // tested untried patterns every single day and proven nothing.
  const chosen = selectForPlanning(
    [
      pattern({ id: "proven", status: "active", confidence: 0.8 }),
      pattern({ id: "untried", status: "candidate" }),
    ],
    1,
    NOW,
  );

  assert.equal(chosen.length, 1);
  assert.equal(chosen[0]?.id, "proven", "the single slot must go to what is known to work");
});

test("exploration still gets a slot once there is room for one", () => {
  const chosen = selectForPlanning(
    [
      pattern({ id: "proven-a", status: "active", confidence: 0.8 }),
      pattern({ id: "proven-b", status: "active", confidence: 0.7 }),
      pattern({ id: "proven-c", status: "active", confidence: 0.6 }),
      pattern({ id: "untried", status: "candidate" }),
    ],
    4,
    NOW,
  );

  assert.ok(
    chosen.some((entry) => entry.id === "untried"),
    "with four slots the playbook must still be trying something new",
  );
});
