/**
 * The approval console's single page.
 *
 * Deliberately one file with no build step and no framework. The operator's
 * whole job is two clicks a day; the tooling around those two clicks should
 * not need a bundler, a lockfile, or a deploy.
 */

import { CYCLE_STATUS_LABELS, CYCLE_STEP_LABELS, FAILURE_SUMMARIES } from "./labels.ts";
import { messagesFor, type Locale } from "./messages.ts";
import {
  MIN_COLUMN_WIDTH,
  PAGE_GUTTER,
  portfolioColumns,
  portfolioStackBelow,
  portfolioTableWidth,
} from "./portfolio-columns.ts";
import { WAITING_IS_OVER_SOURCE } from "./waiting.ts";

export function renderPage(options: { companyName: string; locale?: Locale }): string {
  const locale = options.locale ?? "ja";
  const T = messagesFor(locale);
  const t = (key: keyof typeof T): string => T[key];
  // The accounts table's layout is arithmetic on its own column widths, not a
  // set of round numbers chosen next to them. Every one of the three defects
  // the owner walked through came from a number that had been written twice.
  const columns = portfolioColumns(T);
  const tableWidth = portfolioTableWidth(columns);
  const stackBelow = portfolioStackBelow(columns);
  // Two selectors need these, and plain CSS has no way to give one declaration
  // block two of them when one is inside a media query. One string, used twice,
  // beats one palette maintained twice.
  // Joined rather than written as a template literal: the page below is one,
  // and a third backtick in this file splices source code into the HTML a
  // browser receives. There is a test that counts them.
  const dark = [
    "color-scheme: dark;",
    "--bg: #14141a; --panel: #1e1e25; --ink: #f0f0ee; --muted: #a8a8a4;",
    "--line: #35353e; --line-strong: #46464f; --accent: #7fcf9f; --accent-ink: #102016;",
    "--warn: #efbe6c; --danger: #f08c74; --chip: #2c2c35;",
    "--row-alt: #232330; --row-hover: #2b2b38;",
  ].join(" ");
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.companyName)} — ${escapeHtml(t('page.titleSuffix'))}</title>
<style>
  /*
   * Three schemes, not two: the operating system's, and the two the operator
   * can insist on. The page used to have only the first - one
   * prefers-color-scheme block and no way to disagree with it - so an operator
   * whose machine is dark all day got a dark console whether or not it read
   * well, and had nowhere to say so.
   *
   * The order matters. Light is the default. The OS's dark is honoured unless
   * the operator has explicitly asked for light; an explicit dark wins whatever
   * the OS says. Written any other way, one of the two choices is unreachable.
   *
   * --line is the border around a surface; --line-strong is the rule between
   * two rows *inside* one. They were the same colour, which is legible on a
   * near-white page and nearly invisible on a dark one: the accounts table's
   * rows ran together into a block of text.
   */
  :root {
    color-scheme: light;
    --bg: #fbfbfa; --panel: #ffffff; --ink: #1a1a19; --muted: #6b6b66;
    --line: #e4e4e0; --line-strong: #d3d3cd; --accent: #2f6f4f; --accent-ink: #ffffff;
    --warn: #8a5a00; --danger: #a13a2a; --chip: #f0f0ec;
    --row-alt: #f6f6f3; --row-hover: #eef1ee;
    --radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { ${dark} }
  }
  :root[data-theme="dark"] { ${dark} }
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
  /*
   * 推奨/そのほか: 10案が同じ重さで並ぶと30秒で終わらない、という設計提案
   * (console-ux-proposal.md §4.4 / docs/_proposed/design/Main.dc.html) の実装。
   */
  .group-heading { font-size: 13px; font-weight: 600; color: var(--ink); margin: 4px 0 2px; }
  .gate-rest { margin-top: 10px; }
  .gate-rest > summary { cursor: pointer; font-size: 14px; color: var(--muted); padding: 6px 0; }
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
   * per line. Fixed layout plus a colgroup means the widths are decided here;
   * nothing is ever crushed by its neighbour.
   *
   * This still scrolls, because the operator can drag a column wider than the
   * window and that is their business. What it must not do is scroll when
   * nobody asked: the declared widths add up to ${tableWidth}px and the media
   * query below hands the table over to the card layout before the window gets
   * narrower than that, so a table at its default widths always fits.
   */
  .table-wrap { overflow-x: auto; }
  /*
   * main is 860px wide because that is a comfortable measure for reading the
   * proposals. This table is not prose, and inside that column it scrolled
   * sideways on a screen with room to spare, so it steps outside it - still
   * centred, still bounded by the window. (No backticks anywhere in this file:
   * the page is one template literal.)
   */
  #portfolio-section { width: min(1240px, calc(100vw - ${PAGE_GUTTER}px)); margin-left: 50%; transform: translateX(-50%); }
  /*
   * A surface of its own, like every .card. On a dark screen a table drawn
   * straight onto the page background has nothing holding it together: the row
   * rules were the same grey as a card border, which reads on near-white and
   * disappears on near-black.
   */
  table.grid {
    table-layout: fixed; min-width: ${tableWidth}px;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    overflow: hidden;
  }
  /*
   * Headers wrap rather than run under their neighbour. They were nowrap, from
   * when the columns had no widths of their own and a wrapped header read one
   * letter per line; with a declared width the risk is the opposite one, and
   * "Conversions" is eleven characters where 成果 is two.
   */
  table.grid th { position: relative; vertical-align: bottom; line-height: 1.35; padding-top: 10px; }
  table.grid thead th { border-bottom: 1px solid var(--line-strong); }
  table.grid td { vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid var(--line-strong); }
  table.grid tbody tr:last-child td { border-bottom: 0; }
  /* Eleven columns is more than the eye tracks across unaided. */
  table.grid tbody tr:nth-child(even) { background: var(--row-alt); }
  table.grid tbody tr:hover { background: var(--row-hover); }
  table.grid th.num, table.grid td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.grid .err { font-size: 12px; margin-top: 4px; }
  /* The second line of a cell is a note on the first, and reads as one. At the
     same size as the value it doubled the apparent number of columns. */
  table.grid td .muted { font-size: 12px; line-height: 1.5; }
  table.grid button { padding: 5px 10px; font-size: 12px; margin: 0 4px 4px 0; }
  /*
   * The name and the id were the same size and the same line height, stacked
   * with nothing between them, so a two-line name and its slug read as one
   * three-line smear - and where an account is also worth a look, four things
   * in a 176px column with no hierarchy at all. The name is the heading of its
   * row; everything else under it is smaller and quieter, and the name itself
   * breaks between words rather than anywhere.
   */
  .acct-name { font-weight: 600; overflow-wrap: break-word; }
  .acct-id { color: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 3px; }
  .acct-review { margin-top: 6px; }
  /* Wide enough to grab on a trackpad, invisible until the pointer is near. */
  .grip {
    position: absolute; top: 0; right: -4px; width: 9px; height: 100%;
    cursor: col-resize; touch-action: none;
  }
  .grip:hover, .grip.dragging { background: var(--accent); opacity: .35; }
  .grid-reset { font-size: 12px; color: var(--muted); background: none; border: 0; padding: 4px 0; cursor: pointer; }
  /* The control the row exists for. It must never be the thing that is clipped. */
  table.grid td[data-col="actions"] { white-space: nowrap; }
  /*
   * Under ${stackBelow}px the table becomes one card per account.
   *
   * Sideways scrolling was what it did before, and on a phone that meant two
   * and a half of eleven columns with the rest - every number, whether it is
   * measuring, and 開く - past the right edge with nothing to say so. Nothing
   * is dropped here: this screen exists to compare accounts, and a comparison
   * missing a number is a wrong comparison rather than a smaller one. The
   * columns are laid out instead: name, state and 直近サイクル across the card,
   * the six figures three to a line with their own headers as labels, then
   * 計測 and the control.
   *
   * The 列の幅をもとに戻す button goes: there are no columns here to reset. The
   * widths it resets are still remembered, and come back with the table.
   */
  @media (max-width: ${stackBelow - 1}px) {
    #portfolio-section { width: auto; margin-left: 0; transform: none; }
    .table-wrap { overflow-x: visible; }
    table.grid { display: block; table-layout: auto; min-width: 0; background: none; border: 0; border-radius: 0; }
    table.grid colgroup, table.grid thead { display: none; }
    table.grid tbody { display: block; }
    table.grid tbody tr, table.grid tbody tr:nth-child(even), table.grid tbody tr:hover {
      display: grid; grid-template-columns: repeat(6, 1fr); gap: 0 12px;
      background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
      padding: 12px 14px; margin-bottom: 10px;
    }
    table.grid td, table.grid tbody tr:last-child td {
      display: block; grid-column: span 6; border-bottom: 0; padding: 4px 0; text-align: left;
    }
    /* Three figures to a line. Left-aligned like everything else in the card:
       right alignment is for scanning down a column, and there is no column. */
    table.grid td.num { grid-column: span 2; text-align: left; }
    /*
     * The column's own header, reused as the field's label - so the words are
     * in messages.ts once and both layouts say the same thing.
     *
     * The name is excluded: it is the card's heading, and does not need to be
     * told it is a name. So is the control, whose header is deliberately blank.
     */
    table.grid td[data-label]:not([data-label=""]):not([data-col="name"])::before {
      content: attr(data-label); display: block; color: var(--muted); font-size: 11px; line-height: 1.4;
    }
    table.grid td[data-col="name"] { font-size: 15px; padding-bottom: 8px; }
    table.grid td[data-col="actions"] { padding-top: 10px; }
    .grid-reset { display: none; }
  }
  /*
   * A tablet, or a laptop too narrow for eleven columns but far too wide for
   * three figures to a line. The six figures go back to one line, which is the
   * shape they are meant to be read in - side by side - without asking for the
   * width a whole table needs.
   */
  @media (min-width: 560px) and (max-width: ${stackBelow - 1}px) {
    table.grid td.num { grid-column: span 1; }
  }
  /* The exact text going out, shown at the publishing gate without a click. */
  pre.post { background: var(--panel); border-color: var(--accent); line-height: 1.7; font-size: 14px; }
  /*
   * A post the operator has to put out themselves. Bordered in the accent
   * colour because it is the one thing on this screen that does not happen
   * unless they do it - the table underneath is a list of things the machine
   * is going to do on its own.
   */
  .card.handover { border-color: var(--accent); }
  .card.handover h3 { margin: 0 0 6px; font-size: 15px; }
  .handover-part { margin: 12px 0; }
  .handover-part .muted { font-size: 12px; margin-bottom: 4px; }
  .handover-part button { font-size: 12px; padding: 4px 10px; }
  /*
   * The order to paste them. Eight copy-and-pastes is the worst day this card
   * has, and until this block existed the screen said which texts but never
   * which goes where - so the only way to find out was to guess, on somebody
   * else's live account.
   */
  .handover-order { margin: 10px 0 14px; }
  .handover-order ol { margin: 4px 0 0; padding-left: 20px; font-size: 13px; }
  .handover-order li { margin: 2px 0; }
  .handover-order .link-note { color: var(--warn); font-size: 12px; margin: 6px 0 0; }
  .pr-ok { color: var(--accent); font-size: 12px; margin-top: 6px; }
  .pr-missing { color: var(--danger); font-size: 13px; font-weight: 600; margin-top: 6px; }
  .pr-none { color: var(--muted); font-size: 12px; margin-top: 6px; }
  /* A line, not an alarm. The operator's two decisions own this screen; an
     update is the licensee's business and can wait for them to finish. */
  .update { font-size: 13px; color: var(--muted); margin: 0 0 20px; }
  .update b { color: var(--ink); font-weight: 600; }
  .update pre {
    white-space: pre-wrap; word-break: break-word; font-size: 12px;
    background: var(--chip); border-radius: var(--radius); padding: 10px 12px; margin: 8px 0 0;
    max-height: 40vh; overflow: auto;
  }
  /*
   * "It is still running." Its own element, above everything, and the one thing
   * on this page no render touches: the boxes these sentences used to go in
   * belong to a card the poll rebuilds every few seconds, and the gate one of
   * them talks about is gone from the screen by the time it matters.
   */
  #notice { font-size: 14px; margin: 0 0 18px; padding: 12px 14px; }
  #notice.warn { border-color: var(--warn); color: var(--warn); }
  /*
   * Two ways a choice is closed, drawn differently on purpose.
   *
   * The disabled attribute alone changes almost nothing an operator notices: the
   * browser greys a tick, and an unticked box that cannot be ticked looks just
   * like one that can. It shipped that way and read as a screen that had
   * stopped responding.
   *
   * Closed *for now* - the cap is reached. Still worth reading, because the
   * way out is to untick something else and pick this instead. So the card
   * recedes rather than fades, and the text stays at full contrast.
   */
  .card.shut { background: var(--bg); border-style: dashed; }
  .item input[type=checkbox]:disabled { opacity: .3; cursor: not-allowed; }
  /*
   * Closed *for good* - the day has gone and the orchestrator will refuse it.
   * Nothing here can be acted on, so the cards fade. The heading and the line
   * saying which day it was do not: that is the one thing left to read.
   */
  section.locked .card { opacity: .5; }
  .gate-stale { color: var(--warn); font-weight: 600; }
  /*
   * Furniture, not content. It sits beside the refresh button and reads as part
   * of the frame, so it is quiet - but it is the name that lands in the audit
   * log, so it is not as quiet as .muted.
   */
  .who { color: var(--ink); font-size: 13px; background: var(--chip); border-radius: 999px; padding: 3px 10px; white-space: nowrap; }
  /*
   * Against the heading, so the number and the thing it counts are read as one.
   * Same weight as the heading it modifies; it is a fact, not an alarm.
   */
  .count { margin-left: 8px; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--ink); background: var(--chip); border-radius: 999px; padding: 2px 9px; vertical-align: middle; }
  /*
   * A day read back. Quiet on purpose - it is reference, not a thing to act on,
   * and nothing here competes with the two decisions on the other screen.
   */
  .linky { background: none; border: 0; color: var(--accent); font-size: 12px; padding: 0 0 0 10px; cursor: pointer; }
  .tl-step { border-left: 2px solid var(--line); padding: 0 0 14px 14px; margin-left: 4px; font-size: 13px; }
  .tl-step:last-child { padding-bottom: 0; }
  /* The two gates. A person decided these, and that is the distinction. */
  .tl-step.human { border-left-color: var(--accent); }
  .tl-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .tl-items { margin-top: 6px; }
  .tl-item { display: flex; gap: 8px; padding: 3px 0; align-items: baseline; }
  .tl-item .mark { color: var(--muted); flex: none; width: 1.2em; }
  .tl-item.chosen .mark { color: var(--accent); }
  /* Refused by the guardrails. Still listed: what was stopped is part of why. */
  .tl-item.blocked b { color: var(--danger); }
  nav { display: flex; gap: 14px; }
  nav a { color: var(--muted); font-size: 13px; text-decoration: none; }
  nav a:hover { color: var(--ink); }
  /* The company's settings reuse the account's .field rows further down: they
     are the same kind of screen, and a second set of styles for them would drift.
     Only this is new - two of those rows decide what actually happens, and are
     allowed to say so when they are set to something worth knowing about. */
  .loud { color: var(--warn); font-weight: 600; }
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
  <span style="flex:1"></span>
  <!-- Who you are approving as sits in the furniture, next to the refresh
       button, because it does not change all session and every other tool puts
       it here. It used to share a grey span with the waiting count, where a
       name read as a role and both were skipped. -->
  <!-- Two views became three, which is where a way between them starts to
       earn its place. Links rather than buttons: they are navigation, and the
       browser's back button should work on them. -->
  <nav><a href="#/">${escapeHtml(t("nav.today"))}</a><a href="#/settings">${escapeHtml(t("nav.settings"))}</a></nav>
  <span class="who" id="who" hidden></span>
  <!-- The operator's own answer to "is this readable where I am". Next to
       refresh because it is furniture, not a decision: it changes nothing about
       the operation and is remembered per browser, like the column widths. The
       label is here as well as in applyTheme so it is never an empty pill in
       the frame before the page's script runs. -->
  <button id="theme" title="${escapeHtml(t("page.themeTitle"))}">${escapeHtml(t("theme.auto"))}</button>
  <button id="refresh">${escapeHtml(t("page.refresh"))}</button>
