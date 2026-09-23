import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { checkComments, checkCompliance, detectAiSmell, passesPolicy, renderForChannel } from "../src/kernel/policy.ts";
import type { LinkContext } from "../src/kernel/policy.ts";
import { repoRoot } from "../src/config/load.ts";
import type { DraftContent, Offer, TrackedLink, VoiceProfile } from "../src/core/types.ts";
import { testConfig, testProfile } from "./helpers.ts";

const config = testConfig();
const policy = config.policy;
const voice: VoiceProfile = config.ventures[0]!.voice;
const offer: Offer = config.offers[0]!;
const profile = testProfile(config, offer.id);
const profileNoOffer = testProfile(config);

/**
 * The URL in a post body was the network's own destination, never the
 * platform's `/go/<code>` redirect, from the first commit until `policy.ts`
 * learned to look. Three call sites each chose which URL to render and the
 * inspector chose the destination; because the inspector rewrites the whole
 * body, its choice is the one that shipped. Clicks from a post body were
 * therefore never counted, and nothing checked a URL at all.
 */
const issuedLink: TrackedLink = {
  id: "lnk_abc1234567",
  ventureId: "main",
  offerId: offer.id,
  code: "abc1234567",
  destinationUrl: "https://example.com/lp?subid=abc1234567&utm_source=test&amp=abc1234567",
  createdAt: "2026-04-01T00:00:00.000Z",
};
const linkContext: LinkContext = { issued: issuedLink, tracking: config.tracking };
/** What a post with no offer hands over, and what a lost link record looks like. */
const noLink: LinkContext = { issued: undefined, tracking: config.tracking };
const trackedUrl = "https://go.test.invalid/go/abc1234567";

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
    link: linkContext,
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
    link: noLink,
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
    link: linkContext,
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
    link: linkContext,
    maxCharacters: 500,
  });
  const banned = findings.find((finding) => finding.code === "voice.banned_phrase");
  assert.equal(banned?.severity, "warn");
  assert.equal(passesPolicy(findings, policy), true);
});

test("an over-long single post is flagged, and a threaded one is not", () => {
  const long = content({ body: "あ".repeat(900) });
  const single = checkCompliance({ content: long, policy, voice, profile: profileNoOffer, link: noLink, maxCharacters: 500 });
  assert.ok(single.some((finding) => finding.code === "channel.too_long"));

  const threaded = checkCompliance({
    content: { ...long, threadParts: ["part one", "part two"] },
    policy,
    voice,
    profile: profileNoOffer,
    link: noLink,
    maxCharacters: 500,
  });
  assert.equal(threaded.some((finding) => finding.code === "channel.too_long"), false);
});

test("an empty hook is blocking - there is no post without a first line", () => {
  const findings = checkCompliance({ content: content({ hook: "  " }), policy, voice, profile: profileNoOffer, link: noLink, maxCharacters: 500 });
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
    link: linkContext,
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
    link: linkContext,
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
    link: linkContext,
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
    link: linkContext,
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
    link: noLink,
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
      link: linkContext,
      maxCharacters: 500,
    });
    assert.ok(
      findings.some((finding) => finding.code === "compliance.prohibited_claim"),
      `a claim in ${where} must be caught`,
    );
  }
});

// ---------------------------------------------------------------------------
// The tracked link
// ---------------------------------------------------------------------------

function linkFindings(body: string, link: LinkContext = linkContext) {
  return checkCompliance({
    content: content({ body }),
    policy,
    voice,
    profile,
    offer,
    link,
    maxCharacters: 2000,
  });
}

test("a post body carrying the network's own URL instead of /go/ is blocked", () => {
  const findings = linkFindings(`使ったのはこれです。\n${issuedLink.destinationUrl}`);
  const blocking = findings.filter((finding) => finding.severity === "blocking");

  assert.deepEqual(blocking.map((finding) => finding.code), ["affiliate.direct_link"]);
  assert.equal(passesPolicy(findings, policy), false);
  assert.ok(
    blocking[0]!.message.includes(trackedUrl),
    `the finding has to name the URL that belongs there, got: ${blocking[0]!.message}`,
  );
});

