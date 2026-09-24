/**
 * renderTimeline and the two module-level variables that let a re-render
 * put an open day back the way it was. The click listener that opens and
 * closes it is decisions-actions.ts - see that file for why.
 */

export const TIMELINE_SCRIPT = `// What is open in the timeline, so the 30-second poll's re-render can put it
// back instead of closing it.
let openTimelineDate = "";
let openTimelineHtml = "";
/**
 * Which account's own history the two lines above belong to.
 *
 * renderVenture() splices openTimelineHtml into whatever account it is
 * currently drawing, with no other check that it is still the account that
 * fetched it. Without this, opening a day on one account and navigating to
 * another before closing it - a plain navigation, not a race - painted the
 * first account's cycle read-back under the second account's own history
 * card. Compared before openTimelineHtml is ever used, never after.
 */
let openTimelineVentureId = "";

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

`;
