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
    const box = ventureId ? $("venture-head") : $("status-strip");
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
`;
