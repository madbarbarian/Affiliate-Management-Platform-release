/**
 * The single delegated click listener that answers the ideas/publishing gate
 * (toggle/up/down/select-recommended/reject-all/submit) - and, because the
 * original page shares one listener between it and the timeline's
 * open/close toggle, that too. They cannot be split across files without
 * splitting one function's body, which would stop the page from being
 * byte-identical to main.
 */

export const DECISIONS_ACTIONS_SCRIPT = `document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-act]");
  if (!target) return;
  const act = target.dataset.act;

  // Handled before the decision lookup below, which returns early for anything
  // without a data-decision. This one belongs to a date, not to a gate.
  if (act === "timeline") {
    const ventureId = routedVentureId();
    const box = $("timeline");
    const already = openTimelineVentureId === ventureId && openTimelineDate === target.dataset.date;
    openTimelineVentureId = ventureId;
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
      // The venture check is the same guard for a navigation instead of a
      // second click: this fetch is still for the account that started it,
      // whatever account is routed by the time it answers.
      if (target.dataset.date !== openTimelineDate || ventureId !== openTimelineVentureId) return;
      openTimelineHtml = renderTimeline(day);
    } catch (error) {
      if (target.dataset.date !== openTimelineDate || ventureId !== openTimelineVentureId) return;
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

`;
