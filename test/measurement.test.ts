/**
 * The measurement chain check.
 *
 * These matter because the failure it prevents is silent and unrecoverable:
 * an operation that runs for a month on simulated numbers or an unreachable
 * redirect looks healthy the whole time, and the month cannot be re-measured
 * afterwards because the clicks were never recorded.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { describeMeasurementChain } from "../src/domain/measurement.ts";
import { BASE_CONFIG, testConfig } from "./helpers.ts";
import type { VentureId } from "../src/core/types.ts";

const MAIN = "main" as VentureId;

/** The shipped test config runs entirely on simulated adapters. */
function realistic(overrides: Record<string, unknown> = {}) {
  return testConfig({
    console: { ...BASE_CONFIG.console, enabled: true },
    tracking: { ...BASE_CONFIG.tracking, baseUrl: "https://go.example.com" },
    channels: [{ ...BASE_CONFIG.channels[0], adapter: "webhook" }],
    networks: [{ ...BASE_CONFIG.networks[0], adapter: "csv" }],
    ...overrides,
  });
}

function failureFor(chain: ReturnType<typeof describeMeasurementChain>, step: string): string {
  return chain.links.find((link) => link.step === step && !link.ok)?.problem ?? "";
}

test("a venture wired end to end reports a closed chain", () => {
  const chain = describeMeasurementChain(realistic(), MAIN);
  assert.equal(chain.closed, true, chain.links.filter((l) => !l.ok).map((l) => l.problem).join("\n"));
});

test("simulated adapters are reported as an open chain, not as working", () => {
  // The default test config is all mocks - the state a licensee is in on day
  // one, and the state they must not still be in when they start posting.
  const chain = describeMeasurementChain(testConfig(), MAIN);

  assert.equal(chain.closed, false);
  assert.match(failureFor(chain, "engagement"), /simulated/);
  assert.match(failureFor(chain, "conversion"), /no real conversion will ever arrive/);
});

test("a console that is switched off breaks the click link, not just the console", () => {
  // The trap: the tracking redirect is served by the console. With it off,
  // every tracked link 404s and no click is ever recorded - and nothing else
  // in the system complains.
  const chain = describeMeasurementChain(
    realistic({ console: { ...BASE_CONFIG.console, enabled: false } }),
    MAIN,
  );

  assert.equal(chain.closed, false);
  assert.match(failureFor(chain, "link"), /serves the tracking redirect/);
});

test("a tracking host a reader cannot reach is caught before the first post", () => {
  const chain = describeMeasurementChain(
    realistic({ tracking: { ...BASE_CONFIG.tracking, baseUrl: "http://localhost:4399" } }),
    MAIN,
  );

  assert.equal(chain.closed, false);
  assert.match(failureFor(chain, "link"), /cannot reach/);
});

test("an offer with no payout cannot value a conversion", () => {
  const chain = describeMeasurementChain(
    realistic({ offers: [{ ...BASE_CONFIG.offers[0], payoutValue: 0 }] }),
    MAIN,
  );

  assert.equal(chain.closed, false);
  assert.match(failureFor(chain, "revenue"), /payout/);
});

test("every failing link names what to change, not just what is wrong", () => {
  const chain = describeMeasurementChain(testConfig(), MAIN);
  for (const link of chain.links) {
    if (link.ok) continue;
    assert.ok(
      /Set |Add |Use |Point |Enable |set /.test(link.problem),
      `"${link.problem}" says what is broken but not what to do about it`,
    );
  }
});
