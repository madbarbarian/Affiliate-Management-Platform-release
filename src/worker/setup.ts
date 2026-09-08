/**
 * The page a licensee sees before they have configured anything.
 *
 * The Worker boots on the example config when the fork has none of its own,
 * and serves this instead of running a stranger's example account. It is the
 * first screen of the onboarding design (`docs/_drafts/design/onboarding/`),
 * reduced to what actually exists: where to put the config, and what is already
 * working.
 *
 * Written for the licensee, in です・ます, like every other screen.
 */

export type SetupState = {
  /** True once a real config is bundled - then this page is not served at all. */
  readonly configured: boolean;
  /** Why the config could not be used, when there is one and it is broken. */
  readonly problem?: string;
  readonly hasDatabase: boolean;
  readonly hasModelKey: boolean;
  readonly hasConsoleToken: boolean;
  /** Where this Worker is answering, so the page can show the real address. */
  readonly address: string;
};

export function renderSetup(state: SetupState): string {
  const check = (ok: boolean, yes: string, no: string): string =>
    ok ? `<li class="ok"><b>できています</b> — ${yes}</li>` : `<li class="todo"><b>まだです</b> — ${no}</li>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>セットアップ</title>
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
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .lede { color: var(--muted); font-size: 15px; margin: 0 0 24px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  ol, ul { margin: 0; padding-left: 22px; }
  li { margin-bottom: 8px; }
  li:last-child { margin-bottom: 0; }
  ul { list-style: none; padding-left: 0; }
  .ok { color: var(--accent); }
  .todo { color: var(--muted); }
  .ok b, .todo b { font-size: 13px; margin-right: 6px; }
  code { background: #f0f0ec; border-radius: 5px; padding: 1px 6px; font-size: 14px; }
  .addr { word-break: break-all; font-size: 14px; color: var(--muted); }
  .warn { border-color: var(--danger); }
  .warn h2 { color: var(--danger); }
  footer { color: var(--muted); font-size: 13px; margin-top: 24px; }
</style>
</head>
<body>
<main>
  <h1>あと1つで、動き始めます</h1>
  <p class="lede">${
    state.configured
      ? "設定は入っています。下の「まだです」がひとつ残っているだけです。"
      : "置き場所はできました。まだ「何を書くアカウントなのか」が決まっていません。"
  }</p>

  ${
    state.problem
      ? `<section class="warn">
    <h2>設定を読み込めませんでした</h2>
    <p style="margin:0 0 8px">直したい箇所は次のとおりです。直して保存すると、1〜2分でこの画面が動き始めます。</p>
    <pre style="white-space:pre-wrap;margin:0;font:14px/1.7 inherit;color:var(--danger)">${escapeHtml(state.problem)}</pre>
  </section>`
      : ""
  }

  <section>
    <h2>いまの状態</h2>
    <ul>
      ${check(state.hasDatabase, "データの保管場所がつながっています", "データの保管場所が見つかりません。作り直しが要ります")}
      ${check(state.hasConsoleToken, "承認画面の合言葉が設定されています", "合言葉がありません。設定するまで、この画面は誰でも開けます")}
      ${check(state.hasModelKey, "AIモデルの鍵が入っています", "AIモデルの鍵はまだです。<b>いまはこれで構いません</b> — 練習用の文章で一巡できます")}
      ${check(state.configured, "設定が入っています", "設定がまだです（下の手順）")}
    </ul>
  </section>

  ${
    // Once the config is in, this section is a list of things already done -
    // and it reads as the reason the console has not opened, which sends the
    // licensee to re-copy a file that is not the problem.
    state.configured
      ? ""
      : `<section>
    <h2>設定を入れる</h2>
    <ol>
      <li>あなたの控え（GitHub のリポジトリ）を開きます</li>
      <li><code>platform.config.example.yaml</code> を <code>platform.config.yaml</code> という名前でコピーします</li>
      <li>いちばん上の <code>company:</code> と、<code>ventures:</code> の1つ目を、自分の言葉に直します</li>
      <li>保存します。1〜2分で、この画面が承認画面に変わります</li>
    </ol>
  </section>`
  }

  <section>
    <h2>ここが、あなたのアドレスです</h2>
    <p class="addr">${escapeHtml(state.address)}</p>
    <p style="margin:0 0 10px;font-size:14px;color:var(--muted)">
      投稿に入るリンクもここを通ります。<b>ドメインを用意する必要はありません。</b>
    </p>
    <p style="margin:0;font-size:14px">
      設定の <code>tracking:</code> にすでにある <code>baseUrl:</code> の行を、
      これに<b>書き換えて</b>ください（足すのではありません）。
      <b>書き換えるまで、リンクは押されても記録されません。</b>
    </p>
    <pre style="white-space:pre-wrap;margin:8px 0 0;font:14px/1.7 inherit;background:#f0f0ec;border-radius:8px;padding:10px 12px">  baseUrl: "${escapeHtml(state.address)}"</pre>
  </section>

  <footer>
    この画面は、設定が入っていないときだけ出ます。入ったあとは承認画面になります。
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