test("the destination URL stripped of its query string is still a direct link", () => {
  // A model copying a long URL out of a prompt loses the tail far more often
  // than it mistypes the host, and what is left still bypasses the redirect.
  for (const written of ["https://example.com/lp", "https://example.com/lp/"]) {
    const findings = linkFindings(`詳しくは ${written} を見てください。`);
    assert.ok(
      findings.some((finding) => finding.code === "affiliate.direct_link"),
      `"${written}" reaches the merchant without passing the redirect`,
    );
  }
});

test("the tracked short link is what the guardrail wants to see", () => {
  const findings = linkFindings(`使ったのはこれです。\n${trackedUrl}`);
  assert.equal(findings.some((finding) => finding.code.startsWith("affiliate.")), false);
  assert.equal(passesPolicy(findings, policy), true);
});

test("a post that mentions some other URL is left alone", () => {
  // A guard that blocks honest content is worse than no guard. None of these
  // sends a reader to the offer's own landing page.
  for (const written of [
    "https://example.org/news/2026",
    "https://example.com/lp-other",
    "https://example.com/lp/deeper/page",
    "https://docs.example.com/lp",
  ]) {
    const findings = linkFindings(`参考にした記事です。${written}\n${trackedUrl}`);
    assert.equal(
      findings.some((finding) => finding.code === "affiliate.direct_link"),
      false,
      `"${written}" is a different page and must not be blocked`,
    );
  }
});

test("an http, www or upper-case spelling of the destination is the same link", () => {
  // Measured against what a model actually produces. Percent-encoding, a URL
  // split over a newline and third-party shorteners are deliberately out of
  // scope - see `directLinkCandidates`.
  for (const written of [
    "http://example.com/lp?subid=abc1234567&utm_source=test&amp=abc1234567",
    "https://www.example.com/lp",
    "http://WWW.Example.COM/lp",
    "https://EXAMPLE.com/lp",
  ]) {
    const findings = linkFindings(`詳しくは ${written} を見てください。`);
    assert.ok(
      findings.some((finding) => finding.code === "affiliate.direct_link"),
      `"${written}" opens the merchant's own page and must be caught`,
    );
  }
});

test("a post with an offer and no link at all is blocked, not waved through", () => {
  // Fail closed on the OFFER, not on the link. Keying this on the link meant
  // a draft that carried an offer and no link id got no URL check at all -
  // and the per-offer `direct` mode still awaiting a decision is exactly the
  // change that would stop issuing one.
  const findings = linkFindings("ふつうの本文です。", noLink);
  assert.ok(
    findings.some((finding) => finding.code === "affiliate.link_unresolved"),
    `expected a fail-closed block, got ${findings.map((finding) => finding.code).join(", ")}`,
  );
  assert.equal(passesPolicy(findings, policy), false);
});

test("a post with no offer and no link is not blocked for lacking one", () => {
  const findings = checkCompliance({
    content: content(),
    policy,
    voice,
    profile: profileNoOffer,
    link: noLink,
    maxCharacters: 2000,
  });
  assert.equal(findings.some((finding) => finding.code.startsWith("affiliate.")), false);
  assert.equal(passesPolicy(findings, policy), true);
});

test("relaxing compliance blocking does not also switch off the tracked-link guard", () => {
  // `blockOnComplianceFindings: false` relaxes what a market's regulator
  // demands of the copy. The platform's own click accounting is not that.
  const relaxed = { ...policy, blockOnComplianceFindings: false };
  const findings = linkFindings(`使ったのはこれです。\n${issuedLink.destinationUrl}`);
  assert.equal(passesPolicy(findings, relaxed), false);
});

test("a comment linking straight to the merchant is repaired, not thrown away", () => {
  // Removing it was the first answer and it was wrong. The publisher appends
  // the tracked URL to the link drop immediately before this runs, so dropping
  // the comment threw that away too: a post with an offer, a link id and no
  // URL anywhere, indistinguishable from a normal post and earning nothing.
  const result = checkComments({
    comments: [
      { id: "cmt_1", purpose: "link_drop", text: `${issuedLink.destinationUrl}\n\n#PR` },
      { id: "cmt_2", purpose: "faq", text: "どこで詰まりましたか。" },
    ],
    profile,
    policy,
    hasOffer: true,
    link: linkContext,
  });

  assert.deepEqual(result.comments.map((comment) => comment.id), ["cmt_1", "cmt_2"]);
  const drop = result.comments[0]!;
  assert.ok(drop.text.includes(trackedUrl), `the link drop must still carry a link, got: ${drop.text}`);
  assert.equal(
    drop.text.includes("example.com"),
    false,
    "the merchant's own URL must be gone, not sitting next to the tracked one",
  );
  assert.ok(result.findings.some((finding) => finding.code === "affiliate.comment_direct_link_repaired"));
  assert.equal(
    result.findings.some((finding) => finding.severity === "blocking"),
    false,
    "nothing was blocked, and the publisher logs a blocking comment finding as a refusal",
  );
});

