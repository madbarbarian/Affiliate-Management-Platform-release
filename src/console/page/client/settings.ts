/**
 * renderSettings: the company-wide settings screen.
 */

export const SETTINGS_SCRIPT = `function renderSettings(s) {
  const row = (label, value, where) =>
    '<div class="field"><div class="label">' + esc(label) + "</div><div>" + value + "</div>" +
    (where ? '<div class="where">' + esc(where) + "</div>" : "") + "</div>";
  const loud = (text) => '<span class="loud">' + text + "</span>";

  const autonomy = s.autonomy === "auto" ? loud(T["settings.autonomyAuto"])
    : s.autonomy === "manual" ? esc(T["settings.autonomyManual"])
    : esc(T["settings.autonomyAssisted"]);

  const model = s.llm.provider === "mock"
    ? loud(T["settings.modelMock"])
    : esc(fmt("settings.modelReal", { model: s.llm.model, fastModel: s.llm.fastModel, effort: s.llm.effort }));

  // The same hostname doctor refuses. Left at the example's placeholder every
  // tracked link in every post goes nowhere, and no click is ever counted.
  const trackingBad = /example\\.invalid/.test(s.trackingBaseUrl) || !/^https:/.test(s.trackingBaseUrl);
  const tracking = esc(s.trackingBaseUrl) + (trackingBad ? "<br>" + loud(T["settings.trackingBad"]) : "");

  const who = s.operators.length === 1
    ? fmt("settings.operatorOne", { name: s.operators[0] })
    : fmt("settings.operatorMany", { names: s.operators.join(T["punct.sep"]), n: s.operators.length });

  // Resolved per market (src/domain/market.ts), never company-wide: a US
  // market owes a different disclosure, and a different prohibited-claims
  // count, than a Japanese one. s.policy deliberately carries neither any
  // more - reporting one number for the whole company here would be this file
  // re-deriving compliance, which CLAUDE.md forbids outright. Deduped by
  // market rather than left one row per venture: resolveCompliance depends
  // only on policy and market, so two ventures sharing a market always
  // resolve to the same numbers, and a row repeated for each venture would
  // say nothing a second time.
  const byMarket = [];
  const seenMarkets = new Set();
  for (const entry of s.compliance) {
    if (seenMarkets.has(entry.market)) continue;
    seenMarkets.add(entry.market);
    byMarket.push(entry);
  }
  const disclosureByMarket = esc(
    byMarket
      .map((entry) => fmt("settings.disclosureRow", { market: entry.marketName, text: entry.disclosureText }))
      .join(T["punct.sep"]),
  );
  const prohibitedByMarket = esc(
    byMarket
      .map((entry) => fmt("settings.prohibitedClaimsRow", { market: entry.marketName, n: entry.prohibitedClaims }))
      .join(T["punct.sep"]),
  );

  // First, because it answers "what am I running" before any of the rows
  // that answer "what is it configured to do" - and because it used to
  // answer nowhere on this screen at all. A licensee who is current never saw
  // it: the only place it appeared was inside the update panel's "いまお使いな
  // のは {version} です", which renders only when an update is available.
  // No "where" - there is no config key to point at, only RELEASE.json, which
  // a licensee never opens.
  const version = s.version ? esc(s.version) : loud(T["settings.versionUnknown"]);

  return '<div class="card">' +
    row(T["settings.version"], version) +
    row(T["settings.autonomy"], autonomy, "company.autonomy") +
    row(T["settings.model"], model, "llm.provider") +
    row(T["settings.operator"], esc(who), "company.operator") +
    row(
      T["settings.disclosure"],
      s.policy.requireDisclosure ? disclosureByMarket : loud(T["settings.disclosureOff"]),
      "markets[].disclosureText",
    ) +
    row(T["settings.limits"], esc(fmt("settings.limitsValue", {
      posts: s.policy.maxPostsPerDay, minutes: s.policy.minMinutesBetweenPosts, smell: s.policy.maxAiSmellScore,
    })), "policy") +
    row(T["settings.words"], esc(fmt("settings.wordsValue", {
      banned: s.policy.bannedPhrases,
    })), "policy.bannedPhrases") +
    row(
      T["settings.prohibitedClaims"],
      prohibitedByMarket,
      "policy.prohibitedClaims + markets[].prohibitedClaims",
    ) +
    row(T["settings.tracking"], tracking, "tracking.baseUrl") +
    row(T["settings.scale"], esc(fmt("settings.scaleValue", {
      ventures: s.ventures, markets: s.markets.join(", "),
    })), "ventures / markets") +
  "</div>" +
  '<p class="muted">' + fmt("setup.editInFile", { path: esc(s.configPath) }) + "</p>";
}

`;
