/**
 * How a draft becomes Threads posts.
 *
 * Only one thing here is worth a test, and it is the one that was wrong: the
 * disclosure has to survive the length limit. Everything else about splitting
 * a thread is cosmetic; a post that promotes an offer with no notice on it is
 * a compliance failure on someone else's account.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { renderParts } from "../src/channels/threads.ts";

const MAX = 500;
const PR = "#PR ※本投稿にはアフィリエイトリンクを含みます";

function draft(overrides: Partial<Parameters<typeof renderParts>[0]> = {}) {
  return {
    hook: "僕が3日で捨てたツールの話。",
    body: "短い本文。",
    cta: "どこで抜けましたか。",
    disclosure: PR,
    hashtags: [] as readonly string[],
    ...overrides,
  };
}

test("a short post carries the disclosure", () => {
  const parts = renderParts(draft());
  assert.equal(parts.length, 1);
  assert.ok(parts[0]!.includes(PR));
});

test("a long first thread part keeps the disclosure instead of losing it", () => {
  // The bug: parts were trimmed to 500 characters *after* the disclosure was
  // appended, so a long opening part published an affiliate thread with no
  // notice anywhere in it. Trimming the copy is the acceptable loss here.
  const parts = renderParts(
    draft({ threadParts: ["あ".repeat(MAX), "二番目のパート。", "三番目のパート。"] }),
  );

  assert.ok(parts[0]!.length <= MAX, "the first part must still fit the channel's limit");
  assert.ok(
    parts[0]!.includes(PR),
    "the disclosure must survive the trim - it is the part that is not optional",
  );
});

test("an over-long single post still leads with the disclosure", () => {
  const parts = renderParts(draft({ body: "本文。".repeat(400) }));

  assert.ok(parts.length > 1, "it should have spilled into replies");
  assert.ok(parts[0]!.length <= MAX);
  assert.ok(parts[0]!.includes(PR), "a #PR buried in part four is not a disclosure");
});

test("every part respects the channel's limit", () => {
  const parts = renderParts(
    draft({ threadParts: ["あ".repeat(MAX * 2), "い".repeat(MAX * 2)] }),
  );
  for (const [index, part] of parts.entries()) {
    assert.ok(part.length <= MAX, `part ${index} is ${part.length} characters`);
  }
});

test("a post with no disclosure to carry is left alone", () => {
  const parts = renderParts(draft({ disclosure: "" }));
  assert.equal(parts.length, 1);
  assert.ok(!parts[0]!.includes("#PR"));
});
