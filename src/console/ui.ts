/**
 * The approval console's single page.
 *
 * Deliberately one file with no build step and no framework. The operator's
 * whole job is two clicks a day; the tooling around those two clicks should
 * not need a bundler, a lockfile, or a deploy.
 */

import { CYCLE_STATUS_LABELS, CYCLE_STEP_LABELS, FAILURE_SUMMARIES } from "./labels.ts";
import { messagesFor, type Locale } from "./messages.ts";

export function renderPage(options: { companyName: string; locale?: Locale }): string {
  const locale = options.locale ?? "ja";
  const T = messagesFor(locale);
  const t = (key: keyof typeof T): string => T[key];
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.companyName)} — ${escapeHtml(t('page.titleSuffix'))}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --panel: #ffffff; --ink: #1a1a19; --muted: #6b6b66;
    --line: #e4e4e0; --accent: #2f6f4f; --accent-ink: #ffffff;
    --warn: #8a5a00; --danger: #a13a2a; --chip: #f0f0ec;
    --radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --panel: #1e1e23; --ink: #ececea; --muted: #9a9a96;
      --line: #33333a; --accent: #6fbf8f; --accent-ink: #14231a;
      --warn: #e0b060; --danger: #e0806a; --chip: #2a2a31;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.65 ui-sans-serif, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
  }
  header {
    padding: 18px 20px; border-bottom: 1px solid var(--line);
    display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap;
    position: sticky; top: 0; background: var(--bg); z-index: 5;
  }
  h1 { font-size: 17px; margin: 0; font-weight: 650; }
  .muted { color: var(--muted); font-size: 13px; }
  main { max-width: 860px; margin: 0 auto; padding: 20px 16px 80px; }
  section { margin-bottom: 34px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 0 0 12px; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 14px 16px; margin-bottom: 10px;
  }
  .item { display: flex; gap: 12px; align-items: flex-start; }
  .item input[type=checkbox] { margin-top: 5px; width: 17px; height: 17px; flex: none; }
  .item-body { flex: 1; min-width: 0; }
  .title { font-weight: 600; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .chip {
    background: var(--chip); border-radius: 999px; padding: 2px 9px;
    font-size: 12px; color: var(--muted);
  }
  .chip.warn { color: var(--warn); }
  .chip.danger { color: var(--danger); }
  details { margin-top: 8px; }
  summary { cursor: pointer; font-size: 13px; color: var(--muted); }
  pre {
    white-space: pre-wrap; word-break: break-word; background: var(--bg);
    border: 1px solid var(--line); border-radius: 8px; padding: 10px; font-size: 13px;
    margin: 8px 0 0;
  }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
  button {
    font: inherit; padding: 8px 15px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--panel); color: var(--ink); cursor: pointer;
  }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; font-weight: 600; }
  button:disabled { opacity: .5; cursor: default; }
  .order { display: flex; gap: 4px; align-items: center; }
  .order button { padding: 2px 9px; line-height: 1.4; }
  .rank { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 13px; min-width: 1.6em; }
  .empty { color: var(--muted); font-size: 14px; }
  .err { color: var(--danger); font-size: 13px; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; }
  /*
   * The accounts table, which has eleven columns and one that can hold a whole
   * API error. Left to itself the browser gave that column everything and
   * squeezed the rest to a character wide, so the headers rendered one letter
   * per line. Fixed layout plus a colgroup means the widths are decided here
   * and the container scrolls; nothing is ever crushed by its neighbour.
   */
  .table-wrap { overflow-x: auto; }
  /*
   * main is 860px wide because that is a comfortable measure for reading the
   * proposals. This table is not prose, and inside that column it scrolled
   * sideways on a screen with room to spare, so it steps outside it - still
   * centred, still bounded by the window. (No backticks anywhere in this file:
   * the page is one template literal.)
   */
  #portfolio-section { width: min(1240px, calc(100vw - 32px)); margin-left: 50%; transform: translateX(-50%); }
  table.grid { table-layout: fixed; min-width: 1180px; }
  table.grid th { position: relative; white-space: nowrap; vertical-align: bottom; }
  table.grid td { vertical-align: top; overflow-wrap: anywhere; }
  table.grid th.num, table.grid td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.grid .err { font-size: 12px; margin-top: 4px; }
  table.grid button { padding: 5px 10px; font-size: 12px; margin: 0 4px 4px 0; }
  /* Wide enough to grab on a trackpad, invisible until the pointer is near. */
  .grip {
    position: absolute; top: 0; right: -4px; width: 9px; height: 100%;
    cursor: col-resize; touch-action: none;
  }
  .grip:hover, .grip.dragging { background: var(--accent); opacity: .35; }
  .grid-reset { font-size: 12px; color: var(--muted); background: none; border: 0; padding: 4px 0; cursor: pointer; }
  /* The exact text going out, shown at the publishing gate without a click. */
  pre.post { background: var(--panel); border-color: var(--accent); line-height: 1.7; font-size: 14px; }
  .pr-ok { color: var(--accent); font-size: 12px; margin-top: 6px; }
  .pr-missing { color: var(--danger); font-size: 13px; font-weight: 600; margin-top: 6px; }
  .pr-none { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .stopped { border-color: var(--danger); border-left-width: 3px; margin-bottom: 22px; }
  .stopped b { color: var(--danger); }
  .stopped code { background: var(--chip); border-radius: 5px; padding: 1px 5px; font-size: 12px; }
  .stat-row { display: flex; gap: 22px; flex-wrap: wrap; }
  .stat b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
  /* The account screen. */
  a.back, a.open { color: var(--accent); text-decoration: none; font-size: 13px; }
  a.open { display: inline-block; padding: 5px 12px; border: 1px solid var(--line); border-radius: 8px; }
  #venture-head h2 { font-size: 20px; text-transform: none; letter-spacing: 0; color: var(--ink); margin: 0; }
  #venture-head .vid { color: var(--muted); font-size: 12px; margin-left: 8px; }
  .whole { color: var(--danger); font-size: 13px; line-height: 1.6; margin-top: 8px; overflow-wrap: anywhere; }
  .why { color: var(--muted); font-size: 12px; margin-top: 10px; line-height: 1.6; }
  .hist div { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .hist div:last-child { border-bottom: 0; }
  .hist .when { color: var(--muted); font-variant-numeric: tabular-nums; width: 104px; flex: none; }
  .hist .bad { color: var(--danger); }
  .field { padding: 8px 0; border-bottom: 1px solid var(--line); }
  .field:last-child { border-bottom: 0; }
  .field .label { color: var(--muted); font-size: 11px; }
  .field .where { color: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 2px; }
  .pat { display: flex; gap: 12px; align-items: baseline; padding: 5px 0; font-size: 13px; }
  .pat .conf { color: var(--muted); font-variant-numeric: tabular-nums; width: 48px; flex: none; text-align: right; }
  /* The list's one-line verdict, and the smaller line under it. */
  .fail-short { color: var(--danger); font-size: 13px; margin-top: 3px; }
  .fail-hint { color: var(--muted); font-size: 11px; line-height: 1.5; margin-top: 1px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(options.companyName)}</h1>
  <span class="muted" id="subtitle">${escapeHtml(t("page.loading"))}</span>
  <span style="flex:1"></span>
  <button id="refresh">${escapeHtml(t("page.refresh"))}</button>
</header>
<main>
  <div id="stopped"></div>

<div id="view-today">
  <section id="decisions">
    <h2>${escapeHtml(t("today.decisions"))}</h2>
    <div id="decision-list"><p class="empty">${escapeHtml(t("page.loading"))}</p></div>
  </section>

  <section>
    <h2>${escapeHtml(t("today.upcoming"))}</h2>
    <div id="upcoming"></div>
  </section>

  <section id="portfolio-section">
    <h2 id="accounts-head"></h2>
    <p class="muted">${t("accounts.lede")}</p>
    <div id="portfolio"></div>
  </section>

  <section id="proposals-section">
    <h2>${escapeHtml(t("scout.heading"))}</h2>
    <div id="proposals"></div>
  </section>

  <section>
    <h2>${escapeHtml(t("today.stats"))}</h2>
    <div id="stats"></div>
  </section>

  <section>
    <h2>${escapeHtml(t("today.activity"))}</h2>
    <div id="activity"></div>
  </section>
</div>

<!--
  The account. Same page, a different route: the list is for comparing and this
  is for understanding and fixing one account, and a screen that does both ends
  up doing neither - an API error in a comparison row took the whole table once.
-->
<div id="view-venture" hidden>
  <p><a class="back" href="#/">${escapeHtml(t("venture.back"))}</a></p>
  <div id="venture-head"></div>
  <section>
    <h2>${escapeHtml(t("venture.lastCycle"))}</h2>
    <div id="venture-cycle"></div>
  </section>
  <section>
    <h2>${escapeHtml(t("venture.history"))}</h2>
    <div id="venture-history"></div>
  </section>
  <section>
    <h2 id="venture-numbers-head"></h2>
    <div id="venture-numbers"></div>
  </section>
  <section>
    <h2 id="venture-playbook-head"></h2>
    <div id="venture-playbook"></div>
  </section>
  <section>
    <h2>${escapeHtml(t("setup.heading"))}</h2>
    <p class="muted">${escapeHtml(t("setup.lede"))}</p>
    <div id="venture-setup"></div>
  </section>
  <section>
    <h2>${escapeHtml(t("switch.heading"))}</h2>
    <div id="venture-switch"></div>
  </section>
</div>
</main>

<script type="module">
const $ = (id) => document.getElementById(id);
let state = null;
/** decisionId -> { selected: Set<string>, order: string[] } */
const draft = new Map();

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || ("HTTP " + response.status));
  }
  return response.status === 204 ? null : response.json();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Built from labels.ts rather than written out here, so a step added to
