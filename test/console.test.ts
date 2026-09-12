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
import { createTestCompany, refusingProvider, testConfig, BASE_CONFIG, type TestCompany } from "./helpers.ts";
import type { MockProvider } from "../src/llm/mock.ts";
import type { Lock } from "../src/storage/lock.ts";
import { CYCLES_LOCK } from "../src/scheduler/tick.ts";
import { CYCLE_FAILURE_CODES, CYCLE_STATUS_LABELS, CYCLE_STEP_LABELS, FAILURE_SUMMARIES } from "../src/console/labels.ts";
import { renderPage } from "../src/console/ui.ts";
import { LOCALES, MESSAGES } from "../src/console/messages.ts";
import { readFileSync } from "node:fs";
import { repoRoot } from "../src/config/load.ts";
import { CYCLE_STEPS } from "../src/core/types.ts";
import { unwrap } from "../src/core/result.ts";
import { runScout } from "../src/kernel/exploration.ts";
import type { Runtime } from "../src/runtime.ts";
import type { ReleaseStamp } from "../src/core/release.ts";
import { fileState } from "../src/kernel/state.ts";
import { openPage } from "./page-harness.ts";

/**
 * A console backed by the test company. `startConsole` only reads `config`,
 * `services` and `loaded.dataDir`, so the in-memory company is enough.
 */
async function withConsole(
  env: Record<string, string | undefined>,
  body: (base: string, handle: ConsoleHandle, company: TestCompany) => Promise<void>,
  options: {
    llm?: MockProvider;
    lock?: Lock;
    operators?: { name: string; tokenEnv: string }[];
    locale?: "ja" | "en";
    release?: ReleaseStamp;
  } = {},
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
      console: {
        ...BASE_CONFIG.console,
        enabled: true,
        port: 20000 + Math.floor(Math.random() * 20000),
        ...(options.operators ? { operators: options.operators } : {}),
        ...(options.locale ? { locale: options.locale } : {}),
      },
    }),
    ...(options.llm ? { llm: options.llm } : {}),
  });
  const runtime = {
    loaded: { config: company.config, path: "test", dataDir, promptsDir: "prompts" },
    config: company.config,
    state: fileState(dataDir),
    services: company.services,
    orchestrator: company.orchestrator,
    bus: company.services.bus,
    ...(options.lock ? { lock: options.lock } : {}),
    ...(options.release ? { release: options.release } : {}),
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

test("a failed day tells the operator why, on the page that is all they have", async () => {
  // A real deploy came up red with `2026-09-09 failed → write` in this cell and
  // nothing else on the page; the reason had gone to a log there is no terminal
  // to read. It took a query against the database to find out the API had
  // refused the call.
  await withConsole(
    { AMP_TEST_TOKEN: "a-real-token-value" },
    async (base, handle, company) => {
      const headers = { authorization: `Bearer ${handle.token}` };
      const cycle = unwrap(await company.orchestrator.runCycle("main"));
      const decision = await company.store.decisions.get(cycle.pendingDecisionId as string);
      const failed = await company.orchestrator.resolveGate(cycle.pendingDecisionId as string, {
        decidedBy: "tester",
        selectedIds: decision!.items.filter((item) => item.recommended).map((item) => item.id),
        nowIso: company.clock.nowIso(),
      });
      assert.equal(failed.ok, false, "the writer's model call was refused, so the day ends here");

      const state = (await (await fetch(`${base}/api/state`, { headers })).json()) as {
        portfolio: { rows: { lastCycle?: { status: string; nextStep?: string; failure?: string } }[] };
      };
      const row = state.portfolio.rows[0]!;
      assert.equal(row.lastCycle?.status, "failed");
      assert.equal(row.lastCycle?.nextStep, "write");
      assert.match(
        row.lastCycle?.failure ?? "",
        /credit balance is too low/,
        "the step alone does not tell the operator what to do next",
      );
    },
    { llm: refusingProvider({ "write.draft": "your credit balance is too low" }) },
  );
});

/** The page's one inline script, as the browser receives it. */
function pageScript(locale: "ja" | "en"): string {
  const page = renderPage({ companyName: "テスト", locale });
  const scripts = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
  assert.equal(scripts.length, 1, "the page is supposed to carry exactly one script");
  return scripts[0]!;
}

test("an account that has never run can still be started", async () => {
  // The Run button and the box that reports an error hung off `lastCycle`, so
  // a fresh deploy - or a scout proposal accepted an hour ago - showed
  // まだ一度も動いていません and nothing to press. The error box not existing
  // was the worse half: 非アクティブにする failing had nowhere to say so.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    const detail = await (
      await fetch(`${base}/api/ventures/main`, { headers: { authorization: `Bearer ${handle.token}` } })
    ).json() as { lastCycle?: unknown };
    assert.equal(detail.lastCycle, undefined, "this account is supposed to have never run");

    const page = await openPage({ base, token: handle.token, hash: "#/ventures/main", until: "venture-cycle" });
    const card = page.html("venture-cycle");
    assert.match(card, /まだ一度も動いていません/);
    assert.match(card, /data-venture-run="1"/, "there is no way to start this account");
    assert.match(card, /id="verr-main"/, "an error on this screen would have nowhere to go");
    // And it does not promise to resume a step that never happened.
    assert.doesNotMatch(card, /止まったステップ/);

    void company;
  });
});

test("the page renders its own words, not its placeholders", async () => {
  // fmt's pattern reached the browser as /{(w+)}/ because a lone backslash is
  // eaten by the template literal the page is written in. It parses, so the
  // parse test below cannot see it; every {n} and {step} on the page simply
  // stayed as it was written, and nobody noticed because no test ever ran the
  // page. This one does.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle) => {
    const page = await openPage({ base, token: handle.token, until: "portfolio" });
    const everything = [...page.elements.values()].map((el) => el.innerHTML + el.textContent).join("\n");
    assert.doesNotMatch(everything, /\{(n|step|days|name|reason|gate|venture|text)\}/, "a placeholder reached the screen");
    // The accounts heading is fmt("accounts.heading", { days }) - proof that
    // substitution happened at all, rather than the pattern matching nothing.
    assert.match(page.elements.get("accounts-head")?.textContent ?? "", /全アカウント — 直近\d+日/);
  });
});