</header>
<main>
  <div id="stopped"></div>
  <!-- Below the stop banner on purpose: stopping is an emergency, an update
       never is. Empty until the check answers, so a licensee who is current -
       or offline - sees nothing at all rather than a box that says nothing. -->
  <div id="update"></div>
  <!-- Whether a slow press is still working. Outside every view because the
       card a message like this used to go in is rebuilt by the poll, and at
       the ideas gate it is gone from the screen altogether. -->
  <div id="notice" hidden></div>

<div id="view-today">
  <section id="decisions">
    <!-- The count belongs against the thing being counted, with the list right
         underneath. In the header it was a second copy of what the reader was
         already looking at. -->
    <h2>${escapeHtml(t("today.decisions"))}<span class="count" id="decision-count" hidden></span></h2>
    <div id="decision-list"><p class="empty">${escapeHtml(t("page.loading"))}</p></div>
  </section>

  <section>
    <h2>${escapeHtml(t("today.upcoming"))}</h2>
    <!-- Above the schedule, not inside it. Every row of the table below is
         something the machine will do on its own; these are the only ones that
         do not happen unless the operator does them. -->
    <div id="hand-over"></div>
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
    <!-- Empty until render(): the window length is {days} from /api/state,
         the same value the accounts table's own heading names, and this is
         not known at the time this shell is served. -->
    <h2 id="stats-head"></h2>
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
  <!-- The gate, on the screen the operator opened to deal with this account.
       Above everything else here for the same reason it is at the top of the
       day's page: it is the only thing on either screen that is waiting on a
       person. Filled by render(), never by renderVenture() - the tick, the
       reorder and the select-all buttons all call render() alone, and a gate
       drawn anywhere else would freeze the moment one was pressed. -->
  <div id="venture-decisions"></div>
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

