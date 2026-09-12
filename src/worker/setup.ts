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
  /** Markets a venture can actually be opened in, given the offers that ship. */
  readonly markets?: readonly string[];
  /** What was typed, so a refused form comes back filled in rather than blank. */
  readonly answers?: Readonly<Record<string, string>>;
  /** Everything wrong with the answers, reported together. */
  readonly formProblem?: string;
  /** The finished file, once the answers made one. */
  readonly generated?: string;
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
  label { display: block; margin-bottom: 18px; }
  .lab { display: block; font-weight: 600; font-size: 15px; }
  .help { display: block; color: var(--muted); font-size: 13px; margin: 2px 0 6px; }
  input, textarea, select {
    font: inherit; width: 100%; padding: 9px 11px; border: 1px solid var(--line);
    border-radius: 8px; background: var(--bg); color: var(--ink);
  }
  textarea { resize: vertical; }
  button {
    font: inherit; font-weight: 600; padding: 10px 20px; border-radius: 8px;
    border: 0; background: var(--accent); color: #fff; cursor: pointer;
  }
  /* Every problem at once, above the fields, so one pass fixes the form. */
  .formerr {
    border: 1px solid var(--danger); border-radius: 8px; padding: 12px 14px;
    margin-bottom: 18px; color: var(--danger); font-size: 14px;
  }
  #conf {
    white-space: pre; overflow: auto; max-height: 50vh; background: #f0f0ec;
    border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.6; margin: 12px 0 0;
  }
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
      ${check(
        state.hasModelKey,
        "AIモデルの鍵が入っています",
        "AIモデルの鍵はまだです。<b>いまはこれで構いません</b> — 練習用の文章で一巡できます。" +
          // Asked for on the deploy screen, this would be a field nobody can
          // leave empty, so it is not asked for there at all. Which makes this
          // the only place a licensee is told where it goes - and they are
          // standing in a browser, not a terminal.
          "本物の文章にしたくなったら、Cloudflare の <b>Workers &amp; Pages → この Worker → Settings → " +
          "Variables and Secrets</b> で <code>ANTHROPIC_API_KEY</code> を足してください",
      )}
      ${check(state.configured, "設定が入っています", "設定がまだです（下の手順）")}
    </ul>
  </section>

  ${
    // Once the config is in, this section is a list of things already done -
    // and it reads as the reason the console has not opened, which sends the
    // licensee to re-copy a file that is not the problem.
    state.configured
      ? ""
      : state.generated
        ? renderResult(state.generated)
        : renderForm(state)
  }

  <section>
    <h2>ここが、あなたのアドレスです</h2>
    <p class="addr">${escapeHtml(state.address)}</p>
    <p style="margin:0 0 10px;font-size:14px;color:var(--muted)">
      投稿に入るリンクもここを通ります。<b>ドメインを用意する必要はありません。</b>
    </p>
    <p style="margin:0;font-size:14px">
      上のフォームで作った設定には、このアドレスが<b>すでに入っています</b>。
      書き換える必要はありません。
    </p>
  </section>

  <footer>
    この画面は、設定が入っていないときだけ出ます。入ったあとは承認画面になります。
  </footer>
