import test from "node:test";
import assert from "node:assert/strict";

import { ConfigError, parseConfig } from "../src/config/schema.ts";
import { describeCompliance, findMarket, resolveCompliance } from "../src/domain/market.ts";
import { checkCompliance, passesPolicy } from "../src/kernel/policy.ts";
import { formatMoney, totalCounts, totalsByCurrency } from "../src/affiliate/attribution.ts";
import type { DraftContent, Offer } from "../src/core/types.ts";
import { BASE_CONFIG, testConfig } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Config-time guardrails
// ---------------------------------------------------------------------------

function configWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...(structuredClone(BASE_CONFIG) as unknown as Record<string, unknown>), ...overrides };
}

const US_OFFER = {
  id: "offer_us",
  network: "demo",
  name: "US SaaS",
  landingUrl: "https://example.com/us",
  payoutModel: "revshare",
  payoutValue: 0.3,
  currency: "USD",
  category: "productivity",
  originMarket: "us",
  targetMarkets: ["us", "jp"],
  crossBorderNote: "米国の事業者との直接契約です。決済はUSD、日本語サポートはありません。",
  complianceNotes: [],
  active: true,
};

test("an offer promoted outside its origin must say what a foreign reader needs to know", () => {
  const broken = configWith({
    offers: [{ ...US_OFFER, crossBorderNote: "" }],
    ventures: [{ ...BASE_CONFIG.ventures[0], offers: ["offer_us"] }],
  });
  try {
    parseConfig(broken, "broken.yaml");
    assert.fail("expected ConfigError");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    const issue = error.issues.find((entry) => entry.path === "offers[0].crossBorderNote");
    assert.ok(issue, `no crossBorderNote issue in ${error.issues.map((i) => i.path).join(", ")}`);
    assert.match(issue.message, /currency, shipping, language support/);
  }
});

test("the same offer is accepted once the caveat is declared", () => {
  const config = parseConfig(
    configWith({
      offers: [US_OFFER],
      ventures: [{ ...BASE_CONFIG.ventures[0], offers: ["offer_us"] }],
    }),
    "ok.yaml",
  );
  assert.equal(config.offers[0]?.originMarket, "us");
  assert.deepEqual(config.offers[0]?.targetMarkets, ["us", "jp"]);
});

