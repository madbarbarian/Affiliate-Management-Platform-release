/**
 * The hand-over card's click listener: copying a part or comment, and
 * marking a post posted.
 */

export const HAND_OVER_ACTIONS_SCRIPT = `document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-hand-over-act]");
  if (!target) return;

  if (target.dataset.handOverAct === "copy") {
    const source = $(target.dataset.target);
    if (!source) return;
    const label = target.textContent;
    try {
      await navigator.clipboard.writeText(source.textContent);
      target.textContent = T["handOver.copied"];
      // The label goes back on its own. A button that stays reading "copied"
      // says nothing about the next press.
      setTimeout(() => { target.textContent = label; }, 2000);
    } catch {
      // Clipboard access is refused outside a secure context, which is exactly
      // where a licensee running this on a plain http address will be. The text
      // is on the screen either way, so this says how to get it.
      notice(T["handOver.copyFailed"], "warn");
    }
    return;
  }

  const postId = target.dataset.post;
  if (posting.has(postId)) return;
  // Asked, not assumed. The URL is only obtainable in the seconds after
  // posting, and cancelling the prompt must not cancel the record - the post is
  // live by then, and nothing else on this page can say so.
  const url = window.prompt(T["handOver.urlPrompt"], "") ?? "";
  posting.add(postId);
  target.disabled = true;
  target.textContent = T["handOver.sending"];
  try {
    await api("/api/posts/" + encodeURIComponent(postId) + "/posted", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    posting.delete(postId);
    await load();
  } catch (error) {
    posting.delete(postId);
    const box = $("hoerr-" + postId);
    if (box) box.textContent = failureText(error);
    target.disabled = false;
    target.textContent = T["handOver.done"];
  }
});

`;