test("the page the browser gets is a program it can parse", () => {
  // It was not. `(s) => {"running":"動作中"}[s]` parses the brace as a block,
  // so the module died at the first colon and every line of this page's
  // behaviour with it - the console sat on 読み込み中… and nothing else moved.
  // Nothing here noticed, because every other test reads the page as text.
  for (const locale of ["ja", "en"] as const) {
    assert.doesNotThrow(() => new Function(pageScript(locale)), `the ${locale} page does not parse`);
  }
});

test("exactly two backticks in ui.ts are not escaped: the ones holding the page", () => {
  // Three times now, a backtick written inside a *comment* has closed the
  // literal the whole page lives in. Twice the typechecker caught it; the
  // third time it would not have, because backticks come in pairs — a pair
  // inside a comment closes the literal and opens a new one, which can still
  // typecheck while splicing source code into the HTML a browser receives.
  //
  // So: the file is one template literal, and only its own two ends may be
  // bare. Everything else — including prose about template literals — is
  // escaped or rewritten.
  const source = readFileSync(join(repoRoot(), "src/console/ui.ts"), "utf8");
  const bare: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "`") continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && source[j] === "\\"; j -= 1) slashes += 1;
    if (slashes % 2 === 0) bare.push(source.slice(0, i).split("\n").length);
  }
  assert.deepEqual(
    bare.length,
    2,
    `expected the opening and closing backtick only, found ${bare.length} on lines ${bare.join(", ")}`,
  );
});

test("every CSS variable the page uses is one the page defines", () => {
  // A colour written as var(--fg) when the token is --ink typechecks, renders,
  // and passes every test here: the browser silently drops the declaration and
  // the element inherits whatever was above it. Nothing in a text assertion can
  // see that, so the names are checked against each other directly.
  const page = renderPage({ companyName: "テスト" });
  const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));

  const names = (pattern: RegExp): string[] =>
    [...style.matchAll(pattern)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

  const defined = new Set(names(/(--[a-z-]+)\s*:/g));
  const undefinedNames = new Set(names(/var\((--[a-z-]+)/g).filter((name) => !defined.has(name)));
  assert.deepEqual(
    [...undefinedNames],
    [],
    `the page reads CSS variables it never defines: ${[...undefinedNames].join(", ")}`,
  );
});

test("who you are approving as is not drawn as part of the day's status", () => {
  // These were one grey span joined by "・": a name that never changes all
  // session sitting at the same weight as a count that changes on every poll.
  // The name read as a role, and both got skipped. They are separate elements
  // now, and the count lives against the heading of the thing it counts.
  const page = renderPage({ companyName: "テスト" });

  const header = page.slice(page.indexOf("<header>"), page.indexOf("</header>"));
  assert.match(header, /id="who"/, "the operator's name belongs in the header furniture");
  assert.doesNotMatch(header, /id="decision-count"/, "the count does not belong in the header");

  const decisions = page.slice(page.indexOf('<section id="decisions">'), page.indexOf('<div id="decision-list"'));
  assert.match(decisions, /id="decision-count"/, "the count belongs against the heading it counts");

  // The one place a count is worth having is a tab nobody is looking at.
  assert.match(page, /document\.title = .*baseTitle/, "a background tab should say how many are waiting");
});

test("no escape on the page was eaten by the template literal it lives in", () => {
  // ui.ts is one template literal, so `\w` reaches the browser as `w`. Both of
  // these still *parse*, which is why the test above cannot see them:
  //   fmt's /\{(\w+)\}/  became  /{(w+)}/   - no placeholder was ever filled
  //   the router's /^#\/ventures\//  became  /^#/ventures/  - a syntax error
  // A backslash in this file is right only when it is doubled, or when it is
  // escaping a backtick or a ${ for a nested template.
  const source = readFileSync(join(repoRoot(), "src/console/ui.ts"), "utf8");
  for (const match of source.matchAll(/\\+/g)) {
    if (match[0].length % 2 === 0) continue;
    const next = source.slice(match.index + match[0].length, match.index + match[0].length + 1);
    if (next === "`" || next === "$") continue;
    const line = source.slice(0, match.index).split("\n").length;
    assert.fail(
      `src/console/ui.ts:${line} has a lone backslash before "${next}". ` +
        `The browser will not see it - double it.`,
    );
  }

  // And the two that were actually wrong, in the form the browser must get.
  const script = pageScript("ja");
  assert.match(script, /\/\\\{\(\\w\+\)\\\}\/g/, "fmt's placeholder pattern");
  assert.match(script, /\/\^#\\\/ventures\\\//, "the hash router's pattern");
});

test("a day still running is never reported as a failed one", async () => {
  // Every screen keys the failure off the code being present rather than off
  // the status, so a cycle carrying a stale failure read 実行できませんでした
  // while it sat at an approval gate - beside a step it had already passed.
  // The orchestrator clears the failure now; this is the guard on the reader.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    const headers = { authorization: `Bearer ${handle.token}` };
    const cycle = unwrap(await company.orchestrator.runCycle("main"));
    assert.equal(cycle.status, "awaiting_approval");
    await company.store.cycles.put({
      ...cycle,
      failure: { step: "analyze", message: "400 This model does not support the effort parameter.", code: "llm.bad_request" },
    });

    const state = (await (await fetch(`${base}/api/state`, { headers })).json()) as {
      portfolio: { rows: { lastCycle?: { status: string; failure?: string; failureCode?: string } }[] };
    };
    const last = state.portfolio.rows[0]!.lastCycle;
    assert.equal(last?.status, "awaiting_approval");
    assert.equal(last?.failureCode, undefined, "the list would print a verdict on a day that is still going");
    assert.equal(last?.failure, undefined);
  });
});

