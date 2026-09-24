/**
 * failureCell (shared with today.ts's render()), the top page's per-account
 * status row, and the account screen (renderVenture and routedVentureId).
 * Contiguous in the original file; kept together so this piece, like every
 * other, holds exactly one template literal.
 */

export const VENTURE_SCRIPT = `// ---------------------------------------------------------------------------
// The top page: which account is in what state
// ---------------------------------------------------------------------------

/** How many gates this account has open, from the day's own list. */
function waitingHere(ventureId) {
  return (state?.pending ?? []).filter((d) => d.ventureId === ventureId).length;
}

/**
 * How many posts are sitting on this account, waiting for a person to post
 * them by hand - counted off the same array the account's own screen reads
 * (state.handOver), never a separately memoised number. decisions.md
 * (2026-09-23) made that the condition for removing the hand-over cards from
 * this page at all: the badge and the account screen must never be able to
 * disagree about what is actually waiting.
 */
function handOverHere(ventureId) {
  return (state?.handOver ?? []).filter((post) => post.ventureId === ventureId).length;
}

/**
 * One account, one row: which of the three facts apply, at the strength
 * decisions.md (2026-09-23) gives each one.
 *
 * Normal (承認が要る): a decision waits for the operator: late by an hour
 * costs nothing. Strong (いま投稿する番です): the one thing on this page a
 * machine is waiting on a person for at a specific minute - miss the slot and
 * it is gone, not merely late. Exception (失敗しています): console-
 * architecture.md already decided failures are the one thing this kind of
 * list must never hide behind a click, and the reason comes from
 * failureCell() - the failure's *code*, never a truncated message.
 */
function renderStatusRow(row) {
  const approvalsNeeded = row.pendingDecisions ?? 0;
  const postingNow = handOverHere(row.ventureId);
  const failed = row.lastCycle?.status === "failed";
  const facts =
    (approvalsNeeded > 0
      ? '<span class="status-badge">' + esc(fmt("status.approvalsNeeded", { n: approvalsNeeded })) + "</span>"
      : "") +
    (postingNow > 0
      ? '<span class="status-badge status-badge--handover">' + esc(T["status.handOverBadge"]) + "</span>"
      : "") +
    (failed
      ? '<span class="status-badge status-badge--failed">' + esc(T["status.failed"]) + "</span>"
      : "");
  return '<a class="status-row" href="#/ventures/' + encodeURIComponent(row.ventureId) + '">' +
    '<div class="status-row-top">' +
      '<span class="status-name">' + esc(row.name) + "</span>" +
      '<span class="status-facts">' + facts + "</span>" +
    "</div>" +
    (failed ? failureCell(row.lastCycle.failureCode) : "") +
  "</a>";
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
  const running = runningVentureIds.has(v.ventureId);
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
      // whoever was reading it. Guarded on the account, not only spliced in:
      // without openTimelineVentureId this painted whichever account last
      // opened a day under every other account's history card too.
      (openTimelineVentureId === v.ventureId
        ? '<div id="timeline" data-date="' + esc(openTimelineDate) + '">' + openTimelineHtml + "</div>"
        : '<div id="timeline" data-date=""></div>');

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

`;
