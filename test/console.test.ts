/**
 * The approval console's front door.
 *
 * There was no test of `src/console/` at all until a security review found
 * that `Cookie: amp_console=` authenticated every route - including the POST
 * that approves posts and publishes them to a real account. Same shape as
 * every other elementary bug in this project: a band the suite did not cover.
 *
 * These start the real server and speak HTTP to it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startConsole, type ConsoleHandle } from "../src/console/server.ts";
import { createTestCompany, testConfig, BASE_CONFIG, type TestCompany } from "./helpers.ts";
import { unwrap } from "../src/core/result.ts";
import { runScout } from "../src/kernel/exploration.ts";
import type { Runtime } from "../src/runtime.ts";
import { fileState } from "../src/kernel/state.ts";

/**
 * A console backed by the test company. `startConsole` only reads `config`,
 * `services` and `loaded.dataDir`, so the in-memory company is enough.
 */
async function withConsole(
  env: Record<string, string | undefined>,
  body: (base: string, handle: ConsoleHandle, company: TestCompany) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "amp-console-"));
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const company = createTestCompany({
    config: testConfig({
      // A real port, because the schema refuses 0 - rightly, since a licensee
      // writing 0 means a mistake. Random and high to avoid colliding with
      // whatever else is on the machine.
      console: { ...BASE_CONFIG.console, enabled: true, port: 20000 + Math.floor(Math.random() * 20000) },
    }),
  });
  const runtime = {
    loaded: { config: company.config, path: "test", dataDir, promptsDir: "prompts" },
    config: company.config,
    state: fileState(dataDir),
    services: company.services,
    orchestrator: company.orchestrator,
    bus: company.services.bus,
    dryRun: false,
    close: async () => {},
  } as unknown as Runtime;

  const started = await startConsole(runtime);
  assert.ok(started.ok, started.ok ? "" : started.error.message);
  const port = (started.value.server.address() as { port: number }).port;
  try {
    await body(`http://127.0.0.1:${port}`, started.value, company);
  } finally {
    await started.value.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("a blank token env var does not become a blank password", async () => {
  // `.env.local.sample` ships `AMP_CONSOLE_TOKEN=`, which the loader turns into
  // "". `??` did not catch that, so "" was the server's secret - and
  // timingSafeEqual on two empty buffers is true, so `Cookie: amp_console=`
  // opened every route on a daemon the operator had put a public domain in
  // front of.
  await withConsole({ AMP_TEST_TOKEN: "" }, async (base, handle) => {
    assert.notEqual(handle.token, "", "a blank env var must yield a generated token, not an empty one");

    for (const headers of [
      {},
      { cookie: "amp_console=" },
      { cookie: "amp_console=wrong" },
      { authorization: "Bearer " },
      { authorization: "Bearer wrong" },
    ]) {
      const response = await fetch(`${base}/api/state`, { headers });
      assert.equal(response.status, 401, `${JSON.stringify(headers)} must not authenticate`);
    }
  });
});

test("an empty credential cannot resolve a decision", async () => {
  // The route that publishes. A 401 here is the whole point; anything else
  // means the request reached the orchestrator.
  await withConsole({ AMP_TEST_TOKEN: "" }, async (base) => {
    const response = await fetch(`${base}/api/decisions/dec_anything/resolve`, {
      method: "POST",
      headers: { cookie: "amp_console=", "content-type": "application/json" },
      body: JSON.stringify({ selectedIds: [], ordering: [] }),
    });
    assert.equal(response.status, 401);
  });
});

test("the token the console prints is the one it accepts", async () => {
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle) => {
    assert.equal(handle.token, "a-real-token-value");

    for (const headers of [
      { authorization: `Bearer ${handle.token}` },
      { cookie: `amp_console=${handle.token}` },
    ]) {
      const response = await fetch(`${base}/api/state`, { headers });
      assert.equal(response.status, 200, `${JSON.stringify(headers)} should be accepted`);
    }

    const viaQuery = await fetch(`${base}/api/state?token=${handle.token}`);
    assert.equal(viaQuery.status, 200);
  });
});

test("opening the page with a token in the URL hands back a cookie that works", async () => {
  // The token moves out of the address bar into a cookie so it stops appearing
  // in browser history. `Headers` joins repeated values with ", ", which a
  // browser reads as one malformed cookie, so the adapter has to write
  // `set-cookie` out on its own.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle) => {
    const page = await fetch(`${base}/?token=${handle.token}`);
    assert.equal(page.status, 200);
    const cookies = page.headers.getSetCookie();
    assert.equal(cookies.length, 1, "exactly one cookie, not a joined pair");
    const value = cookies[0]!;
    assert.match(value, /^amp_console=a-real-token-value;/);
    assert.match(value, /HttpOnly/);

    const withCookie = await fetch(`${base}/api/state`, {
      headers: { cookie: value.split(";")[0] as string },
    });
    assert.equal(withCookie.status, 200, "the cookie the page set must authenticate");
  });
});

test("the tracking redirect stays public, and refuses an unknown code", async () => {
  // It is the link in the posts, so it must answer without a credential - and
  // must never redirect somewhere it was not told to.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base) => {
    const unknown = await fetch(`${base}/go/not-a-real-code`, { redirect: "manual" });
    assert.equal(unknown.status, 404, "an unknown code is a 404, never a redirect");
    assert.equal(unknown.headers.get("location"), null);
  });
});