test("the activity feed says the day died, in the operator's words", async () => {
  // It used to say nothing at all: the orchestrator wrote the failure to the
  // cycle and to a logger, and the feed reads the audit log. Two days ended
  // that way on Cloudflare under a heading that said 最近の動き.
  await withConsole(
    { AMP_TEST_TOKEN: "a-real-token-value" },
    async (base, handle, company) => {
      const headers = { authorization: `Bearer ${handle.token}` };
      const cycle = unwrap(await company.orchestrator.runCycle("main"));
      const decision = await company.store.decisions.get(cycle.pendingDecisionId as string);
      assert.equal(
        (
          await company.orchestrator.resolveGate(cycle.pendingDecisionId as string, {
            decidedBy: "tester",
            selectedIds: decision!.items.filter((item) => item.recommended).map((item) => item.id),
            nowIso: company.clock.nowIso(),
          })
        ).ok,
        false,
      );

      const state = (await (await fetch(`${base}/api/state`, { headers })).json()) as {
        activity: { type: string; summary: string; failureCode?: string; failureStep?: string }[];
      };
      const entry = state.activity.find((item) => item.type === "cycle.failed");
      assert.ok(entry, "the feed has no entry for the day that ended");
      // The page renders these two, not the stored English sentence.
      assert.equal(entry.failureStep, "write");
      assert.equal(FAILURE_SUMMARIES[entry.failureCode ?? ""]?.short, "実行できませんでした");
    },
    { llm: refusingProvider({ "write.draft": "your credit balance is too low" }) },
  );
});

test("every step and state a cycle can be in has a word the operator can read", () => {
  // The cell read `2026-09-09 failed → write` on a page that is otherwise
  // entirely Japanese, to somebody with no terminal to look "write" up in. The
  // labels fall back to the identifier, so a step added later without a word
  // reads exactly the way that one did.
  for (const step of CYCLE_STEPS) {
    assert.ok(CYCLE_STEP_LABELS[step], `the cycle step "${step}" needs a Japanese label`);
    assert.doesNotMatch(CYCLE_STEP_LABELS[step], /[a-z_]/, `"${step}" is still its own identifier`);
  }
  for (const status of ["running", "awaiting_approval", "completed", "failed", "cancelled"] as const) {
    assert.ok(CYCLE_STATUS_LABELS[status], `the cycle status "${status}" needs a Japanese label`);
  }
  // And they reach the page, which builds them in rather than repeating them.
  const page = renderPage({ companyName: "テスト" });
  assert.match(page, /承認待ち/);
  assert.match(page, /執筆/);
});

test("two operators are two names in the record, not one", async () => {
  // The reason this exists at all. With one shared passphrase every approval
  // was recorded against `company.operator`, whoever pressed it - and an
  // approval cannot be attributed afterwards. The day a second person starts
  // operating, the whole history becomes "one of two".
  await withConsole(
    { AMP_TEST_TOKEN: "the-owners-passphrase", AMP_TEST_TOKEN_MIDORI: "midoris-own-passphrase" },
    async (base, _handle, company) => {
      const cycle = unwrap(await company.orchestrator.runCycle("main"));
      const decisionId = cycle.pendingDecisionId as string;
      const decision = await company.store.decisions.get(decisionId);

      const resolved = await fetch(`${base}/api/decisions/${decisionId}/resolve`, {
        method: "POST",
        headers: { authorization: "Bearer midoris-own-passphrase", "content-type": "application/json" },
        body: JSON.stringify({
          selectedIds: decision!.items.filter((item) => item.recommended).map((item) => item.id),
          ordering: [],
        }),
      });
      assert.equal(resolved.status, 200, "her own passphrase opens every route the owner's does");

      const after = await company.store.decisions.get(decisionId);
      assert.equal(
        after?.resolution?.decidedBy,
        "みどり",
        "the record has to name who pressed it, not who owns the company",
      );

      // And the page says whose passphrase this is, before anything is pressed.
      const state = (await (
        await fetch(`${base}/api/state`, { headers: { authorization: "Bearer midoris-own-passphrase" } })
      ).json()) as { you?: string };
      assert.equal(state.you, "みどり");

      const owner = (await (
        await fetch(`${base}/api/state`, { headers: { authorization: "Bearer the-owners-passphrase" } })
      ).json()) as { you?: string };
      assert.equal(owner.you, "tester", "and the owner is still the owner");
    },
    { operators: [{ name: "みどり", tokenEnv: "AMP_TEST_TOKEN_MIDORI" }] },
  );
});

test("one useless credential does not throw away a good one in the same request", async () => {
  // A request carries up to three: a Bearer header, ?token=, and the cookie.
  // Taking whichever was present first meant an emptied ?token= in a bookmark
  // - "" is present, not absent - beat the cookie sitting beside it and 401'd
  // a session that was working a second earlier.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle) => {
    const cookie = { cookie: `amp_console=${handle.token}` };

    for (const [what, url, headers] of [
      ["an emptied ?token=", `${base}/api/state?token=`, cookie],
      ["a stale ?token=", `${base}/api/state?token=last-months-value`, cookie],
      ["a stale Bearer", `${base}/api/state`, { ...cookie, authorization: "Bearer last-months-value" }],
    ] as const) {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200, `${what} logged the holder out`);
    }

    // And nothing was loosened: three useless credentials are still nobody.
    const refused = await fetch(`${base}/api/state?token=`, {
      headers: { authorization: "Bearer nope", cookie: "amp_console=" },
    });
    assert.equal(refused.status, 401);
  });
});

