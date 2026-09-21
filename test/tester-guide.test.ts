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
