/**
 * renderHandOver: the card for a post the platform composed and cannot
 * publish itself. Its click listener (copy / mark done) is
 * hand-over-actions.ts - the two are not adjacent in the original page.
 */

export const HAND_OVER_SCRIPT = `function renderHandOver(post) {
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

`;