test("a repaired comment keeps the words around the link", () => {
  const result = checkComments({
    comments: [
      {
        id: "cmt_1",
        purpose: "link_drop",
        text: `使ったのはこれです → https://www.example.com/lp です。\n\n#PR`,
      },
    ],
    profile,
    policy,
    hasOffer: true,
    link: linkContext,
  });

  assert.equal(result.comments[0]!.text, `使ったのはこれです → ${trackedUrl} です。\n\n#PR`);
});

test("a comment with no offer link and no offer is untouched", () => {
  const result = checkComments({
    comments: [{ id: "cmt_1", purpose: "self_reply", text: "https://example.org/news を読みました。" }],
    profile: profileNoOffer,
    policy,
    hasOffer: false,
    link: noLink,
  });

  assert.equal(result.comments[0]!.text, "https://example.org/news を読みました。");
  assert.equal(result.findings.length, 0);
});

test("a link drop carrying the tracked short link is kept", () => {
  const result = checkComments({
    comments: [{ id: "cmt_1", purpose: "link_drop", text: `${trackedUrl}\n\n#PR` }],
    profile,
    policy,
    hasOffer: true,
    link: linkContext,
  });

  assert.deepEqual(result.comments.map((comment) => comment.id), ["cmt_1"]);
  assert.equal(result.findings.length, 0);
});

/**
 * The seam, guarded statically.
 *
 * `formatOffer` no longer accepts a URL, so the type checker refuses the
 * obvious reintroduction. This catches the roundabout ones: a role reaching
 * for the merchant's own address by any of the two names it has. The first
 * review round only banned `destinationUrl`, which left
 * `formatOffer(offer, offer.landingUrl)` green - so both names are listed,
 * and this test claims only what it checks: which *names* a role may mention,
 * not that no role can ever produce a direct URL by some other route. The
 * behavioural tests above are what cover that.
 *
 * The merchant's address belongs to `affiliate/links.ts`, which builds the
 * tracked URL from it, to `networks/`, which knows the network's format, to
 * `console/`, which is the one place it is meant to be used, and to
 * `kernel/policy.ts`, which checks it never reaches a reader.
 */
const MERCHANT_URL_FIELDS = ["destinationUrl", "landingUrl"] as const;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("no role names the merchant's own URL", () => {
  const roleDir = join(repoRoot(), "src", "roles");
  // Recursive, so adding `src/roles/<something>/` does not silently shrink the
  // sweep to nothing.
  const roles = filesUnder(roleDir);
  assert.ok(roles.length > 0, "src/roles matched no files - the search is misconfigured");

  const offenders: string[] = [];
  for (const path of roles) {
    const source = readFileSync(path, "utf8");
    for (const field of MERCHANT_URL_FIELDS) {
      if (source.includes(field)) offenders.push(`${path.slice(roleDir.length + 1)} names ${field}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `A role must never handle the merchant's own address: the reader has to go through /go/<code> or ` +
      `the click is not counted. Pass the TrackedLink to formatOffer and let it decide. Offenders:\n` +
      offenders.join("\n"),
  );
});

test("the merchant's URL fields are spelt the way the seam guard searches for them", () => {
  // Without this, renaming a field would make the test above pass by searching
  // for strings that exist nowhere.
  const sources = {
    destinationUrl: join(repoRoot(), "src", "console", "router.ts"),
    landingUrl: join(repoRoot(), "src", "affiliate", "links.ts"),
  };
  for (const [field, path] of Object.entries(sources)) {
    assert.ok(
      readFileSync(path, "utf8").includes(field),
      `${path} is where "${field}" is meant to be used; if it no longer names it, the seam guard ` +
        `above is searching for nothing`,
    );
  }
});
