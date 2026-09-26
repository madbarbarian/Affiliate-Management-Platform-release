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

/**
 * The live defect: a model finding that describes the pre-rewrite draft,
 * shown next to a rewrite that had already fixed it. Verified live on the
 * deployed console - the published-bound body opened with a first-person line
 * twice, and the attached finding still said "わたし" never appears once.
 *
 * The schema now tells the model not to do this (`INSPECT_SCHEMA.findings`'s
 * description, and `prompts/inspector.system.md`'s "Findings" section), but a
 * prompt is not a guarantee - this test is about the deterministic guard in
 * `inspector.ts`: any finding whose `excerpt` cannot be found in the rewrite
 * is dropped before it reaches the operator's screen.
 */
test("a model finding whose excerpt only exists in the original draft is dropped", async () => {
  // The venture's configured first person is "僕" (test/helpers.ts's
  // BASE_CONFIG), which the rewrite below uses twice - matching the live
  // incident, where the published body opened with 「わたしは...」 twice. "僕"
  // rather than "わたし" is what actually was live, only so this rewrite also
  // satisfies the mechanical `detectAiSmell` check for the same voice; a
  // second, genuine "voice.no_first_person" finding from that heuristic would
  // otherwise share a code with the fabricated one and make the assertion
  // below meaningless.
  const revised = {
    ...CLEAN_REWRITE,
    hook: "僕はモバイルバッテリー3個持って行って、減ったのは1個だけだった。",
    body: "僕は家族4人で旅行に行った。荷物は多かったけど、バッテリーのおかげで助かった。",
  };
  const reports = await inspectWith({
    aiSmellScore: 70,
    revisedAiSmellScore: 10,
    findings: [
      {
        severity: "warn",
        code: "voice.no_first_person",
        message: "投稿全体に一人称が一度も出てこず、体験談ではなく説明文のように読める。",
        // This text is not in `revised` above - it describes a draft that no
        // longer exists after the rewrite added first person twice.
        excerpt: "このツールは誰にでもおすすめできる万能な解決策です。",
        suggestion: "フックと本文の少なくとも一箇所に一人称を戻す",
      },
    ],
    revised,
    unfixable: "",
  });
  assert.ok(reports.length > 0, "something must have been inspected");
  for (const report of reports) {
    assert.equal(
      report.findings.some((finding) => finding.code === "voice.no_first_person"),
      false,
      "a finding whose excerpt is absent from the rewrite must not reach the report",
    );
  }
});

test("a model finding whose excerpt genuinely is in the rewrite is kept", async () => {
  // The honest case, right next to the dishonest one above: a guard that
  // silently eats every model finding is worse than the bug it was built to
  // fix, so a finding that quotes real text still standing in the rewrite has
  // to survive.
  const revised = {
    ...CLEAN_REWRITE,
    body: "このツールは誰にでもおすすめできる万能な解決策です。",
  };
  const reports = await inspectWith({
    aiSmellScore: 70,
    revisedAiSmellScore: 10,
    findings: [
      {
        severity: "warn",
        code: "voice.superlative",
        message: "「万能な解決策」に具体的な数字が伴っていない。",
        excerpt: "このツールは誰にでもおすすめできる万能な解決策です。",
        suggestion: "具体的な数字か体験に置き換える",
      },
    ],
    revised,
    unfixable: "",
  });
  assert.ok(reports.length > 0, "something must have been inspected");
  for (const report of reports) {
    assert.ok(
      report.findings.some((finding) => finding.code === "voice.superlative"),
      "a finding whose excerpt genuinely is in the rewrite must not be dropped",
    );
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
