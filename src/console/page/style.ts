/**
 * The console page's CSS.
 *
 * Split out of ui.ts (test/console.test.ts calls the whole directory "the
 * page" now). Unchanged from what ui.ts used to return inline - see ui.ts
 * for why tableWidth, stackBelow and dark are arguments rather than
 * constants recomputed here.
 *
 * No backtick-quoted names in this comment on purpose: this file, like every
 * other one under ./page/, holds exactly one template literal, and the test
 * that guards that counts every unescaped backtick in the whole file.
 */

export function pageStyle(tableWidth: number, stackBelow: number, dark: string): string {
  return `
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
   * The declared widths add up to ${tableWidth}px, which is wider than this
   * page's content ever gets (see the comment below on #portfolio-section) -
   * so on an ordinary desktop window this now scrolls by default, not only
   * when the operator drags a column wider still. That is a deliberate trade,
   * not a bug: see below for what it replaced.
   */
  .table-wrap { overflow-x: auto; }
  /*
   * Says the table scrolls. On a macOS overlay scrollbar nothing shows until
   * the pointer touches it, and the table is ~280px wider than main, so
   * 確定報酬 arrived as a 6px sliver with no cue that 型 and 計測 were beyond
   * it. A thin scrollbar that stays drawn is the cue. It exists only while
   * .table-wrap actually overflows, so nothing shows when the table fits, and
   * the stacked-card layout below resets overflow to visible, which removes it
   * there. (An edge fade is not an option: the table paints its own opaque
   * panel over anything the wrapper could put behind it.) The webkit rules
   * are what keep it always-on in Safari; scrollbar-color is Firefox and
   * current Chrome, which ignore the webkit ones once it is set.
   */
  .table-wrap { scrollbar-width: thin; scrollbar-color: var(--muted) var(--chip); }
  .table-wrap::-webkit-scrollbar { height: 10px; }
  .table-wrap::-webkit-scrollbar-track { background: var(--chip); border-radius: 5px; }
  .table-wrap::-webkit-scrollbar-thumb { background: var(--muted); border-radius: 5px; }
  /*
   * main is 860px wide because that is a comfortable measure for reading the
   * proposals. This table used to step outside that column on purpose - still
   * centred, still bounded by the window, capped at the same ${tableWidth}px
   * the table itself needs - because eleven columns scrolling inside 828px of
   * content read as cramped on a screen with room to spare. (The cap used to
   * be a bare 1240 before that; see the change that replaced it with
   * tableWidth for the bug that number caused.)
   *
   * But a section that grows to fit its own table, while every other section
   * on the page stays at main's width, drifts from them as the window widens -
   * up to 139px wider on each side at a common desktop size, which is exactly
   * the "はみ出た感じ" the owner saw once there was something else on the page
   * to compare it against: 「横幅が他のところと合っておらず、表がはみ出た感じに
   * 見える」. The owner's call, once both could not be had at once: match the
   * page over keeping the table scroll-free. So this section is given no
   * width of its own any more - the plain "section" rule above already sizes
   * it like every section above and below it - and the table scrolls inside
   * .table-wrap when eleven columns do not fit, the same mechanism a column
   * dragged wider than the window already relied on.
   */
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
  /*
   * Meaningful only to someone who has actually dragged a column, so it ships
   * hidden (the "hidden" attribute in the markup) and wireColumnResize shows
   * it once a stored width exists. Before this it rendered under the table on
   * every visit, whether or not anyone had ever touched a border.
   */
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
   * columns are laid out instead, in the same order portfolio-columns.ts
   * declares them: name and the control right under it, then state and
   * 直近サイクル, the six figures three to a line with their own headers as
   * labels, then 計測.
   *
   * The 列の幅をもとに戻す button goes: there are no columns here to reset. The
   * widths it resets are still remembered, and come back with the table.
   */
  @media (max-width: ${stackBelow - 1}px) {
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
  /*
   * A gate that is open is waiting on the operator and nothing else on the
   * screen is, so it gets the frame .card.handover has: --accent means "does
   * not happen unless you act". A locked gate (its day has passed) is not
   * waiting on anyone, so it does not get it - the class is only put on an
   * open one, in renderDecision.
   */
  section.gate { border: 1px solid var(--accent); border-radius: var(--radius); padding: 14px 16px 4px; }
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
  /* Label above, value below - drawn only by statHtml() in the client helpers. One .stat-line per currency. */
  .stat .stat-label { display: block; }
  .stat b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
  .stat .stat-line { display: block; }
  /*
   * The top page's whole content now: which account is in what state. One row
   * per account, always the same shape whether there is one account or five -
   * decisions.md (2026-09-23) rejected a one-account special case on purpose.
   * A plain link rather than a table row: the day's page compares nothing any
   * more, it only points, and a row that is entirely "open this account" reads
   * better as a link than as a control bolted onto a comparison.
   */
  .status-row {
    display: block; padding: 12px 16px; margin-bottom: 8px;
    border: 1px solid var(--line); border-radius: var(--radius);
    background: var(--panel); text-decoration: none; color: inherit;
  }
  .status-row:hover { background: var(--row-hover); }
  .status-row-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .status-name { font-weight: 600; }
  .status-facts { display: flex; gap: 8px; flex-wrap: wrap; }
  /* Normal: a decision waits for the operator, and being an hour late costs
     nothing. The weakest of the three badges on purpose. */
  .status-badge { font-size: 12px; border-radius: 999px; padding: 3px 10px; background: var(--chip); color: var(--muted); white-space: nowrap; }
  /* Strong: the one fact here where a machine is waiting on a person at a
     specific minute, not merely waiting. Filled with --accent, the same
     colour .card.handover already used for the one card that does not happen
     unless the operator acts - this is that same rule promoted to a badge. */
  .status-badge--handover { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
  /* Exception: console-architecture.md already decided failures cannot hide
     behind a click. Bordered rather than filled, so it reads as distinct from
     both the normal chip and the strong one rather than as a third filled pill. */
  .status-badge--failed { background: none; border: 1px solid var(--danger); color: var(--danger); font-weight: 600; }
  /* An account not going to run at all until someone resumes it - the same
     visual weight as --failed on purpose, so a quiet-looking row is never the
     one that is actually halted, but its own class: this is not a failure. */
  .status-badge--stopped { background: none; border: 1px solid var(--danger); color: var(--danger); font-weight: 600; }
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
`;
}
