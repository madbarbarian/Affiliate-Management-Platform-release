#!/usr/bin/env node
/**
 * Draws a design canvas as one static HTML page.
 *
 * The published canvases used to be produced by `seed-canvas.mjs`, a tool that
 * shipped inside Claude's design skill and is no longer there. The sources -
 * `canvas.json` and the `.dc.html` boards - never left this repository, so
 * what went missing was only the drawing. This is the drawing, owned here,
 * with nothing to lose again.
 *
 * Each board becomes an `<iframe srcdoc>`. That is not a stylistic choice:
 * every `.dc.html` was written as a whole document and carries its own `:root`
 * variables and its own `body`, `h1`, `header` and `.card` rules. Concatenated
 * into one page, the last board's `body` rule wins for all of them and every
 * `.card` takes the colours of whichever file was appended last. The
 * alternative - rewriting every selector to be scoped - means owning a CSS
 * parser. An iframe is a document boundary: complete isolation, no dependency,
 * and the boards stay byte-identical to what a designer edits.
 *
 * Usage:
 *   node scripts/build-canvas.ts
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The file in a canvas directory that owns placement, titles and notes. */
const CANVAS_FILE = "canvas.json";
/** What this script writes, next to the boards. Committed, so GitHub can open it. */
const OUTPUT_FILE = "canvas.html";
/** How a board is recognised on disk. */
const BOARD_SUFFIX = ".dc.html";

export interface CanvasTarget {
  /** Repository-relative, so an error message says the path a person can open. */
  readonly dir: string;
  readonly title: string;
}

/** Every canvas this repository draws. A new canvas directory is added here. */
export const CANVAS_TARGETS: readonly CanvasTarget[] = [
  { dir: "docs/_proposed/design", title: "運用者の2つの判断 — 画面設計" },
  { dir: "docs/_proposed/design/onboarding", title: "ライセンシーの最初の1時間 — 画面設計" },
];

/** Room above each board for its title. The board's own top edge stays at `y`. */
const BOARD_LABEL_HEIGHT_PX = 28;
/** Breathing room around the outermost thing on the canvas. */
const CANVAS_MARGIN_PX = 120;
/** How far the overview toggle shrinks the canvas. Small enough to see it all. */
const OVERVIEW_SCALE = 0.3;

/** Sticky-note metrics. Only used to work out how far the canvas has to scroll. */
const NOTE_FONT_SIZE_PX = 13;
const NOTE_LINE_HEIGHT_PX = 21;
const NOTE_PADDING_PX = 14;
const NOTE_PARAGRAPH_GAP_PX = 12;

/** A board's logic is design-time sample data, not a program. It has no reason to loop. */
const LOGIC_TIMEOUT_MS = 2_000;

export interface Artboard {
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  is_interactive?: boolean;
}

export interface Annotation {
  id?: string;
  x: number;
  y: number;
  w: number;
  text: string;
}

export interface CanvasFile {
  artboards: Artboard[];
  annotations?: Annotation[];
}

/** A board with the document that goes into its iframe. */
interface DrawnBoard extends Artboard {
  document: string;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * A note's text as paragraphs, with `**...**` bold.
 *
 * Escaping happens first so a note can talk about `<sc-for>` without becoming
 * one; `**` survives escaping untouched, which is why the order is safe.
 */
export function noteBody(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) =>
      escapeHtml(paragraph)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replaceAll("\n", "<br>"),
    )
    .map((paragraph) => `<p>${paragraph}</p>`)
    .join("");
}

/**
 * How tall a note will end up, near enough.
 *
 * Nothing renders from this - the notes size themselves - but absolutely
 * positioned children do not stretch their container, so without an estimate
 * the page stops scrolling above the lowest note. Japanese sets close to one
 * character per font size, and `**` markers count as text here, so this reads
 * a little high. Too tall only costs blank space; too short hides a note.
 */
export function estimateNoteHeight(note: Annotation): number {
  const columns = Math.max(1, Math.floor((note.w - NOTE_PADDING_PX * 2) / NOTE_FONT_SIZE_PX));
  const paragraphs = note.text.split(/\n{2,}/);
  const lines = paragraphs.reduce(
    (total, paragraph) => total + Math.max(1, Math.ceil(paragraph.length / columns)),
    0,
  );
  return (
    NOTE_PADDING_PX * 2 +
    lines * NOTE_LINE_HEIGHT_PX +
    (paragraphs.length - 1) * NOTE_PARAGRAPH_GAP_PX
  );
}

