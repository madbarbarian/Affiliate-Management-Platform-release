import test from "node:test";
import assert from "node:assert/strict";

import { buildStatement, describeTerms, renderStatement, termsFor } from "../src/domain/licensing.ts";
import { totalsByCurrency } from "../src/affiliate/attribution.ts";
import { parseConfig } from "../src/config/schema.ts";
import { BASE_CONFIG, testConfig } from "./helpers.ts";

const PERIOD = { fromIso: "2026-03-01T00:00:00Z", toIso: "2026-03-31T00:00:00Z", days: 30 };

const REVENUE = totalsByCurrency([
  { clicks: 100, conversions: 10, approvedRevenue: 50_000, pendingRevenue: 5000, currency: "JPY" },
  { clicks: 20, conversions: 2, approvedRevenue: 200, pendingRevenue: 0, currency: "USD" },
]);

function licensingConfig(licensing: Record<string, unknown>) {
  return parseConfig(
    { ...(structuredClone(BASE_CONFIG) as unknown as Record<string, unknown>), licensing },
    "licensing.yaml",
  ).licensing;
}

test("no billing configured is the default and produces no fee", () => {
  const licensing = testConfig().licensing;
  assert.equal(licensing.model, "none");

  const statement = buildStatement({
    licensing,
    ventureId: "main",
    ventureName: "Test",
    totals: REVENUE,
    period: PERIOD,
  });
  assert.ok(statement.lines.every((line) => line.fee === 0));
});

test("revenue share bills each currency separately and never converts", () => {
  const licensing = licensingConfig({ model: "revshare", revshareRate: 0.2 });
  const statement = buildStatement({
    licensing,
    ventureId: "main",
    ventureName: "Test",
    totals: REVENUE,
    period: PERIOD,
  });

  const byCurrency = new Map(statement.lines.map((line) => [line.currency, line]));
  assert.equal(byCurrency.get("JPY")?.fee, 10_000);
  assert.equal(byCurrency.get("USD")?.fee, 40);
  assert.equal(statement.lines.length, 2, "no third, blended line may exist");
  assert.match(byCurrency.get("JPY")?.basis ?? "", /20\.0% of 50,000 JPY/);
});

test("pending revenue is shown but not billed", () => {
  const licensing = licensingConfig({ model: "revshare", revshareRate: 0.2 });
  const statement = buildStatement({
    licensing,
    ventureId: "main",
    ventureName: "Test",
    totals: REVENUE,
    period: PERIOD,
  });
  assert.deepEqual(statement.pendingByCurrency, [{ currency: "JPY", amount: 5000 }]);
  // 5,000 pending must not have moved the fee off 20% of the approved 50,000.
  assert.equal(statement.lines.find((line) => line.currency === "JPY")?.fee, 10_000);
});

test("a subscription is owed even when nothing converted", () => {
  const licensing = licensingConfig({
    model: "subscription",
    subscriptionAmount: 30_000,
    subscriptionCurrency: "JPY",
  });
  const statement = buildStatement({
    licensing,
    ventureId: "main",
    ventureName: "Test",
    totals: totalsByCurrency([]),
    period: PERIOD,
  });
  assert.equal(statement.lines.length, 1);
  assert.equal(statement.lines[0]?.fee, 30_000);
});

test("a subscription is prorated by the length of the period", () => {
  const licensing = licensingConfig({ model: "subscription", subscriptionAmount: 30_000 });
  const statement = buildStatement({
    licensing,
    ventureId: "main",
    ventureName: "Test",
    totals: totalsByCurrency([]),
    period: { ...PERIOD, days: 15 },
  });
  assert.equal(statement.lines[0]?.fee, 15_000);
  assert.match(statement.lines[0]?.basis ?? "", /15 days/);
});

test("a per-venture override wins over the default terms", () => {
  const licensing = licensingConfig({
    model: "revshare",
    revshareRate: 0.2,
    overrides: [{ venture: "main", revshareRate: 0.1 }],
  });
  assert.equal(termsFor(licensing, "main").revshareRate, 0.1);
  assert.equal(termsFor(licensing, "someone_else").revshareRate, 0.2);
});

test("an override may change the model entirely, not just the rate", () => {
  const licensing = licensingConfig({
    model: "revshare",
    revshareRate: 0.2,
    overrides: [{ venture: "main", model: "subscription", subscriptionAmount: 9800 }],
  });
  const terms = termsFor(licensing, "main");
  assert.equal(terms.model, "subscription");
  assert.equal(terms.subscriptionAmount, 9800);
});

test("an override for a venture that does not exist is refused", () => {
  assert.throws(
    () => licensingConfig({ model: "revshare", revshareRate: 0.2, overrides: [{ venture: "ghost" }] }),
    /unknown venture "ghost".*silently never apply/s,
  );
});

test("a revenue share above 100% is refused", () => {
  assert.throws(() => licensingConfig({ model: "revshare", revshareRate: 1.5 }), /must be at most 1/);
});

test("the rendered statement shows the arithmetic, not just the total", () => {
  const licensing = licensingConfig({ model: "revshare", revshareRate: 0.15 });
  const rendered = renderStatement(
    buildStatement({
      licensing,
      ventureId: "main",
      ventureName: "テスト運用",
      totals: REVENUE,
      period: PERIOD,
    }),
    PERIOD,
  );
  assert.match(rendered, /テスト運用 \(main\)/);
  assert.match(rendered, /7,500 JPY/);
  assert.match(rendered, /15\.0% of 50,000 JPY approved/);
  assert.match(rendered, /still pending network approval — not billed/);
});

test("terms describe themselves in a sentence an operator can check", () => {
  assert.match(describeTerms({ model: "revshare", revshareRate: 0.2, subscriptionAmount: 0, subscriptionCurrency: "JPY" }), /20\.0% of approved/);
  assert.match(
    describeTerms({ model: "subscription", revshareRate: 0, subscriptionAmount: 9800, subscriptionCurrency: "JPY" }),
    /9,800 JPY per 30 days/,
  );
  assert.match(describeTerms({ model: "none", revshareRate: 0, subscriptionAmount: 0, subscriptionCurrency: "JPY" }), /running it for yourself/);
});
