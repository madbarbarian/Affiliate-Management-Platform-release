/**
 * What the design canvases have to keep being.
 *
 * `canvas.html` is committed, so it can rot in two directions at once: a board
 * can change without the page being redrawn, and a board can be added without
 * `canvas.json` being told about it. Both leave a canvas that still opens and
 * still looks finished while no longer being the picture of the design — which
 * is the only reason the canvas exists.
 *
 * Nothing here counts boards. The canvas gains screens; a test that says
 * "fourteen" is a test that will be wrong and will be edited to match rather
 * than read.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANVAS_TARGETS,
  boardDocument,
  buildCanvas,
  canvasOutputPath,
  escapeHtml,
  readCanvas,
} from "../scripts/build-canvas.ts";
import type { CanvasTarget } from "../scripts/build-canvas.ts";
import { repoRoot } from "../src/config/load.ts";
import { TERMINAL_COMMAND } from "./terminal-command.ts";

const ROOT = repoRoot();

/** A board with nothing in it but the shape every `.dc.html` has. */
function board(text: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    "<x-dc><helmet><style>body { margin: 0 }</style></helmet>",
    `<div class="frame">${text}</div></x-dc>`,
    "<script data-dc-script data-props='{}'>",
    "class Component extends DCLogic { renderVals() { return {}; } }",
    "</script></body></html>",
  ].join("");
}

interface Scratch extends CanvasTarget {
  root: string;
}

/** A throwaway canvas directory, so the deliberately broken cases touch nothing real. */
function scratch(files: Record<string, string>, canvas: unknown): Scratch {
  const root = mkdtempSync(join(tmpdir(), "amp-canvas-"));
  const dir = "design";
  mkdirSync(join(root, dir));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, dir, name), text);
  writeFileSync(join(root, dir, "canvas.json"), JSON.stringify(canvas), "utf8");
  return { root, dir, title: "てすと" };
}

const PLACED = { x: 0, y: 0, w: 390, h: 844 };

test("every board named in canvas.json is labelled on the canvas it draws", () => {
  for (const target of CANVAS_TARGETS) {
    const html = buildCanvas(target, ROOT);
    for (const artboard of readCanvas(join(ROOT, target.dir), target.dir).artboards) {
      assert.ok(
        html.includes(escapeHtml(artboard.title)),
        `${target.dir}/canvas.html does not label ${artboard.file} with "${artboard.title}"`,
      );
    }
  }
});

test("no template syntax survives into the canvas a person opens", () => {
  // Main.dc.html and Publish.dc.html are the live ones. If their component
  // logic stopped being evaluated, a reader would be looking at
  // {{ventureName}} and <sc-for> instead of the screen.
  for (const target of CANVAS_TARGETS) {
    const html = buildCanvas(target, ROOT);
    for (const leftover of ["{{", "sc-for", "sc-if", "x-dc", "DCLogic"]) {
      assert.ok(
        !html.includes(leftover),
        `${target.dir}/canvas.html still contains "${leftover}" — the board was copied, not rendered`,
      );
    }
  }
});

test("a canvas.json pointing at a board that is not there stops the build", (t) => {
  const target = scratch({}, { artboards: [{ file: "Gone.dc.html", ...PLACED, title: "消えた板" }] });
  t.after(() => rmSync(target.root, { recursive: true, force: true }));

  assert.throws(
    () => buildCanvas(target, target.root),
    (error: Error) =>
      error.message.includes("points at Gone.dc.html") &&
      error.message.includes("remove that artboard"),
    "a missing board has to fail the build, and the message has to say both ways out",
  );
});

test("a board on disk that canvas.json does not list stops the build", (t) => {
  const target = scratch(
    { "Kept.dc.html": board("kept"), "Stray.dc.html": board("stray") },
    { artboards: [{ file: "Kept.dc.html", ...PLACED, title: "載っている板" }] },
  );
  t.after(() => rmSync(target.root, { recursive: true, force: true }));

  assert.throws(
    () => buildCanvas(target, target.root),
    (error: Error) =>
      error.message.includes("Stray.dc.html") && error.message.includes("left off the canvas"),
    "adding a board and forgetting canvas.json has to fail, not silently drop the board",
  );
});

test("a note's **bold** is drawn bold, and its blank line starts a paragraph", (t) => {
  const target = scratch(
    { "One.dc.html": board("one") },
    {
      artboards: [{ file: "One.dc.html", ...PLACED, title: "1枚" }],
      annotations: [{ id: "n", x: 0, y: 900, w: 390, text: "**押す前に見える**必要がある。\n\n2段落目。" }],
    },
  );
  t.after(() => rmSync(target.root, { recursive: true, force: true }));

  const html = buildCanvas(target, target.root);
  assert.ok(html.includes("<strong>押す前に見える</strong>"), "** ** did not become bold");
  assert.ok(html.includes("<p>2段落目。</p>"), "a blank line did not start a new paragraph");
  assert.ok(!html.includes("**"), "the ** markers were left on the screen");
});