<div id="view-settings" hidden>
  <p><a class="back" href="#/">${escapeHtml(t("venture.back"))}</a></p>
  <section>
    <h2>${escapeHtml(t("settings.heading"))}</h2>
    <p class="muted">${escapeHtml(t("settings.lede"))}</p>
    <div id="settings-body"><p class="empty">${escapeHtml(t("page.loading"))}</p></div>
  </section>
</div>
</main>

<script type="module">
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

/**
 * Which 「開く」 panels on the gates are open, so a re-render can put them back.
 *
 * Same defect the timeline had below, in the other half of this screen: the
 * list is thrown away and rebuilt by innerHTML, so an open <details> was being
 * shut under whoever was reading it. Not only by the 30-second poll - ticking a
 * box, reordering, 推奨を選ぶ and すべて外す all re-render, so the reasons closed
 * the moment the operator acted on them.
 *
 * A Set rather than one key, for the same reason resolving below is a Set: two
 * gates can stand open at once, and one gate holds several ideas, so several
 * panels are genuinely open together.
 */
const openDetails = new Set();

/**
 * The key a panel is remembered by: the gate it belongs to and the item inside
 * it. Both survive a re-render. The position in the list does not - the
 * operator can reorder, and an index would then carry the open panel to
 * whatever idea moved into that slot.
 *
 * Built with JSON rather than joining on a separator because both halves are
 * ids from elsewhere, and nothing here gets to promise what is not in them.
 */
function detailsKey(decisionId, itemId) {
  return JSON.stringify([decisionId, itemId]);
}

/**
 * A synthetic item id for the 「そのほかのN件を見る」 <details> that wraps the
 * non-recommended half of a split gate (renderDecision, below).
 *
 * It is not a real item, but detailsKey() only needs two strings that identify
 * a panel, and this one already does: no decision ever has a real item whose
 * id is this. Giving the wrapper this id, rather than a second Set or a second
 * key scheme, is what lets it survive the 30-second poll through the exact
 * same mechanism "ねらいと根拠" already survives it with.
 */
const REST_ITEM_ID = "__rest__";

/**
 * Drops the panels of gates that are no longer on the screen.
 *
 * Answering a gate takes it out of the list without ever closing its <details>,
 * so without this the Set only grows for as long as the page is open - and an
 * id that came back would come back already open.
 */
function forgetGoneDetails(pending) {
  const here = new Set();
  pending.forEach((decision) => {
    decision.items.forEach((item) => here.add(detailsKey(decision.id, item.id)));
    // The rest-toggle's panel is not in decision.items, so without this line
    // it was never in "here" and this function forgot it on every render -
    // the one case this whole function exists to prevent.
    here.add(detailsKey(decision.id, REST_ITEM_ID));
  });
  openDetails.forEach((key) => {
    if (!here.has(key)) openDetails.delete(key);
  });
}

// One delegated listener in the capture phase, rather than one wired to every
// <details> after every rebuild. A toggle event does not bubble, so an ancestor
// only ever sees it on the way down - without the capture flag this listener
// would never run at all. And the gates are replaced wholesale several times a
// minute, so per-element wiring would have to be redone after each innerHTML
// and would lapse silently the first time a new render path forgot to.
document.addEventListener("toggle", (event) => {
  const panel = event.target;
  const decisionId = panel && panel.dataset ? panel.dataset.decision : undefined;
  const itemId = panel && panel.dataset ? panel.dataset.item : undefined;
  if (!decisionId || !itemId) return;
  const key = detailsKey(decisionId, itemId);
  if (panel.open) openDetails.add(key);
  else openDetails.delete(key);
}, true);