test("the publish gate says whether each post carries an offer, so a missing disclosure is only red when it matters", async () => {
  // The page turned every offer-less post red ("PR表記が入っていません") because
  // it only knew whether the disclosure string was empty, not whether the post
  // owed one. Half of every slate carries no offer, and the first-week
  // instructions tell the operator never to approve a red post.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    const atProposal = unwrap(await company.orchestrator.runCycle("main"));
    const proposal = (await company.store.decisions.get(atProposal.pendingDecisionId as string))!;
    unwrap(
      await company.orchestrator.resolveGate(proposal.id, {
        decidedBy: "tester",
        // The first two of the demo slate: one carries an offer, one does not.
        selectedIds: proposal.items.slice(0, proposal.selectionHint.max).map((item) => item.id),
        nowIso: company.clock.nowIso(),
      }),
    );

    const response = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${handle.token}` } });
    assert.equal(response.status, 200);
    const state = (await response.json()) as {
      pending: { gateLabel: string; items: { post?: string; disclosure?: string; hasOffer?: boolean }[] }[];
    };
    const publish = state.pending.find((decision) => decision.gateLabel === "投稿の承認と順番");
    assert.ok(publish, "the cycle should be waiting at the publish gate");

    for (const item of publish.items) {
      assert.equal(typeof item.post, "string", "the text being approved is shown as-is");
      assert.equal(typeof item.hasOffer, "boolean", "each post says whether it owes a disclosure");
      if (item.hasOffer) {
        assert.notEqual(item.disclosure, "", "a post with an offer never reaches the gate without one");
      }
    }
    assert.ok(
      publish.items.some((item) => item.hasOffer === false),
      "the demo slate mixes offer and no-offer posts; without one of each this test proves nothing",
    );
  });
});

test("the console carries the portfolio and the scout's proposals, and accepting one returns the block to paste", async () => {
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
    unwrap(await runScout(company.services, { count: 1 }));

    const state = (await (await fetch(`${base}/api/state`, { headers })).json()) as {
      proposals: { id: string }[];
      portfolio: { rows: { ventureId: string; measurement: string; measurementStep?: string }[] };
    };
    assert.equal(state.portfolio.rows.length, 1);
    const row = state.portfolio.rows[0]!;
    assert.equal(row.ventureId, "main");
    // The test config runs on simulated adapters, so the chain is open at the
    // first step that needs a real one. Asserted rather than assumed, because
    // the interesting part is what an open chain says: on a host there is no
    // terminal to run `doctor` in, so *which* step is open travels with the row.
    assert.equal(row.measurement, "INCOMPLETE");
    assert.equal(row.measurementStep, "engagement");
    assert.equal(state.proposals.length, 1);

    const accept = await fetch(`${base}/api/proposals/${state.proposals[0]!.id}/accept`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(accept.status, 200);
    const body = (await accept.json()) as { block?: string; written?: boolean };
    assert.match(body.block ?? "", /- id: /, "the block is shown, the config is never written");

    const again = await fetch(`${base}/api/proposals/${state.proposals[0]!.id}/dismiss`, { method: "POST", headers, body: "{}" });
    assert.equal(again.status, 409);

    // The console's runtime has no real config file, so the append reports that
    // it could not write and hands the block back - the CLI smoke test covers
    // the write itself.
    assert.equal(body.written, false);

    // The page polls every thirty seconds; the accepted proposal must still
    // be there, with its block, or the operator loses the one thing accepting
    // produced.
    const after = (await (await fetch(`${base}/api/state`, { headers })).json()) as {
      proposals: { id: string; status: string; block?: string }[];
    };
    const kept = after.proposals.find((entry) => entry.id === state.proposals[0]!.id) as
      | { status: string; block?: string; appended?: boolean }
      | undefined;
    assert.equal(kept?.status, "accepted");
    assert.match(kept?.block ?? "", /- id: /);
    assert.equal(kept?.appended, false, "the page must not claim the block reached the config when it did not");

    const unauthenticated = await fetch(`${base}/api/proposals/${state.proposals[0]!.id}/accept`, { method: "POST", body: "{}" });
    assert.equal(unauthenticated.status, 401);
  });
});

test("an account can be switched off and on from the console, and the table says so at once", async () => {
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle) => {
    const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
    const rows = async () =>
      ((await (await fetch(`${base}/api/state`, { headers })).json()) as { portfolio: { rows: { ventureId: string; state: string; deactivated?: { reason: string } }[] } })
        .portfolio.rows;

    assert.equal((await rows())[0]!.state, "active");

    const off = await fetch(`${base}/api/ventures/main/deactivate`, { method: "POST", headers, body: JSON.stringify({ note: "季節が終わった" }) });
    assert.equal(off.status, 200);
    const afterOff = (await rows())[0]!;
    assert.equal(afterOff.state, "deactivated", "the memoised table must be forgotten on a switch");
    assert.equal(afterOff.deactivated?.reason, "季節が終わった");

    const on = await fetch(`${base}/api/ventures/main/activate`, { method: "POST", headers, body: "{}" });
    assert.equal(on.status, 200);
    assert.equal((await rows())[0]!.state, "active");

    assert.equal((await fetch(`${base}/api/ventures/nope/deactivate`, { method: "POST", headers, body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/api/ventures/main/deactivate`, { method: "POST", body: "{}" })).status, 401);
  });
});

test("a path that walks out of /go/ does not reach an authenticated route", async () => {
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base) => {
    const response = await fetch(`${base}/go/../api/state`, { redirect: "manual" });
    assert.notEqual(response.status, 200, "traversal must not hand out state without a token");
  });
});
