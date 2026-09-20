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
import { createMockProvider, type MockProvider } from "../src/llm/mock.ts";
import { createDemoHandlers } from "../src/llm/demo.ts";
import type { Lock } from "../src/storage/lock.ts";
import { CYCLES_LOCK } from "../src/scheduler/tick.ts";
import { cycleIdFor } from "../src/kernel/orchestrator.ts";
import { localDate } from "../src/core/clock.ts";
import { CYCLE_FAILURE_CODES, CYCLE_STATUS_LABELS, CYCLE_STEP_LABELS, FAILURE_SUMMARIES } from "../src/console/labels.ts";
import { renderPage } from "../src/console/ui.ts";
import { LOCALES, MESSAGES, type Locale } from "../src/console/messages.ts";
import { readFileSync } from "node:fs";
import { repoRoot } from "../src/config/load.ts";
import { CYCLE_STEPS } from "../src/core/types.ts";
import { unwrap } from "../src/core/result.ts";
import { runScout } from "../src/kernel/exploration.ts";
import type { Runtime } from "../src/runtime.ts";
import type { ReleaseStamp } from "../src/core/release.ts";
import { fileState } from "../src/kernel/state.ts";
import { deactivateVenture } from "../src/kernel/venture-state.ts";
import { openPage } from "./page-harness.ts";
// Shared with test/canvas.test.ts: the design canvases ship to licensees too,
// and two copies of this pattern would let one of them drift.
import { TERMINAL_COMMAND } from "./terminal-command.ts";
import { renderUnlock, UNLOCK_MISMATCH } from "../src/console/unlock.ts";
import { waitEndedBecause, waitingIsOver, WAITING_IS_OVER_SOURCE, type WaitingSnapshot } from "../src/console/waiting.ts";
import {
  MIN_COLUMN_WIDTH,
  portfolioColumns,
  portfolioStackBelow,
  portfolioTableWidth,
} from "../src/console/portfolio-columns.ts";

/**
 * A console backed by the test company. `startConsole` only reads `config`,
 * `services` and `loaded.dataDir`, so the in-memory company is enough.
 */