// CycleStep without a Japanese word fails a test instead of reaching the
// screen in English.
// The parentheses are load-bearing. An arrow body that opens with a brace is
// a block, so (s) => {"running":"動作中"}[s] is a SyntaxError at the first
// colon - and one SyntaxError anywhere in a module means the whole page does
// nothing at all. It shipped, and the console was inert until somebody opened
// the browser's own console.
const cycleStatusLabel = (status) => (${JSON.stringify(CYCLE_STATUS_LABELS)})[status] || status;
const cycleStepLabel = (step) => (${JSON.stringify(CYCLE_STEP_LABELS)})[step] || step;
// Chosen by the failure's code. Truncating the API's message would land
// mid-clause, in English, or before the word that carried the meaning.
const failureSummary = (code) =>
  (${JSON.stringify(FAILURE_SUMMARIES)})[code] || { short: code || "?", hint: "" };

/** Every word this page says, in the language console.locale asked for. */
const T = ${JSON.stringify(T)};
/** T with {placeholders} filled. Values are inserted as-is; escape first. */
function fmt(key, values) {
  // Doubled on purpose: this file is one template literal, and a lone
  // backslash is eaten by it. Written once, this pattern reached the browser
  // as /{(w+)}/ and every placeholder on the page stayed a placeholder.
  return String(T[key] ?? key).replace(/\\{(\\w+)\\}/g, (whole, name) =>
    values && name in values ? String(values[name]) : whole);
}
const cycleCell = (last) => {
  if (!last) return "—";
  const where = last.nextStep && last.status !== "completed"
    ? fmt("punct.paren", { text: esc(cycleStepLabel(last.nextStep)) })
    : "";
  return esc(last.date) + " " + esc(cycleStatusLabel(last.status)) + where;
};

