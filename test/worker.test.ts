/**
 * The Worker entry point, against a stand-in for D1.
 *
 * D1 is SQLite, and `node:sqlite` is SQLite, so a thin object with D1's shape
 * over the sqlite driver runs the same statements the real binding would. That
 * covers the driver, the store, the state rows and the boot path without a
 * network or an account. What it cannot cover — whether wrangler resolves our
 * `./y.ts` imports, and whether the SDK runs on workerd — is not testable here
 * and is settled by deploying once.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { repoRoot } from "../src/config/load.ts";
import { renderSetup } from "../src/worker/setup.ts";
import { createSqliteDriver } from "../src/storage/sqlite-driver.ts";
import type { SqlParam, SqlStatement } from "../src/storage/sql-driver.ts";
import type { D1Database, D1PreparedStatement } from "../src/storage/d1-driver.ts";
import { createWorkerRuntime, forgetIsolateSqlCacheForTests } from "../src/worker/runtime.ts";
import worker from "../src/worker/index.ts";
import { createWorker, licenseeProblem } from "../src/worker/handler.ts";
import { configSource } from "../src/worker/bundled.generated.ts";
import { cycleIdFor } from "../src/kernel/orchestrator.ts";

/** The handlers as a licensee's deploy has them: a config of their own. */
async function configuredWorker() {
  return createWorker({ configSource: "licensee", configText: await exampleConfig(), prompts: {} });
}