test("a stale token in the address does not overwrite the cookie that let you in", async () => {
  // The page hands back a cookie so the token can leave the URL. Once any of
  // the three credentials admits a request, storing whichever one was in the
  // address would replace a good cookie with a dead bookmark - a logout on the
  // next click, from a page that had just loaded.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle) => {
    const stale = await fetch(`${base}/?token=last-months-value`, {
      headers: { cookie: `amp_console=${handle.token}` },
    });
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("set-cookie"), null, "the good cookie was about to be replaced with a dead one");

    const real = await fetch(`${base}/?token=${handle.token}`);
    assert.match(real.headers.get("set-cookie") ?? "", /amp_console=/, "a real token still moves out of the URL");
  });
});

test("an operator whose passphrase is not set cannot get in on an empty one", async () => {
  // The listed-but-unset case. An empty secret must never be satisfiable, and
  // the operator must not silently become "anyone".
  await withConsole(
    { AMP_TEST_TOKEN: "the-owners-passphrase", AMP_TEST_TOKEN_MIDORI: "" },
    async (base) => {
      for (const headers of [{ authorization: "Bearer " }, { cookie: "amp_console=" }]) {
        const response = await fetch(`${base}/api/state`, { headers });
        assert.equal(response.status, 401, `${JSON.stringify(headers)} must not authenticate`);
      }
      const owner = await fetch(`${base}/api/state`, {
        headers: { authorization: "Bearer the-owners-passphrase" },
      });
      assert.equal(owner.status, 200, "and the owner is unaffected");
    },
    { operators: [{ name: "みどり", tokenEnv: "AMP_TEST_TOKEN_MIDORI" }] },
  );
});

test("the account behind a row carries what the list deliberately does not", async () => {
  // The list compares; this is the screen that understands one account. The
  // whole failure lives here, with the history, the numbers and the config
  // that is actually in force - so nobody has to query the database to find
  // out why a day went red, which is what actually happened.
  await withConsole(
    { AMP_TEST_TOKEN: "a-real-token-value" },
    async (base, handle, company) => {
      const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
      const cycle = unwrap(await company.orchestrator.runCycle("main"));
      const decision = await company.store.decisions.get(cycle.pendingDecisionId as string);
      await company.orchestrator.resolveGate(cycle.pendingDecisionId as string, {
        decidedBy: "tester",
        selectedIds: decision!.items.filter((item) => item.recommended).map((item) => item.id),
        nowIso: company.clock.nowIso(),
      });

      const detail = (await (await fetch(`${base}/api/ventures/main`, { headers })).json()) as {
        ventureId: string;
        lastCycle?: { failure?: string; failureCode?: string; failureStep?: string };
        recentCycles: { date: string; status: string; failureCode?: string }[];
        approvedRevenue: string;
        setup: {
          path: string;
          configPath: string;
          niche: string;
          channels: string[];
          offers: { name: string; crossBorder: boolean }[];
          market?: { id: string; disclosureText: string };
        };
      };

      assert.equal(detail.ventureId, "main");
      assert.match(detail.lastCycle?.failure ?? "", /credit balance is too low/, "the whole reason, not a summary");
      assert.equal(detail.lastCycle?.failureCode, "write.all_failed", "and the code the screen picks its words from");
      assert.equal(detail.lastCycle?.failureStep, "write");
      assert.equal(detail.recentCycles.length, 1, "the day that ran is in the history");

      // What is in force for this account, so the operator does not have to
      // open the YAML to read it - each field with where it came from.
      assert.equal(detail.setup.path, "ventures[0]");
      assert.equal(detail.setup.niche, "AI活用");
      assert.deepEqual(detail.setup.channels, ["threads"]);
      assert.equal(detail.setup.offers[0]?.name, "テスト商材");
      assert.equal(detail.setup.market?.id, "jp");
      assert.equal(detail.setup.market?.disclosureText, "#PR", "the disclosure follows the reader's market");
      assert.match(detail.approvedRevenue, /¥|JPY|0/, "money formatted per currency, never summed");

      const missing = await fetch(`${base}/api/ventures/not-an-account`, { headers });
      assert.equal(missing.status, 404);
    },
    { llm: refusingProvider({ "write.draft": "your credit balance is too low" }) },
  );
});

test("the console speaks the language console.locale asks for", () => {
  // The strings used to be Japanese because they were written into ui.ts, which
  // made the screen's language something only a fork could change - the one
  // thing this project says a licensee should never have to do.
  const ja = renderPage({ companyName: "テスト", locale: "ja" });
  assert.match(ja, /<html lang="ja">/);
  assert.match(ja, /あなたの判断待ち/);
  assert.doesNotMatch(ja, /Waiting on you/);

  const en = renderPage({ companyName: "Test Co", locale: "en" });
  assert.match(en, /<html lang="en">/);
  assert.match(en, /Waiting on you/);
  assert.doesNotMatch(en, /あなたの判断待ち/);

  // An unknown locale is the default, not a blank page.
  assert.match(renderPage({ companyName: "x", locale: "de" as never }), /あなたの判断待ち/);

  // Both languages say everything. `en` is typed against `ja`, so a missing key
  // is a compile error - this is the runtime half: no key left holding the
  // other language's words.
  const jaKeys = Object.keys(MESSAGES.ja);
  assert.deepEqual(Object.keys(MESSAGES.en), jaKeys);
  for (const key of jaKeys) {
    const value = MESSAGES.en[key as keyof typeof MESSAGES.en];
    assert.ok(value.trim().length > 0, `${key} is empty in en`);
    assert.doesNotMatch(value, /[ぁ-んァ-ヶ一-龠]/, `${key} was never translated: ${value}`);
  }
});

