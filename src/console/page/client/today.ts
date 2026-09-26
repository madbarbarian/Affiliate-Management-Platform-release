/**
 * The day's own page (#view-today): render(), its activity-log text helper,
 * and the scout's proposal cards with their accept/dismiss listener. These
 * are contiguous in the original file and share no boundary with any other
 * named piece, so they stayed together.
 */

export const TODAY_SCRIPT = `function render() {
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

  // The gate lives on the account's own screen only, now that the day's page
  // no longer carries a company-wide list of them to draw it into twice. The
  // card still carries id="err-<decisionId>", but there is exactly one place
  // in the document that can ever hold it.
  const routed = routedVentureId();
  const mine = routed ? state.pending.filter((d) => d.ventureId === routed) : [];
  $("venture-decisions").innerHTML = !routed
    ? ""
    : mine.length === 0
      ? '<p class="empty">' + esc(T["today.decisionsEmpty"]) + "</p>"
      : mine.map(renderDecision).join("");

  // 予約中の投稿 and the hand-over cards: company-wide arrays, filtered to the
  // routed account the same way the gate above is - never sent pre-filtered,
  // so the account screen and the status strip's badge below always agree
  // about what is actually waiting on this account.
  const handOverMine = routed ? (state.handOver ?? []).filter((post) => post.ventureId === routed) : [];
  $("venture-hand-over").innerHTML = handOverMine.map(renderHandOver).join("");

  const upcomingMine = routed ? (state.upcoming ?? []).filter((post) => post.ventureId === routed) : [];
  $("venture-upcoming").innerHTML = !routed
    ? ""
    : upcomingMine.length === 0
      ? '<p class="empty">' + esc(T["today.upcomingEmpty"]) + "</p>"
      : '<table><thead><tr><th>' + esc(T["today.upcomingTime"]) + "</th><th>" + esc(T["today.upcomingStatus"]) + "</th><th>" + esc(T["today.upcomingHook"]) + "</th></tr></thead><tbody>" +
        upcomingMine.map((post) =>
          "<tr><td>" + esc(post.at) + "</td><td>" + esc(post.status) + "</td><td>" + esc(post.hook) + "</td></tr>").join("") +
        "</tbody></table>";

  const portfolio = state.portfolio ?? { rows: [] };
  // Which account is in what state - the whole of the day's page now that the
  // judgement and the schedule moved to each account's own screen. Built from
  // the same three sources the account screen itself reads (pendingDecisions,
  // state.handOver, lastCycle), so the badge and the account screen can never
  // disagree about what is waiting - the exact failure mode decisions.md
  // (2026-09-23) named as the condition that makes removing the list from
  // this page safe at all: a badge that under-reports is the same defect as a
  // silent audit log, with a number on it.
  $("status-strip").innerHTML = portfolio.rows.length === 0
    ? '<p class="empty">' + esc(T["status.empty"]) + "</p>"
    : portfolio.rows.map(renderStatusRow).join("");
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
    revenue: row.approvedLines.map(esc).join("<br>"),
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
    // Hidden by default: wireColumnResize shows it only once a stored width
    // exists, since resetting means nothing until a column has been dragged.
    '<button class="grid-reset" type="button" hidden>' + esc(T["accounts.resetWidths"]) + "</button>";
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
    statHtml(stat.label, stat.lines)).join("") + "</div>";

  // entry.text arrives already in the operator's language - router.ts's
  // buildActivityFeed and describeAuditEvent do the translating now, the
  // same place the composing happens (clicks and conversions are not audit
  // events, so this page could never have done that join on its own). This
  // page's only job is to lay the line out: the meta row names when, which
  // account (absent for a whole-platform event) and who, in that order, and
  // the ones that need a person's attention today - a failure, a gate that
  // lapsed unanswered - are bold. (No backticks in here: this file is one
  // big template literal.)
  $("activity").innerHTML = state.activity.length === 0
    ? '<p class="empty">' + esc(T["today.activityEmpty"]) + "</p>"
    : '<div class="card">' + state.activity.map((entry) => {
        const meta = [entry.at, entry.ventureName, entry.actor].filter(Boolean).map(esc).join(T["punct.sep"]);
        const line = esc(entry.text);
        return '<div class="muted">' + meta + "</div><div>" + (entry.emphasize ? "<b>" + line + "</b>" : line) + "</div>";
      }).join("<hr style=\\"border:none;border-top:1px solid var(--line);margin:8px 0\\">") + "</div>";
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

`;