// ---------------------------------------------------------------------------
// Reading a .dc.html board
// ---------------------------------------------------------------------------

interface ElementSpan {
  /** Index of the `<`. */
  start: number;
  /** Index just past the opening tag's `>`. */
  bodyStart: number;
  /** Index of the closing tag's `<`. */
  bodyEnd: number;
  /** Index just past the closing tag's `>`. */
  end: number;
  /** The opening tag, attributes included. */
  openTag: string;
}

/**
 * Finds one element by tag name, counting depth so a nested `<sc-if>` inside an
 * `<sc-if>` closes the inner one first. Main.dc.html has exactly that shape.
 */
function elementSpan(html: string, tag: string, from = 0): ElementSpan | undefined {
  const opening = new RegExp(`<${tag}(\\s[^>]*)?>`, "g");
  opening.lastIndex = from;
  const open = opening.exec(html);
  if (!open) return undefined;

  const openTag = open[0]!;
  const bodyStart = open.index + openTag.length;
  const scanner = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  scanner.lastIndex = bodyStart;
  let depth = 1;
  let step: RegExpExecArray | null;
  while ((step = scanner.exec(html)) !== null) {
    const token = step[0]!;
    depth += token.startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return { start: open.index, bodyStart, bodyEnd: step.index, end: step.index + token.length, openTag };
    }
  }
  return undefined;
}

function attributeOf(openTag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(openTag);
  return match?.[1];
}

type Scope = Record<string, unknown>;

const HOLE = /\{\{\s*([\w.$]+)\s*\}\}/g;
const WHOLE_HOLE = /^\{\{\s*([\w.$]+)\s*\}\}$/;

function lookUp(scope: Scope, path: string, where: string): unknown {
  let value: unknown = scope;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object" || !(key in value)) {
      throw new Error(
        `${where}: the markup asks for {{${path}}}, but nothing named "${key}" is there. ` +
          `Return "${key}" from renderVals() in ${where}, or take {{${path}}} out of the markup.`,
      );
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function fillHoles(html: string, scope: Scope, where: string): string {
  return html.replace(HOLE, (_match, path: string) => {
    const value = lookUp(scope, path, where);
    // Handlers exist so the editor could make a board clickable. A picture has
    // nothing to call, and printing a function body into an attribute would be
    // worse than printing nothing.
    if (typeof value === "function") return "";
    if (value === undefined || value === null) return "";
    return escapeHtml(String(value));
  });
}

function holeName(attribute: string | undefined, tag: string, where: string): string {
  const name = attribute === undefined ? undefined : WHOLE_HOLE.exec(attribute)?.[1];
  if (name === undefined) {
    throw new Error(
      `${where}: a <${tag}> is missing the attribute that says what it reads ` +
        `(<sc-if value="{{name}}"> / <sc-for list="{{name}}" as="item">). Fix the tag in ${where}.`,
    );
  }
  return name;
}

/**
 * Turns the two live tags into the markup they would produce.
 *
 * `sc-if` and `sc-for` are read against the values `renderVals()` actually
 * returns, not against the `hint-placeholder-*` attributes the editor used.
 * Both agree on the boards here, and the real values carry the real sample
 * text - three named plans, four slots with their times - which is the thing
 * the canvas exists to show.
 */
function renderMarkup(html: string, scope: Scope, where: string): string {
  const candidates = ["sc-if", "sc-for"]
    .map((tag) => ({ tag, span: elementSpan(html, tag) }))
    .filter((found): found is { tag: string; span: ElementSpan } => found.span !== undefined)
    .sort((a, b) => a.span.start - b.span.start);

  const first = candidates[0];
  if (!first) return fillHoles(html, scope, where);

  const { tag, span } = first;
  const body = html.slice(span.bodyStart, span.bodyEnd);
  const middle =
    tag === "sc-if"
      ? renderIf(span, body, scope, where)
      : renderFor(span, body, scope, where);

  return (
    fillHoles(html.slice(0, span.start), scope, where) +
    middle +
    renderMarkup(html.slice(span.end), scope, where)
  );
}

function renderIf(span: ElementSpan, body: string, scope: Scope, where: string): string {
  const name = holeName(attributeOf(span.openTag, "value"), "sc-if", where);
  return lookUp(scope, name, where) ? renderMarkup(body, scope, where) : "";
}

function renderFor(span: ElementSpan, body: string, scope: Scope, where: string): string {
  const name = holeName(attributeOf(span.openTag, "list"), "sc-for", where);
  const alias = attributeOf(span.openTag, "as");
  if (!alias) {
    throw new Error(
      `${where}: <sc-for list="{{${name}}}"> has no as="..." attribute, so its body ` +
        `has no name for each item. Add as="item" to that tag in ${where}.`,
    );
  }

  const list = lookUp(scope, name, where);
  if (!Array.isArray(list)) {
    throw new Error(
      `${where}: <sc-for list="{{${name}}}"> needs an array, but renderVals() returns ` +
        `${typeof list} for "${name}". Return an array from renderVals() in ${where}.`,
    );
  }

  return list.map((item) => renderMarkup(body, { ...scope, [alias]: item }, where)).join("");
}

/** The base class a board's `<script data-dc-script>` extends, cut down to what a still picture needs. */
const DC_LOGIC_SHIM = `
class DCLogic {
  constructor(props) { this.props = props ?? {}; }
  setState() { /* nothing re-renders: this is a picture, not the editor */ }
}
`;

function propDefaults(openTag: string): Scope {
  const raw = /data-props='([^']*)'/.exec(openTag)?.[1];
  if (!raw) return {};
  const spec = JSON.parse(raw) as Record<string, { default?: unknown }>;
  const props: Scope = {};
  for (const [key, value] of Object.entries(spec)) {
    // `$preview` is the editor's frame size, not something the markup reads.
    if (key.startsWith("$")) continue;
    if (value && typeof value === "object" && "default" in value) props[key] = value.default;
  }
  return props;
}