/**
 * The accounts table's columns, and how wide each one starts.
 *
 * Widths are here rather than left to the browser because the content decides
 * nothing sensible: one account with a long API error in its 直近サイクル cell
 * took the whole table and left 投稿 and 中央値 a character wide, headers
 * reading downwards. These are minimums that fit the header plus its usual
 * value; anything longer wraps inside its own column, and the operator can
 * drag any border to suit what they are actually looking at.
 */
const PORTFOLIO_COLUMNS = [
  { key: "name", label: T["accounts.colName"], width: 170 },
  { key: "state", label: T["accounts.colState"], width: 120 },
  { key: "cycle", label: T["accounts.colCycle"], width: 300 },
  { key: "posts", label: T["accounts.colPosts"], width: 62, numeric: true },
  { key: "median", label: T["accounts.colMedian"], width: 72, numeric: true },
  { key: "clicks", label: T["accounts.colClicks"], width: 82, numeric: true },
  { key: "conversions", label: T["accounts.colConversions"], width: 62, numeric: true },
  { key: "revenue", label: T["accounts.colRevenue"], width: 110, numeric: true },
  { key: "playbook", label: T["accounts.colPlaybook"], width: 60, numeric: true },
  { key: "measurement", label: T["accounts.colMeasurement"], width: 150 },
  { key: "actions", label: "", width: 190 },
];
const COLUMN_WIDTH_KEY = "amp.portfolio.columns";
const MIN_COLUMN_WIDTH = 48;

/**
 * Per-viewer, per-browser, and never read back by anything else - so a failure
 * to read or write it is not worth reporting, only worth surviving. Some
 * browsers throw on the accessor itself rather than returning null.
 */
