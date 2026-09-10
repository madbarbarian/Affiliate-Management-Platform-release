import test from "node:test";
import assert from "node:assert/strict";

import { ConfigError, parseConfig } from "../src/config/schema.ts";
import { interpolate } from "../src/config/load.ts";
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
