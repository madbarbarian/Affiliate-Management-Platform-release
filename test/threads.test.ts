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

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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

test("a thread whose parts already open with the hook and end on the close says neither twice", () => {
  // The shape a real model returns, and the one the mock never did: the writer
  // wrote the finished thread, so part 1 already carries the hook and the last
  // part already lands the CTA. Prepending and appending regardless published
  // both twice.
  const hook = "結論から言うと、ファミリーキャンプは設営の最初の20分が全部です。";
  const cta = "到着して車から最初に下ろすの、何ですか？";
  const parts = renderParts(
    draft({
      hook,
      cta,
      hashtags: ["#キャンプ"],
      threadParts: [`${hook}\n\nキャンプ場8回分、ぜんぶ順番の問題でした。`, `僕が固定した手順です。\n\n${cta}`],
    }),
  );

  const whole = parts.join("\n\n");
  assert.equal(occurrences(whole, hook), 1, "the hook is published once, where the writer put it");
  assert.equal(occurrences(whole, cta), 1, "the close is published once, where the writer put it");
  assert.equal(occurrences(whole, "#キャンプ"), 1, "and the hashtag line is not doubled either");
});

test("a thread whose parts carry neither still leads with the hook and lands on the close", () => {
  // The other half: nothing may be *removed* by the check that stops things
  // being added. A writer that returns bare parts still gets a whole post.
  const parts = renderParts(draft({ threadParts: ["一番目のパート。", "二番目のパート。"] }));

  assert.ok(parts[0]!.startsWith("僕が3日で捨てたツールの話。"), "the hook still leads");
  assert.ok(
    parts.at(-1)!.includes("どこで抜けましたか。"),
    "the close still lands, as its own part at the end",
  );
});

test("an offer thread carries its disclosure in the first part, whichever shape the parts arrive in", () => {
  const hook = "結論から言うと、設営の最初の20分が全部です。";
  const cta = "最初に下ろすの、何ですか？";
  const long = "あ".repeat(MAX);

  for (const [shape, threadParts] of [
    ["parts already carrying the hook and the close", [`${hook}\n\n${long}`, `本文。\n\n${cta}`]],
    ["parts carrying neither", [long, "本文。"]],
  ] as const) {
    const parts = renderParts(draft({ hook, cta, threadParts }));
    assert.ok(parts[0]!.includes(PR), `${shape}: the notice must ride on the first part`);
    assert.ok(parts[0]!.length <= MAX, `${shape}: and the first part must still fit`);
  }
});

test("a post with no disclosure to carry is left alone", () => {
  const parts = renderParts(draft({ disclosure: "" }));
  assert.equal(parts.length, 1);
  assert.ok(!parts[0]!.includes("#PR"));
});

test("a close that sits above the hashtags is still a close that was already said", () => {
  // The shape the anchored check missed: the writer ends the last part with the
  // question and then the tags, so nothing "ends with" the question and it was
  // appended a second time.
  const parts = renderParts({
    hook: "結論から言うと、設営の最初の20分が全部です。",
    body: "",
    cta: "到着して車から最初に下ろすの、何ですか？",
    disclosure: "",
    hashtags: ["#ファミリーキャンプ"],
    threadParts: [
      "結論から言うと、設営の最初の20分が全部です。\n\n8回測りました。",
      "うちが固定した手順です。\n\n到着して車から最初に下ろすの、何ですか？\n\n#ファミリーキャンプ",
    ],
  });

  const whole = parts.join("\n");
  assert.equal(whole.split("到着して車から最初に下ろすの、何ですか？").length - 1, 1, "asked once");
  assert.equal(whole.split("#ファミリーキャンプ").length - 1, 1, "tagged once");
});
