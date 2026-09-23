import test from "node:test";
import assert from "node:assert/strict";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ConfigError,
  DEFAULT_MAX_CYCLE_ATTEMPTS,
  OFFER_FORBIDDEN_REDIRECT_HOST_ISSUE,
  parseConfig,
} from "../src/config/schema.ts";
import { buildConfig, interpolate, repoRoot } from "../src/config/load.ts";
import { BASE_CONFIG, testConfig } from "./helpers.ts";

test("accepts the shipped shape and fills in defaults", () => {
  const config = testConfig();
  assert.equal(config.company.autonomy, "assisted");
  assert.equal(config.llm.effort, "high");
  assert.equal(config.llm.fastEffort, "medium");
  assert.equal(config.runtime.promptsDir, "prompts");
  assert.equal(config.ventures[0]?.cadence.ideasPerCycle, 6);
});

test("collects every problem in one pass instead of failing on the first", () => {
  const broken = structuredClone(BASE_CONFIG) as unknown as Record<string, unknown>;
  broken["company"] = { name: "x", operator: "y", autonomy: "reckless" };
  broken["policy"] = { ...BASE_CONFIG.policy, maxPostsPerDay: 999_999 };
  broken["tracking"] = { baseUrl: "not a url", linkParam: "amp", extraParams: {} };

  try {
    parseConfig(broken, "broken.yaml");
    assert.fail("expected ConfigError");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    const paths = error.issues.map((issue) => issue.path);
    assert.ok(paths.includes("company.autonomy"), `missing autonomy issue in ${paths.join(", ")}`);
    assert.ok(paths.includes("policy.maxPostsPerDay"));
    assert.ok(paths.includes("tracking.baseUrl"));
  }
});

test("catches references to things that do not exist", () => {
  const broken = structuredClone(BASE_CONFIG) as Record<string, unknown>;
  broken["ventures"] = [
    { ...BASE_CONFIG.ventures[0], channels: ["nope"], offers: ["also_nope"] },
  ];

  try {
    parseConfig(broken, "broken.yaml");
    assert.fail("expected ConfigError");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    const messages = error.issues.map((issue) => issue.message).join(" | ");
    assert.match(messages, /unknown channel "nope"/);
    assert.match(messages, /unknown offer "also_nope"/);
  }
});

test("refuses a venture that wants to post more than policy allows", () => {
  const broken = structuredClone(BASE_CONFIG) as Record<string, unknown>;
  broken["ventures"] = [
    { ...BASE_CONFIG.ventures[0], cadence: { ...BASE_CONFIG.ventures[0].cadence, postsPerDay: 9 } },
  ];
  assert.throws(() => parseConfig(broken, "broken.yaml"), /exceeds policy.maxPostsPerDay/);
});

test("rejects a malformed cycle start time and an unknown timezone", () => {
  const broken = structuredClone(BASE_CONFIG) as Record<string, unknown>;
  broken["ventures"] = [
    {
      ...BASE_CONFIG.ventures[0],
      timezone: "Mars/Olympus",
      cadence: { ...BASE_CONFIG.ventures[0].cadence, cycleStartsAt: "25:99" },
    },
  ];
  try {
    parseConfig(broken, "broken.yaml");
    assert.fail("expected ConfigError");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    const messages = error.issues.map((issue) => issue.message).join(" | ");
    assert.match(messages, /24-hour form/);
    assert.match(messages, /IANA timezone/);
  }
});

test("expands ${VAR} and ${VAR:-default} in strings", () => {
  const expanded = interpolate(
    { a: "${SET_VALUE}", b: "${MISSING:-fallback}", c: ["${SET_VALUE}"], d: 5 },
    { SET_VALUE: "yes" },
  ) as Record<string, unknown>;

  assert.equal(expanded["a"], "yes");
  assert.equal(expanded["b"], "fallback");
  assert.deepEqual(expanded["c"], ["yes"]);
  assert.equal(expanded["d"], 5);
});

test("an unset variable with no default is an error, not an empty string", () => {
  assert.throws(
    () => interpolate({ url: "https://${HOST}/go" }, {}),
    /HOST.*not set/s,
  );
});

test("conversions are looked back over weeks, not the engagement window", () => {
  // These were the same setting, so conversions were fetched over 72 hours.
  // An ASP approves on its own schedule - often a monthly close - and anything
  // reported later than the window is never imported at all: revenue genuinely
  // earned, absent from every report, statement and pattern.
  const config = testConfig();
  assert.ok(
    config.policy.conversionLookbackDays >= 30,
    "a lookback shorter than a monthly close silently drops revenue",
  );
  assert.notEqual(
    config.policy.conversionLookbackDays * 24,
    config.policy.metricsWindowHours,
    "engagement and conversion timescales are not the same thing",
  );
});

