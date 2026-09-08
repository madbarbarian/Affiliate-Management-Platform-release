import test from "node:test";
import assert from "node:assert/strict";

import { checkComments, checkCompliance, detectAiSmell, passesPolicy, renderForChannel } from "../src/kernel/policy.ts";
import type { DraftContent, Offer, VoiceProfile } from "../src/core/types.ts";
import { testConfig, testProfile } from "./helpers.ts";

const config = testConfig();
const policy = config.policy;
const voice: VoiceProfile = config.ventures[0]!.voice;
const offer: Offer = config.offers[0]!;
const profile = testProfile(config, offer.id);
const profileNoOffer = testProfile(config);

function content(overrides: Partial<DraftContent> = {}): DraftContent {
  return {
    hook: "僕が3日で捨てたツールの話。",
    body: "結論から言うと、記録を取っていなかったのが原因でした。短い。ここで詰まった。それから二週間、毎朝十五分だけ記録を続けてようやく何が効いていたのか分かるようになりました。",
    cta: "同じところで詰まった人、どこで抜けましたか。",
    disclosure: "#PR",
    hashtags: [],
    ...overrides,
  };
}

test("a post with an offer and no disclosure is blocked", () => {
  const findings = checkCompliance({
    content: content({ disclosure: "" }),
    policy,
    voice,
    profile,
    offer,
    maxCharacters: 500,
  });
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0]?.code, "compliance.missing_disclosure");
  assert.equal(passesPolicy(findings, policy), false);
});

test("the same post without an offer needs no disclosure", () => {
  const findings = checkCompliance({
    content: content({ disclosure: "" }),
    policy,
    voice,
    profile: profileNoOffer,
    maxCharacters: 500,
  });
  assert.equal(findings.some((finding) => finding.code === "compliance.missing_disclosure"), false);
  assert.equal(passesPolicy(findings, policy), true);
});

test("a prohibited claim blocks whatever else the post does right", () => {
  const findings = checkCompliance({
    content: content({ body: "これをやれば必ず稼げるようになります。" }),
    policy,
    voice,
    profile,
    offer,
    maxCharacters: 500,
  });
  assert.ok(findings.some((finding) => finding.code === "compliance.prohibited_claim"));
  assert.equal(passesPolicy(findings, policy), false);
});

test("banned phrases warn but do not block", () => {
  const findings = checkCompliance({
    content: content({ cta: "いかがでしたか。" }),
    policy,
    voice,
    profile,
    offer,
    maxCharacters: 500,
  });
  const banned = findings.find((finding) => finding.code === "voice.banned_phrase");
  assert.equal(banned?.severity, "warn");
  assert.equal(passesPolicy(findings, policy), true);
});

test("an over-long single post is flagged, and a threaded one is not", () => {
  const long = content({ body: "あ".repeat(900) });
  const single = checkCompliance({ content: long, policy, voice, profile: profileNoOffer, maxCharacters: 500 });
  assert.ok(single.some((finding) => finding.code === "channel.too_long"));

  const threaded = checkCompliance({
    content: { ...long, threadParts: ["part one", "part two"] },
    policy,
    voice,
    profile: profileNoOffer,
    maxCharacters: 500,
  });
  assert.equal(threaded.some((finding) => finding.code === "channel.too_long"), false);
});

test("an empty hook is blocking - there is no post without a first line", () => {
  const findings = checkCompliance({ content: content({ hook: "  " }), policy, voice, profile: profileNoOffer, maxCharacters: 500 });
  assert.ok(findings.some((finding) => finding.code === "content.no_hook" && finding.severity === "blocking"));
});

test("writing with no first person scores as machine-written", () => {
  const impersonal = detectAiSmell(
    content({
      hook: "ツールの選定は重要です。",
      body: "多くの人が導入を検討しています。効果的な運用が求められます。適切な選択が必要です。",
    }),
    voice,
  );
  assert.ok(impersonal.score > 30, `expected a high score, got ${impersonal.score}`);
  assert.ok(impersonal.findings.some((finding) => finding.code === "voice.no_first_person"));
});

test("a first-person account with varied rhythm scores low", () => {
  const human = detectAiSmell(content(), voice);
  assert.ok(human.score < 30, `expected a low score, got ${human.score}: ${JSON.stringify(human.findings)}`);
});

test("stacked hedging is detected", () => {
  const hedged = detectAiSmell(
    content({
      body: "僕はこれが有効だと言えるでしょう。改善することができます。重要です。",
    }),
    voice,
  );
  assert.ok(hedged.findings.some((finding) => finding.code === "voice.hedged"));
});

test("empty superlatives are detected", () => {
  const puffed = detectAiSmell(content({ body: "僕にとって圧倒的な効果がありました。" }), voice);
  assert.ok(puffed.findings.some((finding) => finding.code === "voice.empty_superlative"));
});