/*
 * The canvases ship: `make-release.ts` puts `docs` in INCLUDE and nothing
 * excludes `_proposed/design`, so a licensee reads these boards as the product.
 * A screen that has never been built therefore has to say so on the board, or
 * it is being shown as something they can go and use.
 */
const IMPLEMENTED = "実装済";
const PROPOSAL = "提案（未実装）";

/**
 * What one board draws inside the canvas a person opens.
 *
 * The iframe's `srcdoc` alone, never the element around it: the title is an
 * attribute on the same tag and it carries the state word, so a check that
 * kept it would pass on every proposal board whether or not the board itself
 * said anything.
 */
function boardSrcdoc(html: string, title: string): string {
  const opens = html.indexOf(`<iframe title="${escapeHtml(title)}"`);
  assert.notEqual(opens, -1, `the canvas has no board titled "${title}"`);
  const doc = html.indexOf('srcdoc="', opens) + 'srcdoc="'.length;
  return html.slice(doc, html.indexOf('"></iframe>', doc));
}

test("every board's title says whether the screen exists", () => {
  // Two words, not a scale. The state a reader needs is "can I use this", and
  // anything richer gets written differently by each person who adds a board.
  for (const target of CANVAS_TARGETS) {
    for (const artboard of readCanvas(join(ROOT, target.dir), target.dir).artboards) {
      assert.ok(
        artboard.title.includes(IMPLEMENTED) || artboard.title.includes(PROPOSAL),
        `${target.dir}/canvas.json: "${artboard.title}" does not say whether the screen exists. ` +
          `End the title with （${IMPLEMENTED} v0.7.0） or ・${PROPOSAL} — check the code, not this README.`,
      );
    }
  }
});

test("a board that is only a proposal says so on the board, not only in its title", () => {
  // The title lives in canvas.json and is drawn by canvas.html alone. Opening
  // `Connect.dc.html` on its own - which is what a link to one screen does -
  // shows none of it, so the mark has to be inside the board's own document.
  for (const target of CANVAS_TARGETS) {
    const html = buildCanvas(target, ROOT);
    for (const artboard of readCanvas(join(ROOT, target.dir), target.dir).artboards) {
      const drawn = boardSrcdoc(html, artboard.title);
      if (artboard.title.includes(PROPOSAL)) {
        assert.ok(
          drawn.includes(PROPOSAL),
          `${target.dir}/${artboard.file} is a proposal but the board itself does not say so. ` +
            `Add <div class="proposal-mark">${PROPOSAL}</div> before </x-dc>, with the style the other proposal boards use.`,
        );
      } else {
        assert.ok(
          !drawn.includes(PROPOSAL),
          `${target.dir}/${artboard.file} is titled ${IMPLEMENTED} but still carries the proposal mark. ` +
            `Delete the mark from the board when the screen ships.`,
        );
      }
    }
  }
});

test("no board's screen copy hands the licensee a command to type", () => {
  /*
   * The same check `test/console.test.ts` runs over the console, over the
   * picture of the console, using the same pattern. It reads the *rendered*
   * board - the screen - so the component's own script is out of scope, and
   * so are the notes in canvas.json: those are the design's record, read by
   * somebody auditing it, and they cite `doctor` and the terminal precisely
   * because requirement §3.1 says the licensee has neither.
   */
  const offenders: string[] = [];
  for (const target of CANVAS_TARGETS) {
    const dir = join(ROOT, target.dir);
    for (const artboard of readCanvas(dir, target.dir).artboards) {
      const where = `${target.dir}/${artboard.file}`;
      const document = boardDocument(readFileSync(join(dir, artboard.file), "utf8"), where);
      for (const [index, line] of document.split("\n").entries()) {
        if (TERMINAL_COMMAND.test(line)) offenders.push(`${where}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  if (offenders.length > 0) {
    assert.fail(
      "a board tells the licensee to type something, and they have no terminal:\n  " +
        offenders.join("\n  ") +
        "\nSay what the screen does, or name the setting in the config file.",
    );
  }
});

test("the committed canvas.html is what the boards draw today", () => {
  for (const target of CANVAS_TARGETS) {
    const path = canvasOutputPath(target, ROOT);
    assert.equal(
      readFileSync(path, "utf8"),
      buildCanvas(target, ROOT),
      `${target.dir}/canvas.html is stale. Run \`npm run build:canvas\` and commit the result.`,
    );
  }
});
