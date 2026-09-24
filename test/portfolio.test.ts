/**
 * `buildPortfolio`'s own concurrency, not its numbers - `test/exploration.test.ts`
 * already covers what a row says. This file covers how long it takes to say it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildPortfolio } from "../src/domain/portfolio.ts";
import { createTestCompany, testConfig, BASE_CONFIG } from "./helpers.ts";

test("buildPortfolio reads every account at once, not one account after another", async () => {
  // The loop this guards: `for (const venture of config.ventures) { ... await
  // ... }` waited for one account's whole read before even asking the store
  // about the next. Three accounts on a Worker - backed by D1, where each
  // read is a real network round trip - paid three round trips in series for
  // work with no reason to be sequential: no row depends on another
  // account's row. (`reviewReason` is the one thing that compares accounts,
  // and it only runs after every row already exists.) A licensee with five
  // accounts would wait longer still.
  //
  // Counting, not timing: each account's `cycles.all()` is gated so it cannot
  // resolve until this test has confirmed every account's read already
  // started. A sequential implementation never reaches the second account's
  // call at all - it is still awaiting the first, which this test does not
  // release until after the assertion below.
  const ventureA = { ...structuredClone(BASE_CONFIG.ventures[0]), id: "venture-a" };
  const ventureB = { ...structuredClone(BASE_CONFIG.ventures[0]), id: "venture-b" };
  const config = testConfig({ ventures: [ventureA, ventureB] });
  const company = createTestCompany({ config });

  const entered = new Set<string>();
  const release = new Map<string, () => void>();
  for (const venture of config.ventures) {
    const store = company.stores.open(venture.id);
    store.cycles.all = async () => {
      entered.add(venture.id);
      await new Promise<void>((resolve) => release.set(venture.id, resolve));
      return [];
    };
  }

  const donePromise = buildPortfolio({
    config,
    stores: company.stores,
    nowMs: company.clock.now(),
    days: 30,
    state: undefined,
  });

  // Drains the microtask queue - every `await` short of a real timer or I/O -
  // without resolving anything ourselves. Not a sleep: `setImmediate` fires
  // only once nothing left in the microtask queue can still run, so this is
  // deterministic regardless of how many `await` hops each implementation
  // takes to reach the gate.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    [...entered].sort(),
    config.ventures.map((venture) => venture.id).sort(),
    "every account's read must have started before any one of them can finish",
  );

  for (const resolve of release.values()) resolve();
  const portfolio = await donePromise;
  assert.equal(portfolio.rows.length, 2, "both accounts still make it into the finished portfolio");
});
