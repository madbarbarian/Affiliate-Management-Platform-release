/**
 * The passphrase, asked for on the page instead of in the address.
 *
 * Both 401 screens used to say the same thing: put the passphrase in
 * `?token=…`. The deploy screen tells the licensee to make one with a password
 * manager's generator, and what that produces contains `+`, `#`, `&`, `%` or a
 * space - none of which survive the trip. `+` arrives as a space, `#` truncates
 * everything after it, `&` starts another parameter. The passphrase was correct
 * and was refused, and the page said only that a passphrase was required, so
 * the obvious move was to paste the same one again.
 *
 * A form posts it in a body, where the browser encodes it properly and nobody
 * has to edit a URL. The licensee has no terminal (requirements 3.1), so this
 * is the only way in that does not assume one.
 *
 * Written for them, in です・ます, with the same palette and card as
 * `src/worker/setup.ts`: these are the two pages they meet before anything
 * works, and they should look like one product.
 */

/** Where the form posts. Both gates answer it, so neither spells it itself. */
export const UNLOCK_PATH = "/unlock";

/** Shown when a passphrase was tried and did not match. */
export const UNLOCK_MISMATCH = "合言葉が違いました。もう一度入力してください。";

export type UnlockState = {
  /** Where to go once it matches. Already reduced by `safeNext`. */
  readonly next: string;
  /** What went wrong last time, when something did. */
  readonly problem?: string;
};

/**
 * A path on this site, or `/`.
 *
 * The page that takes a passphrase is exactly the page an open redirect is
 * worth having: it is where somebody arrives already willing to type a secret,
 * and a link that sent them on to a copy of it afterwards would be believed.
 * So only a value that starts with a single `/` is kept. A backslash goes too,
 * because browsers read `/\evil.example` as scheme-relative, and so do control
 * characters, which would otherwise be a second header on the way out.
 */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  // Written as escapes rather than the characters themselves: a literal NUL in
  // the source makes git call this file binary, and a file whose diff cannot be
  // read is a file nobody reviews.
  if (/[\\\x00-\x1f\x7f]/.test(value)) return "/";
  return value;
}

export type UnlockSubmission = {
  /** Exactly what was typed. Compared, never rendered back into the page. */
  readonly token: string;
  readonly next: string;
};

/**
 * What the form said.
 *
 * `URLSearchParams` is the one decode, and it is the right one for a form body:
 * a browser sends a literal `+` as `%2B` there, so it comes back a `+`. That is
 * the whole difference from `?token=`, where the licensee types the passphrase
 * themselves and a `+` is already a space by the time anything reads it.
 */
export function readUnlockSubmission(body: string): UnlockSubmission {
  const form = new URLSearchParams(body);
  return { token: form.get("token") ?? "", next: safeNext(form.get("next")) };
}

export function renderUnlock(state: UnlockState): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>合言葉</title>
<style>
  :root {
    --bg: #fbfbfa; --panel: #ffffff; --ink: #1a1a19; --muted: #6b6b66;
    --line: #e4e4e0; --accent: #2f6f4f; --danger: #a13a2a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--ink);
    font: 16px/1.7 ui-sans-serif, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
  }
  main { max-width: 480px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .lede { color: var(--muted); font-size: 15px; margin: 0 0 24px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  label { display: block; margin-bottom: 18px; }
  .lab { display: block; font-weight: 600; font-size: 15px; }
  .help { display: block; color: var(--muted); font-size: 13px; margin: 2px 0 6px; }
  input {
    font: inherit; width: 100%; padding: 9px 11px; border: 1px solid var(--line);
    border-radius: 8px; background: var(--bg); color: var(--ink);
  }
  button {
    font: inherit; font-weight: 600; padding: 10px 20px; border-radius: 8px;
    border: 0; background: var(--accent); color: #fff; cursor: pointer;
  }
  .formerr {
    border: 1px solid var(--danger); border-radius: 8px; padding: 12px 14px;
    margin-bottom: 18px; color: var(--danger); font-size: 14px;
  }
  footer { color: var(--muted); font-size: 13px; margin-top: 24px; }
</style>
</head>
<body>
<main>
  <h1>合言葉を入力してください</h1>
  <p class="lede">この画面は、合言葉を知っている人だけが開けます。</p>
  <section>
    ${state.problem ? `<div class="formerr">${escapeHtml(state.problem)}</div>` : ""}
    <form method="post" action="${UNLOCK_PATH}">
      <input type="hidden" name="next" value="${escapeHtml(state.next)}">
      <label>
        <span class="lab">合言葉</span>
        <span class="help">
          設定したものを、そのまま貼り付けてください。
          <b>記号や空白が入っていても、そのままで届きます。</b>
        </span>
        <input type="password" name="token" autocomplete="current-password" autofocus>
      </label>
      <button type="submit">開く</button>
    </form>
  </section>
  <footer>
    一度入力すると、この端末では30日間そのまま開けます。
    合言葉をアドレスの末尾に付ける必要はありません。
  </footer>
</main>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
