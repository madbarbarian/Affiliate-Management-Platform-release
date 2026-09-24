/**
 * Click listeners for a single account (activate/deactivate, run today's
 * cycle) and for the whole-platform emergency stop (resume). Contiguous in
 * the original page; renderVenture and the rest of the account screen are
 * venture.ts.
 */

export const VENTURE_ACTIONS_SCRIPT = `document.addEventListener("click", async (event) => {
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
  // id. Independent of runningVentureIds below, which answers a different
  // question - not "is this still the right account" but "is this account's
  // own run already in flight", and has to keep working after the operator
  // navigates away from the account it is running, not stop working here.
  if (ventureId !== routedVentureId()) return;
  // The guard that actually holds. Greying the button is what the operator
  // sees, but it sits on a button the poll replaces every thirty seconds, and
  // it is not what stops a second POST - this is. A run whose response was lost
  // is still a run in flight, and a second one is what the orchestrator then
  // has to reconcile.
  if (runningVentureIds.has(ventureId)) return;
  // A real day makes six model calls and can take minutes. The label is the
  // only thing telling the operator that it is working rather than stuck.
  const label = target.textContent;
  // In a variable, not only on the button. The thirty-second poll rebuilds
  // this card while the run is still going, and the fresh button came back
  // enabled and reading 今日のサイクルを動かす - so the operator, told nothing
  // was happening, pressed it again. That is the second caller the
  // orchestrator now has to join.
  runningVentureIds.add(ventureId);
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
      runningVentureIds.delete(ventureId);
      // Clearing the flag first, so this render is what puts the button back.
      await load();
      return;
    }

    runningVentureIds.delete(ventureId);
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
    //
    // Deletes only this account's own entry. A Set, not a scalar, because
    // clearing it unconditionally here would release every other account's
    // in-flight fact too, the moment any one of their handlers threw -
    // outdoor3 finishing (or failing) must never repaint outdoor2's button.
    if (runningVentureIds.has(ventureId)) {
      runningVentureIds.delete(ventureId);
      notice(T["wait.tooLong"], "warn");
      await load();
    }
  }
});

`;