/** D1's shape over real SQLite. Only the four methods the driver uses. */
function fakeD1(): D1Database & { close(): Promise<void> } {
  const driver = createSqliteDriver({ filename: ":memory:" });
  const statement = (sql: string, params: readonly SqlParam[]): D1PreparedStatement & { readonly sql: string; readonly params: readonly SqlParam[] } => ({
    sql,
    params,
    bind(...values: readonly SqlParam[]) {
      return statement(sql, values);
    },
    async all<T>() {
      return { results: await driver.all<T>(sql, params) };
    },
    async run() {
      await driver.run(sql, params);
      return {};
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    async batch(statements: readonly D1PreparedStatement[]) {
      const asStatements = statements as readonly (D1PreparedStatement & { sql: string; params: readonly SqlParam[] })[];
      await driver.batch(asStatements.map((entry): SqlStatement => ({ sql: entry.sql, params: entry.params })));
      return {};
    },
    close: () => driver.close?.() ?? Promise.resolve(),
  };
}

async function exampleConfig(): Promise<string> {
  return readFile(join(repoRoot(), "platform.config.example.yaml"), "utf8");
}

// `node --test` runs every test below in one process, i.e. one module scope -
// the same thing a real Worker isolate is. Most of these tests open their own
// throwaway D1 stand-in to model a *different* isolate serving a different
// licensee's database, which `worker/runtime.ts`'s isolate-lifetime cache has
// no way to tell apart from "the same isolate, a later request" on its own -
// that distinction is precisely what real Cloudflare deployment guarantees
// (one Worker, one database) and nothing inside a test process. Forgetting
// the cache before every test draws that boundary explicitly.
test.beforeEach(() => {
  forgetIsolateSqlCacheForTests();
});

/**
 * The example, switched to the real model.
 *
 * The key-missing path has to be asked for explicitly now. It used to come
 * free, because the example shipped `provider: anthropic` - which is the bug
 * that made a licensee's first deploy answer with the setup page.
 */
async function configWantingAKey(): Promise<string> {
  const text = await exampleConfig();
  const wanted = text.replace(/^(\s*)provider: mock\b/m, "$1provider: anthropic");
  assert.notEqual(wanted, text, "the example no longer says provider: mock - update this helper");
  return wanted;
}

test("a second operator's passphrase is a second Cloudflare variable, and a second name", async () => {
  // On a host there is no .env.local: another operator is another variable in
  // the same dashboard. This covers the wiring rather than the rule - the rule
  // is tested against the daemon in console.test.ts, and this is the band
  // (bindings, env, adapter) where every elementary bug in this project lived.
  const text = (await exampleConfig()).replace(
    /^(console:\n(?:.*\n)*?  tokenEnv: .*\n)/m,
    '$1  operators:\n    - name: "みどり"\n      tokenEnv: AMP_CONSOLE_TOKEN_MIDORI\n',
  );
  assert.match(text, /AMP_CONSOLE_TOKEN_MIDORI/, "the operators block has to reach the bundled config");

  const db = fakeD1();
  const handlers = createWorker({ configSource: "licensee", configText: text, prompts: {} });
  const env = {
    DB: db,
    AMP_CONSOLE_TOKEN: "the-owners-passphrase",
    AMP_CONSOLE_TOKEN_MIDORI: "midoris-own-passphrase",
  };

  const hers = await handlers.fetch(
    new Request("https://amp.example.workers.dev/api/state", {
      headers: { authorization: "Bearer midoris-own-passphrase" },
    }),
    env,
  );
  assert.equal(hers.status, 200, "her own variable opens the console");
  assert.equal(((await hers.json()) as { you?: string }).you, "みどり");

  const nobody = await handlers.fetch(
    new Request("https://amp.example.workers.dev/api/state", {
      headers: { authorization: "Bearer not-anyones-passphrase" },
    }),
    env,
  );
  assert.equal(nobody.status, 401);

  await db.close();
});

test("renaming console.tokenEnv renames the passphrase, on Cloudflare too", async () => {
  // The gate on this host asked `env.AMP_CONSOLE_TOKEN` while the router asked
  // the config. A licensee who renamed the variable had a correct console and
  // met the setup screen forever, and the screen told them to set a variable
  // their own config never mentions. Two gates, two questions, one door.
  const text = (await exampleConfig()).replace(/^(\s*)tokenEnv: .*$/m, "$1tokenEnv: AMP_MY_OWN_TOKEN");
  assert.match(text, /AMP_MY_OWN_TOKEN/, "the rename has to reach the bundled config");

  const db = fakeD1();
  const handlers = createWorker({ configSource: "licensee", configText: text, prompts: {} });

  const open = await handlers.fetch(
    new Request("https://amp.example.workers.dev/api/state", {
      headers: { authorization: "Bearer the-renamed-passphrase" },
    }),
    { DB: db, AMP_MY_OWN_TOKEN: "the-renamed-passphrase" },
  );
  assert.equal(open.status, 200, "the variable the config names is the one that opens it");

  // And with nothing set, the screen names the variable this config asked for.
  const setup = await handlers.fetch(new Request("https://amp.example.workers.dev/"), { DB: db });
  assert.equal(setup.status, 503);
  const body = await setup.text();
  assert.match(body, /AMP_MY_OWN_TOKEN/, "it named a variable the licensee does not have");
  assert.doesNotMatch(body, /AMP_CONSOLE_TOKEN/, "and told them to set one their config never mentions");

  await db.close();
});

test("the worker builds the whole company from a D1 binding and bundled text", async () => {
  const db = fakeD1();
  const runtime = await createWorkerRuntime({
    // Asking for the real model on purpose, so this covers the wiring a
    // paying licensee ends up on rather than only the simulated default.
    env: { DB: db, ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" },
    configText: await configWantingAKey(),
    prompts: { "analyst.system": "hello" },
  });
  assert.ok(runtime.ok, runtime.ok ? "" : runtime.error.message);

  // The store is a real one: the schema applied itself, and a write survives.
  await (await runtime.value.services.stores.for("ai-tools")).patterns.put({ id: "pat_1", ventureId: "ai-tools" } as never);
  const stored = await (await runtime.value.services.stores.for("ai-tools")).patterns.get("pat_1");
  assert.equal(stored?.id, "pat_1");

  // The switches came back from the same database, and nothing is stopped.
  assert.equal(runtime.value.state.read("paused").kind, "absent");
  // The prompts came from the build, not from a directory.
  assert.equal(runtime.value.services.prompts.has("analyst.system"), true);
  assert.equal(runtime.value.services.prompts.has("not-bundled"), false);

  await runtime.value.close();
  await db.close();
});

test("a missing model key is reported by name rather than crashing the worker", async () => {
  const db = fakeD1();
  const runtime = await createWorkerRuntime({
    env: { DB: db },
    configText: await configWantingAKey(),
    prompts: {},
  });
  assert.equal(runtime.ok, false);
  assert.equal(runtime.ok ? "" : runtime.error.code, "llm.no_api_key");
  // Cloudflare has no .env.local and no terminal to make one in, so the fix
  // the message names first has to be the one that exists there - a licensee
  // met this on the day they switched to the real model, and what it told them
  // to do was run a command on a machine they do not have.
  const message = runtime.ok ? "" : runtime.error.message;
  assert.match(message, /Variables and Secrets -> Add/);
  assert.ok(
    message.indexOf("Variables and Secrets") < message.indexOf(".env.local"),
    "the host's own fix comes before the one that needs a terminal",
  );
  // And on the screen they are actually reading, in the language the rest of
  // it is written in.
  if (!runtime.ok) assert.match(licenseeProblem(runtime.error), /モデルの鍵が設定されていません/);
  await db.close();
});

/**
 * The example, with its one offer pointed at Amazon.
 *
 * Amazon's Associates terms forbid the redirect this platform issues for
 * every offer (`src/config/schema.ts`, `FORBIDDEN_OFFER_HOSTS`) - a licensee
 * who added one like this would otherwise see the platform run normally and
 * earn nothing from it, silently.
 */
async function configWithAmazonOffer(): Promise<string> {
  const text = await exampleConfig();
  const wanted = text.replace(
    'landingUrl: "https://example.com/lp/demo-tool"',
    'landingUrl: "https://www.amazon.co.jp/dp/B000000000"',
  );
  assert.notEqual(wanted, text, "the example's demo offer landingUrl changed - update this helper");
  return wanted;
}

test("an Amazon offer is reported in Japanese on the screen a licensee reads, with the English detail kept underneath", async () => {
  // licenseeProblem translates this one specifically (keyed on the issue's
  // code, not the English prose) - every other config.invalid failure still
  // falls through untranslated, which is a separate, tracked gap.
  const db = fakeD1();
  const runtime = await createWorkerRuntime({
    env: { DB: db },
    configText: await configWithAmazonOffer(),
    prompts: {},
  });
  assert.equal(runtime.ok, false);
  assert.equal(runtime.ok ? "" : runtime.error.code, "config.invalid");
  if (!runtime.ok) {
    const problem = licenseeProblem(runtime.error);
    assert.match(problem, /Amazon/);
    assert.match(problem, /没収されます/, "forfeited, not merely uncounted");
    assert.match(problem, /直リンク/, "says there is no direct-link mode yet");
    assert.match(problem, /platform\.config\.yaml/);
    assert.match(problem, /active: false/);
    assert.match(problem, /GitHub の画面/, "the fix is worked in the browser, not a shell the licensee does not have");
    // The English original - which names the specific offer - is kept below it.
    assert.match(problem, /offer_demo_tool/);
    assert.match(problem, /amazon\.co\.jp/);
  }
  await db.close();
});

test("the example a licensee deploys opens the console with no key at all", async () => {
  // The promise is that you reach a working product holding no key. This ran
  // the other way for months: the example asked for the real model, so the
  // first deploy answered with the setup page and nothing said why.
  const db = fakeD1();
  const runtime = await createWorkerRuntime({
    env: { DB: db },
    configText: await exampleConfig(),
    prompts: { "analyst.system": "hello" },
  });
  assert.ok(runtime.ok, runtime.ok ? "" : runtime.error.message);
  await runtime.value.close();
  await db.close();
});

test("a configured deploy is not told to go and write the config again", async () => {
  // What a licensee actually saw: config in, passphrase in, no model key - and
  // a page whose one instruction was to copy the example over again. The step
  // was already done, so following it changes nothing and the real cause (the
  // key) reads as a footnote.
  const handlers = createWorker({
    configSource: "licensee",
    configText: await configWantingAKey(),
    prompts: {},
  });
  const token = "a-real-token-value";
  const response = await handlers.fetch(
    new Request(`https://amp.example.workers.dev/?token=${token}`),
    { DB: fakeD1(), AMP_CONSOLE_TOKEN: token },
  );
  const body = await response.text();
  assert.match(body, /ANTHROPIC_API_KEY/, "the page has to name what is actually missing");
  assert.doesNotMatch(
    body,
    /platform\.config\.example\.yaml/,
    "and must not ask for a file that is already there",
  );
});

test("a missing database binding is refused by name, not by throwing", async () => {
  const runtime = await createWorkerRuntime({
    env: {} as never,
    configText: await exampleConfig(),
    prompts: {},
  });
  assert.equal(runtime.ok, false);
  assert.match(runtime.ok ? "" : runtime.error.message, /D1 binding called DB/);
});

test("health answers before anything else has to work", async () => {
  const response = await worker.fetch(new Request("https://amp.example.workers.dev/healthz"), { DB: fakeD1() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, configured: configSource === "licensee" });
});

test("health names the version, when the build carried one", async () => {
  // `release` is a value the build closed over, not something read off disk or
  // a binding, so naming it here costs /healthz none of its promise that it
  // answers "whatever else is broken" - the value was already sitting in
  // memory before this request arrived, config and database included.
  const handlers = createWorker({
    configSource: "licensee",
    configText: await exampleConfig(),
    prompts: {},
    release: { version: "1.4.0", commit: "cafefee", builtAt: "2026-09-01T00:00:00.000Z", upstream: "owner/release" },
  });
  const response = await handlers.fetch(new Request("https://amp.example.workers.dev/healthz"), { DB: fakeD1() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, configured: true, version: "1.4.0" });
});

test("health names no version for a build that carries none, rather than the word undefined", async () => {
  const handlers = createWorker({ configSource: "licensee", configText: await exampleConfig(), prompts: {} });
  const response = await handlers.fetch(new Request("https://amp.example.workers.dev/healthz"), { DB: fakeD1() });
  assert.deepEqual(await response.json(), { ok: true, configured: true }, "no version key at all, not version: null or the string \"undefined\"");
});

test("with no config of its own, the worker serves the setup page rather than a stranger's example account", async (t) => {
  // The premise is a build with no licensee config - which is this repository,
  // and a licensee's fork before they write one. A checkout that *has* one
  // (ours, when someone is running the platform locally) cannot exercise this,
  // and must not be reported as a failure either.
  if (configSource === "licensee") return t.skip("this checkout bundles a real config");

  const response = await worker.fetch(new Request("https://amp.example.workers.dev/"), { DB: fakeD1() });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /あと1つ、決めるだけです/);
  // It asks the questions rather than handing over the 428-line file: the file
  // name comes after there is something to put in it, in the result view.
  assert.match(body, /<form method="post" action="\/setup">/, "it has to offer the way in");
  assert.match(body, /何について書きますか/);
  assert.match(body, /amp\.example\.workers\.dev/, "and show the address it is answering on");
});

test("the setup page is behind the passphrase once there is one", async (t) => {
  if (configSource === "licensee") return t.skip("this checkout bundles a real config");
  const env = { DB: fakeD1(), AMP_CONSOLE_TOKEN: "a-real-token-value" };

  const refused = await worker.fetch(new Request("https://amp.example.workers.dev/"), env);
  assert.equal(refused.status, 401, "what is set up and what is missing is not for strangers");

  const wrong = await worker.fetch(new Request("https://amp.example.workers.dev/?token=nope"), env);
  assert.equal(wrong.status, 401);

  const allowed = await worker.fetch(new Request("https://amp.example.workers.dev/?token=a-real-token-value"), env);
  assert.equal(allowed.status, 200);
  const page = await allowed.text();
  assert.match(page, /<span class="badge done">済<\/span><span class="what"><b>承認画面の合言葉/);
  assert.match(page, /設定されています/);
});


test("a link in a published post keeps redirecting when the rest cannot start", async () => {
  // The failure this prevents is silent and permanent: a config that stopped
  // validating, or a secret that went missing, would otherwise turn every link
  // already inside a published post into the setup page - and a click that is
  // not recorded cannot be counted afterwards.
  const db = fakeD1();
  const runtime = await createWorkerRuntime({
    env: { DB: db, ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" },
    configText: await exampleConfig(),
    prompts: {},
  });
  assert.ok(runtime.ok, runtime.ok ? "" : runtime.error.message);
  await (await runtime.value.services.stores.for("ai-tools")).links.put({
    id: "lnk_1",
    code: "abc123",
    ventureId: "main",
    offerId: "off_1",
    destinationUrl: "https://merchant.example/product?sub=abc123",
    createdAt: "2026-09-04T00:00:00Z",
  } as never);
  await runtime.value.close();

  // Configured and able to start, but with no passphrase: the console is
  // unreachable, on purpose.
  const worker = await configuredWorker();
  const env = { DB: db, ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" };

  const page = await worker.fetch(new Request("https://amp.example.workers.dev/"), env);
  assert.equal(page.status, 503, "the console must not open without a passphrase");

  const redirect = await worker.fetch(new Request("https://amp.example.workers.dev/go/abc123"), env);
  assert.equal(redirect.status, 302, "but the reader's link must still work");
  assert.equal(redirect.headers.get("location"), "https://merchant.example/product?sub=abc123");

  const after = await createWorkerRuntime({
    env: { DB: db, ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" },
    configText: await exampleConfig(),
    prompts: {},
  });
  assert.ok(after.ok);
  assert.equal((await (await after.value.services.stores.for("ai-tools")).clicks.all()).length, 1, "and the click must be recorded");
  await after.value.close();
  await db.close();
});

test("the D1 driver is kept for the isolate's life, even when env.DB is a different object each time", async () => {
  // `ensureSchema` (sql-store.ts) already keeps its own memo of which drivers
  // have been migrated - a `WeakMap` keyed on the driver, "once per driver for
  // as long as it lives, which on a Worker is once per isolate". But
  // `createWorkerRuntime` used to call `createD1Driver(env.DB)` fresh on every
  // single call, so that memo's key was fresh every time too and could never
  // hit - the schema's `PRAGMA table_info` check, and the six `CREATE ... IF
  // NOT EXISTS` statements behind it, ran again on every request, not once per
  // isolate as that comment already assumed.
  //
  // v0.12.1 fixed that by keying a new cache on `env.DB` itself, and the
  // version of this test that shipped with it passed the *identical* `db`
  // object to `createWorkerRuntime` twice. That only proves a `WeakMap` can
  // find a key it was handed back unchanged - it does not touch the actual
  // question, which is whether the Workers runtime hands `fetch` the same
  // `env.DB` object on the next request. Measured on the deployed Worker, it
  // does not behave as if it does: eight consecutive `/api/state` calls
  // seconds apart, well inside the portfolio memo's 30-second TTL, never once
  // returned faster than the first - the same shape of failure PR #83 had
  // just fixed one layer up, one layer further down.
  //
  // This test builds two *different* JS objects that both answer for the
  // same underlying database - standing in for "the same D1 database, a
  // structurally new binding object on the next call," which is what the
  // measurement above says production actually does. Counting
  // `PRAGMA table_info` calls - `migrate()`'s first statement - proves the
  // schema is checked once no matter how many distinct objects `env.DB` turns
  // out to be, which the identical-object version of this test could not
  // have told apart from the bug it was meant to catch.
  const raw = fakeD1();
  let pragmaCalls = 0;
  const freshBindingForSameDatabase = (): typeof raw => ({
    ...raw,
    prepare(sql: string) {
      if (sql.includes("PRAGMA table_info")) pragmaCalls += 1;
      return raw.prepare(sql);
    },
  });

  const first = await createWorkerRuntime({
    env: { DB: freshBindingForSameDatabase() },
    configText: await exampleConfig(),
    prompts: {},
  });
  assert.ok(first.ok, first.ok ? "" : first.error.message);
  await first.value.close();
  assert.equal(pragmaCalls, 1, "the first request in an isolate does check the schema");

  const second = await createWorkerRuntime({
    env: { DB: freshBindingForSameDatabase() },
    configText: await exampleConfig(),
    prompts: {},
  });
  assert.ok(second.ok, second.ok ? "" : second.error.message);
  await second.value.close();
  assert.equal(
    pragmaCalls,
    1,
    "a second request, even against a different object standing in for the same database, must reuse the driver rather than re-check the schema",
  );

  await raw.close();
});

test("an unknown code is still a 404, not a redirect to anywhere", async () => {
  const db = fakeD1();
  const worker = await configuredWorker();
  const response = await worker.fetch(new Request("https://amp.example.workers.dev/go/nope"), { DB: db });
  assert.equal(response.status, 404, "this endpoint must never become an open redirector");
  await db.close();
});

test("a cron that fires while the last one is still running does nothing", async () => {
  // Without this, two ticks publish the same due post twice. The test is that
  // the second one does not touch the database at all - not merely that the
  // lock said no.
  const held = new Set<string>();
  const lock = {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      async fetch(request: Request): Promise<Response> {
        const name = String(id);
        if (new URL(request.url).pathname === "/acquire") {
          if (held.has(name)) return Response.json({ acquired: false, holder: "someone" });
          held.add(name);
          return Response.json({ acquired: true });
        }
        held.delete(name);
        return Response.json({ released: true });
      },
    }),
  };

  const db = fakeD1();
  let queries = 0;
  const counted = { ...db, prepare: (sql: string) => (queries += 1, db.prepare(sql)) };
  const worker = await configuredWorker();
  const env = { DB: counted, LOCK: lock, ANTHROPIC_API_KEY: "sk-ant-not-a-real-key", AMP_CONSOLE_TOKEN: "t" };

  // Hold the dispatch lock, as an overrunning tick would.
  held.add("tick:dispatch");
  await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.UTC(2026, 8, 4, 0, 30) }, env);
  assert.equal(queries, 0, "the second tick must not even open the database");

  held.delete("tick:dispatch");
  await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.UTC(2026, 8, 4, 0, 31) }, env);
  assert.ok(queries > 0, "and must run once the first one is done");
  assert.equal(held.size, 0, "the lock is released afterwards");

  // The console's run button is the other way into the same work, so it takes
  // the same lock. The request path only gets one because `fetch` passes it
  // down; before it did, the button could run a day beside the hourly cron and
  // draft it twice.
  held.add("tick:cycles");
  const refused = await worker.fetch(
    new Request("https://amp.example.workers.dev/api/ventures/main/run", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    }),
    env,
  );
  assert.equal(refused.status, 409);

  await db.close();
});