async function withConsole(
  env: Record<string, string | undefined>,
  // `runtime` is here for the tests that have to reach past the HTTP surface -
  // the state file the CLI writes, which the console re-reads every request.
  body: (base: string, handle: ConsoleHandle, company: TestCompany, runtime: Runtime) => Promise<void>,
  options: {
    llm?: MockProvider;
    lock?: Lock;
    operators?: { name: string; tokenEnv: string }[];
    locale?: "ja" | "en";
    release?: ReleaseStamp;
    /** Anything else the config needs - a different channel, a different autonomy. */
    config?: Record<string, unknown>;
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
      ...(options.config ?? {}),
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
    await body(`http://127.0.0.1:${port}`, started.value, company, runtime);
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

test("the publish gate shows a threaded post once, not the hook and the close twice over", async () => {
  // On a real run the writer returned parts that already opened with the hook
  // and ended on the CTA. The gate printed HOOK, BODY, every part, then CTA, so
  // the operator read the same post two and a half times and could not tell
  // which version was the one about to go out. The mock never produced that
  // shape, which is why nothing here caught it.
  const HOOK = "結論から言うと、設営の最初の20分が全部です。";
  const CTA = "僕が最初に下ろすのは椅子でした。あなたは何ですか？";
  const PART_ONE = `${HOOK}\n\nキャンプ場8回分、ぜんぶ順番の問題でした。道具ではなかった。`;
  const PART_TWO = `僕が固定した手順はこれです。ペグを打つ前に荷物を降ろしきる。それだけ。\n\n${CTA}`;
  const written = {
    hook: HOOK,
    body: `${PART_ONE}\n\n${PART_TWO}`,
    cta: CTA,
    disclosure: "",
    hashtags: [] as string[],
    threadParts: [PART_ONE, PART_TWO],
  };

  await withConsole(
    { AMP_TEST_TOKEN: "a-real-token-value" },
    async (base, handle, company) => {
      const atProposal = unwrap(await company.orchestrator.runCycle("main"));
      const proposal = (await company.store.decisions.get(atProposal.pendingDecisionId as string))!;
      unwrap(
        await company.orchestrator.resolveGate(proposal.id, {
          decidedBy: "tester",
          selectedIds: proposal.items.slice(0, proposal.selectionHint.max).map((item) => item.id),
          nowIso: company.clock.nowIso(),
        }),
      );

      const state = (await (
        await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${handle.token}` } })
      ).json()) as {
        pending: { gateLabel: string; items: { preview: string; post?: string; hasOffer?: boolean }[] }[];
      };
      const publish = state.pending.find((decision) => decision.gateLabel === "投稿の承認と順番");
      assert.ok(publish, "the cycle should be waiting at the publish gate");
      assert.ok(publish.items.length > 0, "and it should have posts in it");

      const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
      for (const item of publish.items) {
        assert.equal(count(item.preview, HOOK), 1, `the preview says the hook twice:\n${item.preview}`);
        assert.equal(count(item.preview, CTA), 1, `the preview says the close twice:\n${item.preview}`);
        assert.equal(count(item.post ?? "", HOOK), 1, "and so does the text being approved");
        assert.equal(count(item.post ?? "", CTA), 1, "and so does the text being approved");
        if (item.hasOffer) {
          assert.match(item.preview, /PR:/, "the notice is still on the screen it is checked on");
        }
      }
      assert.ok(
        publish.items.some((item) => item.hasOffer),
        "without a post carrying an offer, the disclosure assertion above proves nothing",
      );
    },
    {
      llm: createMockProvider({
        responses: {
          ...createDemoHandlers(),
          "write.draft": () => written,
          "inspect.review": () => ({
            aiSmellScore: 40,
            revisedAiSmellScore: 12,
            findings: [],
            revised: written,
            unfixable: "",
          }),
        } as never,
      }),
    },
  );
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

test("no message on the screen can only be carried out from a terminal", () => {
  // Every offender is collected before failing: the first one found was
  // `scout.empty`, and stopping there hid the three behind it.
  const offenders: string[] = [];
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) {
      if (TERMINAL_COMMAND.test(value)) offenders.push(`${locale}.${key}: ${value}`);
    }
  }
  if (offenders.length > 0) {
    assert.fail(
      "the console hands the licensee a command they have no way to run:\n  " +
        offenders.join("\n  ") +
        "\nSay what this screen does, or name the setting in the config file.",
    );
  }
});

test("nor does the page's own source splice one in", () => {
  // The message table is not the only place copy is written. `ui.ts` builds
  // strings inline and carries comments about them, and a scan of the table
  // alone walks past both.
  //
  // Deliberately not widened to `src/**`: `src/worker/bundled.generated.ts`
  // holds a whole config file as one string, commands and all.
  const source = readFileSync(join(repoRoot(), "src", "console", "ui.ts"), "utf8");

  // One exception, and only one. The console has no resume - the router has no
  // pause/resume route at all - so the stop card has nothing to offer but the
  // command. Fixing that is a route, not a sentence. The assertion below is
  // what stops this excuse from outliving the command it excuses.
  const NO_RESUME_IN_THE_CONSOLE = /"amp resume"/;
  assert.match(
    source,
    NO_RESUME_IN_THE_CONSOLE,
    "the stop card no longer hands over a command - delete this exception with it",
  );

  for (const [index, line] of source.split("\n").entries()) {
    if (!TERMINAL_COMMAND.test(line) || NO_RESUME_IN_THE_CONSOLE.test(line)) continue;
    assert.fail(`src/console/ui.ts:${index + 1} puts a terminal command on the screen: ${line.trim()}`);
  }
});

test("the proposals heading does not promise a rhythm the default never keeps", () => {
  // `company.exploration.enabled` ships false (`src/config/schema.ts`), and the
  // only thing that ever runs the scout is the daemon's `exploreIfDue`
  // (`src/scheduler/tick.ts`), which returns early when it is off. A heading
  // reading "the weekly decision" therefore promises a cadence that, out of the
  // box, never happens once. No regex can see that in the sentence - this is
  // the named case that holds it.
  const cadenceWord: Record<Locale, RegExp> = {
    ja: /毎|週|隔|[0-9０-９]\s*日/,
    en: /\b(?:weekly|daily|monthly|every|each)\b/i,
  };
  for (const locale of LOCALES) {
    assert.doesNotMatch(
      MESSAGES[locale]["scout.heading"],
      cadenceWord[locale],
      `${locale}.scout.heading claims a cadence: "${MESSAGES[locale]["scout.heading"]}". ` +
        "Exploration is off by default, so the heading names the thing, not when it happens.",
    );
  }
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

  for (const locale of LOCALES) {
    const columns = portfolioColumns(MESSAGES[locale]);
    assert.equal(columns.length, 11, "every column in the table needs a declared width");
    for (const column of columns) {
      assert.ok(column.width >= MIN_COLUMN_WIDTH, `${locale}: a ${column.width}px column is narrower than its own header`);
    }
  }

  assert.match(page, /table-layout:\s*fixed/, "auto layout is what let one cell take everything");
  assert.match(page, /<col style="width:/, "the widths have to reach the table as a colgroup");
  assert.match(page, /\.table-wrap \{[^}]*overflow-x:\s*auto/, "a column dragged wider than the window still has to be reachable");
  assert.match(page, /col-resize/, "the operator adjusts a column by dragging its border");
  assert.match(page, /列の幅をもとに戻す/, "and can undo that without clearing site data");
});

test("a column is wide enough for its own header in both languages", () => {
  // The widths were sized against Japanese, where 成果 is two glyphs. In
  // English the same column says "Conversions" - eleven characters in 62px,
  // which ran under its neighbour. One set of widths has to hold for both.
  // Deliberately crude: a lower bound on how much room a string needs, not a
  // font metric. It catches the order-of-magnitude mistake, which is the one
  // that has actually happened.
  const PADDING = 16;
  const LATIN = 6.4;
  const CJK = 13;
  for (const locale of LOCALES) {
    for (const column of portfolioColumns(MESSAGES[locale])) {
      const needed = [...column.label].reduce((total, character) =>
        total + (/[\u3000-\u9fff\uff00-\uffef]/.test(character) ? CJK : LATIN), PADDING);
      assert.ok(
        column.width >= needed,
        `${locale}: ${column.key} is ${column.width}px and its header ${JSON.stringify(column.label)} needs about ${Math.ceil(needed)}px`,
      );
    }
  }
});

test("the accounts table fits the space it is given, so its last column is never clipped", async () => {
  // The bug the owner walked into: 開く, the only control in a row, was cut in
  // half on a 1440px screen and off the edge entirely on anything narrower.
  //
  // The cause was two numbers for one fact. The stylesheet said the table was
  // at least 1180px and the section it sits in is at most 1240px, which reads
  // as if it fits - but the widths in the colgroup summed to 1378px, and a
  // fixed-layout table is as wide as its columns say. So the container scrolled
  // on every screen the console was ever opened on, and what it hid was the
  // right-hand end.
  //
  // Measured off the markup the page actually writes, not off the declaration,
  // because the declaration was the thing that was wrong.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle) => {
    const page = await openPage({ base, token: handle.token, until: "portfolio" });
    const markup = page.html("portfolio");
    const widths = [...markup.matchAll(/<col style="width:(\d+)px">/g)].map(([, width]) => Number(width));
    assert.equal(widths.length, 11, "the table has to declare a width per column");

    const sum = widths.reduce((total, width) => total + width, 0);
    const source = renderPage({ companyName: "テスト" });
    const section = source.match(/#portfolio-section \{ width: min\((\d+)px/);
    assert.ok(section, "the accounts section still declares the widest it can be");
    assert.ok(
      sum <= Number(section[1]),
      `the columns add up to ${sum}px inside a section at most ${section[1]}px wide, so ${sum - Number(section[1])}px of the last column is behind the edge`,
    );

    const declared = source.match(/table\.grid \{[^}]*min-width:\s*(\d+)px/);
    assert.ok(declared, "the table still declares a minimum width");
    assert.equal(Number(declared[1]), sum, "the table's minimum width and its columns are the same fact, written twice");
  });
});

test("no column is dropped when the accounts table stops being a table", async () => {
  // Under portfolioStackBelow() the rows become cards, because eleven columns
  // on a phone meant two and a half of them and a sideways scrollbar for the
  // rest. Every column still renders: this screen compares accounts, and a
  // comparison missing a number is a wrong comparison rather than a small one.
  // The card layout labels each field with the column's own header, so the
  // cells have to carry the key and the label, and the words stay in
  // messages.ts for both languages.
  const columns = portfolioColumns(MESSAGES.ja);
  assert.ok(
    portfolioStackBelow(columns) > portfolioTableWidth(columns),
    "the table would hand over at a width it still fits in",
  );

  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle) => {
    const page = await openPage({ base, token: handle.token, until: "portfolio" });
    const markup = page.html("portfolio");
    const rows = markup.split("<tr>").slice(2);
    assert.ok(rows.length >= 1, "there is no account in the table to check");
    for (const row of rows) {
      for (const column of columns) {
        assert.ok(
          row.includes(`<td data-col="${column.key}" data-label="${column.label}"`),
          `the ${column.key} column is not in the row, or is not labelled for the card layout`,
        );
      }
    }
  });

  const source = renderPage({ companyName: "テスト" });
  assert.match(
    source,
    new RegExp(`@media \\(max-width: ${portfolioStackBelow(columns) - 1}px\\)`),
    "the breakpoint is derived from the widths, not written next to them",
  );
  assert.match(source, /content: attr\(data-label\)/, "a field with no label is a number with no name");
  // The grip on the last header had no column to its right to give width to,
  // and its 9px handle sat 4px outside the table - enough on its own to make
  // the container scroll and take 開く with it.
  assert.equal(
    (source.match(/class="grip"/g) ?? []).length,
    1,
    "the grip is rendered from one place",
  );
  assert.match(source, /index < PORTFOLIO_COLUMNS\.length - 1/, "the last header has no border to drag");
});

test("the console's dark scheme is a decision, and the operator can overrule it", () => {
  // It had one prefers-color-scheme block and no way to disagree with it, so an
  // operator whose machine is dark all day got a dark console whether or not it
  // read well. Three things have to be true at once, and each of them was the
  // thing that broke a version of this: the OS's dark still applies by default,
  // an explicit light beats the OS, and an explicit dark applies whatever the
  // OS says.
  const page = renderPage({ companyName: "テスト" });
  assert.match(
    page,
    /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/,
    "the OS is followed unless the operator has said otherwise",
  );
  assert.match(page, /:root\[data-theme="dark"\] \{/, "and can be overruled in the other direction");
  assert.match(page, /:root\[data-theme="dark"\] \{[^}]*color-scheme:\s*dark/, "scrollbars and form controls follow too");
  // The rule between two rows inside one surface is not the border around the
  // surface. They were the same grey, which reads on near-white and disappears
  // on near-black: the accounts table's rows ran together.
  assert.match(page, /--line-strong:/, "a row rule that survives a dark background");
  assert.match(page, /table\.grid td \{[^}]*border-bottom: 1px solid var\(--line-strong\)/);
  assert.match(page, /table\.grid tbody tr:nth-child\(even\)/, "eleven columns is more than the eye tracks unaided");
  // The choice is this browser's, like the column widths - not the company's.
  for (const locale of LOCALES) {
    for (const key of ["theme.auto", "theme.light", "theme.dark", "page.themeTitle"] as const) {
      assert.ok(MESSAGES[locale][key], `${locale} has no word for ${key}`);
    }
  }
  assert.match(page, /window\.localStorage\.setItem\(THEME_KEY/, "the choice is remembered");
  assert.match(page, /let theme = savedTheme\(\);/, "and read back when the page is opened again");
  assert.match(page, /applyTheme\(theme\);\n\$\("theme"\)/, "and applied before the first load, not after it");
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

/**
 * The gate as the page reads it: which ideas are there, and what opens.
 *
 * Taken from /api/state rather than from the store, because the `<details>` is
 * drawn from this payload and keyed off these two ids - a test built on the
 * store's own shape could agree with itself while the page keyed off something
 * else entirely.
 */
async function openGate(base: string, token: string) {
  const state = (await (await fetch(`${base}/api/state`, {
    headers: { authorization: `Bearer ${token}` },
  })).json()) as { pending: { id: string; items: { id: string; preview?: string }[] }[] };
  const gate = state.pending[0];
  assert.ok(gate, "this test needs a gate standing open");
  const withReasons = gate.items.filter((item) => (item.preview ?? "") !== "");
  assert.ok(withReasons.length >= 2, "and at least two ideas that have 開く to open");
  return { id: gate.id, items: withReasons };
}

test("the reasons an operator opened survive the page redrawing itself", async () => {
  // Reported from the running operation: "ねらいと根拠とかを開いていると、定期的に
  // 画面がリフレッシュされるのか、開いた部分が閉じたりしている". render() replaces
  // the whole list through innerHTML, so the <details> went with it.
  await withConsole({ AMP_TEST_TOKEN: "tok-details" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const page = await openPage({ base, token: handle.token, until: "decision-list" });
    const gate = await openGate(base, handle.token);
    const panel = { decision: gate.id, item: gate.items[0]!.id };

    assert.equal(page.detailsOpen("decision-list", panel), false, "it starts closed");
    await page.toggleDetails("decision-list", panel, true);
    // Any redraw will do - this is the one the 30-second poll ends in too.
    await page.press({ act: "none", decision: gate.id });
    assert.equal(page.detailsOpen("decision-list", panel), true, "and is still open afterwards");

    // The other half of it: putting the panel back must not mean always
    // opening it, or nothing could ever be closed again.
    await page.toggleDetails("decision-list", panel, false);
    await page.press({ act: "none", decision: gate.id });
    assert.equal(page.detailsOpen("decision-list", panel), false, "closed stays closed");
  });
});

test("ticking a box does not shut the reasons the operator is ticking it from", async () => {
  // The 30 seconds were never the whole story: toggle, 推奨を選ぶ, すべて外す and
  // the arrows all re-render, so reading a rationale and acting on it closed it
  // under the operator's hand, immediately.
  await withConsole({ AMP_TEST_TOKEN: "tok-details-tick" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const page = await openPage({ base, token: handle.token, until: "decision-list" });
    const gate = await openGate(base, handle.token);
    const panel = { decision: gate.id, item: gate.items[0]!.id };

    await page.toggleDetails("decision-list", panel, true);
    await page.press({ act: "toggle", decision: gate.id, item: gate.items[0]!.id });
    assert.equal(page.detailsOpen("decision-list", panel), true);
  });
});

test("two rationales can be read side by side", async () => {
  // A single remembered id would close the first one the moment the second
  // opened, which is the comparison the operator is here to make.
  await withConsole({ AMP_TEST_TOKEN: "tok-details-two" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const page = await openPage({ base, token: handle.token, until: "decision-list" });
    const gate = await openGate(base, handle.token);
    const first = { decision: gate.id, item: gate.items[0]!.id };
    const second = { decision: gate.id, item: gate.items[1]!.id };

    await page.toggleDetails("decision-list", first, true);
    await page.toggleDetails("decision-list", second, true);
    await page.press({ act: "none", decision: gate.id });

    assert.equal(page.detailsOpen("decision-list", first), true);
    assert.equal(page.detailsOpen("decision-list", second), true);
  });
});

test("reordering the ideas carries the open rationale with the idea, not the slot", async () => {
  // The operator can move an idea up the list. Remembering "the second one is
  // open" would leave the panel behind on whatever moved into second place -
  // and they would be reading the wrong idea's reasons without being told.
  await withConsole({ AMP_TEST_TOKEN: "tok-details-order" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const page = await openPage({ base, token: handle.token, until: "decision-list" });
    const gate = await openGate(base, handle.token);
    // As drawn, so "the one above it" is the one the operator sees above it.
    const drawnOrder = (): string[] => {
      const seen: string[] = [];
      for (const match of page.html("decision-list").matchAll(/data-item="([^"]*)"/g)) {
        if (!seen.includes(match[1]!)) seen.push(match[1]!);
      }
      return seen;
    };
    const before = drawnOrder();
    const lift = gate.items[gate.items.length - 1]!.id;
    const above = before[before.indexOf(lift) - 1];
    assert.ok(above, "the idea being lifted has to have one above it to swap with");

    await page.toggleDetails("decision-list", { decision: gate.id, item: lift }, true);
    await page.press({ act: "up", decision: gate.id, item: lift });

    const after = drawnOrder();
    assert.ok(after.indexOf(lift) < after.indexOf(above), "the idea actually moved, or this proves nothing");
    assert.equal(
      page.detailsOpen("decision-list", { decision: gate.id, item: lift }), true,
      "the idea kept its panel",
    );
    assert.equal(
      page.detailsOpen("decision-list", { decision: gate.id, item: above }), false,
      "and the slot it left did not gain one",
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

/** The form on the 401 page, submitted the way a browser submits it. */
function unlock(base: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

test("a passphrase with a + in it gets in through the page, and never could through the address", async () => {
  // The defect, in one test. The deploy screen tells the licensee to generate a
  // passphrase with a password manager, which produces exactly this - and
  // `?token=sunny+river+42` is read as "sunny river 42", so the passphrase they
  // were told to make was the one that could not be presented. The old 401 then
  // said only that a passphrase was required, which reads as "you typed nothing".
  const passphrase = "sunny+river+42";
  await withConsole({ AMP_TEST_TOKEN: passphrase }, async (base) => {
    const pasted = await fetch(`${base}/api/state?token=${passphrase}`);
    assert.equal(pasted.status, 401, "in the address the + is a space by the time anything reads it");

    const unlocked = await unlock(base, { token: passphrase, next: "/" });
    assert.equal(unlocked.status, 303, "the same passphrase, posted, is the holder's");
    assert.equal(unlocked.headers.get("location"), "/");

    const cookie = unlocked.headers.getSetCookie()[0];
    assert.ok(cookie, "getting in has to hand back the session");
    assert.match(cookie, /^amp_console=sunny%2Briver%2B42;/, "encoded, so the browser keeps all of it");
    assert.match(cookie, /HttpOnly/);

    const opened = await fetch(`${base}/api/state`, { headers: { cookie: cookie.split(";")[0] as string } });
    assert.equal(opened.status, 200, "and that session opens the console");
  });
});

test("a passphrase with a semicolon and a space in it survives being a session", async () => {
  // The half of the same defect that lives one screen later: a cookie value
  // ends at a `;` or a space, so a passphrase carrying either was accepted by
  // the form, and then the session it handed back was truncated to something
  // that was nobody's. The licensee types the right passphrase, is told they
  // are in, and lands back on the same page.
  const passphrase = "night; owl 7 & rain";
  await withConsole({ AMP_TEST_TOKEN: passphrase }, async (base) => {
    const unlocked = await unlock(base, { token: passphrase, next: "/" });
    assert.equal(unlocked.status, 303);

    const cookie = unlocked.headers.getSetCookie()[0] as string;
    const value = cookie.split(";")[0] as string;
    assert.ok(!/[ ;]/.test(value.slice("amp_console=".length)), "nothing a cookie ends at");

    const opened = await fetch(`${base}/api/state`, { headers: { cookie: value } });
    assert.equal(opened.status, 200, "the session the browser would actually send is the holder's");
  });
});

test("a passphrase that does not match gets the page back, with nothing attached to it", async () => {
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base) => {
    for (const token of ["last-months-value", ""]) {
      const response = await unlock(base, { token, next: "/" });
      assert.equal(response.status, 401, `"${token}" must not open anything`);
      assert.equal(response.headers.getSetCookie().length, 0, "a refusal must never hand out a session");
    }

    const body = await (await unlock(base, { token: "last-months-value", next: "/" })).text();
    assert.match(body, /合言葉が違いました/, "and says so, rather than repeating the first screen");
    assert.match(body, /type="password"/, "with the field still there - a dead end is what this replaced");
    assert.doesNotMatch(body, /last-months-value/, "what was typed never goes back into the page");
  });
});

test("the page that takes a passphrase cannot be used to send somebody somewhere else", async () => {
  // An open redirect is worth most on exactly this page: it is where a person
  // has already decided to type a secret, and a copy of it one hop away would
  // be believed.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base) => {
    for (const [next, landsOn] of [
      ["//evil.example", "/"],
      ["https://evil.example", "/"],
      ["/\\evil.example", "/"],
      ["/api/settings", "/api/settings"],
    ] as const) {
      const response = await unlock(base, { token: "a-real-token-value", next });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), landsOn, `next=${next}`);
    }
  });
});

test("the two routes that answer without a credential still answer without one", async () => {
  // A route added ahead of the gate is a chance to move the gate. The redirect
  // is the link inside every published post and the reader has no passphrase;
  // health is what says the deploy is alive before anything else works.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const link = await fetch(`${base}/go/not-a-real-code`, { redirect: "manual" });
    assert.equal(link.status, 404, "a reader's click is not a login");
  });
});

test("the passphrase page carries no value of its own, and cannot be made to carry markup", () => {
  const page = renderUnlock({ next: '/"><script>alert(1)</script>', problem: UNLOCK_MISMATCH });
  assert.doesNotMatch(page, /<script>/, "the return path is a value in an attribute, never markup");
  assert.match(page, /value="\/&quot;&gt;&lt;script&gt;/);
  assert.match(page, /<input type="password" name="token" autocomplete="current-password"/);
  assert.doesNotMatch(page, /name="token"[^>]*value=/, "the passphrase is never written back into the page");
});

// ---------------------------------------------------------------------------
// The screen that went quiet
//
// Running a day and answering the ideas gate each do minutes of model calls,
// and both did that work inside the HTTP request. When the response was lost -
// a Cloudflare edge timeout, a closed laptop - the page silently went back to
// what it had been showing, although the work had finished and been saved. The
// owner pressed run, saw nothing, reloaded, and found three proposals waiting;
// pressed approve, saw nothing, reloaded, and found the next gate open with a
// finished post behind it. He pressed each of them twice.
// ---------------------------------------------------------------------------

/** A row for the judgement to read, with only the fields it reads. */
function row(ventureId: string, cycle?: { date: string; status: string; nextStep?: string }) {
  return cycle ? { ventureId, lastCycle: cycle } : { ventureId };
}

test("a gate opening for this account is what ends the wait", () => {
  // The clearest answer there is: the work finished and it is asking something
  // new. It has to count even while the row still says 動作中, because the
  // portfolio behind that row is memoised for thirty seconds and the gate is
  // not - so for up to half a minute the two disagree, and the gate is right.
  const before: WaitingSnapshot = {
    pending: [],
    portfolio: { rows: [row("main", { date: "2026-09-18", status: "running", nextStep: "write" })] },
  };
  const now: WaitingSnapshot = {
    pending: [{ id: "dec_1", ventureId: "main" }],
    portfolio: { rows: [row("main", { date: "2026-09-18", status: "running", nextStep: "write" })] },
  };
  assert.equal(waitingIsOver(before, now, "main"), true);
});

test("another account's gate, and a step that only moved, are not an answer", () => {
  const cycle = { date: "2026-09-18", status: "running", nextStep: "write" };
  const before: WaitingSnapshot = {
    pending: [],
    portfolio: { rows: [row("main", cycle), row("second", { date: "2026-09-18", status: "running" })] },
  };

  // A second account opening its own gate says nothing about this one, and
  // ending the wait on it would leave a screen that has not changed reading
  // 終わりました.
  assert.equal(
    waitingIsOver(before, { ...before, pending: [{ id: "dec_9", ventureId: "second" }] }, "main"),
    false,
  );

  // The middle of the work is saved a step at a time. A cycle that has gone
  // from write to inspect has finished nothing the operator asked for, and a
  // screen that said so would be lying a second way.
  const moved: WaitingSnapshot = {
    pending: [],
    portfolio: {
      rows: [row("main", { date: "2026-09-18", status: "running", nextStep: "inspect" }), row("second")],
    },
  };
  assert.equal(waitingIsOver(before, moved, "main"), false);
});

test("a cycle that came to rest ends the wait; a state that cannot say does not", () => {
  const before: WaitingSnapshot = {
    pending: [],
    portfolio: { rows: [row("main", { date: "2026-09-18", status: "running", nextStep: "write" })] },
  };
  const at = (status: string, nextStep?: string): WaitingSnapshot => ({
    pending: [],
    portfolio: {
      rows: [row("main", nextStep ? { date: "2026-09-18", status, nextStep } : { date: "2026-09-18", status })],
    },
  });

  assert.equal(waitingIsOver(before, at("completed"), "main"), true, "a day that finished");
  assert.equal(waitingIsOver(before, at("failed"), "main"), true, "and one that failed");
  assert.equal(waitingIsOver(before, at("cancelled"), "main"), true, "and one that was stopped");

  // Nothing moved at all.
  assert.equal(
    waitingIsOver(before, { ...before }, "main"),
    false,
    "an unchanged state is not an answer",
  );

  // Fail-closed: when the state cannot answer, the answer is not yes. Saying
  // yes here takes down the line saying the work is still going, which is the
  // silence this whole path exists to end. Saying no costs one more poll.
  assert.equal(waitingIsOver(null, at("completed"), "main"), false, "nothing to compare against");
  assert.equal(waitingIsOver(before, { pending: [] }, "main"), false, "no rows at all");
  assert.equal(waitingIsOver(before, at("completed"), ""), false, "no account named");
});

test("a gate says which account it belongs to, not only what it is called", async () => {
  // Two accounts are allowed the same display name, and answering a gate starts
  // minutes of work whose answer can be lost. The page watches this account's
  // row to find out what became of it, and cannot do that from a name.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const state = (await (
      await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${handle.token}` } })
    ).json()) as { pending: { id: string; ventureId?: string; ventureName: string }[] };
    assert.equal(state.pending.length, 1);
    assert.equal(state.pending[0]!.ventureId, "main");
  });
});

test("the page carries the deadline, the watch and the words for both", () => {
  // The script is inlined and most of it cannot be called from here, so this is
  // a guard against a refactor quietly dropping the wiring - not a test that it
  // works. What it does assert exactly is that the page carries the *same*
  // judgement the three tests above exercise, rather than a second copy of it.
  const page = renderPage({ companyName: "テスト" });

  assert.ok(page.includes(WAITING_IS_OVER_SOURCE), "the page must inline the tested function, not a copy");
  assert.match(page, /const SLOW_ACTION_DEADLINE_MS = 20000;/, "the request stops being the work after 20s");
  assert.match(page, /const WATCH_POLL_MS = \d+;/);
  assert.match(page, /const WATCH_LIMIT_MS = \d+;/, "a watch with no bound is the same lie more slowly");
  assert.match(page, /waitEndedBecause\(\{ answered: answered, before: before, now: state, ventureId: ventureId \}\)/,
    "the watch has to consult it");
  // The baseline, before the press. Without it the comparison has nothing to
  // compare against and answers "not yet" to every poll, forever.
  assert.match(page, /if \(!state\) await load\(\);/, "there is no comparing against nothing");
  assert.match(page, /watchUntilItMoves\(before, ventureId, T\["wait\.stillRunning"\], request\)/,
    "the request is handed over, because its own answer ends the wait");
  assert.match(page, /withDeadline\(/);
  assert.match(page, /<div id="notice" hidden>/, "the line has to outlive the render that rebuilds the card");

  for (const key of ["wait.stillRunning", "wait.gateStillRunning", "wait.changed", "wait.tooLong"]) {
    assert.ok(page.includes(key), `${key} never reached the page`);
    // Both languages, like every other string on this screen. The parity test
    // above proves the key sets match; this proves the keys exist at all.
    assert.ok(MESSAGES.ja[key as keyof typeof MESSAGES.ja], `${key} has no Japanese`);
    assert.ok(MESSAGES.en[key as keyof typeof MESSAGES.en], `${key} has no English`);
  }

  // And the guard that survives a re-render: the poll rebuilds the gate's card
  // every few seconds, and a fresh button reading 承認して進める is what got the
  // same day approved twice.
  assert.match(page, /const sending = resolving\.has\(decision\.id\);/);
  assert.match(page, /if \(resolving\.has\(decisionId\)\) return;/);
  assert.match(page, /if \(runningVentureId === ventureId\) return;/);
});

test("pressing the button before the page has loaded still ends the wait", () => {
  // What the owner did on the first real run: opened an account and pressed.
  // The page had no state yet, so the watcher compared against null - which it
  // reads as "not finished" - and the screen said the work was still running
  // for five minutes after it had finished. Reproduced in a browser before this
  // was written.
  assert.equal(
    waitEndedBecause({ answered: true, before: null, now: null, ventureId: "main" }),
    "answered",
    "the answer arriving is the end of the wait, with nothing to compare",
  );
  assert.equal(
    waitEndedBecause({ answered: false, before: null, now: { pending: [] }, ventureId: "main" }),
    null,
    "and until it does, an absent baseline still cannot say anything",
  );
  assert.equal(
    waitEndedBecause({
      answered: false,
      before: { pending: [] },
      now: { pending: [{ id: "dec_1", ventureId: "main" }] },
      ventureId: "main",
    }),
    "moved",
    "the comparison still works when there is something to compare",
  );
});

test("pressing approve twice sends one answer, not two", async () => {
  // The screen said 送信中… and then, when the response never came, went back to
  // 「N件を承認して進める」 - so it was pressed again. The disabled attribute
  // could not stop that: it is on a button the poll replaces.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const state = (await (
      await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${handle.token}` } })
    ).json()) as { pending: { id: string }[] };
    const decisionId = state.pending[0]!.id;

    const page = await openPage({ base, token: handle.token, until: "decision-list" });
    // Both presses before the first has settled, which is the only moment the
    // guard exists for.
    await Promise.all([
      page.press({ act: "submit", decision: decisionId }),
      page.press({ act: "submit", decision: decisionId }),
    ]);

    const answers = page.requests.filter((path) => path.includes("/resolve"));
    assert.equal(answers.length, 1, `the gate was answered ${answers.length} times`);
  });
});