test("rendering for a channel keeps every part a reader needs", () => {
  const rendered = renderForChannel(content({ hashtags: ["#副業"] }));
  assert.match(rendered, /僕が3日で捨てた/);
  assert.match(rendered, /#PR/);
  assert.match(rendered, /#副業/);
});

test("a disclosure the reader's market does not require is not a disclosure", () => {
  // The guardrail used to pass on any non-empty `disclosure` field, which made
  // the platform's headline claim - that the disclosure check is code, not a
  // prompt - untrue. A model writing "ad" for a Japanese audience satisfied it,
  // and both the writer and the inspector keep the model's wording verbatim, so
  // the required text could be missing from end to end.
  const findings = checkCompliance({
    content: content({ disclosure: "ad" }),
    policy,
    voice,
    profile,
    offer,
    maxCharacters: 500,
  });

  assert.ok(
    findings.some((finding) => finding.code === "compliance.missing_disclosure"),
    `"ad" is not "${profile.disclosureText}" and must be blocked`,
  );
});

test("the market's own wording, written into the body, is accepted", () => {
  const findings = checkCompliance({
    content: content({ disclosure: "", body: `本文です。\n\n${profile.disclosureText} を含みます` }),
    policy,
    voice,
    profile,
    offer,
    maxCharacters: 500,
  });

  assert.ok(
    !findings.some((finding) => finding.code === "compliance.missing_disclosure"),
    "a disclosure a reader will actually see counts, wherever in the text it sits",
  );
});

test("a comment carrying a prohibited claim is removed, not published", () => {
  // Comments used to skip every check in policy.ts, which made them the way
  // round all of them. A regulator does not care whether a claim is in the
  // post or in the reply underneath it.
  const claim = profile.prohibitedClaims[0]!;
  const result = checkComments({
    comments: [
      { id: "cmt_1", purpose: "self_reply", text: `補足です。${claim}` },
      { id: "cmt_2", purpose: "faq", text: "どこで詰まりましたか。" },
    ],
    profile,
    policy,
    hasOffer: true,
  });

  assert.deepEqual(result.comments.map((comment) => comment.id), ["cmt_2"]);
  assert.ok(result.findings.some((finding) => finding.severity === "blocking"));
});

test("a link drop without the market's disclosure gets it appended", () => {
  const result = checkComments({
    comments: [{ id: "cmt_1", purpose: "link_drop", text: "https://go.test.invalid/go/abc" }],
    profile,
    policy,
    hasOffer: true,
  });

  assert.equal(result.comments.length, 1);
  assert.ok(
    result.comments[0]!.text.includes(profile.disclosureText),
    "the affiliate link lives in this comment, so the notice has to be here too",
  );
});

test("comments on a post with no offer are left alone", () => {
  const result = checkComments({
    comments: [{ id: "cmt_1", purpose: "self_reply", text: "ただの補足です。" }],
    profile,
    policy,
    hasOffer: false,
  });

  assert.equal(result.comments[0]!.text, "ただの補足です。");
  assert.equal(result.findings.length, 0);
});

test("relaxing compliance blocking does not also publish what the inspector could not fix", () => {
  // `blockOnComplianceFindings: false` kept only `content.*` blockers, which
  // silently also switched off the AI-smell gate and `inspect.unfixable`.
  const relaxed = { ...policy, blockOnComplianceFindings: false };

  assert.equal(
    passesPolicy([{ severity: "blocking", code: "compliance.prohibited_claim", message: "x" }], relaxed),
    true,
    "compliance blocking is what the flag turns off",
  );
  assert.equal(
    passesPolicy([{ severity: "blocking", code: "voice.too_synthetic", message: "x" }], relaxed),
    false,
    "the AI-smell gate is not a compliance finding and must survive",
  );
  assert.equal(
    passesPolicy([{ severity: "blocking", code: "inspect.unfixable", message: "x" }], relaxed),
    false,
    "a draft the inspector said it could not fix must never publish",
  );
});

test("a threaded draft's body is scanned too, not scanned instead", () => {
  // `renderPlainText` substituted threadParts for body, so a prohibited claim
  // sitting in `body` produced zero findings while channels that publish the
  // whole content object still sent it.
  const claim = profile.prohibitedClaims[0]!;
  for (const [where, draft] of [
    ["body", content({ body: `これは ${claim} という話。`, threadParts: ["別のパート"] })],
    ["threadParts", content({ body: "ふつうの本文", threadParts: [`${claim} です`] })],
  ] as const) {
    const findings = checkCompliance({
      content: draft,
      policy,
      voice,
      profile,
      offer,
      maxCharacters: 500,
    });
    assert.ok(
      findings.some((finding) => finding.code === "compliance.prohibited_claim"),
      `a claim in ${where} must be caught`,
    );
  }
});