/**
 * Runs a board's component class far enough to get its `renderVals()`.
 *
 * Evaluating the file's own logic is the only way the canvas can show what the
 * board says rather than `{{ventureName}}`. It runs in a fresh context with
 * nothing but the shim reachable, and with a timeout, because a build should
 * not be able to hang on design-time sample data.
 */
function logicValues(source: string, where: string): Scope {
  // Not elementSpan(): every board's <head> holds a plain <script src> first,
  // and the one that matters is the last element in the file.
  const open = /<script\s+data-dc-script[^>]*>/.exec(source);
  const bodyStart = open ? open.index + open[0]!.length : -1;
  const bodyEnd = source.indexOf("</script>", bodyStart);
  if (!open || bodyEnd === -1) {
    throw new Error(
      `${where} uses {{holes}} or <sc-for>/<sc-if> but has no <script data-dc-script>…</script> ` +
        `to fill them. Add the component class to ${where}, or write the markup without holes.`,
    );
  }

  const values = runInNewContext(
    `${DC_LOGIC_SHIM}\n${source.slice(bodyStart, bodyEnd)}\nnew Component(__props).renderVals();`,
    { __props: propDefaults(open[0]!) },
    { timeout: LOGIC_TIMEOUT_MS, filename: where },
  ) as unknown;

  if (values === null || typeof values !== "object") {
    throw new Error(
      `${where}: renderVals() returned ${typeof values} instead of an object. ` +
        `Return an object of the values the markup asks for from renderVals() in ${where}.`,
    );
  }
  return values as Scope;
}

/**
 * The document that goes inside one board's iframe.
 *
 * Exported because this is the part worth testing on its own: given the text
 * of a `.dc.html`, it either produces finished HTML or says why it cannot.
 */