test("pressing run twice starts one day, not two", async () => {
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    const page = await openPage({ base, token: handle.token, hash: "#/ventures/main", until: "venture-cycle" });
    await Promise.all([
      page.press({ ventureRun: "1", venture: "main" }),
      page.press({ ventureRun: "1", venture: "main" }),
    ]);

    const runs = page.requests.filter((path) => path.endsWith("/run"));
    assert.equal(runs.length, 1, `the day was started ${runs.length} times`);
    assert.equal((await company.store.cycles.all()).length, 1, "and only one cycle exists");
  });
});

test("a post the platform cannot publish reaches the operator as text, a link and one button", async () => {
  // The whole feature, from the operator's side: the text they will paste, the
  // comment that carries the affiliate link, somewhere to go, and the press
  // that records what they did. Read off the real HTTP surface, because the
  // console is the only place a licensee has - there is no terminal.
  await withConsole(
    { AMP_TEST_TOKEN: "a-real-token-value" },
    async (base, handle, company) => {
      unwrap(await company.orchestrator.runCycle("main"));
      const approved = await company.store.posts.find((post) => post.status === "approved");
      assert.ok(approved.length > 0);
      company.clock.set(new Date(Math.max(...approved.map((post) => post.scheduledFor)) + 60_000).toISOString());
      unwrap(await company.orchestrator.dispatchDue(company.clock.now()));

      const read = async () =>
        (await (
          await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${handle.token}` } })
        ).json()) as {
          handOver: {
            postId: string;
            parts: string[];
            comments: { purpose: string; text: string }[];
            composerUrl?: string;
          }[];
          stats: { label: string; value: string }[];
        };

      const before = await read();
      assert.ok(before.handOver.length > 0, "a handed-over post has to be on the screen");
      const card = before.handOver[0]!;
      const stored = (await company.store.posts.get(card.postId))!;
      assert.deepEqual(
        card.parts,
        stored.handOverParts,
        "the screen shows the text that was handed over, never a fresh rendering of the draft",
      );
      assert.equal(card.composerUrl, "https://www.threads.net/", "and where to go to paste it");

      // The press. The URL of the real post is optional and travels with it.
      const response = await fetch(`${base}/api/posts/${encodeURIComponent(card.postId)}/posted`, {
        method: "POST",
        headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://www.threads.net/@owner/post/xyz" }),
      });
      assert.equal(response.status, 200, await response.text());

      const now = await company.store.posts.get(card.postId);
      assert.equal(now?.status, "published");
      assert.equal(now?.externalUrl, "https://www.threads.net/@owner/post/xyz");
      // Recorded against the passphrase that was used, like every other press.
      assert.equal(now?.postedBy, "owner");

      const after = await read();
      assert.ok(
        after.handOver.every((entry) => entry.postId !== card.postId),
        "and it leaves the list of things waiting on the operator",
      );
    },
    {
      config: {
        company: { name: "Hand Co", operator: "owner", autonomy: "auto" },
        channels: [
          {
            id: "by-hand",
            adapter: "manual",
            enabled: true,
            credentialEnv: {},
            research: { queries: [], minLikes: 0, maxItems: 1, lookbackHours: 24 },
            options: { maxCharacters: 500, format: "thread", composerUrl: "https://www.threads.net/" },
          },
        ],
        ventures: BASE_CONFIG.ventures.map((venture) => ({ ...venture, channels: ["by-hand"] })),
      },
    },
  );
});

test("stopping an account stops it asking to be approved", async () => {
  // The owner stopped the reference environment and the console kept showing
  // its ideas gate. The tick hears "stopped" - no new cycle opens - but the
  // gate already open did not, and there was no way to make the question go
  // away short of answering it for an account that had been told to stop.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, _handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));

    const asking = async (): Promise<number> => {
      const state = (await (
        await fetch(`${base}/api/state?token=a-real-token-value`)
      ).json()) as { pending: unknown[] };
      return state.pending.length;
    };

    assert.equal(await asking(), 1, "a running account with an open gate asks");

    const stopped = await fetch(`${base}/api/ventures/main/deactivate?token=a-real-token-value`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "今日はここまで" }),
    });
    assert.equal(stopped.status, 200);

    assert.equal(await asking(), 0, "a switched-off account does not");

    // And the record is closed rather than left pending. Leaving it was the
    // half-measure: the page stopped offering the gate and the decision went on
    // saying somebody owed it an answer, which is a row nobody could ever
    // reconcile. It closes with a reason, and `decision.closed` is its own
    // event - a day the operator ended is not a day they missed.
    assert.equal((await company.orchestrator.pendingDecisions()).length, 0, "the gate is still asking");
    const closed = (await company.store.audit.recent(20)).filter((event) => event.type === "decision.closed");
    assert.equal(closed.length, 1, "a gate that vanished without a record is a gate that vanished");
    assert.equal(closed[0]?.data["reason"], "venture_deactivated");
  });
});

test("the button a person presses is not the scheduler, and does not take its advice", async () => {
  // `judgeCycleStart` exists to stop the *hourly cron* paying for a day that
  // cannot succeed. A person pressing 今日のサイクルを動かす has decided
  // something the scheduler cannot know - they fixed the key, the outage is
  // over - and this route deliberately does not go through the judgement.
  // Routing it through would leave a licensee, who has no terminal, with a day
  // nothing on earth could restart.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    const date = localDate(company.clock.now(), "Asia/Tokyo");
    await company.store.cycles.put({
      id: cycleIdFor("main", date),
      ventureId: "main",
      date,
      createdAt: "2026-04-01T21:00:00Z",
      updatedAt: "2026-04-01T21:00:00Z",
      status: "failed",
      nextStep: "analyze",
      completed: [],
      artifacts: {},
      // Both of the scheduler's reasons to refuse, at once.
      attempts: 99,
      failure: { step: "analyze", message: "the output hit the cap", code: "llm.truncated", retryable: false },
    } as never);

    const response = await fetch(`${base}/api/ventures/main/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
      body: "{}",
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal((JSON.parse(text) as { status: string }).status, "awaiting_approval", "the press did nothing");
    // And it did not spend one of the scheduler's tries. Those count what the
    // machine decided to pay for; a person deciding to is not the same budget.
    assert.equal((await company.store.cycles.all())[0]?.attempts, 99, "a press was counted as a retry");
  });
});

// ---------------------------------------------------------------------------
// The gate, on the account's own screen
// ---------------------------------------------------------------------------

/** Deactivates an account through the real route, the way the page does. */
async function switchOff(base: string, token: string, ventureId: string, note = "今日はここまで"): Promise<Response> {
  return fetch(`${base}/api/ventures/${ventureId}/deactivate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ note }),
  });
}

async function switchOn(base: string, token: string, ventureId: string): Promise<Response> {
  return fetch(`${base}/api/ventures/${ventureId}/activate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
}

test("the account's own screen shows the gate that is waiting on it", async () => {
  // The operator clicks into an account *because* something needs doing there,
  // and the one thing that needed doing was on the other screen. Read off the
  // page the browser actually runs, because "the payload contains it" and "the
  // operator can act on it" have been different things in this project before.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const decision = (await company.orchestrator.pendingDecisions())[0]!;

    const page = await openPage({
      base,
      token: handle.token,
      hash: "#/ventures/main",
      until: "venture-cycle",
    });
    const block = page.html("venture-decisions");
    assert.ok(block.includes(decision.id), "the gate is not on the account's screen");
    assert.match(block, /data-act="submit"/, "there is nothing to press");
    assert.ok(
      block.includes(decision.items[0]!.title.replace(/&/g, "&amp;")),
      "the ideas being approved are not on the screen",
    );
  });
});

test("and the day's list is empty there, so no gate is drawn twice", async () => {
  // Both would render `id="err-<decisionId>"` twice. `#decision-list` comes
  // first in the document, so `getElementById` would hand a refused approval
  // the copy inside the hidden view - the error would be written somewhere
  // nobody can see, on the one press where an error matters.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const page = await openPage({
      base,
      token: handle.token,
      hash: "#/ventures/main",
      until: "venture-cycle",
    });
    assert.equal(page.html("decision-list"), "", "the day's list still drew the same gate");
  });
});