test("every default the schema falls back to is one the schema would accept", () => {
  // `llm.maxRetries` had `max: 8` with `fallback: 45`, so omitting the key gave
  // 45 SDK retries per role call against a rate-limited API, while writing 45
  // explicitly was rejected as "must be at most 8". A default outside its own
  // bounds is unreachable by any config a person could write.
  const defaults = parseConfig(
    { ...BASE_CONFIG, llm: { provider: "mock", model: "m", fastModel: "f" } },
    "test",
  );
  const explicit = parseConfig(
    {
      ...BASE_CONFIG,
      llm: { provider: "mock", model: "m", fastModel: "f", maxRetries: defaults.llm.maxRetries },
    },
    "test",
  );
  assert.equal(explicit.llm.maxRetries, defaults.llm.maxRetries);
});

test("an offer with no landing URL is a config error, not a surprise at write time", () => {
  // `readUrl` passed "" as the default, which suppressed the reader's own
  // "is required" check, so a missing landingUrl passed parseConfig and doctor
  // and only surfaced when the writer tried to build a link.
  assert.throws(
    () =>
      parseConfig(
        { ...BASE_CONFIG, offers: [{ ...BASE_CONFIG.offers[0], landingUrl: undefined }] },
        "test",
      ),
    /landingUrl.*is required/s,
  );
});

test("refuses an offer on an Amazon domain, naming the offer and the fix", () => {
  // Amazon's Associates terms forbid the redirect every tracked link is
  // (docs/3-development/integrations.md), so an offer like this would run to
  // completion - links issued, posts published - and earn nothing, silently.
  const broken = structuredClone(BASE_CONFIG) as Record<string, unknown>;
  broken["offers"] = [{ ...BASE_CONFIG.offers[0], landingUrl: "https://www.amazon.co.jp/dp/B000000000" }];
  try {
    parseConfig(broken, "broken.yaml");
    assert.fail("expected ConfigError");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    const paths = error.issues.map((issue) => issue.path);
    assert.ok(paths.includes("offers[0].landingUrl"), paths.join(", "));
    const messages = error.issues.map((issue) => issue.message).join(" | ");
    assert.match(messages, /offer "offer_test"/, "the offer is named");
    assert.match(messages, /amazon\.co\.jp/, "the offending host is named");
    assert.match(messages, /forbid/i, "Amazon's terms are named as the reason");
    assert.match(messages, /forfeited/i, "it must say forfeited, not merely uncounted");
    assert.match(messages, /platform\.config\.yaml/, "the fix names the file a licensee actually edits");
  }
});

test("the Amazon-offer issue carries a code, not just English prose, for licenseeProblem to key on", () => {
  // src/worker/handler.ts renders this one issue in Japanese on the screen a
  // licensee actually reads - it recognises it by this code so it never has
  // to pattern-match the English message above, which is free to keep changing.
  const broken = structuredClone(BASE_CONFIG) as Record<string, unknown>;
  broken["offers"] = [{ ...BASE_CONFIG.offers[0], landingUrl: "https://www.amazon.co.jp/dp/B000000000" }];
  try {
    parseConfig(broken, "broken.yaml");
    assert.fail("expected ConfigError");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    const issue = error.issues.find((entry) => entry.path === "offers[0].landingUrl");
    assert.equal(issue?.code, OFFER_FORBIDDEN_REDIRECT_HOST_ISSUE);
  }
});

test("a short link on amzn.to is refused the same way a full amazon.com URL is", () => {
  const broken = structuredClone(BASE_CONFIG) as Record<string, unknown>;
  broken["offers"] = [{ ...BASE_CONFIG.offers[0], landingUrl: "https://amzn.to/3xample" }];
  assert.throws(
    () => parseConfig(broken, "broken.yaml"),
    /offers\[0\]\.landingUrl.*amzn\.to/s,
  );
});

test("collects every Amazon offer in one run, not just the first", () => {
  const broken = structuredClone(BASE_CONFIG) as Record<string, unknown>;
  broken["offers"] = [
    { ...BASE_CONFIG.offers[0], id: "offer_a", landingUrl: "https://www.amazon.com/dp/1" },
    { ...BASE_CONFIG.offers[0], id: "offer_b", landingUrl: "https://amzn.to/xyz" },
  ];
  broken["ventures"] = [{ ...BASE_CONFIG.ventures[0], offers: ["offer_a", "offer_b"] }];
  try {
    parseConfig(broken, "broken.yaml");
    assert.fail("expected ConfigError");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    const paths = error.issues.map((issue) => issue.path);
    assert.ok(paths.includes("offers[0].landingUrl"), paths.join(", "));
    assert.ok(paths.includes("offers[1].landingUrl"), paths.join(", "));
  }
});

test("a plain merchant offer, and hosts that only resemble Amazon, all pass", () => {
  // A naive substring check would also catch these two - neither is Amazon.
  const config = testConfig({
    offers: [
      { ...BASE_CONFIG.offers[0], id: "offer_test", landingUrl: "https://example.com/lp" },
      { ...BASE_CONFIG.offers[0], id: "offer_lookalike_1", landingUrl: "https://notamazon.com/lp" },
      { ...BASE_CONFIG.offers[0], id: "offer_lookalike_2", landingUrl: "https://amazon.com.evil.example/lp" },
    ],
  });
  assert.equal(config.offers.length, 3);
});

