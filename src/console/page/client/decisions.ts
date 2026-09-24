/**
 * The ideas/publishing gate: the draft each decision is built from, which
 * 「開く」 panels stay open across a re-render, and renderDecision itself.
 * move() (item reordering) and the click listener that answers a gate are
 * elsewhere (decisions-reorder.ts, decisions-actions.ts) - they sit between
 * unrelated sections in the original page and moving them here too would
 * give this file more than one template literal.
 */

export const DECISIONS_SCRIPT = `function ensureDraft(decision) {
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
`;