test("approving from the account's screen actually approves", async () => {
  // Two names, because they measure two different things and only the second
  // one is proof. `page.press` ignores `disabled`, and the harness's
  // querySelectorAll answers with an empty list, so a press on its own would
  // pass against a screen with no working controls at all.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const decision = (await company.orchestrator.pendingDecisions())[0]!;

    const page = await openPage({
      base,
      token: handle.token,
      hash: "#/ventures/main",
      until: "venture-cycle",
    });
    // (a) the control exists, and belongs to this gate
    const block = page.html("venture-decisions");
    assert.match(block, new RegExp(`data-act="submit" data-decision="${decision.id}"`));

    // (b) and pressing it reaches the store
    await page.press({ act: "submit", decision: decision.id });
    const after = await company.store.decisions.get(decision.id);
    assert.equal(after?.status, "approved", "the press did not reach the decision");
  });
});

test("the badge and the block agree, even on an account that is switched off", async () => {
  // 判断待ち1件 above a screen with nothing on it. The count came from the
  // portfolio row, which counted every pending decision; the block comes from
  // the day's list, which drops accounts that are off. One number, one source.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company, runtime) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const state = (await (
      await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${handle.token}` } })
    ).json()) as { portfolio: { rows: { ventureId: string; pendingDecisions: number }[] } };
    assert.equal(state.portfolio.rows[0]?.pendingDecisions, 1, "a running account with a gate waiting");

    // Switched off the way `amp venture deactivate` does it: straight into the
    // state file, which the console re-reads on every request. That path does
    // not close the gate, so the decision stays `pending` - which is exactly
    // the case where the two counts used to disagree.
    await deactivateVenture(runtime.state, "main", { at: company.clock.nowIso(), by: "tester", reason: "no clicks" });
    // Deliberately without `forgetPortfolio`: the accounts table is memoised
    // for thirty seconds and the switch was not thrown through the route that
    // clears it, so the row is a stale answer to the same question the gate
    // list answers freshly. Counting the badge off the gate list is what makes
    // the two agree no matter which of them is older.

    const off = (await (
      await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${handle.token}` } })
    ).json()) as { pending: unknown[]; portfolio: { rows: { pendingDecisions: number }[] } };
    assert.equal(off.pending.length, 0);
    assert.equal(off.portfolio.rows[0]?.pendingDecisions, 0, "the table still says something is waiting");

    const page = await openPage({
      base,
      token: handle.token,
      hash: "#/ventures/main",
      until: "venture-cycle",
    });
    assert.doesNotMatch(page.html("venture-head"), /判断待ち/, "a badge over an empty screen");
    assert.doesNotMatch(page.html("venture-decisions"), /data-act="submit"/);
  });
});