test("an inactive offer on an Amazon domain is not refused - active: false is the deactivate path the message names", () => {
  const config = testConfig({
    offers: [{ ...BASE_CONFIG.offers[0], landingUrl: "https://www.amazon.co.jp/dp/1", active: false }],
  });
  assert.equal(config.offers[0]?.active, false);
});

test("two operators cannot share a name or a passphrase", () => {
  // Both mistakes produce a record that looks attributed and is not: one name
  // for two people, or one secret two people hold. The audit trail is the only
  // thing this feature buys, so neither may validate.
  const withOperators = (operators: unknown) => ({
    ...BASE_CONFIG,
    console: { ...BASE_CONFIG.console, operators },
  });

  assert.throws(
    () => parseConfig(withOperators([{ name: "tester", tokenEnv: "AMP_OTHER" }]), "test"),
    /already the name of another operator/s,
    "the owner's own name is taken",
  );
  assert.throws(
    () =>
      parseConfig(
        withOperators([
          { name: "a", tokenEnv: "AMP_ONE" },
          { name: "a", tokenEnv: "AMP_TWO" },
        ]),
        "test",
      ),
    /already the name of another operator/s,
  );
  assert.throws(
    () => parseConfig(withOperators([{ name: "a", tokenEnv: BASE_CONFIG.console.tokenEnv }]), "test"),
    /already another operator's passphrase/s,
    "sharing the owner's secret is sharing the owner's identity",
  );

  // Roles are deferred, so the config has to say so out loud. Reading only the
  // two fields it knows and ignoring the rest is how a deferred feature turns
  // into a false belief: this reads like the person was limited to one account,
  // and a passphrase is a passphrase.
  assert.throws(
    () => parseConfig(withOperators([{ name: "a", tokenEnv: "AMP_ONE", role: "manager" }]), "test"),
    /role.*not implemented yet.*do everything you can/s,
  );
  assert.throws(
    () => parseConfig(withOperators([{ name: "a", tokenEnv: "AMP_ONE", ventures: ["zakka"] }]), "test"),
    /ventures.*not implemented yet/s,
  );
  assert.throws(
    () => parseConfig(withOperators([{ name: "a", tokenEnv: "AMP_ONE", tokenEnvv: "typo" }]), "test"),
    /tokenEnvv.*not a field of console\.operators/s,
    "a misspelt field is the same silence with a worse cause",
  );

  const fine = parseConfig(withOperators([{ name: "みどり", tokenEnv: "AMP_MIDORI" }]), "test");
  assert.deepEqual(fine.console.operators, [{ name: "みどり", tokenEnv: "AMP_MIDORI" }]);
  // And a config that names nobody is still a config.
  assert.deepEqual(parseConfig(BASE_CONFIG, "test").console.operators, []);
});

test("the example a licensee edits carries the retry limit, with what it costs", async () => {
  // "Anything a licensee might want to change belongs in config" is only true
  // once it is *in* the file. A key that exists in the schema and nowhere in
  // the example is a key nobody finds: the default runs, the bill moves, and
  // the setting is discoverable only by reading `src/`, which a licensee on
  // Cloudflare has no way to do.
  const example = await readFile(join(repoRoot(), "platform.config.example.yaml"), "utf8");
  const { config } = buildConfig(example, join(repoRoot(), "platform.config.example.yaml"), {});
  assert.equal(config.company.retry.maxCycleAttempts, DEFAULT_MAX_CYCLE_ATTEMPTS);
  assert.match(example, /^\s*maxCycleAttempts: 2$/m, "the value has to be written, not merely defaulted");

  // And the two things a reader cannot work out from the number alone.
  const comment = example.slice(0, example.indexOf("maxCycleAttempts"));
  assert.match(comment.slice(-400), /費用/, "nothing says this setting costs money");
  assert.match(comment.slice(-400), /Cloudflare/, "nothing says a redeploy is needed there");
});

test("the retry limit is refused with the fix in the message, not only the bound", async () => {
  // `.number({ min, max })` answers "must be at most 5, got 20", which names
  // the problem and not the repair. This is a number whose only effect is on
  // the licensee's bill, so being told what to write instead is the point.
  const example = await readFile(join(repoRoot(), "platform.config.example.yaml"), "utf8");
  const tooMany = example.replace(/maxCycleAttempts: 2/, "maxCycleAttempts: 20");
  assert.notEqual(tooMany, example, "the example no longer carries this key - update this test");
  assert.throws(
    () => buildConfig(tooMany, join(repoRoot(), "platform.config.example.yaml"), {}),
    (error: Error) => /between 1 and 5/.test(error.message) && /write 2/.test(error.message),
  );
});
