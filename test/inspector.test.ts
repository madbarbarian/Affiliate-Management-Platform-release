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

async function runToInspection(options: Parameters<typeof createTestCompany>[0] = {}) {
  const company = createTestCompany(options);
  const atProposal = unwrap(await company.orchestrator.runCycle("main"));
  const decision = (await company.store.decisions.get(atProposal.pendingDecisionId as string))!;
  const done = unwrap(
    await company.orchestrator.resolveGate(decision.id, {
      decidedBy: "tester",
      selectedIds: decision.items.slice(0, decision.selectionHint.max).map((item) => item.id),
      nowIso: company.clock.nowIso(),
    }),
  );
  return { company, reports: done.artifacts.inspect?.reports ?? [] };
}

async function inspectWith(review: Record<string, unknown>) {
  const { reports } = await runToInspection({ responses: { "inspect.review": (() => review) as never } });
  return reports;
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

/**
 * The inspector is the role that made the direct-link defect ship.
 *
 * It was handed the affiliate network's own destination URL while the writer
 * and the publisher were handed the platform's `/go/<code>` redirect, and it
 * replaces the whole body with its rewrite - so its URL is the one readers
 * got, and no click from a post body was ever counted. Which URL each role is
 * shown is asserted across the whole cycle in `tracked-link.test.ts`; this
 * covers the part that is specific to the rewrite.
 */
test("a rewrite that copies the offer link into the body still ships a counted link", async () => {
  // What a real model does with the "link to use" line is put that URL in the
  // post. The mock's stock rewrite never does, which is why this went
  // unnoticed; this one does, and both halves of the fix have to hold for it
  // to pass - the right URL in the prompt, and a guardrail behind it.
  const { company, reports } = await runToInspection({
    responses: {
      "inspect.review": ((request: { user: string }) => {
        const shown = /link to use: (\S+)/.exec(request.user)?.[1] ?? "";
        return {
          aiSmellScore: 60,
          revisedAiSmellScore: 20,
          findings: [],
          revised: {
            ...CLEAN_REWRITE,
            body: shown.startsWith("http") ? `${CLEAN_REWRITE.body}\n${shown}` : CLEAN_REWRITE.body,
          },
          unfixable: "",
        };
      }) as never,
    },
  });

  const links = await company.store.links.all();
  const linked = reports.filter((report) => report.revised.body.includes("http"));
  assert.ok(linked.length > 0, "at least one rewrite must have carried a URL");

  for (const report of linked) {
    const blocking = report.findings.filter((finding) => finding.severity === "blocking");
    assert.ok(report.passed, `blocked by ${blocking.map((finding) => finding.code).join(", ")}`);
    assert.ok(
      report.revised.body.includes("/go/"),
      `the published body has to carry the redirect, got: ${report.revised.body}`,
    );
    for (const link of links) {
      assert.equal(report.revised.body.includes(link.destinationUrl), false);
    }
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