test("console.locale: en reaches the two screens the operator works in", async () => {
  // Half of what those screens show is rendered by the server, and those
  // strings were written straight into router.ts. `locale: en` gave an English
  // shell around a Japanese gate and a Japanese row of numbers - and the
  // gate's own question came back English in both languages, because that one
  // lives in the CLI's vocabulary.
  await withConsole(
    { AMP_TEST_TOKEN: "a-real-token-value" },
    async (base, handle, company) => {
      unwrap(await company.orchestrator.runCycle("main"));
      const state = (await (
        await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${handle.token}` } })
      ).json()) as {
        pending: { gateLabel: string; question: string; items: { chips: { label: string }[]; preview: string }[] }[];
        stats: { label: string }[];
      };

      const japanese = /[ぁ-んァ-ヴ一-龯]/;
      const gate = state.pending[0]!;
      assert.match(gate.gateLabel, /Proposals/);
      assert.match(gate.question, /Which of today/);
      for (const stat of state.stats) {
        assert.doesNotMatch(stat.label, japanese, `the numbers row is still Japanese: ${stat.label}`);
      }
      // What the model wrote stays in the venture's language - the drafts are
      // for Japanese readers whoever is reading the console. So this checks
      // the words the console owns: every chip opens with one of them, and the
      // preview's field names are the console's.
      for (const item of gate.items) {
        for (const chip of item.chips) {
          assert.doesNotMatch(chip.label[0] ?? "", japanese, `a chip opens in Japanese: ${chip.label}`);
        }
        assert.match(item.preview, /Angle:|Rationale:|Risk:|Why this slot:/, "the preview's field names are Japanese");
        assert.doesNotMatch(item.preview, /狙い:|根拠:|リスク:|枠の理由:/);
      }
    },
    { locale: "en" },
  );
});

test("and in Japanese the gate asks its question in Japanese", async () => {
  // The other half of the same bug: describeGate is the CLI's sentence, and a
  // terminal is English here on purpose. It was going to the console too.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const state = (await (
      await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${handle.token}` } })
    ).json()) as { pending: { question: string; gateLabel: string }[] };
    assert.match(state.pending[0]!.question, /どれを書きますか/);
    assert.match(state.pending[0]!.gateLabel, /企画の承認/);
  });
});