export function boardDocument(source: string, where: string): string {
  const root = elementSpan(source, "x-dc");
  if (!root) {
    throw new Error(
      `${where} has no <x-dc> element, so there is no board to draw. ` +
        `A board is <x-dc><helmet><style>…</style></helmet>…markup…</x-dc>. Fix ${where}.`,
    );
  }

  const inside = source.slice(root.bodyStart, root.bodyEnd);
  const helmet = elementSpan(inside, "helmet");
  const styles = helmet ? inside.slice(helmet.bodyStart, helmet.bodyEnd) : "";
  const markup = helmet ? inside.slice(0, helmet.start) + inside.slice(helmet.end) : inside;

  const isLive = /\{\{|<sc-(if|for)\b/.test(markup);
  const body = renderMarkup(markup, isLive ? logicValues(source, where) : {}, where);

  return [
    "<!doctype html>",
    '<html lang="ja"><head><meta charset="utf-8">',
    // Each board's stylesheet assumes it owns the document and sets its own
    // body margin; this only covers the 8px the browser adds before it can.
    "<style>html,body{margin:0;padding:0}</style>",
    styles,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

// ---------------------------------------------------------------------------
// Reading a canvas directory
// ---------------------------------------------------------------------------

const NUMERIC_KEYS = ["x", "y", "w", "h"] as const;

function artboardProblems(board: Artboard, where: string): string[] {
  const problems: string[] = [];
  if (typeof board.file !== "string" || !board.file.endsWith(BOARD_SUFFIX)) {
    problems.push(`${where} needs "file": "<name>${BOARD_SUFFIX}".`);
  }
  if (typeof board.title !== "string" || board.title === "") {
    problems.push(`${where} needs "title": "<何の画面か>" — the title is the label drawn above the board.`);
  }
  for (const key of NUMERIC_KEYS) {
    if (typeof board[key] !== "number") problems.push(`${where} needs "${key}": <number>.`);
  }
  return problems;
}

function annotationProblems(note: Annotation, where: string): string[] {
  const problems: string[] = [];
  if (typeof note.text !== "string" || note.text === "") {
    problems.push(`${where} needs "text": "<付箋の中身>".`);
  }
  for (const key of ["x", "y", "w"] as const) {
    if (typeof note[key] !== "number") problems.push(`${where} needs "${key}": <number>.`);
  }
  return problems;
}

/**
 * Every disagreement between `canvas.json` and the directory, in one list.
 *
 * Both directions fail the build. A board listed but missing is the obvious
 * one; a board present but unlisted is the one that actually happens - someone
 * adds a screen and forgets the placement - and silently leaving it out of the
 * canvas is how a canvas stops being the picture of the design.
 */
export function coverageProblems(
  dirLabel: string,
  onDisk: readonly string[],
  artboards: readonly Artboard[],
): string[] {
  const problems: string[] = [];
  const listed = new Set<string>();

  for (const board of artboards) {
    if (listed.has(board.file)) {
      problems.push(
        `${dirLabel}/${CANVAS_FILE} lists ${board.file} twice. Delete the duplicate artboard entry.`,
      );
    }
    listed.add(board.file);
    if (!onDisk.includes(board.file)) {
      problems.push(
        `${dirLabel}/${CANVAS_FILE} points at ${board.file}, which is not in ${dirLabel}/. ` +
          `Add ${dirLabel}/${board.file}, or remove that artboard from ${CANVAS_FILE}.`,
      );
    }
  }

  for (const name of onDisk) {
    if (listed.has(name)) continue;
    problems.push(
      `${dirLabel}/${name} exists but no artboard in ${CANVAS_FILE} names it, so it would be ` +
        `left off the canvas. Add {"file": "${name}", "x": 0, "y": 0, "w": 390, "h": 844, ` +
        `"title": "<何の画面か>"} to artboards in ${dirLabel}/${CANVAS_FILE}, or delete the file.`,
    );
  }

  return problems;
}

function boardsOnDisk(dirAbs: string): string[] {
  return readdirSync(dirAbs)
    .filter((name) => name.endsWith(BOARD_SUFFIX))
    .sort();
}

/** Reads and checks one canvas directory. Throws with every problem at once. */
export function readCanvas(dirAbs: string, dirLabel: string): CanvasFile {
  const path = join(dirAbs, CANVAS_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${dirLabel}/${CANVAS_FILE} does not exist. Create it as {"artboards": [...], "annotations": [...]}, ` +
        `or take "${dirLabel}" out of CANVAS_TARGETS in scripts/build-canvas.ts.`,
    );
  }

  const canvas = JSON.parse(readFileSync(path, "utf8")) as CanvasFile;
  if (!Array.isArray(canvas.artboards) || canvas.artboards.length === 0) {
    throw new Error(
      `${dirLabel}/${CANVAS_FILE} has no "artboards" array, so there is nothing to draw. ` +
        `Add "artboards": [{"file": "…${BOARD_SUFFIX}", "x": 0, "y": 0, "w": 390, "h": 844, "title": "…"}].`,
    );
  }
  const annotations = canvas.annotations ?? [];

  const problems = [
    ...canvas.artboards.flatMap((board, index) =>
      artboardProblems(board, `${dirLabel}/${CANVAS_FILE} artboards[${index}]`),
    ),
    ...annotations.flatMap((note, index) =>
      annotationProblems(note, `${dirLabel}/${CANVAS_FILE} annotations[${index}]`),
    ),
    ...coverageProblems(dirLabel, boardsOnDisk(dirAbs), canvas.artboards),
  ];

  if (problems.length > 0) {
    throw new Error(
      `${dirLabel} and its ${CANVAS_FILE} disagree:\n` + problems.map((line) => `  - ${line}`).join("\n"),
    );
  }

  return { artboards: canvas.artboards, annotations };
}

// ---------------------------------------------------------------------------
// Drawing the page
// ---------------------------------------------------------------------------

function pageStyles(): string {
  return `
    :root {
      --paper: #f2f2ee; --ink: #1a1a19; --muted: #6b6b66; --line: #dededa;
      --note: #fdf6dd; --note-line: #e6d9a4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--paper); color: var(--ink);
      font: 15px/1.65 ui-sans-serif, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
    }
    .page-head {
      position: sticky; left: 0; top: 0; z-index: 2;
      width: 100vw; padding: 12px 20px; background: #ffffff;
      border-bottom: 1px solid var(--line);
    }
    .page-head h1 { font-size: 16px; font-weight: 650; margin: 0; }
    .page-head p { font-size: 13px; color: var(--muted); margin: 3px 0 0; }
    .page-head code { font-size: 12px; background: #f0f0ec; border-radius: 4px; padding: 1px 5px; }
    .overview { display: none; }
    .overview-label {
      display: inline-block; margin-top: 8px; font-size: 13px; color: var(--muted);
      border: 1px solid var(--line); border-radius: 999px; padding: 3px 11px; cursor: pointer;
    }
    .overview:checked ~ .page-head .overview-label { color: var(--ink); border-color: var(--muted); }
    .stage { position: relative; overflow: hidden; }
    .canvas {
      position: relative; transform-origin: 0 0;
      background-image: radial-gradient(#d9d9d3 1px, transparent 1px);
      background-size: 40px 40px;
    }
    .board { position: absolute; margin: 0; }
    .board figcaption {
      height: ${BOARD_LABEL_HEIGHT_PX}px; display: flex; align-items: center; gap: 8px;
      font-size: 13px; color: var(--muted); white-space: nowrap;
    }
    .board .live {
      font-size: 11px; color: var(--muted); background: #ffffff;
      border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px;
    }
    .board iframe {
      display: block; border: 1px solid var(--line); border-radius: 12px;
      background: #ffffff; box-shadow: 0 1px 3px rgba(0, 0, 0, .06); overflow: hidden;
    }
    .note {
      position: absolute; background: var(--note); border: 1px solid var(--note-line);
      border-radius: 8px; padding: ${NOTE_PADDING_PX}px;
      font-size: ${NOTE_FONT_SIZE_PX}px; line-height: ${NOTE_LINE_HEIGHT_PX}px; color: #4a4634;
    }
    .note p { margin: 0 0 ${NOTE_PARAGRAPH_GAP_PX}px; }
    .note p:last-child { margin-bottom: 0; }
    .note strong { color: #2c2a1f; font-weight: 650; }
  `;
}

function boardHtml(board: DrawnBoard, offsetX: number, offsetY: number): string {
  const live = board.is_interactive
    ? '<span class="live">動く板 — 初期状態の写し</span>'
    : "";
  return [
    `<figure class="board" style="left:${board.x + offsetX}px;top:${board.y + offsetY - BOARD_LABEL_HEIGHT_PX}px;width:${board.w}px">`,
    `<figcaption>${escapeHtml(board.title)}${live}</figcaption>`,
    `<iframe title="${escapeHtml(board.title)}" style="width:${board.w}px;height:${board.h}px" `,
    `srcdoc="${escapeHtml(board.document)}"></iframe>`,
    "</figure>",
  ].join("");
}

function noteHtml(note: Annotation, offsetX: number, offsetY: number): string {
  const id = note.id ? ` id="note-${escapeHtml(note.id)}"` : "";
  return (
    `<aside class="note"${id} style="left:${note.x + offsetX}px;top:${note.y + offsetY}px;width:${note.w}px">` +
    `${noteBody(note.text)}</aside>`
  );
}

/**
 * Lays every board and note out on one absolutely positioned sheet.
 *
 * `canvas.json` places things around an origin that can go negative - the notes
 * above the first row sit at negative `y` - so everything is shifted by the
 * top-left corner of what was placed, plus a margin.
 */
export function buildPage(
  title: string,
  boards: readonly DrawnBoard[],
  notes: readonly Annotation[],
): string {
  const left = Math.min(...boards.map((b) => b.x), ...notes.map((n) => n.x));
  const top = Math.min(
    ...boards.map((b) => b.y - BOARD_LABEL_HEIGHT_PX),
    ...notes.map((n) => n.y),
  );
  const right = Math.max(...boards.map((b) => b.x + b.w), ...notes.map((n) => n.x + n.w));
  const bottom = Math.max(
    ...boards.map((b) => b.y + b.h),
    ...notes.map((n) => n.y + estimateNoteHeight(n)),
  );

  const offsetX = CANVAS_MARGIN_PX - left;
  const offsetY = CANVAS_MARGIN_PX - top;
  const width = Math.round(right - left + CANVAS_MARGIN_PX * 2);
  const height = Math.round(bottom - top + CANVAS_MARGIN_PX * 2);
  const small = (value: number) => Math.round(value * OVERVIEW_SCALE);

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${pageStyles()}
    /* The overview toggle. CSS transform rather than the zoom property:
       zoom re-lays-out an iframe's contents at the shrunken width, and these
       boards are fixed-width frames, so they would be cropped, not scaled. */
    .stage { width: ${width}px; height: ${height}px; }
    .canvas { width: ${width}px; height: ${height}px; }
    .overview:checked ~ .stage { width: ${small(width)}px; height: ${small(height)}px; }
    .overview:checked ~ .stage .canvas { transform: scale(${OVERVIEW_SCALE}); }
</style>
</head>
<body>
<input class="overview" type="checkbox" id="overview">
<div class="page-head">
  <h1>${escapeHtml(title)}</h1>
  <p>生成物です。正本は同じディレクトリの <code>canvas.json</code> と <code>*.dc.html</code>。<code>npm run build:canvas</code> で作り直します。</p>
  <label class="overview-label" for="overview">全体を縮小して見る</label>
</div>
<div class="stage"><div class="canvas">
${boards.map((board) => boardHtml(board, offsetX, offsetY)).join("\n")}
${notes.map((note) => noteHtml(note, offsetX, offsetY)).join("\n")}
</div></div>
</body>
</html>
`;
}

/** Reads one canvas directory and returns the page, without writing anything. */
export function buildCanvas(target: CanvasTarget, root = ROOT): string {
  const dirAbs = resolve(root, target.dir);
  const canvas = readCanvas(dirAbs, target.dir);
  const boards: DrawnBoard[] = canvas.artboards.map((board) => ({
    ...board,
    document: boardDocument(
      readFileSync(join(dirAbs, board.file), "utf8"),
      `${target.dir}/${board.file}`,
    ),
  }));
  return buildPage(target.title, boards, canvas.annotations ?? []);
}

export function canvasOutputPath(target: CanvasTarget, root = ROOT): string {
  return resolve(root, target.dir, OUTPUT_FILE);
}

function main(): number {
  for (const target of CANVAS_TARGETS) {
    const html = buildCanvas(target);
    const path = canvasOutputPath(target);
    writeFileSync(path, html, "utf8");
    const kb = Math.round(Buffer.byteLength(html, "utf8") / 1024);
    process.stdout.write(`${target.dir}/${OUTPUT_FILE} — ${kb} KB\n`);
  }
  return 0;
}

// Importable from the tests without drawing anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
