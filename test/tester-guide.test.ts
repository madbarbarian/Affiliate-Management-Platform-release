/**
 * What the tester's guide has to keep being.
 *
 * `docs/2-setup/tester-guide.md` is handed to the first person outside this
 * project who touches the product, and requirements §3.1 says that person has
 * no terminal. A line telling them to type something is not merely unhelpful:
 * it is the end of their walk, because there is nowhere for them to type it.
 * The pattern is the one `test/console.test.ts` and `test/canvas.test.ts`
 * already run over the console and its canvases - imported, not restated, so
 * the three cannot drift into three different ideas of what a command is.
 *
 * The second test guards the other failure this repository keeps having: the
 * same question answered in three documents, with nothing saying which answer
 * is current. Two older guides in the same directory describe a first hour that
 * no longer exists, and both still open and still read as finished. The mark at
 * the top is what stops a reader starting there.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../src/config/load.ts";
import { MESSAGES, type MessageKey } from "../src/console/messages.ts";
import { TERMINAL_COMMAND } from "./terminal-command.ts";

const SETUP_DIR = join(repoRoot(), "docs", "2-setup");
const GUIDE = "tester-guide.md";

/**
 * The guides the tester's guide takes over from. Named, because "every other
 * file in the directory" would sweep in `onboarding.md`, which is a design
 * document about the first hour rather than a route through it.
 */
const SUPERSEDED: readonly string[] = ["licensee-guide.md", "first-week.md"];

/**
 * How far into a file the mark has to be. Far enough for a title and a blank
 * line, near enough that nobody scrolls past it.
 */
const MARK_WITHIN_LINES = 12;

function read(name: string): string {
  return readFileSync(join(SETUP_DIR, name), "utf8");
}

test("the tester's guide never asks for a command to be typed", () => {
  const offenders: string[] = [];
  for (const [index, line] of read(GUIDE).split("\n").entries()) {
    if (TERMINAL_COMMAND.test(line)) offenders.push(`${GUIDE}:${index + 1}: ${line.trim()}`);
  }
  if (offenders.length > 0) {
    assert.fail(
      "the tester has no terminal, and these lines hand them a command:\n  " +
        offenders.join("\n  ") +
        "\nSay which button on which screen does it, or which line of " +
        "platform.config.yaml to change in GitHub.",
    );
  }
});

test("each guide it replaces carries a mark pointing at it", () => {
  for (const name of SUPERSEDED) {
    const head = read(name).split("\n").slice(0, MARK_WITHIN_LINES);
    // A blockquote, because that is what a reader's eye reads as "before you
    // start" rather than as the document's own first paragraph.
    const marked = head.some((line) => line.startsWith(">") && line.includes(GUIDE));
    assert.ok(
      marked,
      `docs/2-setup/${name} describes a first hour that ${GUIDE} replaced, and nothing in its ` +
        `first ${MARK_WITHIN_LINES} lines says so. Put a blockquote there naming ${GUIDE}: what is ` +
        `out of date, and which document to read instead.`,
    );
  }
});

/**
 * A document that tells a licensee to press "Run workflow" has to tell them how
 * the workflow got there.
 *
 * The copy the Deploy button makes has no workflows at all - GitHub will not let
 * Cloudflare's app write under `.github/workflows/`, and a real deploy's Actions
 * tab came up empty. The updater arrives as `update-workflow.yml` at the top and
 * has to be pasted into place once. The design had that step (the onboarding
 * canvas's last board). The tester's guide and the README's update section, both
 * written the same day, dropped it - each was right on its own, and the seam
 * between "the button made your copy" and "press Run workflow" had nothing in it.
 * A tester would have started with no way to receive an update at all.
 */
test("anything that says Run workflow also says how the updater is installed", () => {
  const INSTALLED_AT = ".github/workflows/take-updates.yml";
  const documents: readonly [string, string][] = [
    ["docs/2-setup/tester-guide.md", readFileSync(join(SETUP_DIR, GUIDE), "utf8")],
    ["README.md", readFileSync(join(repoRoot(), "README.md"), "utf8")],
  ];
  for (const [path, text] of documents) {
    if (!text.includes("Run workflow")) continue;
    assert.ok(
      text.includes(INSTALLED_AT),
      `${path} tells the reader to press Run workflow but never says to put the updater at ` +
        `${INSTALLED_AT}. The Deploy button's copy has no workflows, so that button does not exist yet.`,
    );
  }
});

// ---------------------------------------------------------------------------
// Screen copy the guide quotes
// ---------------------------------------------------------------------------