test("the screen's language is never the disclosure's language", () => {
  // A US offer promoted to Japanese readers is governed by 景表法 whatever
  // language the operator reads the console in. The disclosure comes from the
  // venture's market, and nothing in the message table may be reachable from
  // that path.
  const source = readFileSync(join(repoRoot(), "src", "console", "messages.ts"), "utf8");
  assert.doesNotMatch(source, /disclosureText\s*[:=]/, "the message table must not carry a disclosure");
  for (const locale of LOCALES) {
    for (const value of Object.values(MESSAGES[locale])) {
      assert.doesNotMatch(value, /#PR|#ad/, "a disclosure string has no business in the console's chrome");
    }
  }
  // And the account's settings screen reads it from the market, not from here.
  assert.match(renderPage({ companyName: "x" }), /setup\.market\.disclosureText/);
});

test("the accounts list compares, and the only control it keeps is 開く", () => {
  // Deactivate, reactivate and run moved to the account screen. A row that is
  // also a control panel stops reading as a comparison - which is how a whole
  // API error ended up in a table cell and took the other nine columns with it.
  const page = renderPage({ companyName: "テスト" });
  assert.match(page, /class="open" href="#\/ventures\//, "a row opens the account");
  const rowMarkup = page.slice(page.indexOf("portfolio.rows.map"), page.indexOf("wireColumnResize"));
  assert.doesNotMatch(rowMarkup, /data-venture-act/, "deactivate belongs to the account screen");
  assert.doesNotMatch(rowMarkup, /data-venture-run/, "so does running a day");
  // And the account screen has them. The words themselves live in the message
  // table now, so what the screen owns is the control, keyed.
  const ventureMarkup = page.slice(page.indexOf("function renderVenture"));
  assert.match(ventureMarkup, /T\["switch.deactivate"\]/);
  assert.match(ventureMarkup, /T\["venture.run"\]/);
  assert.match(ventureMarkup, /data-venture-act="activate"/);
  assert.match(ventureMarkup, /data-venture-run="1"/);
});

test("a failed day is summarised from its code, never from the API's sentence", () => {
  // Truncating the message lands mid-clause, in English, or before the word
  // that carried the meaning. The one that started this read:
  // `400 {"type":"error",...,"message":"output_config.format.schema: ...`
  for (const code of CYCLE_FAILURE_CODES) {
    const summary = FAILURE_SUMMARIES[code]!;
    assert.ok(summary.short.length > 0 && summary.short.length <= 20, `${code}: ${summary.short}`);
    assert.doesNotMatch(summary.short, /[a-z_]{3,}/, `${code} still shows its own identifier`);
  }
  // Every code the orchestrator itself can end a cycle on has words.
  for (const code of ["write.all_failed", "cycle.step_threw", "platform.stopped", "venture.deactivated"]) {
    assert.ok(FAILURE_SUMMARIES[code], `${code} has no words of its own`);
  }
  // The page carries the table, and falls back to the code rather than to a
  // blank - an unlabelled failure has to be visible, not silent.
  const page = renderPage({ companyName: "テスト" });
  assert.match(page, /実行できませんでした/);
  assert.match(page, /const failureSummary = \(code\) =>/);
  assert.match(page, /\|\| \{ short: code/, "an unknown code prints itself rather than nothing");
});

test("one long cell cannot crush the rest of the accounts table", () => {
  // A single API error in the 直近サイクル cell took the whole table: the other
  // nine columns were squeezed to a character wide and their headers rendered
  // one letter per line. Every column gets a width of its own, the table
  // scrolls inside its own container rather than being compressed, and the
  // operator can drag any border when a particular day needs a different shape.
  const page = renderPage({ companyName: "テスト" });

  const columns = [...page.matchAll(/\{ key: "[a-z]+", label: [^,]+, width: (\d+)/g)];
  assert.equal(columns.length, 11, "every column in the table needs a declared width");
  for (const [, width] of columns) {
    assert.ok(Number(width) >= 48, `a ${width}px column is narrower than its own header`);
  }

  assert.match(page, /table-layout:\s*fixed/, "auto layout is what let one cell take everything");
  assert.match(page, /<col style="width:/, "the widths have to reach the table as a colgroup");
  assert.match(page, /table\.grid th \{[^}]*white-space:\s*nowrap/, "a wrapped header reads downwards");
  assert.match(page, /\.table-wrap \{[^}]*overflow-x:\s*auto/, "wider than the window must scroll, not squeeze");
  assert.match(page, /col-resize/, "the operator adjusts a column by dragging its border");
  assert.match(page, /列の幅をもとに戻す/, "and can undo that without clearing site data");
});

test("the operator can start the day themselves, and not only wait for the schedule", async () => {
  // On a host there is no terminal to run `cycle run` in, so without this the
  // only way to start or retry a day is to wait for the next cron. Waiting is
  // not the same as deciding.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
    const before = await company.store.cycles.all();
    assert.equal(before.length, 0, "nothing has run yet");

    const response = await fetch(`${base}/api/ventures/main/run`, { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { cycleId: string; status: string; nextStep: string | null };
    assert.equal(body.status, "awaiting_approval");
    assert.equal(body.nextStep, "proposal_approval");
    assert.equal((await company.store.cycles.all()).length, 1);
  });
});

test("running from the console cannot race the schedule", async () => {
  // The cycles cron and this button both run a day. Two of them at once draft
  // it twice, and the operator is billed for both. They take the same lock, by
  // the same name - which is why that name is a constant and not a string in
  // two files.
  let asked: string | undefined;
  const busy: Lock = {
    async acquire(name) {
      asked = name;
      return undefined;
    },
  };
  await withConsole(
    { AMP_TEST_TOKEN: "a-real-token-value" },
    async (base, handle, company) => {
      const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
      const response = await fetch(`${base}/api/ventures/main/run`, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 409);
      assert.equal(asked, CYCLES_LOCK, "it has to be the tick's own lock, not a second one");
      assert.equal((await company.store.cycles.all()).length, 0, "and nothing may have run");
    },
    { lock: busy },
  );
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

/**
 * Answers the platform's own published files, and passes everything else
 * through to the console under test.
 *
 * The router reaches for the global `fetch`, which is right in production and
 * awkward here, because the page harness uses the same global to talk to the
 * console. Routing by host keeps both honest without an injection point that
 * exists only for tests.
 */
function withUpstream<T>(pages: Readonly<Record<string, string>>, body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  type FetchInput = Parameters<typeof fetch>[0];
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://raw.githubusercontent.com/")) return real(input, init);
    const page = pages[url];
    return page === undefined ? new Response("not found", { status: 404 }) : new Response(page, { status: 200 });
  }) as typeof fetch;
  return body().finally(() => {
    globalThis.fetch = real;
  });
}

const MINE: ReleaseStamp = {
  version: "0.2.0",
  commit: "aaaaaaa",
  builtAt: "2026-09-01T00:00:00.000Z",
  upstream: "owner/release",
};
const UP_STAMP = "https://raw.githubusercontent.com/owner/release/main/RELEASE.json";
const UP_LOG = "https://raw.githubusercontent.com/owner/release/main/CHANGELOG.md";

test("a licensee running a copy with a fix outstanding is told so, on the page they already open", async () => {
  // The requirement is that fixed things reach a person (requirements.md 6).
  // Everything before this commit satisfied it in the API and nowhere a human
  // looks, which is the same as not satisfying it.
  await withUpstream(
    {
      [UP_STAMP]: JSON.stringify({ ...MINE, commit: "bbbbbbb", version: "0.3.0" }),
      [UP_LOG]: "# Changelog\n\n## [0.3.0] - 2026-09-11\n\n### Fixed\n\n- 予約が1件だけ取り消せなかった\n",
    },
    async () => {
      await withConsole(
        { AMP_TEST_TOKEN: "a-real-token-value" },
        async (base, handle) => {
          const page = await openPage({ base, token: handle.token, until: "update" });
          const html = page.html("update");
          assert.match(html, /0\.3\.0/, "which release is waiting");
          assert.match(html, /0\.2\.0/, "and which one they are on");
          assert.match(html, /予約が1件だけ取り消せなかった/, "and what is actually in it");
          assert.match(html, /<details>/, "the notes are folded away, not competing with today's two decisions");
        },
        { release: MINE },
      );
    },
  );
});

test("the update notice renders what it fetched as text, never as markup", async () => {
  // The notes are whatever is published at the address this copy's stamp
  // names, and they land on a page that is already authenticated. A fork
  // pointing `upstream` somewhere hostile must get escaped text, not a script.
  await withUpstream(
    {
      [UP_STAMP]: JSON.stringify({ ...MINE, commit: "bbbbbbb", version: "0.3.0" }),
      [UP_LOG]: '# Changelog\n\n## [0.3.0]\n\n- <img src=x onerror="alert(1)"> and <script>alert(2)</script>\n',
    },
    async () => {
      await withConsole(
        { AMP_TEST_TOKEN: "a-real-token-value" },
        async (base, handle) => {
          const page = await openPage({ base, token: handle.token, until: "update" });
          const html = page.html("update");
          assert.doesNotMatch(html, /<img/, "an img tag must not survive into the page");
          assert.doesNotMatch(html, /<script>/, "nor a script tag");
          assert.match(html, /&lt;img/, "it is shown, escaped, so the licensee can still read the entry");
        },
        { release: MINE },
      );
    },
  );
});

test("a copy that is current, or cannot reach github, shows nothing at all", async () => {
  // A box that says "no news" is a third thing on a screen whose whole promise
  // is two decisions in thirty seconds.
  for (const pages of [
    { [UP_STAMP]: JSON.stringify(MINE) },
    {} as Record<string, string>,
  ]) {
    await withUpstream(pages, async () => {
      await withConsole(
        { AMP_TEST_TOKEN: "a-real-token-value" },
        async (base, handle) => {
          const page = await openPage({ base, token: handle.token, until: "decision-list" });
          assert.equal(page.html("update"), "", "nothing to say means nothing on the screen");
        },
        { release: MINE },
      );
    });
  }
});

test("two gates left open on different days are told apart, and the older one says so", async () => {
  // Reported from a running operation: "企画の承認 — メインアカウント" appeared
  // twice, stacked. It was not a repeated row. Nobody approved one day, so its
  // gate stayed open — which is the documented behaviour, the cycle is
  // supposed to survive a human who does not come — and the next day's opened
  // beside it. The card carried the gate and the account and nothing else, so
  // the two were the same sentence twice.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    const first = unwrap(await company.orchestrator.runCycle("main"));
    assert.equal(first.status, "awaiting_approval");

    // The next local day, with the first gate deliberately left standing.
    company.clock.advance(24 * 60 * 60 * 1000);
    const second = unwrap(await company.orchestrator.runCycle("main"));
    assert.notEqual(second.id, first.id, "a new day is a new cycle");

    const headers = { authorization: `Bearer ${handle.token}` };
    const state = (await (await fetch(`${base}/api/state`, { headers })).json()) as {
      pending: { id: string; day?: string; stale: boolean }[];
    };
    assert.equal(state.pending.length, 2, "both gates are still waiting");

    const days = state.pending.map((entry) => entry.day);
    assert.ok(days.every(Boolean), "every open gate has to say which day it is");
    assert.equal(new Set(days).size, 2, "and the two days have to differ, or the screen repeats itself");

    // The old one is not merely older. Approving it writes its posts, and the
    // dispatcher publishes anything whose slot is in the past — so the whole
    // day goes out at once, immediately. That has to be on the card before the
    // button is pressed.
    const older = state.pending.find((entry) => entry.day === days.slice().sort()[0]);
    assert.equal(older?.stale, true, "a day that has passed must be marked as passed");
    assert.equal(state.pending.find((entry) => entry !== older)?.stale, false, "and today's must not be");

    const page = await openPage({ base, token: handle.token, until: "decision-list" });
    const html = page.html("decision-list");
    for (const day of days) assert.ok(html.includes(day as string), `${day} has to be on the screen`);
    assert.match(html, /もう過ぎています/, "and the operator has to be told which one is stale");
  });
});

test("a gate for a day that has passed cannot be touched, only read", async () => {
  // Labelling it was not enough. Reported from the running operation: the
  // checkboxes still toggled and the button still looked pressable. Pressing
  // it is refused by the orchestrator, but a control that can be operated and
  // never works is worse than one that cannot — and before the hourly sweep
  // has run the gate is still `pending`, which is the window where pressing it
  // would have published a whole day at once.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    company.clock.advance(24 * 60 * 60 * 1000);
    unwrap(await company.orchestrator.runCycle("main"));

    const page = await openPage({ base, token: handle.token, until: "decision-list" });
    const html = page.html("decision-list");
    // Split on the open tag, not "<section>": a locked one carries a class now.
    const sections = html.split("<section").slice(1);
    assert.equal(sections.length, 2, "both gates are drawn");

    const stale = sections.find((section) => section.includes("もう過ぎています"));
    const today = sections.find((section) => !section.includes("もう過ぎています"));
    assert.ok(stale && today);

    for (const fragment of (stale as string).match(/<input[^>]*>/g) ?? []) {
      assert.match(fragment, /disabled/, "every box on a day that has gone is shut");
    }
    assert.match(stale as string, /data-act="submit"[^>]*disabled/, "and so is approving it");

    // And it has to *look* shut. `disabled` on its own greys a tick and
    // nothing else, so a card nobody can act on was indistinguishable from one
    // they could - which is how this was reported: "it is not greyed out".
    assert.match(html, /<section class="locked">/, "the whole gate is drawn as closed");
    assert.match(stale as string, /class="gate-stale"/, "and the day it was for is the line that stays readable");

    // Today's is untouched: the point is the day, not a blanket lockdown.
    assert.doesNotMatch(today as string, /data-act="submit"[^>]*disabled/);
  });
});

test("the cap on a gate is a thing you cannot exceed, not a thing you are told about afterwards", async () => {
  // The screen said "最大 3 件" and let four be ticked; the server then refused
  // the submission. The operator builds an invalid choice and finds out at the
  // end — on a screen whose whole promise is thirty seconds.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    const cycle = unwrap(await company.orchestrator.runCycle("main"));
    const gate = (await company.store.decisions.get(cycle.pendingDecisionId as string))!;
    assert.ok(gate.items.length > gate.selectionHint.max, "this test needs more ideas than the cap");

    const page = await openPage({ base, token: handle.token, until: "decision-list" });
    const html = page.html("decision-list");

    // `assisted` preselects the recommendations, and the fixture recommends up
    // to the cap — so the page opens already full, which is exactly the state
    // where the untouched boxes have to be closed.
    const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    assert.equal(boxes.length, gate.items.length);
    const checked = boxes.filter((box) => box.includes("checked"));
    assert.equal(checked.length, gate.selectionHint.max, "opens at the cap");

    for (const box of boxes) {
      if (box.includes("checked")) {
        assert.doesNotMatch(box, /disabled/, "a chosen one stays live, so a choice can be swapped");
      } else {
        assert.match(box, /disabled/, "an unchosen one closes while the cap is reached");
      }
    }

    assert.match(html, /件選びました/, "and the screen says why, or it just looks broken");

    // Recessed, not faded: at the cap the way out is to untick something and
    // pick this one instead, so it still has to be readable.
    const shutCards = html.match(/<div class="card shut">/g) ?? [];
    assert.equal(
      shutCards.length,
      gate.items.length - gate.selectionHint.max,
      "every box that closed is on a card drawn as closed",
    );
  });
});