function renderDecision(decision) {
  const entry = ensureDraft(decision);
  const ordered = entry.order
    .map((id) => decision.items.find((i) => i.id === id))
    .filter(Boolean);

  // Two reasons a control is dead here, and they are not the same reason.
  //
  // A day that has gone cannot be approved at all - the server refuses it, and
  // a button that can be pressed but never works is worse than one that
  // cannot. The selection cap is different: the boxes already ticked stay live
  // so a choice can be swapped, and only the untouched ones close.
  const locked = Boolean(decision.stale);
  const atMax = entry.selected.size >= decision.max;
  // A third: this gate has been answered and the writing it started is still
  // going. The card is rebuilt every few seconds by the poll, so without this
  // the button came back enabled reading 「N件を承認して進める」 while the work
  // was in flight - which is how the same day got approved twice. It does not
  // fade the section the way a gone day does; nothing here is over.
  const sending = resolving.has(decision.id);

  const renderItem = (item, index) => {
    const checked = entry.selected.has(item.id);
    const shut = locked || sending || (atMax && !checked);
    const rank = checked ? [...entry.order.filter((id) => entry.selected.has(id))].indexOf(item.id) + 1 : "";
    const chips = (item.chips ?? []).map((chip) =>
      '<span class="chip ' + esc(chip.tone ?? "") + '">' + esc(chip.label) + "</span>").join("");
    return \`
      <div class="card\${shut && !locked && !sending ? " shut" : ""}">
        <div class="item">
          <input type="checkbox" data-act="toggle" data-decision="\${esc(decision.id)}" data-item="\${esc(item.id)}" \${checked ? "checked" : ""} \${shut ? "disabled" : ""}>
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
            \${item.preview ? '<details data-decision="' + esc(decision.id) + '" data-item="' + esc(item.id) + '"' +
              (openDetails.has(detailsKey(decision.id, item.id)) ? " open" : "") +
              '><summary>' + (item.post ? T["gate.openPost"] : T["gate.openIdea"]) + '</summary><pre>' + esc(item.preview) + "</pre></details>" : ""}
          </div>
          <div class="order">
            <span class="rank">\${rank}</span>
            <button data-act="up" data-decision="\${esc(decision.id)}" data-item="\${esc(item.id)}" \${locked || sending || index === 0 ? "disabled" : ""}>↑</button>
            <button data-act="down" data-decision="\${esc(decision.id)}" data-item="\${esc(item.id)}" \${locked || sending || index === ordered.length - 1 ? "disabled" : ""}>↓</button>
          </div>
        </div>
      </div>\`;
  };

  // 「推奨」と「そのほか」に割る。10案が同じ重さで平らに並ぶと30秒で終わらない、
  // というオーナーの指摘への実装で、板 (Main.dc.html) と
  // docs/3-development/console-ux-proposal.md §4.4 が先に設計を持っている。
  const openItems = [];
  const restItems = [];
  // チェックの入った案は、畳んだ側に隠れてはいけない。推奨を外して別の案を
  // 選ぶのは普通の操作で、選んだ瞬間にその案が見えなくなるのは事故である。
  ordered.forEach((item) => {
    (item.recommended || entry.selected.has(item.id) ? openItems : restItems).push(item);
  });
  // 両方に少なくとも1件あるときだけ割る。recommended は企画担当（ロール）が
  // 決める値で0件・全件のこともあり、選び直してそのほか側が空になることも
  // あるので、そのどちらでも「機械がN件選んだ」という嘘の区切りは出さない。
  const splitGate = openItems.length > 0 && restItems.length > 0;

  let itemsHtml;
  if (!splitGate) {
    itemsHtml = ordered.map((item, index) => renderItem(item, index)).join("");
  } else {
    const openHtml = openItems.map((item) => renderItem(item, ordered.indexOf(item))).join("");
    const restHtml = restItems.map((item) => renderItem(item, ordered.indexOf(item))).join("");
    // openDetails をそのまま伸ばして使う。新しい仕組みを作ると、この
    // <details> だけ30秒のポーリングで閉じる、という同じ不具合をもう一度
    // 起こすことになる。
    const restOpen = openDetails.has(detailsKey(decision.id, REST_ITEM_ID)) ? " open" : "";
    itemsHtml =
      '<h3 class="group-heading">' + esc(T["gate.recommended"]) + "</h3>" +
      '<p class="muted">' + esc(T["gate.recommendedWhy"]) + "</p>" +
      openHtml +
      '<details class="gate-rest" data-decision="' + esc(decision.id) + '" data-item="' + esc(REST_ITEM_ID) + '"' + restOpen + ">" +
        "<summary>" + esc(fmt("gate.others", { n: restItems.length })) + "</summary>" +
        restHtml +
      "</details>";
  }

  const count = entry.selected.size;
  return \`
    <section\${locked ? ' class="locked"' : ""}>
      <h2>\${esc(fmt("gate.heading", { gate: decision.gateLabel, venture: decision.ventureName }))}</h2>
      \${decision.day ? '<p class="' + (locked ? "gate-stale" : "muted") + '">' + esc(gateDay(decision)) + "</p>" : ""}
      <p class="muted">\${esc(fmt("gate.question", { question: decision.question, max: decision.max }))}\${atMax && !locked ? " " + esc(fmt("gate.atMax", { max: decision.max })) : ""}</p>
      \${itemsHtml}
      <div class="row">
        <button class="primary" data-act="submit" data-decision="\${esc(decision.id)}" \${locked || sending || count === 0 ? "disabled" : ""}>
          \${esc(sending ? T["gate.sending"] : fmt("gate.approve", { n: count }))}
        </button>
        <button data-act="all" data-decision="\${esc(decision.id)}" \${locked || sending ? "disabled" : ""}>\${esc(T["gate.selectRecommended"])}</button>
        <button data-act="none" data-decision="\${esc(decision.id)}" \${locked || sending ? "disabled" : ""}>\${esc(T["gate.rejectAll"])}</button>
      </div>
      <div class="err" id="err-\${esc(decision.id)}"></div>
    </section>\`;
}

/**
 * A post the platform composed and cannot publish: the text, and the press.
 *
 * The text shown is the text the channel composed at the slot, carried here on
 * the post itself. Nothing on this screen rebuilds it - a preview free to
 * disagree with what was handed over is the same defect the publishing gate
 * already had once, and here it would be worse: this text is the post.
 */
function renderHandOver(post) {
  const parts = post.parts ?? [];
  const comments = post.comments ?? [];
  const sending = posting.has(post.postId);
  const block = (label, text, key) =>
    '<div class="handover-part">' +
      '<div class="muted">' + esc(label) + "</div>" +
      '<pre class="post" id="ho-' + esc(post.postId) + "-" + esc(key) + '">' + esc(text) + "</pre>" +
      '<button data-hand-over-act="copy" data-target="ho-' + esc(post.postId) + "-" + esc(key) + '">' +
        esc(T["handOver.copy"]) + "</button>" +
    "</div>";

  const partLabel = (index) =>
    parts.length > 1 ? fmt("handOver.part", { n: index + 1, total: parts.length }) : T["handOver.onePart"];

  const body = parts.map((part, index) => block(partLabel(index), part, "p" + index)).join("");

  // Numbered and named. Every comment was labelled 「最初のコメント」, so three
  // of them claimed the same place and none of them said what it was for; the
  // name is chosen in messages.ts and arrives already in the operator's
  // language, so there is no identifier here to print by accident.
  const commentBlocks = comments.map((comment, index) =>
    block(fmt("handOver.comment", { n: index + 1, total: comments.length, name: comment.name }),
      comment.text, "c" + index)).join("");

  // The order, as the app is actually operated: part one is a new post, the
  // rest reply to the part before them, and every comment replies to the first
  // post - which is what the publishing adapter does when it does this itself
  // (threads.ts chains the parts, and comments go to the root's id).
  const linkComment = comments.filter((comment) => comment.carriesLink)[0];
  const steps = [fmt("handOver.orderFirst", { label: partLabel(0) })]
    .concat(parts.length > 1 ? [T["handOver.orderRest"]] : [])
    .concat(comments.length > 0 ? [fmt("handOver.orderComments", { label: partLabel(0) })] : [])
    .concat([fmt("handOver.orderDone", { button: T["handOver.done"] })]);
  const order = parts.length === 0 ? "" :
    '<div class="handover-order"><div class="muted">' + esc(T["handOver.order"]) + "</div><ol>" +
      steps.map((step) => "<li>" + esc(step) + "</li>").join("") +
    "</ol>" +
    // Outside the list: it is not a step, it is what happens if one is skipped.
    // That comment is the only place the affiliate URL exists.
    (linkComment
      ? '<p class="link-note">' + esc(fmt("handOver.orderLink", { name: linkComment.name })) + "</p>"
      : "") +
    "</div>";

  return '<div class="card handover">' +
    "<h3>" + esc(T["handOver.heading"]) + " — " + esc(post.ventureName) + "</h3>" +
    '<p class="muted">' + esc(T["handOver.lede"]) + "</p>" +
    '<p class="muted">' + esc(fmt("handOver.slot", { at: post.at })) + T["punct.sep"] + esc(post.channel) + "</p>" +
    order +
    body +
    commentBlocks +
    '<div class="row">' +
      '<button class="primary" data-hand-over-act="done" data-post="' + esc(post.postId) + '"' +
        (sending ? " disabled" : "") + ">" +
        esc(sending ? T["handOver.sending"] : T["handOver.done"]) + "</button>" +
      // A plain link, opened in a new tab: the operator is coming back to this
      // page to press the button, and replacing it would lose the text.
      (post.composerUrl
        ? '<a class="open" href="' + esc(post.composerUrl) + '" target="_blank" rel="noopener noreferrer">' +
            esc(T["handOver.open"]) + "</a>"
        : "") +
    "</div>" +
    // Said where the loss actually shows, rather than left for the operator to
    // discover as a gap in their numbers.
    '<p class="muted">' + esc(T["handOver.noEngagement"]) + "</p>" +
    '<div class="err" id="hoerr-' + esc(post.postId) + '"></div>' +
  "</div>";
}

function render() {
  if (!state) return;
  // Before the gates are drawn, so a panel is only put back if its gate is
  // still there to put it back into.
  forgetGoneDetails(state.pending);
  // Whose passphrase this is. The audit log records this name against
  // everything approved here, so it has to be visible before pressing, not
  // discoverable afterwards.
  const who = $("who");
  who.textContent = state.you ?? "";
  who.title = T["page.operatorTitle"];
  who.hidden = !state.you;

  const waiting = state.pending.length;
  const count = $("decision-count");
  count.textContent = String(waiting);
  count.title = fmt("page.waitingCount", { n: waiting });
  // No "(0)" next to the heading: the empty list below already says it, and a
  // zero badge is a thing to read that carries nothing.
  count.hidden = waiting === 0;

  // The one place a count earns its keep is when nobody is looking at the page.
  // A background tab said only the company name, so a day's work could sit here
  // unanswered with the tab open the whole time.
  document.title = (waiting > 0 ? "(" + waiting + ") " : "") + baseTitle;

  // A stop belongs above everything, including the decisions: approving while
  // stopped is refused, and finding that out by pressing the button is a worse
  // way to learn it.
  const stopped = state.stopped ?? [];
  $("stopped").innerHTML = stopped.map((stop) => {
    // pause.ts's synthetic record for a slot it could not read: nobody
    // actually stopped anything, and "reason" is machine text written for a
    // log, not this screen. Only possible on the "all" scope - a per-venture
    // entry is always a real record someone wrote.
    const failClosed = stop.scope === "all" && stop.by === "fail-closed";
    const detail = failClosed
      ? esc(T["stop.failClosedExplain"])
      : [stop.at, stop.by, stop.reason].map(esc).join(T["punct.sep"]);
    // Whole-platform only (see the click handler below and pause.ts): a
    // per-venture resume is refused while a global stop is on, and a button
    // that is visible but refuses is worse than no button. A per-venture
    // entry keeps the plain "no button here" line it always had.
    const action = stop.scope === "all"
      ? '<div class="row" style="margin-top:8px"><button data-resume-all="all">' + esc(T["stop.resumeAll"]) + "</button></div>"
      : '<div class="muted">' + esc(T["stop.howToResume"]) + "</div>";
    return '<div class="card stopped">' +
      "<b>" + (stop.scope === "all" ? esc(T["stop.all"]) : esc(fmt("stop.one", { label: stop.label ?? stop.scope }))) + "</b>" +
      '<div class="muted">' + detail + "</div>" +
      action +
    "</div>";
  }).join("");

  // One gate, one place. Never both: the cards carry id="err-<decisionId>",
  // and with the same decision drawn twice getElementById hands back the copy
  // that is higher in the document - which on the account screen is the hidden
  // one, so a refused approval reported itself into a box nobody could see.
  const routed = routedVentureId();
  const mine = routed ? state.pending.filter((d) => d.ventureId === routed) : [];
  $("venture-decisions").innerHTML = !routed
    ? ""
    : mine.length === 0
      ? '<p class="empty">' + esc(T["today.decisionsEmpty"]) + "</p>"
      : mine.map(renderDecision).join("");
  $("decision-list").innerHTML = routed
    ? ""
    : state.pending.length === 0
      ? '<p class="empty">' + esc(T["today.decisionsEmpty"]) + "</p>"
      : state.pending.map(renderDecision).join("");

  const handOver = state.handOver ?? [];
  $("hand-over").innerHTML = handOver.map(renderHandOver).join("");

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
  /*
   * One account, keyed by column. Written this way rather than as eleven <td>s
   * in a row so that the cell, the header above it and the label the card
   * layout puts beside it all come from the same column - they were three
   * separate lists, kept in the same order by hand.
   */
  const portfolioCells = (row) => ({
    name: '<div class="acct-name">' + esc(row.name) + '</div><div class="acct-id">' + esc(row.ventureId) + "</div>" +
      (row.review
        ? '<div class="acct-review"><span class="chip warn">' + esc(T["accounts.review"]) +
          '</span><div class="muted">' + esc(row.review) + "</div></div>"
        : ""),
    state: stateCell(row) +
      (row.pendingDecisions > 0 ? '<div class="muted">' + esc(fmt("accounts.waiting", { n: row.pendingDecisions })) + "</div>" : ""),
    // A failed day is the one thing a comparison view still has to say, so it
    // says the least that is useful: a verdict chosen by the failure's code,
    // and one smaller line. The whole reason is behind 開く.
    cycle: cycleCell(row.lastCycle) +
      (row.lastCycle?.failureCode ? failureCell(row.lastCycle.failureCode) : ""),
    posts: String(row.posts),
    median: String(row.medianScore),
    clicks: String(row.clicks),
    conversions: String(row.conversions),
    revenue: esc(row.approved),
    playbook: esc(row.playbook),
    measurement: row.measurement === "closed"
      ? esc(T["accounts.measurementClosed"])
      : '<span class="chip warn">' + esc(T["accounts.measurementOpen"]) + "</span>" +
        // Which step is open, not just that one is. There is no terminal to
        // run "doctor" in when this is deployed to a host. (No backticks in
        // here: this file is one big template literal.)
        (row.measurementStep ? '<div class="muted">' + esc(measurementStepLabel(row.measurementStep)) + "</div>" : ""),
    // The only control a row keeps. Switching an account off, reactivating it
    // and running a day all moved to the account screen: a row that is also a
    // control panel stops reading as a comparison, which is what this table
    // is for.
    actions: '<a class="open" href="#/ventures/' + encodeURIComponent(row.ventureId) + '">' + esc(T["accounts.open"]) + "</a>",
  });

  $("portfolio").innerHTML =
    '<div class="table-wrap"><table class="grid"><colgroup>' +
    PORTFOLIO_COLUMNS.map((column) => '<col style="width:' + column.width + 'px">').join("") +
    "</colgroup><thead><tr>" +
    PORTFOLIO_COLUMNS.map((column, index) => "<th" + (column.numeric ? ' class="num"' : "") + ">" +
      esc(column.label) +
      // No grip on the last header: there is no column to its right to give
      // width to, and the 9px handle sat 4px outside the table, which was
      // enough on its own to make the container scroll and clip 開く.
      (index < PORTFOLIO_COLUMNS.length - 1 ? '<span class="grip" data-grip="' + esc(column.key) + '"></span>' : "") +
      "</th>").join("") +
    "</tr></thead><tbody>" +
    portfolio.rows.map((row) => {
      const cells = portfolioCells(row);
      return "<tr>" + PORTFOLIO_COLUMNS.map((column) =>
        '<td data-col="' + esc(column.key) + '" data-label="' + esc(column.label) + '"' +
        (column.numeric ? ' class="num"' : "") + ">" + (cells[column.key] ?? "") + "</td>").join("") + "</tr>";
    }).join("") +
    "</tbody></table></div>" +
    '<button class="grid-reset" type="button">' + esc(T["accounts.resetWidths"]) + "</button>";
  // After the innerHTML above, not before: every element the resize handler
  // holds on to has just been replaced.
  wireColumnResize($("portfolio"));

  const proposals = state.proposals ?? [];
  $("proposals").innerHTML = proposals.length === 0
    ? '<p class="empty">' + T["scout.empty"] + "</p>"
    : proposals.map(renderProposal).join("");

  // Same window, same wording as the accounts table's own heading just above -
  // "直近の数字" used to leave the window unnamed while meaning exactly the
  // table's {days}, and the two adjacent headings both read as "recent".
  $("stats-head").textContent = fmt("today.stats", { days: portfolio.days ?? 30 });
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
  // A day that lapsed is the other entry an operator has to act on: it means
  // the thirty seconds a day this product is built around stopped happening,
  // and nothing else on the screen says so once the gate is gone.
  if (entry.type === "decision.expired") {
    return "<b>" + esc(fmt("today.activityExpired", { day: entry.day ?? "" })) + "</b>";
  }
  // Not the same line, and not bold. The operator closed this one themselves
  // by switching the account off; telling them they missed it is how a record
  // stops being believed.
  if (entry.type === "decision.closed") {
    return esc(fmt("today.activityClosed", { day: entry.day ?? "" }));
  }
  // Handing a post over and a person posting it both land here, and with only
  // the stored summary the two read as the same line twice about the same post.
  if (entry.type === "post.handed_over") {
    return esc(fmt("today.activityHandedOver", { hook: entry.summary }));
  }
  // src/kernel/resume.ts's audit line. "Who" and "when" are already the row's
  // own columns; this is only what happened, in the operator's language rather
  // than the English the stored summary carries for everything that falls
  // through below.
  if (entry.type === "platform.resumed") {
    return esc(T["today.activityResumed"]);
  }
  if (entry.type !== "cycle.failed") return esc(entry.summary);
  const failure = failureSummary(entry.failureCode);
  return '<b>' + esc(fmt("today.activityFailed", {
    step: cycleStepLabel(entry.failureStep),
    reason: failure.short,
  })) + "</b>";
}

function renderProposal(proposal) {
  // The server carries the block for a week after acceptance, so it survives
  // the thirty-second poll and a reload. After that the card goes and the block
  // goes with it: the proposal is kept, but no screen renders it again.
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
    if (box) box.textContent = failureText(error);
    target.disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-hand-over-act]");
  if (!target) return;

  if (target.dataset.handOverAct === "copy") {
    const source = $(target.dataset.target);
    if (!source) return;
    const label = target.textContent;
    try {
      await navigator.clipboard.writeText(source.textContent);
      target.textContent = T["handOver.copied"];
      // The label goes back on its own. A button that stays reading "copied"
      // says nothing about the next press.
      setTimeout(() => { target.textContent = label; }, 2000);
    } catch {
      // Clipboard access is refused outside a secure context, which is exactly
      // where a licensee running this on a plain http address will be. The text
      // is on the screen either way, so this says how to get it.
      notice(T["handOver.copyFailed"], "warn");
    }
    return;
  }

  const postId = target.dataset.post;
  if (posting.has(postId)) return;
  // Asked, not assumed. The URL is only obtainable in the seconds after
  // posting, and cancelling the prompt must not cancel the record - the post is
  // live by then, and nothing else on this page can say so.
  const url = window.prompt(T["handOver.urlPrompt"], "") ?? "";
  posting.add(postId);
  target.disabled = true;
  target.textContent = T["handOver.sending"];
  try {
    await api("/api/posts/" + encodeURIComponent(postId) + "/posted", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    posting.delete(postId);
    await load();
  } catch (error) {
    posting.delete(postId);
    const box = $("hoerr-" + postId);
    if (box) box.textContent = failureText(error);
    target.disabled = false;
    target.textContent = T["handOver.done"];
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-venture-act]");
  if (!target) return;
  const ventureId = target.dataset.venture;
  // This button only ever exists on the account screen load() painted, so
  // this can only fire if the operator has since navigated away and the old
  // screen was still showing at the moment of the press - the same window
  // load()'s own fix closes for a *response*, not for a click that lands
  // inside it. Deactivating (or reactivating) an account is not undoable by
  // pressing it again with no side effects, so this checks again rather than
  // trusting that a card on screen can only ever be the routed one.
  if (ventureId !== routedVentureId()) return;
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
    // What switching off reached, and what it did not. The closed gate belongs
    // here with the rest: the operator just lost the question that was on the
    // screen, and finding that out by noticing it gone is not being told.
    if (act === "deactivate" && result) {
      const said =
        (result.closedGates > 0 ? fmt("switch.closedGates", { n: result.closedGates }) : "") +
        (result.heldApproved > 0 ? fmt("switch.heldApproved", { n: result.heldApproved }) : "") +
        (result.beyondRecall > 0 ? fmt("switch.beyondRecall", { n: result.beyondRecall }) : "");
      const box = said === "" ? null : $("verr-" + ventureId);
      if (box) box.textContent = said;
    }
  } catch (error) {
    const box = $("verr-" + ventureId);
    if (box) box.textContent = failureText(error);
    target.disabled = false;
  }
});

/**
 * The console's exit from the emergency stop. Whole-platform only - see
 * pause.ts and the router's /api/resume for why there is no equivalent for
 * one venture.
 *
 * Refetches before asking anything, rather than trusting whatever the last
 * thirty-second poll drew: the record the operator is asked to confirm has to
 * be the one actually in force right now, not one that happened to be on
 * screen when the press landed. The route re-checks this again itself before
 * writing anything - this is what puts the true record in front of the person,
 * not the safety property, which lives in applyResume.
 */
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-resume-all]");
  if (!target) return;
  target.disabled = true;
  await load();
  const stop = ((state && state.stopped) || []).find((entry) => entry.scope === "all");
  if (!stop) {
    // Resolved itself between the poll that drew this button and the press -
    // a hiccup that recovered, or someone else already resumed it.
    notice(T["stop.resumeNothingToDo"], "");
    return;
  }
  const detail = stop.by === "fail-closed"
    ? T["stop.failClosedExplain"]
    : fmt("stop.resumeConfirmDetail", { at: stop.at, by: stop.by, reason: stop.reason });
  // Doubled backslash, same reason as fmt()'s: this file is one template
  // literal, and a lone one is eaten by it before the browser ever sees it.
  if (!window.confirm(detail + "\\n\\n" + T["stop.resumeConfirm"])) return;
  try {
    await api("/api/resume", { method: "POST" });
    notice(T["stop.resumed"], "");
  } catch (error) {
    notice(failureText(error), "warn");
  } finally {
    await load();
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-venture-run]");
  if (!target) return;
  const ventureId = target.dataset.venture;
  // This is the button a stale render used to leave armed: load()'s own fix
  // stops a late answer from *painting* another account's card while this one
  // stays routed, but it does nothing about a click that lands in the window
  // before that fix ever gets to run - the operator navigates, the old card
  // is still what is on screen for the instant it takes to replace it, and
  // they press what they can see. Running a cycle is exactly the harm the
  // owner named, so this checks again at the moment of the press rather than
  // trusting that a card on screen can only ever carry the routed account's
  // id. Independent of runningVentureId below, which answers a different
  // question - not "is this still the right account" but "is this account's
  // own run already in flight", and has to keep working after the operator
  // navigates away from the account it is running, not stop working here.
  if (ventureId !== routedVentureId()) return;
  // The guard that actually holds. Greying the button is what the operator
  // sees, but it sits on a button the poll replaces every thirty seconds, and
  // it is not what stops a second POST - this is. A run whose response was lost
  // is still a run in flight, and a second one is what the orchestrator then
  // has to reconcile.
  if (runningVentureId === ventureId) return;
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
    // What the screen knew before the press. Taken now, because load() replaces
    // it, and the watcher below has nothing to compare against without it.
    //
    // And loaded first when there is nothing: pressing on a page whose first load
    // had not landed left the watcher comparing against null, which it reads as
    // "not yet" forever. The screen then said the work was still running for five
    // minutes after it had finished.
    if (!state) await load();
    const before = state;
    notice("", "");

    const request = api("/api/ventures/" + encodeURIComponent(ventureId) + "/run", { method: "POST", body: "{}" });
    const outcome = await withDeadline(request, SLOW_ACTION_DEADLINE_MS);

    if (outcome.timedOut) {
      // The run is still going and everything it has done is saved. The only
      // thing lost is this page's answer, so this page stops asking for one.
      await watchUntilItMoves(before, ventureId, T["wait.stillRunning"], request);
      runningVentureId = null;
      // Clearing the flag first, so this render is what puts the button back.
      await load();
      return;
    }

    runningVentureId = null;
    if (!outcome.ok) {
      const error = outcome.error;
      // Nothing was re-rendered on this path, so the button this press disabled
      // is still the one on the page.
      const box = $("verr-" + ventureId);
      if (box) {
        box.className = "err";
        box.textContent = failureText(error);
      }
      target.disabled = false;
      target.textContent = label;
      return;
    }

    const result = outcome.value;
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
  } finally {
    // Every path above lets go of the flag before its last render, because that
    // render is what puts the button back. Still holding it here means one of
    // them threw on the way - and the flag is what every thirty-second redraw
    // reads, so a flag nobody clears is a button reading 動かしています… for
    // good about work that may have finished long ago. That is how v0.7.0 sat
    // on Cloudflare: the watcher died on its first poll and nothing let go.
    // Not a catch: the error still reaches the browser's console, and this
    // page cannot say more about it than that it does not know.
    if (runningVentureId === ventureId) {
      runningVentureId = null;
      notice(T["wait.tooLong"], "warn");
      await load();
    }
  }
});

function move(entry, itemId, delta) {
  const index = entry.order.indexOf(itemId);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= entry.order.length) return;
  const [removed] = entry.order.splice(index, 1);
  entry.order.splice(target, 0, removed);
}

/**
 * What is in force for the whole company, to read.
 *
 * Two of these rows are why this screen exists. Until now neither the autonomy
 * setting nor the model provider appeared anywhere on this page, so a licensee could be
 * running unattended, or running on the simulated model with nothing real being
 * written, and have no way to find that out from the console. Those two say so
 * in the warning colour when they are set to something worth knowing; the rest
 * is reference.
 */
function renderSettings(s) {
  const row = (label, value, where) =>
    '<div class="field"><div class="label">' + esc(label) + "</div><div>" + value + "</div>" +
    (where ? '<div class="where">' + esc(where) + "</div>" : "") + "</div>";
  const loud = (text) => '<span class="loud">' + text + "</span>";

  const autonomy = s.autonomy === "auto" ? loud(T["settings.autonomyAuto"])
    : s.autonomy === "manual" ? esc(T["settings.autonomyManual"])
    : esc(T["settings.autonomyAssisted"]);

  const model = s.llm.provider === "mock"
    ? loud(T["settings.modelMock"])
    : esc(fmt("settings.modelReal", { model: s.llm.model, fastModel: s.llm.fastModel, effort: s.llm.effort }));

  // The same hostname doctor refuses. Left at the example's placeholder every
  // tracked link in every post goes nowhere, and no click is ever counted.
  const trackingBad = /example\\.invalid/.test(s.trackingBaseUrl) || !/^https:/.test(s.trackingBaseUrl);
  const tracking = esc(s.trackingBaseUrl) + (trackingBad ? "<br>" + loud(T["settings.trackingBad"]) : "");

  const who = s.operators.length === 1
    ? fmt("settings.operatorOne", { name: s.operators[0] })
    : fmt("settings.operatorMany", { names: s.operators.join(T["punct.sep"]), n: s.operators.length });

  // First, because it answers "what am I running" before any of the rows
  // that answer "what is it configured to do" - and because it used to
  // answer nowhere on this screen at all. A licensee who is current never saw
  // it: the only place it appeared was inside the update panel's "いまお使いな
  // のは {version} です", which renders only when an update is available.
  // No "where" - there is no config key to point at, only RELEASE.json, which
  // a licensee never opens.
  const version = s.version ? esc(s.version) : loud(T["settings.versionUnknown"]);

  return '<div class="card">' +
    row(T["settings.version"], version) +
    row(T["settings.autonomy"], autonomy, "company.autonomy") +
    row(T["settings.model"], model, "llm.provider") +
    row(T["settings.operator"], esc(who), "company.operator") +
    row(
      T["settings.disclosure"],
      s.policy.requireDisclosure ? esc(s.policy.disclosureText) : loud(T["settings.disclosureOff"]),
      "policy.disclosureText",
    ) +
    row(T["settings.limits"], esc(fmt("settings.limitsValue", {
      posts: s.policy.maxPostsPerDay, minutes: s.policy.minMinutesBetweenPosts, smell: s.policy.maxAiSmellScore,
    })), "policy") +
    row(T["settings.words"], esc(fmt("settings.wordsValue", {
      banned: s.policy.bannedPhrases, prohibited: s.policy.prohibitedClaims,
    })), "policy.bannedPhrases") +
    row(T["settings.tracking"], tracking, "tracking.baseUrl") +
    row(T["settings.scale"], esc(fmt("settings.scaleValue", {
      ventures: s.ventures, markets: s.markets.join(", "),
    })), "ventures / markets") +
  "</div>" +
  '<p class="muted">' + fmt("setup.editInFile", { path: esc(s.configPath) }) + "</p>";
}

// What is open in the timeline, so the 30-second poll's re-render can put it
// back instead of closing it.
let openTimelineDate = "";
let openTimelineHtml = "";

/**
 * A day, read back. Each role in the order it ran, what it said, and what it
 * produced - with the two gates marked as a person's decision rather than the
 * machine's, because that is the distinction the whole screen exists to show.
 */
function renderTimeline(day) {
  const seconds = (ms) => (ms / 1000).toFixed(1) + "s";
  return '<div class="card tl">' +
    // Once, above the steps: every row below is this clock, and repeating the
    // name on each of nine steps would bury the steps.
    (day.zone ? '<div class="muted">' + esc(fmt("timeline.zone", { zone: day.zone })) + "</div>" : "") +
    day.entries.map((entry) => {
      const items = (entry.items ?? []).map((item) =>
        '<div class="tl-item' + (item.blocked ? " blocked" : "") + (item.chosen ? " chosen" : "") + '">' +
        (entry.byHuman ? '<span class="mark">' + (item.chosen ? "✓" : "—") + "</span>" : "") +
        "<span><b>" + esc(item.title) + "</b>" +
        (item.detail ? '<span class="muted"> ' + esc(item.detail) + "</span>" : "") +
        "</span></div>").join("");
      return '<div class="tl-step' + (entry.byHuman ? " human" : "") + '">' +
        '<div class="tl-head"><b>' + esc(cycleStepLabel(entry.step)) + "</b>" +
        '<span class="muted">' + esc(entry.clock) + T["punct.sep"] + seconds(entry.durationMs) + "</span>" +
        (entry.byHuman ? '<span class="chip">' + esc(T["timeline.byHuman"]) + "</span>" : "") +
        "</div>" +
        (entry.note ? '<div class="muted">' + esc(entry.note) + "</div>" : "") +
        entry.said.map((line) => "<div>" + esc(line) + "</div>").join("") +
        (items ? '<div class="tl-items">' + items + "</div>" : "") +
      "</div>";
    }).join("") +
    (day.failure
      ? '<div class="tl-step"><div class="err">' + esc(failureSummary(day.failure.code).short) +
        T["punct.sep"] + esc(day.failure.message) + "</div></div>"
      : "") +
  "</div>";
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-act]");
  if (!target) return;
  const act = target.dataset.act;

  // Handled before the decision lookup below, which returns early for anything
  // without a data-decision. This one belongs to a date, not to a gate.
  if (act === "timeline") {
    const ventureId = routedVentureId();
    const box = $("timeline");
    const already = openTimelineDate === target.dataset.date;
    openTimelineDate = already ? "" : target.dataset.date;
    box.dataset.date = openTimelineDate;
    if (already) {
      openTimelineHtml = "";
      box.innerHTML = "";
      return;
    }
    box.innerHTML = '<p class="empty">' + esc(T["page.loading"]) + "</p>";
    try {
      const day = await api(
        "/api/ventures/" + encodeURIComponent(ventureId) + "/cycles/" + encodeURIComponent(target.dataset.date),
      );
      // The same shape of race as load()'s, found by the same audit: click a
      // date, click a different one before the first answers, and the first
      // answer landing last used to overwrite the second one's timeline with
      // the wrong day - #timeline is one box shared by every date's panel,
      // and nothing here checked whether this answer was still wanted. Only
      // reachable within one render of the history list: renderVenture()
      // rebuilds #timeline itself (and any reference to the old one goes with
      // it), so this only guards two clicks between one poll and the next.
      if (target.dataset.date !== openTimelineDate) return;
      openTimelineHtml = renderTimeline(day);
    } catch (error) {
      if (target.dataset.date !== openTimelineDate) return;
      openTimelineHtml = '<p class="err">' + esc(failureText(error)) + "</p>";
    }
    box.innerHTML = openTimelineHtml;
    return;
  }

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
    // Answering the ideas gate does not stop at the gate: it carries on into
    // writing and inspection, which is minutes of model calls. A second answer
    // to a gate already answered is refused by the orchestrator, so this guard
    // is not about correctness - it is about not sending the operator a
    // conflict for a press the screen invited.
    if (resolving.has(decisionId)) return;
    resolving.add(decisionId);
    target.disabled = true;
    target.textContent = T["gate.sending"];
    const ventureId = decision.ventureId;
    try {
      if (!state) await load();
      const before = state;
      notice("", "");

      const ordering = entry.order.filter((id) => entry.selected.has(id));
      const request = api("/api/decisions/" + encodeURIComponent(decisionId) + "/resolve", {
        method: "POST",
        body: JSON.stringify({ selectedIds: ordering, ordering }),
      });
      const outcome = await withDeadline(request, SLOW_ACTION_DEADLINE_MS);

      if (outcome.timedOut) {
        // The gate itself was answered the moment the request arrived; what was
        // lost is the reply to it, not the decision. So the draft goes, and the
        // page watches for the post this approval is now writing.
        draft.delete(decisionId);
        await watchUntilItMoves(before, ventureId, T["wait.gateStillRunning"], request);
        resolving.delete(decisionId);
        await load();
        return;
      }

      resolving.delete(decisionId);
      if (!outcome.ok) {
        const error = outcome.error;
        // render() first: it rebuilds the box this writes into, and the button
        // that press disabled.
        render();
        const box = $("err-" + decisionId);
        if (box) box.textContent = failureText(error);
        return;
      }
      draft.delete(decisionId);
      await load();
    } finally {
      // The same guarantee as the run button's, for the same reason: every path
      // above lets go before its last render, so still holding on here means
      // one of them threw, and the redraw would keep drawing 送信中… from it.
      if (resolving.has(decisionId)) {
        resolving.delete(decisionId);
        notice(T["wait.tooLong"], "warn");
        await load();
      }
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

/** How many gates this account has open, from the day's own list. */
function waitingHere(ventureId) {
  return (state?.pending ?? []).filter((d) => d.ventureId === ventureId).length;
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
      // Counted off the same list the block above this screen is drawn from,
      // not off the account payload. Two sources for one number is how a badge
      // reading 判断待ち1件 came to sit above a page with no gate on it.
      (waitingHere(v.ventureId) > 0
        ? '<span class="chip">' + esc(fmt("accounts.waiting", { n: waitingHere(v.ventureId) })) + "</span>"
        : "") +
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
        // The way in to the day. Not a button and not on the daily path: this
        // answers "why did it propose that", which only comes up when something
        // looks wrong, and the operator's thirty seconds are on the other screen.
        return '<div><span class="when">' + esc(cycle.date) + "</span><span" +
          (failed ? ' class="bad"' : "") + ">" + esc(what) + "</span>" +
          '<button class="linky" data-act="timeline" data-date="' + esc(cycle.date) + '">' +
          esc(T["timeline.open"]) + "</button></div>";
      }).join("") + "</div>" +
      // Carried across the re-render rather than rebuilt empty. load() runs
      // every 30 seconds, and an open day was being wiped out from under
      // whoever was reading it.
      '<div id="timeline" data-date="' + esc(openTimelineDate) + '">' + openTimelineHtml + "</div>";

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
/**
 * Gates this page has answered and is still waiting on.
 *
 * A Set rather than one id: two gates can stand open at once, and with a single
 * variable the second answer would release the guard on the first.
 */
const resolving = new Set();
/**
 * Posts this page has already reported as posted and is still waiting on.
 *
 * Same reason as resolving: the poll rebuilds this card every thirty seconds,
 * and a fresh 「投稿しました」 button coming back enabled is how a press becomes
 * two - which the second time round is refused, with an error on a card that
 * had in fact worked.
 */
const posting = new Set();

/**
 * Which call to load() is the one allowed to paint.
 *
 * Three things call load() and none of them knows about the others: the
 * 30-second poll, the hashchange listener, and the run/approve handlers
 * waiting out a slow answer. Each awaits twice - /api/state, then
 * /api/ventures/<id> - and neither await used to be followed by a check that
 * anything had changed while it was pending. So a load() started on one
 * account and a load() started on another, moments later after the operator
 * navigated away, raced: whichever's /api/ventures/<id> happened to answer
 * last painted #venture-head last, whatever account it was for - while the
 * hidden flags (set synchronously, before either await, so they are never
 * stale) already agreed with the address bar. The operator saw the right
 * account framed around the wrong one's data, with a run button that would
 * have started the wrong one's cycle.
 *
 * The fix is a generation count rather than an AbortController: two fetches
 * to different paths cannot share one controller without cancelling the one
 * that is still wanted, and this page never wants to cancel a request that
 * might be doing real work - only to stop painting its answer. Every call
 * takes the next number; every write this function makes, on either side of
 * an await, is gated on still holding the latest one. A load() that is no
 * longer the latest finishes its request (nothing here is aborted) and
 * throws its answer away instead of painting it.
 */
let loadGeneration = 0;

async function load() {
  const generation = ++loadGeneration;
  const isCurrent = () => generation === loadGeneration;

  // Safe to run unguarded: nothing here awaits anything, so no other load()
  // can start between reading the route and writing these three flags. The
  // latest call's synchronous prefix always runs to completion before any
  // earlier call's suspended await can resume - that is what makes the
  // address bar and the hidden flags agree even while the race below is in
  // flight.
  const ventureId = routedVentureId();
  const onSettings = window.location.hash === "#/settings";
  $("view-today").hidden = Boolean(ventureId) || onSettings;
  $("view-venture").hidden = !ventureId;
  $("view-settings").hidden = !onSettings;
  if (onSettings) {
    try {
      const settings = await api("/api/settings");
      if (isCurrent()) $("settings-body").innerHTML = renderSettings(settings);
    } catch (error) {
      if (isCurrent()) $("settings-body").innerHTML = '<p class="err">' + esc(failureText(error)) + "</p>";
    }
    // The day's state is still loaded below: the header's count and the stop
    // banner belong on every view.
  }
  try {
    // The day's state is loaded either way: the header's count, the stop
    // banner and the window length come from it, and they belong on both.
    const fetchedState = await api("/api/state");
    if (!isCurrent()) return;
    state = fetchedState;
    render();
    if (ventureId) {
      const fetchedVenture = await api("/api/ventures/" + encodeURIComponent(ventureId));
      if (!isCurrent()) return;
      venture = fetchedVenture;
      renderVenture(venture);
    } else {
      venture = null;
    }
  } catch (error) {
    if (!isCurrent()) return;
    const box = ventureId ? $("venture-head") : $("decision-list");
    box.innerHTML = '<p class="err">' + esc(failureText(error)) + "</p>";
  }
}

/**
 * Asked once, on load - never on the 30-second poll.
 *
 * The poll exists so the day's state stays fresh; hanging someone else's
 * server off it would put the operator's screen behind github.com's uptime
 * thirty times a minute for a fact that changes once a month.
 *
 * Everything it can return except "behind" renders nothing. A licensee who is
 * current, offline, or running an unreleased checkout should see the screen
 * they came for, not a box explaining that there is nothing to explain.
 */
async function loadUpdate() {
  let status;
  try {
    status = await api("/api/updates");
  } catch {
    return;
  }
  if (!status || status.kind !== "behind") return;

  // Every value here came off the network, so every one is escaped - the notes
  // included: they are markdown from a repository whose address is whatever
  // this copy's stamp says, rendered on a page that is already authenticated.
  const parts = [
    '<div class="update">',
    "<b>" + esc(fmt("update.available", { version: status.upstreamVersion })) + "</b>",
    " " + esc(fmt("update.since", { version: status.version })),
    "<div>" + esc(T["update.how"]) + "</div>",
  ];
  if (status.notes) {
    parts.push(
      "<details><summary>" + esc(T["update.what"]) + "</summary><pre>" + esc(status.notes) + "</pre></details>",
    );
  }
  parts.push("</div>");
  $("update").innerHTML = parts.join("");
}

window.addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  load();
});
$("refresh").addEventListener("click", load);
// Before the first load, so the page never paints in one scheme and then the
// other. It is the only thing on this page that runs ahead of the data.
applyTheme(theme);
$("theme").addEventListener("click", () => {
  applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]);
});
load();
setInterval(load, 30000);
// Not awaited and not inside load(): a slow answer must never delay the
// screen the operator opened, and a failure must never take it down with it.
loadUpdate();
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