test("switching an account off closes its gate, with a reason and without cancelling the day", async () => {
  // `expireStaleGates` cancels the cycle as well, and `advance` returns from a
  // cancelled cycle before it does anything - so closing this one the same way
  // would make the day unreachable even by hand. It is marked failed instead:
  // the scheduler leaves a `retryable: false` day alone, and the console's
  // 今日のサイクルを動かす still reaches it.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const decision = (await company.orchestrator.pendingDecisions())[0]!;

    assert.equal((await switchOff(base, handle.token, "main")).status, 200);

    assert.equal((await company.store.decisions.get(decision.id))?.status, "expired");
    const cycle = (await company.store.cycles.all())[0];
    assert.notEqual(cycle?.status, "cancelled", "a cancelled day can never be started again");
    assert.equal(cycle?.status, "failed");
    assert.equal(cycle?.failure?.retryable, false, "the scheduler would start it again every hour");
    assert.equal(cycle?.pendingDecisionId, undefined, "something still points at the closed gate");

    const closed = (await company.store.audit.recent(20)).filter((event) => event.type === "decision.closed");
    assert.equal(closed.length, 1, "the gate closed with no record of it");
    assert.equal(closed[0]?.data["day"], cycle?.date);
    assert.equal(closed[0]?.data["gate"], decision.gate);
  });
});