test("a day can be read back from the console, and only that account's", async () => {
  await withConsole({ AMP_TEST_TOKEN: "tok-timeline" }, async (base, _handle, company) => {
    const auth = { cookie: "amp_console=tok-timeline" };
    const cycle = unwrap(await company.orchestrator.runCycle("main"));

    const ok = await fetch(`${base}/api/ventures/main/cycles/${cycle.date}`, { headers: auth });
    assert.equal(ok.status, 200);
    const day = (await ok.json()) as { entries: { step: string; items: { detail: string }[] }[] };

    // What the operating promise is actually about: not that the day ran, but
    // that a person can read why each idea was argued for.
    const plan = day.entries.find((entry) => entry.step === "plan");
    assert.ok(plan, "the planning step is there");
    assert.ok(plan.items.length > 0, "with the ideas themselves");
    assert.match(plan.items[0]?.detail ?? "", /根拠:/);

    const missing = await fetch(`${base}/api/ventures/main/cycles/1999-01-01`, { headers: auth });
    assert.equal(missing.status, 404);

    // An account that is not in the config cannot be used to reach a store.
    const stranger = await fetch(`${base}/api/ventures/not-an-account/cycles/${cycle.date}`, { headers: auth });
    assert.equal(stranger.status, 404);

    // The same wall as every other route: a day's ideas are not public.
    const anonymous = await fetch(`${base}/api/ventures/main/cycles/${cycle.date}`);
    assert.equal(anonymous.status, 401);
  });
});

