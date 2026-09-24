/**
 * Routing and the poll: which view is on screen, load(), loadUpdate(), and
 * the bootstrap that wires the refresh button, the theme button, the
 * hashchange listener and the 30-second interval. The theme button's own
 * wiring is four lines of this same bootstrap block in the original page
 * (applyTheme/THEMES themselves live in helpers.ts); splitting those four
 * lines into a file of their own was not worth a fifteenth file.
 */

export const LOAD_POLL_SCRIPT = `// ---------------------------------------------------------------------------
// Routing. One page, two views; the address says which.
// ---------------------------------------------------------------------------

/** The account currently open, so a refresh reloads the right thing. */
let venture = null;
/**
 * Which account's own content #view-venture's regions currently hold - not
 * which account is routed, and not the venture variable above (which is null
 * until the first fetch answers). Set the moment those regions are cleared or
 * repainted for an account, so a load() that finds the route unchanged from
 * this can tell there is nothing stale to clear.
 *
 * See clearVentureView() and its call in load() for what this is for.
 */
let ventureViewAccount = null;
/**
 * Accounts whose run this page started and is still waiting on.
 *
 * A Set rather than one id: two accounts can have a run in flight at once -
 * the operator starts one, navigates before it answers, and starts a second
 * on another account while the first is still going. With a single variable
 * the second start overwrote the first's own in-flight fact, its button came
 * back pressable, and pressing it sent a second POST for a run whose first
 * request had never answered. Same shape as resolving and posting below.
 */
const runningVentureIds = new Set();
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

/**
 * Blanks every region of #view-venture that holds one account's own content:
 * the header, the gate, the hand-over cards, the upcoming table, the last
 * cycle, the history and whatever day is open inside it, the numbers, the
 * playbook, the read-only setup and the switch-off card.
 *
 * Called from load() only when the routed account has just changed to one
 * this DOM does not already belong to (see ventureViewAccount) - never
 * unconditionally, and never on the 30-second poll that finds the account
 * unchanged. This is what stands between "the previous account's screen,
 * including its buttons, sits there until two requests answer" and a poll
 * that blinks blank every time it runs.
 *
 * Blanks rather than a spinner: a loading line in eleven places at once reads
 * as more broken than empty ones, and the two requests load() is about to
 * start (/api/state, then /api/ventures/<id>) usually answer inside a second.
 */
function clearVentureView() {
  $("venture-decisions").innerHTML = "";
  $("venture-head").innerHTML = "";
  $("venture-hand-over").innerHTML = "";
  $("venture-upcoming").innerHTML = "";
  $("venture-cycle").innerHTML = "";
  $("venture-history").innerHTML = "";
  $("venture-numbers-head").textContent = "";
  $("venture-numbers").innerHTML = "";
  $("venture-playbook-head").textContent = "";
  $("venture-playbook").innerHTML = "";
  $("venture-setup").innerHTML = "";
  $("venture-switch").innerHTML = "";
  // The day this held, if any, was this account's. renderVenture() already
  // refuses to splice it under a different account (openTimelineVentureId,
  // timeline.ts) - this clears it outright, because the account that fetched
  // it is not even routed any more, and the box it lived in is gone above.
  openTimelineVentureId = "";
  openTimelineDate = "";
  openTimelineHtml = "";
}

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
  // #view-venture is about to be unhidden (below) with whatever markup it
  // already holds - the previous account's, if this is a navigation between
  // two different accounts. That markup does not go stale and get repainted
  // until the two requests below answer, which on a Worker behind D1 is long
  // enough to read: the owner watched outdoor(3)'s screen, buttons and all,
  // sit there under outdoor(2)'s route until "it fixed itself" a moment
  // later. So it is cleared here, synchronously, before either await and
  // before the view is revealed - never after.
  //
  // Only when the account actually changed, and compared against the account
  // this DOM currently holds (ventureViewAccount), not against the previous
  // call's route: routing away to #/ or #/settings and back to the same
  // account must not blank content that is still that account's own, and the
  // 30-second poll's ordinary case - the route not moving at all - must not
  // blank anything, or the screen would blink on every refresh.
  if (ventureId && ventureId !== ventureViewAccount) {
    clearVentureView();
  }
  // Set whether or not this branch ran: this call's account is what the view
  // is about to show (blank or not), so a second navigation before this one's
  // requests answer compares against this account, not the one before it.
  if (ventureId) ventureViewAccount = ventureId;
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
  // The day's state is loaded either way: the header's count, the stop
  // banner and the window length come from it, and they belong on both.
  // Started here, together with the venture fetch right after it, rather
  // than the venture fetch starting only once this one has answered: the two
  // do not depend on each other over the wire, and awaiting them one after
  // another cost a whole extra round trip on every navigation - on a Worker
  // behind D1, long enough that clearing the stale screen above just leaves
  // the operator looking at a blank one for twice as long as it has to. Both
  // requests are in flight by the time either await below can suspend.
  const statePromise = api("/api/state");
  const venturePromise = ventureId ? api("/api/ventures/" + encodeURIComponent(ventureId)) : undefined;

  // Not Promise.all: one rejecting would take the other's already-settled
  // answer down with it, and the two failures belong in different places
  // anyway (the whole page's banner and gate vs. one account's own header).
  // Not Promise.allSettled either - its array would only be pulled back apart
  // into these same two cases. Each is simply awaited and handled on its own,
  // which is what a real Promise.allSettled caller ends up doing anyway.
  //
  // State is awaited first and paints first on purpose, ahead of whichever
  // answers first over the wire: renderVenture() reads the module-level
  // state variable too (waitingHere(), in venture.ts), so it must never run
  // before state has actually been set for this call, or it would show a
  // stale or wrong "waiting" count read off a previous account's answer - the very
  // defect this file exists to stop. Painting state's own regions (the status
  // strip, the stop banner, this account's gate/hand-over/upcoming) does not
  // wait on the venture fetch, though: it paints the moment its own answer
  // lands, which is what makes this feel faster rather than merely "not
  // stale" - a wait shortened to whichever request answers first shows
  // something sooner than a wait that is not shortened at all.
  try {
    const fetchedState = await statePromise;
    if (isCurrent()) {
      state = fetchedState;
      render();
    }
  } catch (error) {
    if (isCurrent()) {
      // venture-decisions, not venture-head: this is state's own failure, and
      // venture-decisions is the state-derived box this screen leans on most -
      // the same reason a state failure on the day's own page (below) lands in
      // status-strip rather than in some other box that happened to fail.
      // venture-head is reserved for a failure in the venture fetch itself, so
      // the two can never overwrite each other.
      const box = ventureId ? $("venture-decisions") : $("status-strip");
      box.innerHTML = '<p class="err">' + esc(failureText(error)) + "</p>";
    }
  }

  if (ventureId) {
    try {
      const fetchedVenture = await venturePromise;
      if (isCurrent()) {
        venture = fetchedVenture;
        renderVenture(venture);
      }
    } catch (error) {
      if (isCurrent()) $("venture-head").innerHTML = '<p class="err">' + esc(failureText(error)) + "</p>";
    }
  } else {
    venture = null;
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
`;
