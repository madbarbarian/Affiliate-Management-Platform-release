/**
 * The inspection verdict.
 *
 * The "worse of two scores" rule is the guardrail that decides whether a post
 * still reads as machine-written after the rewrite. It has to compare two
 * scores of the *same* text. It used to take the model's score of the ORIGINAL
 * draft - which the prompt tells it should land at 40-70 - and hold that
 * against a limit of 35, so an honest model blocked nearly every draft and the
 * rewrite could never rescue one. The mock's fixed 22 hid it from every test.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { unwrap } from "../src/core/result.ts";
import { createTestCompany } from "./helpers.ts";

const CLEAN_REWRITE = {
  hook: "僕が3日で捨てたツールの話。",
  body: "去年、作業を速くしたくて入れた。結果、通知が増えただけだった。3日で消した。今は紙のメモに戻っている。",
  cta: "同じ経験、ある？",
  disclosure: "#PR",
  hashtags: [],
  threadParts: [],
};

async function inspectWith(review: Record<string, unknown>) {
  const company = createTestCompany({
    responses: { "inspect.review": (() => review) as never },
  });
  const atProposal = unwrap(await company.orchestrator.runCycle("main"));
  const decision = (await company.store.decisions.get(atProposal.pendingDecisionId as string))!;
  const done = unwrap(
    await company.orchestrator.resolveGate(decision.id, {
      decidedBy: "tester",
      selectedIds: decision.items.slice(0, decision.selectionHint.max).map((item) => item.id),
      nowIso: company.clock.nowIso(),
    }),
  );
  return done.artifacts.inspect?.reports ?? [];
}

test("a synthetic first draft that the rewrite fixed passes on the rewrite's score", async () => {
  // Original 70 (over the test limit of 60), rewrite 10, and a rewrite the
  // heuristic also reads as human. The draft must pass: the whole point of the
  // rewrite is that it can rescue a post.
  const reports = await inspectWith({
    aiSmellScore: 70,
    revisedAiSmellScore: 10,
    findings: [],
    revised: CLEAN_REWRITE,
    unfixable: "",
  });
  assert.ok(reports.length > 0, "something must have been inspected");
  for (const report of reports) {
    assert.ok(
      report.passed,
      `the rewrite scored 10 and must pass; blocked with ${report.aiSmellScore}: ${report.findings
        .filter((finding) => finding.severity === "blocking")
        .map((finding) => finding.code)
        .join(", ")}`,
    );
    assert.ok(report.aiSmellScore <= 60, `the recorded score is the rewrite's, got ${report.aiSmellScore}`);
  }
});

test("a rewrite the model itself still scores as machine-written is blocked", async () => {
  // The model's vote on its own rewrite still counts, even when the heuristic
  // is fooled. A model that admits it could not get the machine out has to be
  // believed.
  const reports = await inspectWith({
    aiSmellScore: 70,
    revisedAiSmellScore: 80,
    findings: [],
    revised: CLEAN_REWRITE,
    unfixable: "",
  });
  assert.ok(reports.length > 0);
  for (const report of reports) {
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((finding) => finding.code === "voice.too_synthetic"));
  }
});