</main>
</body>
</html>
`;
}

/**
 * The seven questions that turn the example into theirs.
 *
 * Deliberately only the ones that decide what gets written - who is approving,
 * and the account's subject, readers and voice. The model key, the channel token and the
 * offers are all later steps in `docs/2-setup/onboarding.md`, and every one of
 * them is a place to stop before knowing whether this is worth the trouble.
 */
function renderForm(state: SetupState): string {
  const markets = state.markets ?? ["jp"];
  const was = (name: string): string => escapeHtml(state.answers?.[name] ?? "");

  const field = (name: string, label: string, help: string, placeholder: string, long = false): string => `
    <label>
      <span class="lab">${label}</span>
      <span class="help">${help}</span>
      ${
        long
          ? `<textarea name="${name}" rows="2" placeholder="${escapeHtml(placeholder)}">${was(name)}</textarea>`
          : `<input name="${name}" value="${was(name)}" placeholder="${escapeHtml(placeholder)}">`
      }
    </label>`;

  return `<section>
    <h2>どんなアカウントですか</h2>
    <p style="margin:0 0 16px;font-size:14px;color:var(--muted)">
      答えると、設定ファイルができあがります。あとから直せます。
    </p>
    ${state.formProblem ? `<div class="formerr">${escapeHtml(state.formProblem).replace(/\n/g, "<br>")}</div>` : ""}
    <form method="post" action="/setup">
      ${field("companyName", "会社の名前", "承認画面のいちばん上に出ます", "みどり商店")}
      ${field("operatorName", "あなたのお名前", "承認するたびに、この名前が記録に残ります。<b>あとから書き換えられません</b>", "みどり")}
      ${field("ventureName", "アカウントの名前", "複数運用したときに見分けるための呼び名です", "コスメ")}
      ${field("ventureId", "アカウントの id", "半角英小文字・数字・ハイフン。<b>あとから変えられません</b>", "cosme")}
      ${field("niche", "何について書きますか", "狭いほどうまくいきます", "敏感肌向けのスキンケア", true)}
      ${field("audience", "誰に読ませますか", "年齢・状況・困っていること", "季節の変わり目に肌が荒れる30代。値段より成分を見る。", true)}
      ${field("persona", "書き手はどんな人ですか", "専門家より、当事者のほうが読まれます", "元美容部員。自分の肌で失敗してきた当事者。", true)}
      ${field("firstPerson", "一人称", "この言葉で全部の投稿が書かれます", "わたし")}
      <label>
        <span class="lab">読者がいる国</span>
        <span class="help">
          <b>広告のルールはここで決まります。</b>販売元の国ではなく、読む人の国です
          ${
            markets.length === 1
              ? "。いまは " + escapeHtml(markets[0] ?? "") +
                " だけ選べます — 同梱の案件がその市場向けだからです。他の国に出すには、その国を対象に含む案件を設定ファイルに足してください"
              : ""
          }
        </span>
        <select name="market">
          ${markets.map((m) => `<option value="${escapeHtml(m)}"${state.answers?.["market"] === m ? " selected" : ""}>${escapeHtml(m)}</option>`).join("")}
        </select>
      </label>
      <button type="submit">設定を作る</button>
    </form>
  </section>`;
}

/**
 * The finished file, and the one instruction that follows it.
 *
 * The Worker cannot save this - its filesystem is read only - so the licensee
 * carries it across by hand, once. `onboarding.md` argues that is not a
 * workaround: pasting it into their own repository is what makes it theirs, and
 * the paste is a push, and the push is a deploy.
 */
function renderResult(generated: string): string {
  return `<section>
    <h2>できました</h2>
    <p style="margin:0 0 14px;font-size:14px;color:var(--muted)">
      あとは、あなたのリポジトリに置くだけです。置き場所を教えてもらえれば、
      <b>ファイル名まで入った状態の作成画面</b>を開きます。
    </p>

    <label>
      <span class="lab">あなたのリポジトリのアドレス</span>
      <span class="help">
        Deploy したときにできたものです。GitHub で開いて、
        ブラウザのアドレス欄をそのまま貼ってください（例: <code>https://github.com/yourname/amp-midori</code>）
      </span>
      <input id="repo" placeholder="https://github.com/yourname/amp-midori">
    </label>

    <button type="button" id="go">コピーして、GitHub を開く</button>
    <p id="said" class="help" style="margin-top:10px"></p>

    <details style="margin-top:16px">
      <summary>アドレスが分からないときは</summary>
      <ol style="margin-top:10px">
        <li>下の「コピーだけ」を押します</li>
        <li>GitHub で、あなたの控えのリポジトリを開きます</li>
        <li><b>Add file → Create new file</b> を選びます</li>
        <li>ファイル名を <code>platform.config.yaml</code> にして、貼り付けます</li>
        <li><b>Commit changes</b> を押します</li>
      </ol>
      <button type="button" id="copy">コピーだけ</button>
    </details>

    <p style="margin:14px 0 0;font-size:14px;color:var(--muted)">
      置くと1〜2分で、この画面が承認画面に変わります。
      この内容は、あなたのリポジトリに入るまで<b>どこにも保存されません</b> —
      閉じてしまったら、もう一度答えれば同じものができます。
    </p>
    <pre id="conf">${escapeHtml(generated)}</pre>
  </section>
  <script>
  const conf = document.getElementById("conf");
  const said = document.getElementById("said");

  // Falls back to selecting the text. A clipboard write is refused on an
  // insecure origin and in some browsers without a gesture it recognises, and a
  // button that silently does nothing is worse than one that says "now copy".
  async function copy() {
    try {
      await navigator.clipboard.writeText(conf.textContent);
      return true;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(conf);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return false;
    }
  }

  document.getElementById("copy").addEventListener("click", async () => {
    const button = document.getElementById("copy");
    button.textContent = (await copy()) ? "コピーしました" : "選択しました。コピーしてください";
  });

  /**
   * Accepts what someone actually has in hand - the address bar, which may be
   * deep inside the repository - and reduces it to owner/name.
   */
  function ownerAndRepo(input) {
    const text = input.trim().replace(/^git@github\\.com:/, "https://github.com/").replace(/\\.git$/, "");
    const path = text.startsWith("http") ? text.replace(/^https?:\\/\\/[^/]+\\//, "") : text;
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    if (!/^[\\w.-]+$/.test(parts[0]) || !/^[\\w.-]+$/.test(parts[1])) return null;
    return parts[0] + "/" + parts[1];
  }

  document.getElementById("go").addEventListener("click", async () => {
    const repo = ownerAndRepo(document.getElementById("repo").value);
    if (!repo) {
      said.textContent = "アドレスを読み取れませんでした。https://github.com/… の形で貼ってください。";
      return;
    }
    const copied = await copy();
    said.innerHTML = copied
      ? "コピーしました。開いた画面で <b>貼り付け</b> → <b>Commit changes</b> を押してください。"
      : "内容を選択しました。<b>コピー</b>してから、開いた画面で貼り付けてください。";
    // GitHub's own editor, with the file already named. The content cannot come
    // along - its query strings cap out around 2KB and this file is twenty times
    // that - so the paste stays, but choosing "Create new file" and typing the
    // name do not. The write happens on GitHub, signed in as them: this page
    // holds no credential and asks for none.
    window.open("https://github.com/" + repo + "/new/main?filename=platform.config.yaml", "_blank", "noopener");
  });
  </script>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