function savedColumnWidths() {
  try {
    return JSON.parse(window.localStorage.getItem(COLUMN_WIDTH_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveColumnWidths(widths) {
  try {
    window.localStorage.setItem(COLUMN_WIDTH_KEY, JSON.stringify(widths));
  } catch {
    /* A private window, or site data switched off. The table still works. */
  }
}

/** Applies saved widths and makes each header border draggable. */
function wireColumnResize(container) {
  const cols = [...container.querySelectorAll("col")];
  const widths = savedColumnWidths();
  PORTFOLIO_COLUMNS.forEach((column, index) => {
    const saved = widths[column.key];
    if (typeof saved === "number" && saved >= MIN_COLUMN_WIDTH) cols[index].style.width = saved + "px";
  });

  for (const grip of container.querySelectorAll(".grip")) {
    grip.addEventListener("pointerdown", (event) => {
      const index = PORTFOLIO_COLUMNS.findIndex((column) => column.key === grip.dataset.grip);
      if (index < 0) return;
      // Otherwise the drag selects the header text instead of resizing.
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = cols[index].getBoundingClientRect().width;
      grip.setPointerCapture(event.pointerId);
      grip.classList.add("dragging");

      const move = (moved) => {
        const next = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + (moved.clientX - startX)));
        cols[index].style.width = next + "px";
      };
      const done = () => {
        grip.classList.remove("dragging");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", done);
        grip.removeEventListener("pointercancel", done);
        const kept = savedColumnWidths();
        kept[PORTFOLIO_COLUMNS[index].key] = Math.round(cols[index].getBoundingClientRect().width);
        saveColumnWidths(kept);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", done);
      grip.addEventListener("pointercancel", done);
    });
  }

  const reset = container.querySelector(".grid-reset");
  if (reset) {
    reset.addEventListener("click", () => {
      saveColumnWidths({});
      PORTFOLIO_COLUMNS.forEach((column, index) => {
        cols[index].style.width = column.width + "px";
      });
    });
  }
}

function ensureDraft(decision) {
  if (draft.has(decision.id)) return draft.get(decision.id);
  const recommended = decision.items.filter((i) => i.recommended).map((i) => i.id);
  const entry = {
    selected: new Set(decision.preselect ? recommended : []),
    order: decision.items.map((i) => i.id),
  };
  draft.set(decision.id, entry);
  return entry;
}

function renderDecision(decision) {
  const entry = ensureDraft(decision);
  const ordered = entry.order
    .map((id) => decision.items.find((i) => i.id === id))
    .filter(Boolean);

  const items = ordered.map((item, index) => {
    const checked = entry.selected.has(item.id);
    const rank = checked ? [...entry.order.filter((id) => entry.selected.has(id))].indexOf(item.id) + 1 : "";
    const chips = (item.chips ?? []).map((chip) =>
      '<span class="chip ' + esc(chip.tone ?? "") + '">' + esc(chip.label) + "</span>").join("");
    return \`
      <div class="card">
        <div class="item">
          <input type="checkbox" data-act="toggle" data-decision="\${esc(decision.id)}" data-item="\${esc(item.id)}" \${checked ? "checked" : ""}>
          <div class="item-body">
            <div class="title">\${esc(item.title)}</div>
            <div class="muted">\${esc(item.summary)}</div>
            <div class="chips">\${chips}</div>
            \${item.post ? '<pre class="post">' + esc(item.post) + "</pre>" : ""}
            \${item.post ? (item.disclosure
              ? '<div class="pr-ok">' + esc(T["gate.disclosurePresent"]) + " " + esc(item.disclosure) + "</div>"
              : item.hasOffer
                ? '<div class="pr-missing">' + esc(T["gate.disclosureMissing"]) + "</div>"
                : '<div class="pr-none">' + esc(T["gate.disclosureNotNeeded"]) + "</div>") : ""}
            \${item.preview ? '<details><summary>' + (item.post ? T["gate.openPost"] : T["gate.openIdea"]) + '</summary><pre>' + esc(item.preview) + "</pre></details>" : ""}
          </div>
          <div class="order">
            <span class="rank">\${rank}</span>
            <button data-act="up" data-decision="\${esc(decision.id)}" data-item="\${esc(item.id)}" \${index === 0 ? "disabled" : ""}>↑</button>
            <button data-act="down" data-decision="\${esc(decision.id)}" data-item="\${esc(item.id)}" \${index === ordered.length - 1 ? "disabled" : ""}>↓</button>
          </div>
        </div>
      </div>\`;
  }).join("");

  const count = entry.selected.size;
  return \`
    <section>
      <h2>\${esc(fmt("gate.heading", { gate: decision.gateLabel, venture: decision.ventureName }))}</h2>
      <p class="muted">\${esc(fmt("gate.question", { question: decision.question, max: decision.max }))}</p>
      \${items}
      <div class="row">
        <button class="primary" data-act="submit" data-decision="\${esc(decision.id)}" \${count === 0 ? "disabled" : ""}>
          \${esc(fmt("gate.approve", { n: count }))}
        </button>
        <button data-act="all" data-decision="\${esc(decision.id)}">\${esc(T["gate.selectRecommended"])}</button>
        <button data-act="none" data-decision="\${esc(decision.id)}">\${esc(T["gate.rejectAll"])}</button>
      </div>
      <div class="err" id="err-\${esc(decision.id)}"></div>
    </section>\`;
}

function render() {
  if (!state) return;
  $("subtitle").textContent =
    (state.pending.length > 0 ? fmt("page.waitingCount", { n: state.pending.length }) : T["page.waitingNone"]) +
    // Whose passphrase this is. The audit log records this name against
    // everything approved here, so it has to be visible before pressing, not
    // discoverable afterwards.
    (state.you ? fmt("page.asOperator", { name: state.you }) : "");

  // A stop belongs above everything, including the decisions: approving while
  // stopped is refused, and finding that out by pressing the button is a worse
  // way to learn it.
  const stopped = state.stopped ?? [];
  $("stopped").innerHTML = stopped.map((stop) =>
    '<div class="card stopped">' +
      "<b>" + (stop.scope === "all" ? esc(T["stop.all"]) : esc(fmt("stop.one", { label: stop.label ?? stop.scope }))) + "</b>" +
      '<div class="muted">' + [stop.at, stop.by, stop.reason].map(esc).join(T["punct.sep"]) + "</div>" +
      '<div class="muted">' +
        fmt("stop.howToResume", {
          command: "<code>" + (stop.scope === "all" ? "amp resume" : "amp resume --venture " + esc(stop.scope)) + "</code>",
        }) +
      "</div>" +
    "</div>").join("");

  $("decision-list").innerHTML = state.pending.length === 0
    ? '<p class="empty">' + esc(T["today.decisionsEmpty"]) + "</p>"
    : state.pending.map(renderDecision).join("");

  $("upcoming").innerHTML = state.upcoming.length === 0
    ? '<p class="empty">' + esc(T["today.upcomingEmpty"]) + "</p>"
    : '<table><thead><tr><th>' + esc(T["today.upcomingTime"]) + "</th><th>" + esc(T["today.upcomingStatus"]) + "</th><th>" + esc(T["today.upcomingHook"]) + "</th></tr></thead><tbody>" +
      state.upcoming.map((post) =>
        "<tr><td>" + esc(post.at) + "</td><td>" + esc(post.status) + "</td><td>" + esc(post.hook) + "</td></tr>").join("") +
      "</tbody></table>";

  const portfolio = state.portfolio ?? { rows: [] };
  // The operator's language, from the step name. The reason itself lives in
  // "doctor", which is English and written for a terminal.
  const measurementStepLabel = (step) => ({
    publish: T["measurement.publish"],
    engagement: T["measurement.engagement"],
    link: T["measurement.link"],
    conversion: T["measurement.conversion"],
    revenue: T["measurement.revenue"],
  }[step] || step);

  const stateCell = (row) => {
    if (row.state === "stopped") {
      return '<span class="chip danger">' + esc(T["accounts.stateStopped"]) + "</span>" + (row.deactivated ? '<div class="muted">' + esc(T["accounts.stateAlsoDeactivated"]) + "</div>" : "");
    }
    if (row.state === "deactivated") {
      return '<span class="chip">' + esc(T["accounts.stateDeactivated"]) + '</span><div class="muted">' + esc(row.deactivated?.by ?? "") +
        (row.deactivated?.reason ? T["punct.sep"] + esc(row.deactivated.reason) : "") + "</div>";
    }
    if (row.state === "inactive") return '<span class="chip">' + esc(T["accounts.stateConfigInactive"]) + "</span>";
    return esc(T["accounts.stateRunning"]);
  };
  // The section shipped with an empty h2: the heading is the only place that
  // says how many days the numbers under it cover, and nothing ever wrote it.
  $("accounts-head").textContent = fmt("accounts.heading", { days: portfolio.days ?? 30 });
  $("portfolio").innerHTML =
    '<div class="table-wrap"><table class="grid"><colgroup>' +
    PORTFOLIO_COLUMNS.map((column) => '<col style="width:' + column.width + 'px">').join("") +
    "</colgroup><thead><tr>" +
    PORTFOLIO_COLUMNS.map((column) => "<th" + (column.numeric ? ' class="num"' : "") + ">" +
      esc(column.label) + '<span class="grip" data-grip="' + esc(column.key) + '"></span></th>').join("") +
    "</tr></thead><tbody>" +
    portfolio.rows.map((row) =>
      "<tr><td>" + esc(row.name) + '<div class="muted">' + esc(row.ventureId) + "</div>" +
        (row.review ? '<div class="chip warn" style="display:inline-block;margin-top:4px">' + esc(T["accounts.review"]) + '</div><div class="muted">' + esc(row.review) + "</div>" : "") + "</td>" +
      "<td>" + stateCell(row) +
        (row.pendingDecisions > 0 ? '<div class="muted">' + esc(fmt("accounts.waiting", { n: row.pendingDecisions })) + "</div>" : "") + "</td>" +
      "<td>" + cycleCell(row.lastCycle) +
        // A failed day is the one thing a comparison view still has to say, so
        // it says the least that is useful: a verdict chosen by the failure's
        // code, and one smaller line. The whole reason is behind 開く.
        (row.lastCycle?.failureCode ? failureCell(row.lastCycle.failureCode) : "") +
        '</td><td class="num">' + row.posts + '</td><td class="num">' + row.medianScore + "</td>" +
      '<td class="num">' + row.clicks + '</td><td class="num">' + row.conversions +
        '</td><td class="num">' + esc(row.approved) + "</td>" +
      '<td class="num">' + esc(row.playbook) + "</td>" +
      "<td>" + (row.measurement === "closed"
        ? esc(T["accounts.measurementClosed"])
        : '<span class="chip warn">' + esc(T["accounts.measurementOpen"]) + "</span>" +
          // Which step is open, not just that one is. There is no terminal to
          // run "doctor" in when this is deployed to a host. (No backticks in
          // here: this file is one big template literal.)
          (row.measurementStep ? '<div class="muted">' + esc(measurementStepLabel(row.measurementStep)) + "</div>" : "")) + "</td>" +
      // The only control a row keeps. Switching an account off, reactivating it
      // and running a day all moved to the account screen: a row that is also a
      // control panel stops reading as a comparison, which is what this table
      // is for.
      '<td><a class="open" href="#/ventures/' + encodeURIComponent(row.ventureId) + '">' + esc(T["accounts.open"]) + "</a>" +
        "</td></tr>").join("") +
    "</tbody></table></div>" +
    '<button class="grid-reset" type="button">' + esc(T["accounts.resetWidths"]) + "</button>";
  // After the innerHTML above, not before: every element the resize handler
  // holds on to has just been replaced.
  wireColumnResize($("portfolio"));

  const proposals = state.proposals ?? [];
  $("proposals").innerHTML = proposals.length === 0
    ? '<p class="empty">' + T["scout.empty"] + "</p>"
    : proposals.map(renderProposal).join("");

  $("stats").innerHTML = '<div class="card stat-row">' + state.stats.map((stat) =>
    '<div class="stat"><b>' + esc(stat.value) + "</b><span class=\\"muted\\">" + esc(stat.label) + "</span></div>").join("") + "</div>";

  $("activity").innerHTML = state.activity.length === 0
    ? '<p class="empty">' + esc(T["today.activityEmpty"]) + "</p>"
    : '<div class="card">' + state.activity.map((entry) =>
        '<div class="muted">' + esc(entry.at) + T["punct.sep"] + esc(entry.actor) + "</div><div>" + activityText(entry) + "</div>").join("<hr style=\\"border:none;border-top:1px solid var(--line);margin:8px 0\\">") + "</div>";
}

/**
 * The stored summary is the durable record and it is English. A failed day is
 * the one entry an operator has to act on, so it is said in their language,
 * from the same code the accounts table reads. Everything else falls through.
 */
function activityText(entry) {
  if (entry.type !== "cycle.failed") return esc(entry.summary);
  const failure = failureSummary(entry.failureCode);
  return '<b>' + esc(fmt("today.activityFailed", {
    step: cycleStepLabel(entry.failureStep),
    reason: failure.short,
  })) + "</b>";
}

function renderProposal(proposal) {
  // The server carries the block for a week after acceptance, so it survives
  // the thirty-second poll and a reload. "amp scout show <id>" has it after.
  const accepted = proposal.status === "accepted" ? proposal.block : undefined;
  return \`
    <div class="card">
      <div class="title">\${esc(proposal.niche)}</div>
      <div class="muted">\${esc(proposal.audience)}</div>
      <div class="chips">
        <span class="chip">\${esc(proposal.market)}</span>
        <span class="chip">\${esc(proposal.category)}</span>
        <span class="chip">\${proposal.offerIds.length > 0 ? esc(fmt("scout.offers", { ids: proposal.offerIds.join(", ") })) : esc(T["scout.noOffers"])}</span>
        <span class="chip">\${esc(proposal.createdAt)}</span>
      </div>
      <p><b>\${esc(T["scout.names"])}</b> \${esc(proposal.nameCandidates.join(" / "))}</p>
      <p><b>\${esc(T["scout.hypothesis"])}</b> \${esc(proposal.hypothesis)}</p>
      <p class="muted"><b>\${esc(T["scout.evidence"])}</b> \${esc(proposal.evidence)}</p>
      <p><b>\${esc(T["scout.risk"])}</b> \${esc(proposal.risk)}</p>
      <p><b>\${esc(T["scout.firstHooks"])}</b><br>\${proposal.firstHooks.map((hook) => fmt("punct.quote", { text: esc(hook) })).join("<br>")}</p>
      <p><b>\${esc(T["scout.killSignal"])}</b> \${esc(proposal.killSignal)}</p>
      \${accepted
        ? (proposal.appended
            ? '<div class="pr-ok">' + esc(T["scout.appended"])
            : '<div class="pr-missing">' + esc(T["scout.notAppended"]))
          + '<br>' + fmt("scout.showLater", { id: esc(proposal.id) }) + "</div><pre>" + esc(accepted) + "</pre>"
        : \`<div class="row">
            <button class="primary" data-proposal-act="accept" data-proposal="\${esc(proposal.id)}">\${esc(T["scout.accept"])}</button>
            <button data-proposal-act="dismiss" data-proposal="\${esc(proposal.id)}">\${esc(T["scout.dismiss"])}</button>
          </div>\`}
      <div class="err" id="perr-\${esc(proposal.id)}"></div>
    </div>\`;
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-proposal-act]");
  if (!target) return;
  const proposalId = target.dataset.proposal;
  const act = target.dataset.proposalAct;
  target.disabled = true;
  try {
    const result = await api("/api/proposals/" + encodeURIComponent(proposalId) + "/" + act, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await load();
    if (act === "accept" && result && result.written === false) {
      // The card itself says "not appended" from the server's record; this
      // adds the reason for as long as the page is open.
      const box = $("perr-" + proposalId);
      if (box) box.textContent = fmt("scout.writeError", { error: result.writeError ?? "" });
    }
  } catch (error) {
    const box = $("perr-" + proposalId);
    if (box) box.textContent = String(error.message ?? error);
    target.disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-venture-act]");
  if (!target) return;
  const ventureId = target.dataset.venture;
  const act = target.dataset.ventureAct;
  let note = "";
  if (act === "deactivate") {
    // The reason is what the portfolio shows next to the account for as long
    // as it is off, and what the audit log keeps. Optional, but asked for.
    note = window.prompt(T["switch.deactivatePrompt"], "") ?? null;
    if (note === null) return;
  }
  target.disabled = true;
  try {
    const result = await api("/api/ventures/" + encodeURIComponent(ventureId) + "/" + act, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
    await load();
    if (act === "deactivate" && result && (result.heldApproved > 0 || result.beyondRecall > 0)) {
      const box = $("verr-" + ventureId);
      if (box) {
        box.textContent =
          (result.heldApproved > 0 ? fmt("switch.heldApproved", { n: result.heldApproved }) : "") +
          (result.beyondRecall > 0 ? fmt("switch.beyondRecall", { n: result.beyondRecall }) : "");
      }
    }
  } catch (error) {
    const box = $("verr-" + ventureId);
    if (box) box.textContent = String(error.message ?? error);
    target.disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-venture-run]");
  if (!target) return;
  const ventureId = target.dataset.venture;
  // A real day makes six model calls and can take minutes. The label is the
  // only thing telling the operator that it is working rather than stuck.
  const label = target.textContent;
  // In a variable, not only on the button. The thirty-second poll rebuilds
  // this card while the run is still going, and the fresh button came back
  // enabled and reading 今日のサイクルを動かす - so the operator, told nothing
  // was happening, pressed it again. That is the second caller the
  // orchestrator now has to join.
  runningVentureId = ventureId;
  target.disabled = true;
  target.textContent = T["venture.running"];
  try {
    const result = await api("/api/ventures/" + encodeURIComponent(ventureId) + "/run", {
      method: "POST",
      body: "{}",
    });
    // The table is rebuilt here, so the box has to be found afterwards - the
    // one held before is no longer on the page.
    await load();
    const box = $("verr-" + ventureId);
    if (box && result) {
      box.className = "muted";
      box.textContent = result.status === "awaiting_approval"
        ? T["venture.runAwaiting"]
        : result.status === "completed"
          ? T["venture.runCompleted"]
          : cycleStatusLabel(result.status) +
            (result.nextStep ? fmt("venture.runNext", { step: cycleStepLabel(result.nextStep) }) : "");
    }
  } catch (error) {
    const box = $("verr-" + ventureId);
    if (box) {
      box.className = "err";
      box.textContent = String(error.message ?? error);
    }
    target.disabled = false;
    target.textContent = label;
  } finally {
    runningVentureId = null;
  }
});

function move(entry, itemId, delta) {
  const index = entry.order.indexOf(itemId);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= entry.order.length) return;
  const [removed] = entry.order.splice(index, 1);
  entry.order.splice(target, 0, removed);
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-act]");
  if (!target) return;
  const act = target.dataset.act;
  const decisionId = target.dataset.decision;
  const decision = state?.pending.find((d) => d.id === decisionId);
  if (!decision) return;
  const entry = ensureDraft(decision);

  if (act === "toggle") {
    if (entry.selected.has(target.dataset.item)) entry.selected.delete(target.dataset.item);
    else entry.selected.add(target.dataset.item);
    render();
    return;
  }
  if (act === "up" || act === "down") {
    move(entry, target.dataset.item, act === "up" ? -1 : 1);
    render();
    return;
  }
  if (act === "all") {
    entry.selected = new Set(decision.items.filter((i) => i.recommended).map((i) => i.id));
    render();
    return;
  }
  if (act === "none") {
    entry.selected = new Set();
    render();
    return;
  }
  if (act === "submit") {
    target.disabled = true;
    target.textContent = T["gate.sending"];
    try {
      const ordering = entry.order.filter((id) => entry.selected.has(id));
      await api("/api/decisions/" + encodeURIComponent(decisionId) + "/resolve", {
        method: "POST",
        body: JSON.stringify({ selectedIds: ordering, ordering }),
      });
      draft.delete(decisionId);
      await load();
    } catch (error) {
      const box = $("err-" + decisionId);
      if (box) box.textContent = String(error.message ?? error);
      target.disabled = false;
      render();
    }
  }
});

/** The list's one-line verdict, and the smaller line under it. */
function failureCell(code) {
  const summary = failureSummary(code);
  return '<div class="fail-short">' + esc(summary.short) + "</div>" +
    (summary.hint ? '<div class="fail-hint">' + esc(summary.hint) + "</div>" : "");
}

// ---------------------------------------------------------------------------
// The account screen
// ---------------------------------------------------------------------------

/** The account id in the address, or undefined for the day's own page. */
function routedVentureId() {
  // Doubled, like every backslash on this page. See fmt().
  const match = /^#\\/ventures\\/([^/]+)$/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function renderVenture(v) {
  const stateLabel = v.stopped ? T["accounts.stateStopped"]
    : v.deactivated ? T["accounts.stateDeactivated"]
    : v.active ? T["accounts.stateRunning"] : T["accounts.stateConfigInactive"];
  $("venture-head").innerHTML =
    "<h2>" + esc(v.name) + '<span class="vid">' + esc(v.ventureId) + "</span></h2>" +
    '<div class="chips">' +
      '<span class="chip">' + esc(stateLabel) + "</span>" +
      '<span class="chip' + (v.measurementClosed ? "" : " warn") + '">' +
        esc(fmt("venture.measurement", {
          state: v.measurementClosed ? T["venture.measurementOk"] : T["accounts.measurementOpen"],
        })) + "</span>" +
      (v.setup.market ? '<span class="chip">' + esc(v.setup.market.name) + "</span>" : "") +
      (v.pendingDecisions > 0 ? '<span class="chip">' + esc(fmt("accounts.waiting", { n: v.pendingDecisions })) + "</span>" : "") +
    "</div>" +
    (v.review ? '<div class="card" style="margin-top:12px"><b>' + esc(T["accounts.review"]) + "</b> " + esc(v.review) +
      '<div class="why">' + esc(T["venture.reviewWhy"]) + "</div></div>" : "");

  const last = v.lastCycle;
  const summary = last?.failureCode ? failureSummary(last.failureCode) : undefined;
  // A run started from this screen survives the poll that rebuilds it.
  const running = runningVentureId === v.ventureId;
  // The card is always here, and so are the button and the error box inside
  // it. Hanging them off the last cycle meant an account that had never run -
  // a fresh deploy, or a scout proposal just accepted - showed
  // まだ一度も動いていません and no way to start it, and the error box that
  // reports a failed 非アクティブにする did not exist to report into.
  $("venture-cycle").innerHTML = '<div class="card">' +
    (!last
      ? '<p class="empty" style="margin:0">' + esc(T["venture.neverRan"]) + "</p>"
      : "<div><b>" + esc(last.date) + " " +
        esc(summary ? summary.short : cycleStatusLabel(last.status)) + "</b>" +
        (last.nextStep && last.status !== "completed"
          ? T["punct.sep"] + '<span class="muted">' + esc(fmt("venture.stoppedAt", { step: cycleStepLabel(last.nextStep) })) + "</span>"
          : "") + "</div>" +
        // The whole thing, not a summary of it. This is the screen that exists
        // so the reason does not have to be read out of the database.
        (last.failure ? '<div class="whole">' + esc(last.failure) + "</div>" : "")) +
    (v.active && !v.stopped
      ? '<div class="row"><button class="primary" data-venture-run="1" data-venture="' +
        esc(v.ventureId) + '"' + (running ? " disabled" : "") + ">" +
        esc(running ? T["venture.running"] : T["venture.run"]) + "</button></div>" +
        '<div class="why">' + esc(T[last ? "venture.runWhy" : "venture.runWhyFirst"]) + "</div>"
      : "") +
    '<div class="err" id="verr-' + esc(v.ventureId) + '"></div>' +
    "</div>";

  $("venture-history").innerHTML = (v.recentCycles ?? []).length === 0
    ? '<p class="empty">' + esc(T["venture.historyEmpty"]) + "</p>"
    : '<div class="card hist">' + v.recentCycles.map((cycle) => {
        const failed = Boolean(cycle.failureCode);
        const what = failed
          ? failureSummary(cycle.failureCode).short +
            (cycle.failureStep ? fmt("punct.paren", { text: cycleStepLabel(cycle.failureStep) }) : "")
          : cycleStatusLabel(cycle.status) +
            (cycle.published > 0 ? T["punct.sep"] + fmt("venture.published", { n: cycle.published }) : "");
        return '<div><span class="when">' + esc(cycle.date) + "</span><span" +
          (failed ? ' class="bad"' : "") + ">" + esc(what) + "</span></div>";
      }).join("") + "</div>";

  $("venture-numbers-head").textContent = fmt("venture.numbers", { days: state?.portfolio?.days ?? 30 });
  $("venture-numbers").innerHTML =
    '<div class="card"><div class="stat-row">' +
      [[T["accounts.colPosts"], v.posts], [T["accounts.colMedian"], v.medianScore],
       [T["accounts.colClicks"], v.clicks], [T["accounts.colConversions"], v.conversions],
       [T["accounts.colRevenue"], esc(v.approvedRevenue ?? "—")]]
        .map((pair) => '<span class="stat">' + esc(pair[0]) + "<b>" + pair[1] + "</b></span>").join("") +
    '</div><div class="why">' + esc(T["venture.numbersWhy"]) + "</div></div>";

  $("venture-playbook-head").textContent =
    fmt("venture.playbook", { active: v.playbook.active, total: v.playbook.total });
  $("venture-playbook").innerHTML = v.playbook.top.length === 0
    ? '<p class="empty">' + esc(T["venture.playbookEmpty"]) + "</p>"
    : '<div class="card">' + v.playbook.top.map((pattern) =>
        '<div class="pat"><span class="conf">' + pattern.confidence.toFixed(2) + "</span><span>" +
        esc(pattern.name) + "</span></div>").join("") + "</div>";

  const setup = v.setup;
  const field = (label, value, where) =>
    '<div class="field"><div class="label">' + esc(label) + "</div><div>" + value + "</div>" +
    '<div class="where">' + esc(where) + "</div></div>";
  const voice = setup.voice;
  $("venture-setup").innerHTML =
    '<div class="card">' +
      field(T["setup.niche"], esc(v.niche), setup.path + ".niche") +
      field(T["setup.audience"], esc(v.audience), setup.path + ".audience") +
      field(T["setup.voice"], esc(voice.persona) + "<br>" +
        esc(fmt("setup.voiceFirstPerson", { word: voice.firstPerson })) + T["punct.sep"] +
        (voice.tone ?? []).map(esc).join(" / "), setup.path + ".voice") +
      (setup.market
        ? field(T["setup.market"], esc(setup.market.name) + fmt("punct.paren", {
              text: [setup.market.timezone, setup.market.language, setup.market.currency]
                .map(esc).join(T["punct.sep"]),
            }),
            setup.path + ".market → markets[" + setup.market.id + "]") +
          // The disclosure follows the reader, never the merchant and never the
          // language this screen happens to be in.
          field(T["setup.disclosure"], esc(setup.market.disclosureText), "markets[" + setup.market.id + "].disclosureText") +
          field(T["setup.regulator"], esc(setup.market.regulator), "markets[" + setup.market.id + "].regulator")
        : "") +
      field(T["setup.channels"], '<span class="chips">' +
        setup.channels.map((id) => '<span class="chip">' + esc(id) + "</span>").join("") + "</span>",
        setup.path + ".channels") +
      field(T["setup.offers"], setup.offers.length === 0
        ? '<span class="muted">' + esc(T["setup.offersNone"]) + "</span>"
        : '<span class="chips">' + setup.offers.map((offer) =>
            '<span class="chip' + (offer.crossBorder ? " warn" : "") + '">' + esc(offer.name) + T["punct.sep"] +
            esc(offer.network) + (offer.crossBorder ? T["punct.sep"] + esc(T["setup.crossBorder"]) : "") + "</span>").join("") + "</span>",
        setup.path + ".offers → offers[]") +
      field(T["setup.cadence"], esc(fmt("setup.cadenceValue", {
        postsPerDay: setup.cadence.postsPerDay,
        startsAt: setup.cadence.cycleStartsAt,
        minMinutes: setup.cadence.minMinutesBetweenPosts,
      })), setup.path + ".cadence") +
    "</div>" +
    '<div class="why">' + fmt("setup.editInFile", { path: esc(setup.configPath) }) + "</div>";

  $("venture-switch").innerHTML =
    '<div class="card">' +
    (v.deactivated || !v.active
      ? (v.active || v.deactivated
          ? '<div class="row" style="margin-top:0"><button data-venture-act="activate" data-venture="' +
            esc(v.ventureId) + '">' + esc(T["switch.activate"]) + "</button></div>" +
            '<div class="why">' + esc(T["switch.activateWhy"]) + "</div>"
          : '<span class="muted">' + esc(T["switch.configInactive"]) + "</span>")
      : '<div class="row" style="margin-top:0"><button data-venture-act="deactivate" data-venture="' +
        esc(v.ventureId) + '">' + esc(T["switch.deactivate"]) + "</button></div>" +
        '<div class="why">' + esc(T["switch.deactivateWhy"]) + "</div>") +
    "</div>";
}

// ---------------------------------------------------------------------------
// Routing. One page, two views; the address says which.
// ---------------------------------------------------------------------------

/** The account currently open, so a refresh reloads the right thing. */
let venture = null;
/** The account whose run this page started and is still waiting on. */
let runningVentureId = null;

async function load() {
  const ventureId = routedVentureId();
  $("view-today").hidden = Boolean(ventureId);
  $("view-venture").hidden = !ventureId;
  try {
    // The day's state is loaded either way: the header's count, the stop
    // banner and the window length come from it, and they belong on both.
    state = await api("/api/state");
    render();
    if (ventureId) {
      venture = await api("/api/ventures/" + encodeURIComponent(ventureId));
      renderVenture(venture);
    } else {
      venture = null;
    }
  } catch (error) {
    const box = ventureId ? $("venture-head") : $("decision-list");
    box.innerHTML = '<p class="err">' + esc(error.message ?? error) + "</p>";
  }
}

window.addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  load();
});
$("refresh").addEventListener("click", load);
load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