test("reading a day back is not on the path the operator walks every morning", async () => {
  // The product promises two decisions a day at thirty seconds each. This
  // screen reads five collections for one date; putting it in the payload the
  // day's page re-fetches every 30 seconds is how that promise gets lost.
  await withConsole({ AMP_TEST_TOKEN: "tok-sep" }, async (base, _handle, company) => {
    const auth = { cookie: "amp_console=tok-sep" };
    unwrap(await company.orchestrator.runCycle("main"));

    const state = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as Record<string, unknown>;
    assert.equal(state["timeline"], undefined, "the day's own payload does not carry it");
    assert.ok(Array.isArray(state["pending"]), "and still carries what the operator came for");
  });
});

test("the two settings that decide what actually happens are visible, and say so", async () => {
  // Until this screen existed, neither was anywhere on the page: a licensee
  // could be running unattended, or running on the simulated model with nothing
  // real being written, and have no way to find that out from the console.
  await withConsole({ AMP_TEST_TOKEN: "tok-settings" }, async (base) => {
    const response = await fetch(`${base}/api/settings`, { headers: { cookie: "amp_console=tok-settings" } });
    assert.equal(response.status, 200);
    const settings = (await response.json()) as {
      autonomy: string;
      llm: { provider: string };
      operators: string[];
      policy: { requireDisclosure: boolean };
      configPath: string;
    };

    assert.ok(["manual", "assisted", "auto"].includes(settings.autonomy));
    assert.ok(["mock", "anthropic"].includes(settings.llm.provider));
    // Resolved for this request, not read from process.env - there is no
    // process on a Worker, and that band is where this project's bugs live.
    assert.ok(settings.operators.length > 0, "whoever can approve is named");
    assert.equal(typeof settings.policy.requireDisclosure, "boolean");
    assert.ok(settings.configPath, "and where to change any of it");
  });
});

test("the settings are not secrets, and not a second place to change them", async () => {
  await withConsole({ AMP_TEST_TOKEN: "tok-ro" }, async (base) => {
    const auth = { cookie: "amp_console=tok-ro" };

    // Same wall as every other route.
    assert.equal((await fetch(`${base}/api/settings`)).status, 401);

    // Read-only by design: the config file is the one answer to "what is my
    // configuration" (requirements 3.1), and a second writer makes it two.
    const written = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ autonomy: "auto" }),
    });
    assert.notEqual(written.status, 200, "there is no way to write settings from the console");

    // No credential is echoed back. The passphrases are how the console is
    // entered at all, and the operator names are deliberately not them.
    const body = await (await fetch(`${base}/api/settings`, { headers: auth })).text();
    assert.doesNotMatch(body, /tok-ro/, "a token must never appear in a payload");
    assert.doesNotMatch(body, /apiKey|ANTHROPIC_API_KEY/, "nor the name of a key's value");
  });
});

test("running on the simulated model says so on the settings screen", async () => {
  // The claim this screen was built for, exercised through the real page script
  // rather than the payload: a licensee on the mock is reading writing that is
  // not writing, and nothing anywhere told them. Asserting only that the route
  // returns "mock" would pass with the whole row rendered wrong.
  await withConsole({ AMP_TEST_TOKEN: "tok-mockrow" }, async (base, handle) => {
    const page = await openPage({ base, token: handle.token, hash: "#/settings", until: "settings-body" });
    const body = page.html("settings-body");

    assert.match(body, /模擬です/, "the model row says the writing is not real");
    assert.match(body, /class="loud"/, "and says it loudly, not as one grey row among eight");

    // The rest of the screen still rendered, so this is not a page that fell
    // over before reaching the rows that matter.
    assert.match(body, /機械に任せている範囲/);
    assert.match(body, /リンクの行き先/);
    assert.doesNotMatch(body, /\{(model|fastModel|effort|posts|minutes|smell)\}/, "no placeholder reached the screen");
  });
});