test("a venture cannot carry an offer that is not licensed for its market", () => {
  const broken = configWith({
    offers: [{ ...US_OFFER, targetMarkets: ["us"] }],
    ventures: [{ ...BASE_CONFIG.ventures[0], offers: ["offer_us"] }],
  });
  try {
    parseConfig(broken, "broken.yaml");
    assert.fail("expected ConfigError");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    const messages = error.issues.map((issue) => issue.message).join(" | ");
    assert.match(messages, /may not be promoted in market "jp"/);
    assert.match(messages, /only if the network's terms actually permit it/);
  }
});

test("a category a market prohibits outright cannot be targeted there at all", () => {
  const broken = configWith({
    offers: [{ ...US_OFFER, category: "gambling", targetMarkets: ["jp"] }],
    ventures: [{ ...BASE_CONFIG.ventures[0], offers: ["offer_us"] }],
  });
  try {
    parseConfig(broken, "broken.yaml");
    assert.fail("expected ConfigError");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.match(
      error.issues.map((issue) => issue.message).join(" | "),
      /prohibits the "gambling" category/,
    );
  }
});

test("an unknown market reference is caught", () => {
  const broken = configWith({
    ventures: [{ ...BASE_CONFIG.ventures[0], market: "atlantis" }],
  });
  assert.throws(() => parseConfig(broken, "broken.yaml"), /unknown market "atlantis"/);
});

// ---------------------------------------------------------------------------
// Runtime compliance resolution
// ---------------------------------------------------------------------------

const config = testConfig();
const jp = findMarket(config.markets, "jp");
const us = findMarket(config.markets, "us");

test("compliance follows the audience, not the merchant", () => {
  const usOffer = { ...(config.offers[0] as Offer), originMarket: "us", currency: "USD" };
  const profile = resolveCompliance({ policy: config.policy, market: jp, offer: usOffer });

  // The reader is in Japan, so the Japanese disclosure and rules apply even
  // though the merchant is American.
  assert.equal(profile.disclosureText, "#PR");
  assert.equal(profile.regulator, "消費者庁（景品表示法）");
  assert.ok(profile.prohibitedClaims.includes("必ず痩せる"), "the market's own claims apply");
  assert.ok(profile.prohibitedClaims.includes("必ず稼げる"), "platform-wide claims still apply");
  assert.equal(profile.crossBorder, true);
});

test("a domestic promotion carries no cross-border caveats", () => {
  const profile = resolveCompliance({ policy: config.policy, market: jp, offer: config.offers[0] });
  assert.equal(profile.crossBorder, false);
  assert.deepEqual(profile.crossBorderNotes, []);
});

test("the same offer read by a US audience gets the US disclosure", () => {
  const profile = resolveCompliance({ policy: config.policy, market: us, offer: config.offers[0] });
  assert.equal(profile.disclosureText, "#ad");
  assert.equal(profile.regulator, "FTC Endorsement Guides");
  assert.equal(profile.crossBorder, true, "a JP offer shown to a US audience crosses a border too");
});

test("a market's category rule reaches the prompt", () => {
  const health = { ...(config.offers[0] as Offer), category: "health" };
  const profile = resolveCompliance({ policy: config.policy, market: jp, offer: health });
  assert.deepEqual(profile.categoryNotes, ["薬機法：効能効果は標榜できない"]);
  assert.match(describeCompliance(profile), /薬機法/);
});

// ---------------------------------------------------------------------------
// Publication-time guardrails
// ---------------------------------------------------------------------------

function content(overrides: Partial<DraftContent> = {}): DraftContent {
  return {
    hook: "僕が3日で乗り換えた話。",
    body: "結論から言うと、続かなかった。短い。ここで詰まった。それでも二週間だけ記録を取ってみたら理由がわかった。",
    cta: "同じところで詰まった人いますか。",
    disclosure: "#PR",
    hashtags: [],
    ...overrides,
  };
}

test("a cross-border post missing its caveat is blocked", () => {
  const usOffer: Offer = {
    ...(config.offers[0] as Offer),
    originMarket: "us",
    crossBorderNote: "米国の事業者との直接契約です。",
  };
  const profile = resolveCompliance({ policy: config.policy, market: jp, offer: usOffer });

  const findings = checkCompliance({
    content: content(),
    policy: config.policy,
    voice: config.ventures[0]!.voice,
    profile,
    offer: usOffer,
    maxCharacters: 500,
  });
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  assert.ok(
    blocking.some((finding) => finding.code === "compliance.missing_cross_border_notice"),
    `expected a cross-border block, got ${blocking.map((f) => f.code).join(", ")}`,
  );
  assert.equal(passesPolicy(findings, config.policy), false);
});

test("the same post passes once the caveat is present", () => {
  const usOffer: Offer = {
    ...(config.offers[0] as Offer),
    originMarket: "us",
    crossBorderNote: "米国の事業者との直接契約です。",
  };
  const profile = resolveCompliance({ policy: config.policy, market: jp, offer: usOffer });
  const withNotice = content({
    disclosure: ["#PR", "米国の事業者との直接契約です。", "海外事業者との直接契約になる旨を明記すること"].join("\n"),
  });

  const findings = checkCompliance({
    content: withNotice,
    policy: config.policy,
    voice: config.ventures[0]!.voice,
    profile,
    offer: usOffer,
    maxCharacters: 5000,
  });
  assert.equal(
    findings.some((finding) => finding.code === "compliance.missing_cross_border_notice"),
    false,
  );
  assert.equal(passesPolicy(findings, config.policy), true);
});

test("a claim banned only in the audience's market is still blocked", () => {
  const profile = resolveCompliance({ policy: config.policy, market: jp, offer: config.offers[0] });
  const findings = checkCompliance({
    content: content({ body: "これで必ず痩せると言われました。" }),
    policy: config.policy,
    voice: config.ventures[0]!.voice,
    profile,
    offer: config.offers[0],
    maxCharacters: 500,
  });
  const blocked = findings.find((finding) => finding.code === "compliance.prohibited_claim");
  assert.equal(blocked?.severity, "blocking");
  assert.match(blocked?.message ?? "", /消費者庁/);
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

test("revenue in two currencies is never added together", () => {
  const totals = totalsByCurrency([
    { clicks: 10, conversions: 2, approvedRevenue: 5000, pendingRevenue: 0, currency: "JPY" },
    { clicks: 4, conversions: 1, approvedRevenue: 30, pendingRevenue: 12, currency: "USD" },
    { clicks: 1, conversions: 1, approvedRevenue: 2500, pendingRevenue: 0, currency: "JPY" },
  ]);

  assert.equal(totals.size, 2);
  assert.equal(totals.get("JPY")?.approvedRevenue, 7500);
  assert.equal(totals.get("USD")?.approvedRevenue, 30);

  // Counts are currency-free and may be summed.
  assert.deepEqual(totalCounts(totals.values()), { clicks: 15, conversions: 4 });

  assert.equal(formatMoney(totals, "approvedRevenue"), "7,500 JPY / 30 USD");
  assert.equal(formatMoney(totals, "pendingRevenue"), "12 USD");
});
