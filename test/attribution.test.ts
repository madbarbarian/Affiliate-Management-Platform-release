import test from "node:test";
import assert from "node:assert/strict";

import { payoutFor, resolveConversions, revenueByPattern, revenueByPost } from "../src/affiliate/attribution.ts";
import { issueLink, shortUrl, REDIRECT_PATH } from "../src/affiliate/links.ts";
import { createMockNetwork } from "../src/networks/mock.ts";
import type { ClickEvent, ConversionEvent, Offer, ScheduledPost, TrackedLink } from "../src/core/types.ts";
import type { NetworkConversion } from "../src/networks/network.ts";
import { createTestCompany, testConfig } from "./helpers.ts";
import { computePerformance } from "../src/domain/performance.ts";

const config = testConfig();
const offer: Offer = config.offers[0]!;
const network = createMockNetwork({ id: "demo", credentials: {}, options: {}, nowMs: () => 0 });

function link(overrides: Partial<TrackedLink> = {}): TrackedLink {
  return {
    id: "lnk_1",
    ventureId: "main",
    offerId: offer.id,
    postId: "post_1",
    code: "abc123",
    destinationUrl: "https://example.com/lp?subid=abc123",
    createdAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function conversion(overrides: Partial<NetworkConversion> = {}): NetworkConversion {
  return {
    externalId: "ext_1",
    subId: "abc123",
    at: "2026-04-01T01:00:00Z",
    amount: 1000,
    currency: "JPY",
    status: "approved",
    ...overrides,
  };
}

test("the same post always gets the same tracking code", () => {
  const first = issueLink({
    ventureId: "main",
    offer,
    postId: "post_1",
    network,
    tracking: config.tracking,
    nowMs: 0,
  });
  const second = issueLink({
    ventureId: "main",
    offer,
    postId: "post_1",
    network,
    tracking: config.tracking,
    nowMs: 999_999,
  });
  assert.ok(first.ok && second.ok);
  assert.equal(first.value.code, second.value.code);
  assert.equal(first.value.id, second.value.id);
});

test("different posts get different codes", () => {
  const a = issueLink({ ventureId: "main", offer, postId: "post_1", network, tracking: config.tracking, nowMs: 0 });
  const b = issueLink({ ventureId: "main", offer, postId: "post_2", network, tracking: config.tracking, nowMs: 0 });
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.value.code, b.value.code);
});

test("the destination carries the sub-id and the configured extra params", () => {
  const issued = issueLink({ ventureId: "main", offer, postId: "post_1", network, tracking: config.tracking, nowMs: 0 });
  assert.ok(issued.ok);
  const url = new URL(issued.value.destinationUrl);
  assert.equal(url.searchParams.get("subid"), issued.value.code);
  assert.equal(url.searchParams.get("amp"), issued.value.code);
  assert.equal(url.searchParams.get("utm_source"), "test");
});

test("the link in the post is on the path the console actually answers", () => {
  // Both ends read REDIRECT_PATH. They used not to: links were built as
  // `<baseUrl>/<code>` while the console only served `/go/<code>`, so every
  // published link 404'd and no click was ever recorded - with the documented
  // `baseUrl` looking exactly right.
  const issued = issueLink({ ventureId: "main", offer, postId: "post_1", network, tracking: config.tracking, nowMs: 0 });
  assert.ok(issued.ok);

  const url = shortUrl(config.tracking, issued.value);
  assert.equal(url, `https://go.test.invalid${REDIRECT_PATH}${issued.value.code}`);

  const path = new URL(url).pathname;
  assert.ok(path.startsWith(REDIRECT_PATH), "the console routes on this prefix");
  assert.equal(
    path.slice(REDIRECT_PATH.length),
    issued.value.code,
    "and recovers the code by stripping exactly that prefix",
  );
});

test("conversions resolve to the link that earned them", () => {
  const resolved = resolveConversions([conversion()], [link()], []);
  assert.equal(resolved.resolved.length, 1);
  assert.equal(resolved.resolved[0]?.linkId, "lnk_1");
  assert.equal(resolved.unattributed.length, 0);
});

test("re-importing the same conversion does not double-count it", () => {
  // Built by importing once rather than hand-written, so the test cannot drift
  // from the id shape the code actually stores.
  const first = resolveConversions([conversion()], [link()], [], "a8");
  assert.equal(first.resolved.length, 1);

  const again = resolveConversions([conversion()], [link()], first.resolved, "a8");
  assert.equal(again.resolved.length, 0);
  assert.equal(again.duplicates, 1);
});

test("two networks numbering their orders from 1 do not overwrite each other", () => {
  // Every ASP starts its order ids at 1, so unnamespaced ids collided: the
  // second import was dropped as a duplicate of the first, and that revenue
  // was simply never recorded.
  const fromA8 = resolveConversions([conversion()], [link()], [], "a8");
  const fromImpact = resolveConversions([conversion()], [link()], fromA8.resolved, "impact");

  assert.equal(fromImpact.resolved.length, 1, "a different network's order 1 is a different conversion");
  assert.equal(fromImpact.duplicates, 0);
  assert.notEqual(fromImpact.resolved[0]?.id, fromA8.resolved[0]?.id);
});

test("a conversion for an unknown sub-id is surfaced, not swallowed", () => {
  const resolved = resolveConversions([conversion({ subId: "unknown" })], [link()], []);
  assert.equal(resolved.resolved.length, 0);
  assert.equal(resolved.unattributed.length, 1);
});

test("payout depends on the model", () => {
  const event: ConversionEvent = {
    id: "c",
    linkId: "lnk_1",
    externalId: "e",
    at: "x",
    amount: 10_000,
    currency: "JPY",
    status: "approved",
  };
  assert.equal(payoutFor({ ...offer, payoutModel: "cpa" }, event), 10_000);
  assert.equal(payoutFor({ ...offer, payoutModel: "revshare", payoutValue: 0.3 }, event), 3000);
  // A network that reports the event but not an amount falls back to the rate.
  assert.equal(payoutFor({ ...offer, payoutModel: "cpa", payoutValue: 2500 }, { ...event, amount: 0 }), 2500);
});

test("revenue rolls up per post, separating approved from pending", () => {
  const clicks: ClickEvent[] = [
    { id: "c1", linkId: "lnk_1", at: "x" },
    { id: "c2", linkId: "lnk_1", at: "x" },
  ];
  const conversions: ConversionEvent[] = [
    { id: "v1", linkId: "lnk_1", externalId: "e1", at: "x", amount: 1000, currency: "JPY", status: "approved" },
    { id: "v2", linkId: "lnk_1", externalId: "e2", at: "x", amount: 1000, currency: "JPY", status: "pending" },
    { id: "v3", linkId: "lnk_1", externalId: "e3", at: "x", amount: 1000, currency: "JPY", status: "rejected" },
  ];
  const rollup = revenueByPost({
    links: [link()],
    clicks,
    conversions,
    offers: [offer],
    defaultCurrency: "JPY",
  }).get("post_1");

  assert.equal(rollup?.clicks, 2);
  assert.equal(rollup?.conversions, 2, "rejected conversions must not count");
  assert.equal(rollup?.approvedRevenue, 1000);
  assert.equal(rollup?.pendingRevenue, 1000);
});

test("revenue rolls up per pattern, which is what decides what gets written next", () => {
  const posts = [
    { id: "post_1", patternId: "pat_a" },
    { id: "post_2", patternId: "pat_a" },
    { id: "post_3", patternId: "pat_b" },
  ] as ScheduledPost[];

  const byPost = new Map([
    ["post_1", { clicks: 5, conversions: 1, approvedRevenue: 1000, pendingRevenue: 0, currency: "JPY" }],
    ["post_2", { clicks: 3, conversions: 2, approvedRevenue: 2000, pendingRevenue: 0, currency: "JPY" }],
    ["post_3", { clicks: 9, conversions: 0, approvedRevenue: 0, pendingRevenue: 0, currency: "JPY" }],
  ]);

  const byPattern = revenueByPattern(posts, byPost, "JPY");
  assert.equal(byPattern.get("pat_a")?.approvedRevenue, 3000);
  assert.equal(byPattern.get("pat_a")?.clicks, 8);
  // The most-clicked pattern earning nothing is exactly the case the analyst
  // is meant to surface.
  assert.equal(byPattern.get("pat_b")?.clicks, 9);
  assert.equal(byPattern.get("pat_b")?.approvedRevenue, 0);
});

test("a report's totals cover the window it says it covers", async () => {
  // The bug had teeth beyond a wrong report: `amp statement` computes a
  // revshare percentage from these totals, and they were lifetime figures -
  // so every billing period re-charged a percentage of all revenue ever
  // earned, growing without end.
  const company = createTestCompany();
  const { store, clock } = company;
  const offer = company.config.offers[0]!;
  const nowMs = clock.now();
  const DAY = 86_400_000;

  const link = {
    id: "lnk_old" as never,
    ventureId: "main" as never,
    postId: "pst_old" as never,
    offerId: offer.id,
    code: "old",
    subId: "sub_old",
    destinationUrl: "https://example.invalid",
    createdAt: new Date(nowMs - 90 * DAY).toISOString(),
  };
  await store.links.put(link as never);
  await store.posts.put({
    id: "pst_old",
    ventureId: "main",
    cycleId: "cyc_old",
    draftId: "drf_old",
    channel: "threads",
    status: "published",
    scheduledFor: nowMs - 90 * DAY,
    publishedAt: new Date(nowMs - 90 * DAY).toISOString(),
    content: { hook: "古い投稿", body: "b", cta: "c", disclosure: "#PR", hashtags: [] },
    comments: [],
  } as never);
  await store.conversions.put({
    id: "cnv_old",
    linkId: "lnk_old",
    externalId: "ext_old",
    at: new Date(nowMs - 90 * DAY).toISOString(),
    amount: 100000,
    currency: "JPY",
    status: "approved",
  } as never);

  const lastWeek = await computePerformance(store, {
    ventureId: "main" as never,
    nowMs,
    sinceMs: nowMs - 7 * DAY,
    offers: [offer],
    defaultCurrency: "JPY",
  });

  assert.equal(lastWeek.rows.length, 0, "a 90-day-old post is not in a 7-day window");
  assert.equal(
    lastWeek.totals.get("JPY")?.approvedRevenue ?? 0,
    0,
    "and neither is the revenue it earned - totals must match the rows above them",
  );

  const allTime = await computePerformance(store, {
    ventureId: "main" as never,
    nowMs,
    sinceMs: nowMs - 365 * DAY,
    offers: [offer],
    defaultCurrency: "JPY",
  });
  assert.equal(
    allTime.totals.get("JPY")?.approvedRevenue,
    100000,
    "a window that includes it still counts it",
  );
});

test("computePerformance reads posts, metrics, links, clicks and conversions all at once, not in two waves", async () => {
  // None of these five reads depends on another. `latestByPost` only needs
  // `posts`' ids, and it applies them to `metrics` in memory *after* both have
  // already arrived - so awaiting `posts` and only then asking the store for
  // `metrics`, the way this function used to, cost a whole extra round trip's
  // latency on every venture, every call: real time on a store backed by D1,
  // paid for no reason. Counting, not timing: every read is gated so none can
  // finish until this test has confirmed all five have already started - a
  // version that reads `posts` first and `metrics` only afterward never
  // reaches `metrics`'s gate before this check runs.
  const company = createTestCompany();
  const { store } = company;
  const offer = company.config.offers[0]!;

  const entered = new Set<string>();
  const release = new Map<string, () => void>();
  const gate =
    (name: string) =>
    async (): Promise<never[]> => {
      entered.add(name);
      await new Promise<void>((resolve) => release.set(name, resolve));
      return [];
    };
  store.posts.find = gate("posts") as never;
  store.metrics.all = gate("metrics") as never;
  store.links.find = gate("links") as never;
  store.clicks.all = gate("clicks") as never;
  store.conversions.all = gate("conversions") as never;

  const donePromise = computePerformance(store, {
    ventureId: "main" as never,
    nowMs: company.clock.now(),
    sinceMs: 0,
    offers: [offer],
    defaultCurrency: "JPY",
  });

  // Drains the microtask queue without resolving anything ourselves - not a
  // sleep. `setImmediate` fires only once nothing left in the microtask queue
  // can still run, so this is deterministic regardless of how many `await`
  // hops each implementation takes to reach the gate.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    [...entered].sort(),
    ["clicks", "conversions", "links", "metrics", "posts"],
    "every read must have started before any one of them can finish",
  );

  for (const resolve of release.values()) resolve();
  await donePromise;
});
