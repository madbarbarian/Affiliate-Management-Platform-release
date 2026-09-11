import assert from "node:assert/strict";
import test from "node:test";

import { checkForUpdate, latestNotes } from "../src/console/updates.ts";
import type { ReleaseStamp } from "../src/core/release.ts";

const mine: ReleaseStamp = {
  version: "0.2.0",
  commit: "aaaaaaa",
  builtAt: "2026-09-01T00:00:00.000Z",
  upstream: "owner/release",
};

/** A fetch that answers from a table, and records what was asked for. */
function fetcher(pages: Readonly<Record<string, string | number>>) {
  const asked: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const page = pages[url];
    if (page === undefined) return new Response("no", { status: 404 });
    if (typeof page === "number") return new Response("no", { status: page });
    return new Response(page, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, asked };
}

const upstreamStamp = (over: Partial<ReleaseStamp> = {}): string =>
  JSON.stringify({ ...mine, ...over });

const STAMP_URL = "https://raw.githubusercontent.com/owner/release/main/RELEASE.json";
const LOG_URL = "https://raw.githubusercontent.com/owner/release/main/CHANGELOG.md";

test("a copy running what is published is told it is current", async () => {
  const { impl, asked } = fetcher({ [STAMP_URL]: upstreamStamp() });
  assert.deepEqual(await checkForUpdate(mine, impl), { kind: "current", version: "0.2.0" });
  // The common case stays one request: nothing to describe, nothing fetched to
  // describe it with.
  assert.deepEqual(asked, [STAMP_URL]);
});

test("a copy behind the platform is told what changed, not just that it is behind", async () => {
  // "There is an update" with no way to see what is in it leaves the licensee
  // exactly where they started: unable to answer "will this break my morning?".
  const { impl } = fetcher({
    [STAMP_URL]: upstreamStamp({ commit: "bbbbbbb", version: "0.3.0", builtAt: "2026-09-11T00:00:00.000Z" }),
    [LOG_URL]: "# Changelog\n\npreamble\n\n## [Unreleased]\n\nnot this\n\n## [0.3.0] - 2026-09-11\n\n### Fixed\n\n- the thing\n\n## [0.2.0]\n\nolder\n",
  });
  const status = await checkForUpdate(mine, impl);
  assert.equal(status.kind, "behind");
  assert.equal(status.kind === "behind" && status.upstreamVersion, "0.3.0");
  assert.equal(status.kind === "behind" && status.version, "0.2.0", "and what they are on now");
  assert.match(status.kind === "behind" ? status.notes : "", /0\.3\.0/);
  assert.match(status.kind === "behind" ? status.notes : "", /the thing/);
  assert.doesNotMatch(status.kind === "behind" ? status.notes : "", /older/, "one section, not the whole file");
});

test("a development checkout says nothing and asks nobody", async () => {
  const { impl, asked } = fetcher({ [STAMP_URL]: upstreamStamp() });
  assert.deepEqual(await checkForUpdate(undefined, impl), { kind: "unknown", why: "not-a-release" });
  assert.deepEqual(asked, [], "no stamp means nothing to compare, so no request at all");
});

test("github being down costs the notice and nothing else", async () => {
  // This runs on the page an operator opened to approve today's posts. Every
  // failure here has to come back as "nothing to say".
  for (const answer of [500, 404, 403]) {
    const { impl } = fetcher({ [STAMP_URL]: answer });
    assert.deepEqual(await checkForUpdate(mine, impl), { kind: "unknown", why: "unreachable" });
  }

  const throws = (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as unknown as typeof fetch;
  assert.deepEqual(await checkForUpdate(mine, throws), { kind: "unknown", why: "unreachable" });
});

test("a published stamp that cannot be read is unreachable, not behind", async () => {
  // We cannot tell what changed, so telling them to take an update we cannot
  // describe is worse than saying nothing.
  for (const body of ["", "not json", JSON.stringify({ version: "9.9.9" })]) {
    const { impl } = fetcher({ [STAMP_URL]: body });
    assert.deepEqual(await checkForUpdate(mine, impl), { kind: "unknown", why: "unreachable" });
  }
});

test("an unreadable changelog still reports the update", async () => {
  // Knowing there is a fix matters more than knowing what it is. Losing the
  // notes must not lose the notice.
  const { impl } = fetcher({ [STAMP_URL]: upstreamStamp({ commit: "bbbbbbb" }) });
  const status = await checkForUpdate(mine, impl);
  assert.equal(status.kind, "behind");
  assert.equal(status.kind === "behind" && status.notes, "");
});

// The node:test timeout is the point, not decoration: without the abort inside
// `fetchText` this case does not fail, it hangs — and a suite that hangs is
// worse in CI than one that goes red, because nobody gets told why.
test("a slow server does not hold the console open", { timeout: 5_000 }, async () => {
  // `await fetch` alone does not cover a server that accepts and then goes
  // quiet. Without the abort the operator waits on someone else's outage.
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  // `AbortSignal.timeout` runs on an unref'd timer, so with nothing else
  // pending the test process would exit before it fires. In the console there
  // is always a request in flight holding the loop open; here we hold it.
  //
  // A timer that expires on its own, not an interval: if this test does hang,
  // the loop has to be able to drain so node:test can report the failure. An
  // interval cleared in `finally` is never cleared when `finally` is never
  // reached, and the suite hangs instead of going red.
  const keepAlive = setTimeout(() => {}, 3_000);
  try {
    const started = Date.now();
    assert.deepEqual(await checkForUpdate(mine, hang, { timeoutMs: 50 }), { kind: "unknown", why: "unreachable" });
    assert.ok(Date.now() - started < 2_000, "gave up rather than waiting");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("a huge body is truncated rather than read whole", async () => {
  const { impl } = fetcher({
    [STAMP_URL]: upstreamStamp({ commit: "bbbbbbb" }),
    [LOG_URL]: `## [9.9.9]\n\n${"x".repeat(500_000)}`,
  });
  const status = await checkForUpdate(mine, impl);
  assert.ok(status.kind === "behind" && status.notes.length <= 4_000);
});

test("a changelog with nothing released yet still says something", () => {
  // True of this platform before its first tagged release: every entry is
  // under Unreleased. "No changes" would be a lie.
  const notes = latestNotes("# Changelog\n\nwhat this file is for\n\n## [Unreleased]\n\n- a fix\n");
  assert.match(notes, /what this file is for/);
});