test("switched off and back on the same day, the run button still opens a new gate", async () => {
  // Where the two halves of this work meet. The gate is closed and not
  // reopened, the scheduler will not start the day again by itself, and the
  // only way left to run it is the button - so the button has to work. It
  // returned 200 and did nothing when the cycle was cancelled.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    const first = (await company.orchestrator.pendingDecisions())[0]!;

    assert.equal((await switchOff(base, handle.token, "main")).status, 200);
    assert.equal((await switchOn(base, handle.token, "main")).status, 200);

    const run = await fetch(`${base}/api/ventures/main/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
      body: "{}",
    });
    const text = await run.text();
    assert.equal(run.status, 200, text);
    assert.equal((JSON.parse(text) as { status: string }).status, "awaiting_approval");

    const open = await company.orchestrator.pendingDecisions();
    assert.equal(open.length, 1, "the day could not be started again");
    assert.notEqual(open[0]?.id, first.id, "the closed gate was reopened rather than a new one asked");
  });
});

test("a gate the operator closed does not read as a gate they missed", async () => {
  // Both end with a decision marked `expired`, and the screen used to have one
  // sentence for that: 答えのないまま日が変わりました. Told to an operator who
  // had just switched the account off themselves, it is wrong in the way that
  // stops a record being believed.
  await withConsole({ AMP_TEST_TOKEN: "a-real-token-value" }, async (base, handle, company) => {
    unwrap(await company.orchestrator.runCycle("main"));
    assert.equal((await switchOff(base, handle.token, "main")).status, 200);

    const page = await openPage({ base, token: handle.token, until: "activity" });
    const feed = page.html("activity");
    assert.match(feed, /アカウントを止めたので閉じました/);
    assert.doesNotMatch(feed, /答えのないまま日が変わりました/);
  });
});
