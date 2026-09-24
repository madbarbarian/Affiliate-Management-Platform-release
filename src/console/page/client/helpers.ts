/**
 * The client script's shared helpers: fetch/notice/deadline plumbing, the
 * platform's own vocabulary embedded for the browser (T, the cycle and
 * failure label tables, PORTFOLIO_COLUMNS), and the column-width/theme
 * storage every other piece of the page reads or writes.
 *
 * The only one of the split-out client pieces that takes arguments: it is
 * also the only one that embeds a per-render value (T, columns) rather than
 * a module-level constant, so it is a function, not a plain string.
 */

import { CYCLE_STATUS_LABELS, CYCLE_STEP_LABELS, FAILURE_SUMMARIES } from "../../labels.ts";
import type { Messages } from "../../messages.ts";
import { MIN_COLUMN_WIDTH, type PortfolioColumn } from "../../portfolio-columns.ts";
import { WAITING_IS_OVER_SOURCE } from "../../waiting.ts";

export function clientHelpersScript(T: Messages, columns: readonly PortfolioColumn[]): string {
  return `
const $ = (id) => document.getElementById(id);
// Captured before anything prefixes a count onto it, so repeated renders do not
// stack "(1) (1) ".
const baseTitle = document.title;
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
    // (No backticks in here: this file is one big template literal.)
    // errorJson() on the server (src/console/router.ts) answers a failure
    // with both fields: "error" is describeError's full string - the
    // "[kind/code]", the message written for a log or a terminal, the raw
    // "details" - and "code" is the only one a screen may show. This used to
    // throw "body" itself as the message, which is how a stopped account's
    // now-removed terminal-command instruction once reached this DOM straight
    // from the server: nothing downstream ever looked past .message. It is
    // kept here only so a genuine failure this parse cannot make sense of -
    // a network drop, a host with no JSON body at all - still leaves
    // something for console.error to log; no caller on this page reads it
    // for display any more. See failureText() below.
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    const err = new Error(parsed && typeof parsed.error === "string" ? parsed.error : (body || "HTTP " + response.status));
    if (parsed && typeof parsed.code === "string") err.code = parsed.code;
    throw err;
  }
  return response.status === 204 ? null : response.json();
}

/*
 * Two presses on this screen start minutes of work: running a day, and
 * answering the ideas gate, which carries on into writing and inspection. Both
 * did that work inside the HTTP request, so when the response was lost - a
 * Cloudflare edge timeout, a closed laptop, a network that dropped - the page
 * silently went back to what it had been showing. The work had in fact
 * finished and been saved. The owner pressed run, saw nothing, reloaded, and
 * found three proposals; pressed approve, saw nothing, reloaded, and found the
 * next gate open with a finished post behind it. He pressed both twice.
 *
 * So the page stops treating the request as the work. After the deadline it
 * stops waiting on the response, says so, and watches the state instead.
 */
const SLOW_ACTION_DEADLINE_MS = 20000;
const WATCH_POLL_MS = 4000;
/* Bounded, because a screen that spins forever is the same lie more slowly. */
const WATCH_LIMIT_MS = 300000;

// Inlined from src/console/waiting.ts rather than written out here: this is the
// one decision on this page a test can call directly, and a second copy of it
// would be a second answer. It is JavaScript text there, not a function's
// .toString() - the bundler Cloudflare runs rewrites functions, and never
// looks inside a string.
${WAITING_IS_OVER_SOURCE}

/**
 * The request, or the deadline, whichever answers first.
 *
 * On a deadline the request is left running - it is doing the work, and the
 * work is saved step by step whether or not this page ever hears the answer.
 * Its outcome is swallowed rather than dropped: an unhandled rejection minutes
 * later surfaces in the browser as an error about a request nobody is waiting
 * for any more.
 */
function withDeadline(promise, ms) {
  let timer;
  const settled = promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  return Promise.race([
    settled,
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); }),
  ]).then((outcome) => {
    clearTimeout(timer);
    return outcome;
  });
}

/** The one line that survives every render. Empty text hides it again. */
function notice(text, tone) {
  const box = $("notice");
  box.className = text ? "card " + (tone || "") : "";
  box.textContent = text || "";
  box.hidden = !text;
}

/**
 * Stop waiting on the answer; watch for the work instead.
 *
 * Polls the state the page already fetches until what this account was waiting
 * for has moved, re-rendering each time so the screen is never behind what is
 * on disk. Returns whether it moved before the bound ran out.
 */
async function watchUntilItMoves(before, ventureId, stillRunningText, request) {
  notice(stillRunningText, "");
  // The request is still in flight and still doing the work. Whenever it comes
  // back - which it does, long after this page stopped waiting on it - that is
  // the answer, and it needs no comparison to be believed.
  let answered = false;
  if (request) request.then(() => { answered = true; }, () => { answered = true; });
  const stopAt = Date.now() + WATCH_LIMIT_MS;
  while (Date.now() < stopAt) {
    await new Promise((resolve) => setTimeout(resolve, WATCH_POLL_MS));
    await load();
    if (waitEndedBecause({ answered: answered, before: before, now: state, ventureId: ventureId })) {
      notice(T["wait.changed"], "");
      return true;
    }
  }
  // Not silence, and not a spinner: what is true, and the one thing left to do.
  notice(T["wait.tooLong"], "warn");
  return false;
}

/**
 * Which day an open gate belongs to, and whether that day has gone.
 *
 * Two gates can stand open at once: nobody approved yesterday, so its gate is
 * still there when today's opens beside it. Without the day they are the same
 * sentence twice, and the operator's reasonable reading is that the page has
 * repeated itself. It did that in production.
 *
 * The stale line is not decoration. Approving a day that has passed writes its
 * posts and then hands them to a dispatcher that publishes anything whose slot
 * is in the past - so every one of them goes out at once, now. The screen has
 * to say the day is old before the button is pressed, not after.
 *
 * Whether it *is* old is decided on the server, in the account's own timezone.
 * The browser's midnight is the viewer's, and an operator reading this from
 * another country would be told the wrong thing about somebody else's day.
 */
function gateDay(decision) {
  return fmt(decision.stale ? "gate.dayStale" : "gate.day", { day: decision.day });
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

/**
 * What a caught failure may say on screen: this platform's own words for its
 * code, by way of failureSummary() - never whatever a server put in
 * error.message for a log or a terminal. Every catch block and every
 * !outcome.ok branch on this page renders a failure through this, not
 * error.message directly, which is what once let a stopped account's
 * now-removed terminal-command instruction reach the DOM. A code this table
 * has no entry for falls back to the bare code (or "?" for a failure with
 * none at all, such as a dropped connection) rather than to the message -
 * ugly on purpose, the same trade failureSummary() already makes for a cycle.
 */
function failureText(error) {
  if (error) console.error(error);
  return failureSummary(error && error.code).short;
}

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

/*
 * The accounts table's columns, from portfolio-columns.ts rather than written
 * out again here - the page's layout is arithmetic on these widths, and a
 * second copy of them is how the last column came to be clipped on every
 * screen the console was ever opened on.
 */
const PORTFOLIO_COLUMNS = ${JSON.stringify(columns)};
const COLUMN_WIDTH_KEY = "amp.portfolio.columns";
const MIN_COLUMN_WIDTH = ${MIN_COLUMN_WIDTH};

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

/*
 * The colour scheme, and the operator's right to disagree with their OS.
 *
 * "auto" is the default and follows prefers-color-scheme; the other two set
 * data-theme on <html>, which the stylesheet honours over the media query. Kept
 * in the same localStorage this browser keeps the column widths in, and for the
 * same reason: it is about this screen on this machine, not about the company,
 * so it has no business in platform.config.yaml.
 */
const THEMES = ["auto", "light", "dark"];
const THEME_KEY = "amp.console.theme";

function savedTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return THEMES.indexOf(stored) >= 0 ? stored : "auto";
  } catch {
    return "auto";
  }
}

/* Held here, not read back out of storage: in a private window the write is
   swallowed, and a button that asks storage what it last did would offer the
   same two choices forever. */
let theme = savedTheme();

function applyTheme(next) {
  theme = next;
  // Removed rather than set to "auto": the stylesheet's media query is written
  // to fire unless data-theme says light, and an unknown value would silence it.
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  $("theme").textContent = T["theme." + theme] || theme;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* A private window, or site data switched off. The choice lasts this visit. */
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

`;
}