/*
 * The guide quotes the console. That is the right thing for it to do - a tester
 * reading 「あなたが投稿する番です」 here and seeing it there knows they are in
 * the right place - and it is also how the guide rots, because the quote and
 * the screen are two copies of one sentence with nothing joining them.
 *
 * It rotted exactly that way. §13 told a tester to look for a 「最初のコメント
 * （…）」 panel and quoted 「アフィリエイトリンクはこのコメントに入っています。
 * 投稿したあと、最初の返信として貼ってください。」 - both were the screen's own
 * words when they were written, and neither existed any more by the time anyone
 * noticed. The stale quotes were the symptom; the absence of any join was the
 * defect.
 *
 * So a quote declares which message it is: `<!--screen:handOver.lede-->` at the
 * end of the line. Two checks hang off that, and they fail for opposite
 * reasons:
 *
 *   1. a declared quote that no longer matches its message - the rot itself;
 *   2. an *undeclared* line that matches a message - screen copy pasted in
 *      without a declaration, caught on the day it is pasted, while it still
 *      matches and while fixing it is one comment long.
 *
 * What this does not cover, said plainly rather than left to look covered:
 *
 * - Copy that does not live in `messages.ts`. The unlock screen
 *   (`src/console/unlock.ts`) and the Worker's setup page (`src/worker/setup.ts`)
 *   hold their Japanese inline, so the guide's quotes of those screens are not
 *   joined to anything. That is a defect in those two files - they are also
 *   untranslatable - and it is not fixed here.
 * - Copy short enough that the message is mostly punctuation. 「{text}」 would
 *   match every quotation in the file, so a message has to carry
 *   `FINGERPRINT_MIN` characters of its own to be recognisable as itself.
 * - A second, undeclared quote on a line that already declares one. Check 2
 *   reads the line, not each quotation in it.
 */

/**
 * How much literal text a message needs before an unmarked line matching it is
 * evidence of anything. 「{text}」 and 「{gate} — {venture}」 are punctuation with
 * a hole in them: they match any quotation at all, and requiring a declaration
 * on every 「」 in the guide would bury the declarations that mean something.
 */
const FINGERPRINT_MIN = 8;

const SCREEN_MARKER = /<!--\s*screen:\s*([A-Za-z0-9_.]+)\s*-->/g;

/** A message as a pattern: its own words fixed, its `{placeholders}` open. */
function shapeOf(message: string): RegExp {
  const literal = message
    .split(/\{\w+\}/g)
    .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${literal.join(".+?")}$`);
}

/** The characters a message carries itself, with the holes taken out. */
function fingerprintLength(message: string): number {
  return message.replace(/\{\w+\}/g, "").length;
}

/**
 * The quotations in one line of the guide: the line itself, and anything it
 * sets off with 「」 or **bold**.
 *
 * All three, because the guide quotes all three ways - a blockquote is the
 * whole line, a button name is 「コピー」, and a heading is bold inside a
 * sentence - and a check that knew only one of them would pass by not looking.
 */
function quotations(line: string): string[] {
  const text = line.replace(SCREEN_MARKER, "");
  const bare = text.replace(/^[\s>\-*]*/, "").replace(/\*\*/g, "").trim();
  const found = [bare];
  for (const match of text.matchAll(/「([^」]+)」/g)) found.push(match[1]!.replace(/\*\*/g, "").trim());
  for (const match of text.matchAll(/\*\*([^*]+)\*\*/g)) found.push(match[1]!.trim());
  return found;
}

const SCREEN_WORDS = Object.entries(MESSAGES.ja).map(([key, message]) => ({
  key: key as MessageKey,
  message,
  shape: shapeOf(message),
  fingerprint: fingerprintLength(message),
}));

test("every quote the guide declares still matches what the screen says", () => {
  const stale: string[] = [];
  for (const [index, line] of read(GUIDE).split("\n").entries()) {
    for (const marker of line.matchAll(SCREEN_MARKER)) {
      const key = marker[1] as MessageKey;
      const word = SCREEN_WORDS.find((candidate) => candidate.key === key);
      if (!word) {
        stale.push(`${GUIDE}:${index + 1}: there is no message called "${key}" any more`);
        continue;
      }
      if (!quotations(line).some((quotation) => word.shape.test(quotation))) {
        stale.push(
          `${GUIDE}:${index + 1}: quotes "${key}" but the screen now says 「${word.message}」\n      the guide says: ${line.replace(SCREEN_MARKER, "").trim()}`,
        );
      }
    }
  }
  if (stale.length > 0) {
    assert.fail(
      "the guide quotes screen copy that has changed under it:\n  " +
        stale.join("\n  ") +
        "\nRewrite the line to what the screen says now, or point the declaration at the message that replaced it.",
    );
  }
});

test("screen copy in the guide says which message it is quoting", () => {
  const undeclared: string[] = [];
  for (const [index, line] of read(GUIDE).split("\n").entries()) {
    if (SCREEN_MARKER.test(line)) {
      SCREEN_MARKER.lastIndex = 0;
      continue;
    }
    SCREEN_MARKER.lastIndex = 0;
    for (const quotation of quotations(line)) {
      const word = SCREEN_WORDS.find(
        (candidate) => candidate.fingerprint >= FINGERPRINT_MIN && candidate.shape.test(quotation),
      );
      if (word) {
        undeclared.push(`${GUIDE}:${index + 1}: 「${quotation}」 is ${word.key}`);
        break;
      }
    }
  }
  if (undeclared.length > 0) {
    assert.fail(
      "these lines quote the console without saying so, so nothing will notice when the console changes:\n  " +
        undeclared.join("\n  ") +
        "\nPut <!--screen:the.key--> at the end of the line.",
    );
  }
});