test("the setup form turns answers into a config, without a terminal", async () => {
  // The licensee's first hour used to begin at a 428-line YAML file, which
  // docs/2-setup/onboarding.md names as where most people stop. This is the
  // whole path that replaces it, through the real handler.
  const handlers = createWorker({ configSource: "example", configText: await exampleConfig(), prompts: {} });

  const form = new URLSearchParams({
    companyName: "みどり商店",
    operatorName: "みどり",
    ventureId: "cosme",
    ventureName: "コスメ",
    niche: "敏感肌向けのスキンケア",
    audience: "季節の変わり目に肌が荒れる30代。",
    market: "jp",
    persona: "元美容部員。自分の肌で失敗してきた当事者。",
    firstPerson: "わたし",
  });
  const response = await handlers.fetch(
    new Request("https://amp-midori.workers.dev/setup", {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    {} as never,
  );

  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /みどり商店/, "their words are in the file it shows");
  // Their name, not "owner": it goes against every approval in the audit
  // trail, and that record cannot be rewritten later.
  assert.match(page, /operator: &quot;みどり&quot;/, "and the name approvals are recorded against");
  assert.match(page, /コピー/, "and there is a way to take it away");
  assert.match(page, /platform\.config\.yaml/, "and it names the file to create");
  // The comments are most of what the file is, and the reason it is filled in
  // as text rather than serialised from an object.
  assert.match(page, /景表法|ステルスマーケティング/, "the guidance comes with it");

  // The address it is answering on, filled in for them: until this is a real
  // host, every tracked link in every post goes to a name that does not resolve.
  assert.match(page, /amp-midori\.workers\.dev/);
  assert.doesNotMatch(page, /example\.invalid/);

  // The licensee has no terminal and no git. The most that can be removed from
  // here is choosing "Create new file" and typing the name - GitHub's own
  // editor takes a filename in the URL. The content cannot ride along (its
  // query strings cap out near 2KB and this file is twenty times that), so the
  // paste stays, and nothing here holds a credential for their repository.
  assert.match(page, /new\/main\?filename=platform\.config\.yaml/, "it opens the file already named");
  assert.match(page, /id="repo"/, "it asks where, rather than assuming");
  assert.match(page, /アドレスが分からないときは/, "and still works for someone who cannot answer that");
});

test("a refused setup form comes back filled in, saying everything that is wrong", async () => {
  const handlers = createWorker({ configSource: "example", configText: await exampleConfig(), prompts: {} });
  const response = await handlers.fetch(
    new Request("https://amp-midori.workers.dev/setup", {
      method: "POST",
      body: new URLSearchParams({ companyName: "", ventureId: "Cosme Shop", ventureName: "コスメ", market: "jp" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    {} as never,
  );

  assert.equal(response.status, 400);
  const page = await response.text();
  assert.match(page, /会社の名前/);
  assert.match(page, /id/);
  // Retyping what was accepted, to fix what was not, is how a form loses people.
  assert.match(page, /value="コスメ"/, "what was typed comes back");
});

test("the setup form still works once the passphrase is set, which is the state it asks for", async () => {
  // The dead end this nearly shipped with. The page tells the licensee to set
  // AMP_CONSOLE_TOKEN; doing so made every form submission 401, because the
  // setup path handed out no cookie and the form POSTs to /setup with no
  // ?token= on it. The earlier test missed it by passing {} as the env, so
  // there was no token and the branch was never entered.
  const handlers = createWorker({ configSource: "example", configText: await exampleConfig(), prompts: {} });
  const env = { AMP_CONSOLE_TOKEN: "s3cret" } as never;

  const page = await handlers.fetch(new Request("https://amp-m.workers.dev/?token=s3cret"), env);
  assert.equal(page.status, 200);
  const cookie = page.headers.getSetCookie()[0];
  assert.ok(cookie, "opening with the token must hand back a cookie the form can use");
  assert.match(cookie, /^amp_console=s3cret;/);
  assert.match(cookie, /HttpOnly/);

  const submitted = await handlers.fetch(
    new Request("https://amp-m.workers.dev/setup", {
      method: "POST",
      body: new URLSearchParams({
        companyName: "みどり商店", operatorName: "みどり", ventureId: "cosme", ventureName: "コスメ",
        niche: "スキンケア", audience: "30代", market: "jp", persona: "元美容部員", firstPerson: "わたし",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie.split(";")[0] as string },
    }),
    env,
  );
  assert.equal(submitted.status, 200, "the form the page hands them must be submittable");
  assert.match(await submitted.text(), /みどり商店/);
});

test("a body that is not a form is refused, not thrown out of the Worker", async () => {
  // An unguarded formData() throws, and a throw here escapes fetch() - the
  // licensee gets Cloudflare's own error page instead of anything this repo
  // wrote.
  const handlers = createWorker({ configSource: "example", configText: await exampleConfig(), prompts: {} });
  const response = await handlers.fetch(
    new Request("https://amp-m.workers.dev/setup", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    }),
    {} as never,
  );
  assert.equal(response.status, 400);
  assert.match(await response.text(), /読み取れませんでした/);
});

test("what is done, what is next and what can wait are three different marks", () => {
  // The panel used to open every line with a sentence ("できています — データの
  // 保管場所が…"), and the owner read the whole thing as prose on the first real
  // walk. A state has to be something the eye sorts before it reads.
  const page = renderSetup({
    configured: false,
    hasDatabase: true,
    hasConsoleToken: true,
    hasModelKey: false,
    address: "https://amp-test.example.workers.dev",
  });

  assert.match(page, /<span class="badge done">済<\/span><span class="what"><b>データの保管場所/);
  assert.match(page, /<span class="badge now">これから<\/span><span class="what"><b>設定/);
  // The one that must not read as a fault: at this point in the hour there is
  // no key on purpose, and the same red as a missing database would tell a
  // licensee they are broken while they are exactly where they should be.
  assert.match(page, /<span class="badge later">あとで<\/span><span class="what"><b>AIモデルの鍵/);
});

test("the setup page takes the passphrase in a field, because the address cannot carry it", async () => {
  // The deploy screen asks for a generated passphrase and this page then told
  // them to put it in `?token=…`. A `+` in one arrives as a space and a `#`
  // cuts off everything after it, so the passphrase the licensee was told to
  // make was the one they could not present - and there is no terminal here to
  // work around it in.
  const handlers = createWorker({ configSource: "example", configText: await exampleConfig(), prompts: {} });
  const env = { AMP_CONSOLE_TOKEN: "sunny+river+42" } as never;

  const pasted = await handlers.fetch(new Request("https://amp-m.workers.dev/?token=sunny+river+42"), env);
  assert.equal(pasted.status, 401, "in the address the + is a space by the time anything reads it");
  const page = await pasted.text();
  assert.match(page, /合言葉を入力してください/, "the refusal has to offer the way in");
  assert.match(page, /<input type="password" name="token"/);

  const unlocked = await handlers.fetch(
    new Request("https://amp-m.workers.dev/unlock", {
      method: "POST",
      body: new URLSearchParams({ token: "sunny+river+42", next: "/" }),
    }),
    env,
  );
  assert.equal(unlocked.status, 303);
  assert.equal(unlocked.headers.get("location"), "/");
  const cookie = unlocked.headers.getSetCookie()[0];
  assert.ok(cookie, "getting in has to hand back the session the setup form needs");
  assert.match(cookie, /^amp_console=sunny%2Briver%2B42;/, "encoded, so the browser keeps all of it");

  const opened = await handlers.fetch(
    new Request("https://amp-m.workers.dev/", { headers: { cookie: cookie.split(";")[0] as string } }),
    env,
  );
  assert.equal(opened.status, 200);
  assert.match(await opened.text(), /あと1つ、決めるだけです/);

  const wrong = await handlers.fetch(
    new Request("https://amp-m.workers.dev/unlock", {
      method: "POST",
      body: new URLSearchParams({ token: "sunny river 42", next: "//evil.example" }),
    }),
    env,
  );
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.getSetCookie().length, 0, "a refusal must never hand out a session");
});

test("the screen that says what is broken has a way to ask again", () => {
  // The fix is always somewhere else - the GitHub copy, or the Cloudflare
  // dashboard - and the page said "1〜2分でこの画面が動き始めます", which is
  // only true if something reloads it. Nothing did, and the first person
  // through this walk sat looking at a page with no control on it.
  const page = renderSetup({
    configured: true,
    problem: "llm.provider is \"anthropic\" but ANTHROPIC_API_KEY is not set.",
    hasDatabase: true,
    hasConsoleToken: true,
    hasModelKey: false,
    address: "https://amp-test.example.workers.dev",
  });

  assert.match(page, /<a class="again" href="\/">/, "a way back to the same question");
  assert.match(page, /直したら/);
});

test("the hourly cron does not restart a day that has already given up", async () => {
  // The band this project's elementary bugs live in, and the one the unit
  // tests are structurally blind to: a fresh isolate, a config read off disk,
  // D1 underneath, and the real `scheduled` handler dispatching on the cron
  // string. The tick's memory of "already tried" was always empty here, which
  // is why a dead day was re-run - and re-billed - every hour until midnight.
  const db = fakeD1();
  const env = { DB: db, ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" };

  // 09:00 in Asia/Tokyo, which is past the example account's 06:30 start, so
  // nothing but the judgement can be what stops this.
  const scheduledTime = Date.UTC(2026, 8, 19, 0, 0);
  const seeded = await createWorkerRuntime({ env, configText: await exampleConfig(), prompts: {} });
  assert.ok(seeded.ok, seeded.ok ? "" : seeded.error.message);
  const store = await seeded.value.services.stores.for("ai-tools");
  const cycleId = cycleIdFor("ai-tools", "2026-09-19");
  await store.cycles.put({
    id: cycleId,
    ventureId: "ai-tools",
    date: "2026-09-19",
    createdAt: "2026-09-18T21:30:00Z",
    updatedAt: "2026-09-18T21:35:00Z",
    status: "failed",
    nextStep: "plan",
    completed: [],
    artifacts: {},
    attempts: 2,
    failure: { step: "plan", message: "the output hit the cap", code: "llm.truncated", retryable: false },
  } as never);
  await seeded.value.close();

  const worker = await configuredWorker();
  await worker.scheduled({ cron: "0 * * * *", scheduledTime }, env);

  const after = await createWorkerRuntime({ env, configText: await exampleConfig(), prompts: {} });
  assert.ok(after.ok, after.ok ? "" : after.error.message);
  const read = await (await after.value.services.stores.for("ai-tools")).cycles.get(cycleId);
  assert.equal(read?.status, "failed", "the dead day was started again");
  assert.equal(read?.updatedAt, "2026-09-18T21:35:00Z", "and something wrote to it");
  assert.equal(read?.attempts, 2, "the attempt count moved, so a step ran");

  // And it said so, once: a day that stops quietly is a company that stops
  // quietly, and on this host there is no log anyone reads.
  const events = await (await after.value.services.stores.for("ai-tools")).audit.recent(10, { cycleId });
  assert.ok(
    events.some((event) => event.type === "cycle.retry_abandoned"),
    "giving up on the day was never recorded",
  );
  await after.value.close();
  await db.close();
});
