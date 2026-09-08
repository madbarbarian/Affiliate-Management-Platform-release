/**
 * The approval console's single page.
 *
 * Deliberately one file with no build step and no framework. The operator's
 * whole job is two clicks a day; the tooling around those two clicks should
 * not need a bundler, a lockfile, or a deploy.
 */

export function renderPage(options: { companyName: string }): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.companyName)} — 承認画面</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --panel: #ffffff; --ink: #1a1a19; --muted: #6b6b66;
    --line: #e4e4e0; --accent: #2f6f4f; --accent-ink: #ffffff;
    --warn: #8a5a00; --danger: #a13a2a; --chip: #f0f0ec;
    --radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --panel: #1e1e23; --ink: #ececea; --muted: #9a9a96;
      --line: #33333a; --accent: #6fbf8f; --accent-ink: #14231a;
      --warn: #e0b060; --danger: #e0806a; --chip: #2a2a31;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.65 ui-sans-serif, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
  }
  header {
    padding: 18px 20px; border-bottom: 1px solid var(--line);
    display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap;
    position: sticky; top: 0; background: var(--bg); z-index: 5;
  }
  h1 { font-size: 17px; margin: 0; font-weight: 650; }
  .muted { color: var(--muted); font-size: 13px; }
  main { max-width: 860px; margin: 0 auto; padding: 20px 16px 80px; }
  section { margin-bottom: 34px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 0 0 12px; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 14px 16px; margin-bottom: 10px;
  }
  .item { display: flex; gap: 12px; align-items: flex-start; }
  .item input[type=checkbox] { margin-top: 5px; width: 17px; height: 17px; flex: none; }
  .item-body { flex: 1; min-width: 0; }
  .title { font-weight: 600; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .chip {
    background: var(--chip); border-radius: 999px; padding: 2px 9px;
    font-size: 12px; color: var(--muted);
  }
  .chip.warn { color: var(--warn); }
  .chip.danger { color: var(--danger); }
  details { margin-top: 8px; }
  summary { cursor: pointer; font-size: 13px; color: var(--muted); }
  pre {
    white-space: pre-wrap; word-break: break-word; background: var(--bg);
    border: 1px solid var(--line); border-radius: 8px; padding: 10px; font-size: 13px;
    margin: 8px 0 0;
  }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
  button {
    font: inherit; padding: 8px 15px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--panel); color: var(--ink); cursor: pointer;
  }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; font-weight: 600; }
  button:disabled { opacity: .5; cursor: default; }
  .order { display: flex; gap: 4px; align-items: center; }
  .order button { padding: 2px 9px; line-height: 1.4; }
  .rank { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 13px; min-width: 1.6em; }
  .empty { color: var(--muted); font-size: 14px; }
  .err { color: var(--danger); font-size: 13px; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; }
  /* The exact text going out, shown at the publishing gate without a click. */
  pre.post { background: var(--panel); border-color: var(--accent); line-height: 1.7; font-size: 14px; }
  .pr-ok { color: var(--accent); font-size: 12px; margin-top: 6px; }
  .pr-missing { color: var(--danger); font-size: 13px; font-weight: 600; margin-top: 6px; }
  .pr-none { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .stopped { border-color: var(--danger); border-left-width: 3px; margin-bottom: 22px; }
  .stopped b { color: var(--danger); }
  .stopped code { background: var(--chip); border-radius: 5px; padding: 1px 5px; font-size: 12px; }
  .stat-row { display: flex; gap: 22px; flex-wrap: wrap; }
  .stat b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(options.companyName)}</h1>
  <span class="muted" id="subtitle">読み込み中…</span>
  <span style="flex:1"></span>
  <button id="refresh">更新</button>
</header>
<main>
  <div id="stopped"></div>

  <section id="decisions">
    <h2>あなたの判断待ち</h2>
    <div id="decision-list"><p class="empty">読み込み中…</p></div>
  </section>

  <section>
    <h2>予約中の投稿</h2>
    <div id="upcoming"></div>
  </section>

  <section id="portfolio-section">
    <h2>全アカウント — 直近30日</h2>
    <p class="muted">非アクティブにすると、そのアカウントは動かず、投稿も出ません。学んだこと・履歴・成果はそのまま残り、いつでも再開できます。削除ではありません。</p>
    <div id="portfolio"></div>
  </section>

  <section id="proposals-section">
    <h2>探索の提案 — 週に1回の判断</h2>
    <div id="proposals"></div>
  </section>

  <section>
    <h2>直近の数字</h2>
    <div id="stats"></div>
  </section>

  <section>
    <h2>最近の動き</h2>
    <div id="activity"></div>
  </section>
</main>

<script type="module">
const $ = (id) => document.getElementById(id);
let state = null;
/** decisionId -> { selected: Set<string>, order: string[] } */
const draft = new Map();

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || ("HTTP " + response.status));
  }
  return response.status === 204 ? null : response.json();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function ensureDraft(decision) {
  if (draft.has(decision.id)) return draft.get(decision.id);
  const recommended = decision.items.filter((i) => i.recommended).map((i) => i.id);
  const entry = {
    selected: new Set(decision.preselect ? recommended : []),
    order: decision.items.map((i) => i.id),
  };
  draft.set(decision.id, entry);
  return entry;
}

function renderDecision(decision) {
  const entry = ensureDraft(decision);
  const ordered = entry.order
    .map((id) => decision.items.find((i) => i.id === id))
    .filter(Boolean);

  const items = ordered.map((item, index) => {
    const checked = entry.selected.has(item.id);
    const rank = checked ? [...entry.order.filter((id) => entry.selected.has(id))].indexOf(item.id) + 1 : "";
    const chips = (item.chips ?? []).map((chip) =>
      '<span class="chip ' + esc(chip.tone ?? "") + '">' + esc(chip.label) + "</span>").join("");
    return \`
      <div class="card">
        <div class="item">
          <input type="checkbox" data-act="toggle" data-decision="\${esc(decision.id)}" data-item="\${esc(item.id)}" \${checked ? "checked" : ""}>
          <div class="item-body">
            <div class="title">\${esc(item.title)}</div>
            <div class="muted">\${esc(item.summary)}</div>
            <div class="chips">\${chips}</div>
            \${item.post ? '<pre class="post">' + esc(item.post) + "</pre>" : ""}
            \${item.post ? (item.disclosure
              ? '<div class="pr-ok">PR表記あり ' + esc(item.disclosure) + '</div>'
              : item.hasOffer
                ? '<div class="pr-missing">PR表記が入っていません。承認する前に理由を確かめてください。</div>'
                : '<div class="pr-none">案件なし。PR表記は要りません</div>') : ""}
            \${item.preview ? '<details><summary>' + (item.post ? "根拠・指摘・コメント下書き" : "本文を見る") + '</summary><pre>' + esc(item.preview) + "</pre></details>" : ""}
          </div>
          <div class="order">
            <span class="rank">\${rank}</span>
            <button data-act="up" data-decision="\${esc(decision.id)}" data-item="\${esc(item.id)}" \${index === 0 ? "disabled" : ""}>↑</button>
            <button data-act="down" data-decision="\${esc(decision.id)}" data-item="\${esc(item.id)}" \${index === ordered.length - 1 ? "disabled" : ""}>↓</button>
          </div>
        </div>
      </div>\`;
  }).join("");

  const count = entry.selected.size;
  return \`
    <section>
      <h2>\${esc(decision.gateLabel)} — \${esc(decision.ventureName)}</h2>
      <p class="muted">\${esc(decision.question)} 最大 \${decision.max} 件。上から順に投稿されます。</p>
      \${items}
      <div class="row">
        <button class="primary" data-act="submit" data-decision="\${esc(decision.id)}" \${count === 0 ? "disabled" : ""}>
          \${count} 件を承認して進める
        </button>
        <button data-act="all" data-decision="\${esc(decision.id)}">推奨をすべて選ぶ</button>
        <button data-act="none" data-decision="\${esc(decision.id)}">今日は全部見送る</button>
      </div>
      <div class="err" id="err-\${esc(decision.id)}"></div>
    </section>\`;
}

function render() {
  if (!state) return;
  $("subtitle").textContent =
    state.pending.length > 0
      ? state.pending.length + " 件の判断待ち"
      : "判断待ちはありません";

  // A stop belongs above everything, including the decisions: approving while
  // stopped is refused, and finding that out by pressing the button is a worse
  // way to learn it.
  const stopped = state.stopped ?? [];
  $("stopped").innerHTML = stopped.map((stop) =>
    '<div class="card stopped">' +
      "<b>" + (stop.scope === "all" ? "停止中 — 何も動かず、何も投稿されません" : "停止中 — " + esc(stop.label ?? stop.scope)) + "</b>" +
      '<div class="muted">' + esc(stop.at) + " ・ " + esc(stop.by) + " ・ " + esc(stop.reason) + "</div>" +
      '<div class="muted">再開するには <code>' +
        (stop.scope === "all" ? "amp resume" : "amp resume --venture " + esc(stop.scope)) +
      "</code> を実行してください。</div>" +
    "</div>").join("");

  $("decision-list").innerHTML = state.pending.length === 0
    ? '<p class="empty">今のところ何もありません。次のサイクルが回るとここに出ます。</p>'
    : state.pending.map(renderDecision).join("");

  $("upcoming").innerHTML = state.upcoming.length === 0
    ? '<p class="empty">予約中の投稿はありません。</p>'
    : '<table><thead><tr><th>時刻</th><th>状態</th><th>冒頭</th></tr></thead><tbody>' +
      state.upcoming.map((post) =>
        "<tr><td>" + esc(post.at) + "</td><td>" + esc(post.status) + "</td><td>" + esc(post.hook) + "</td></tr>").join("") +
      "</tbody></table>";

  const portfolio = state.portfolio ?? { rows: [] };
  // The operator's language, from the step name. The reason itself lives in
  // "doctor", which is English and written for a terminal.
  const measurementStepLabel = (step) => ({
    publish: "投稿がチャネルに届いていません",
    engagement: "チャネルから数字が返ってきません",
    link: "読者がリンクをたどれません（tracking.baseUrl）",
    conversion: "ASPから成果が返ってきません",
    revenue: "成果に金額がつきません",
  }[step] || step);

  const stateCell = (row) => {
    if (row.state === "stopped") {
      return '<span class="chip danger">停止中</span>' + (row.deactivated ? '<div class="muted">非アクティブでもあります</div>' : "");
    }
    if (row.state === "deactivated") {
      return '<span class="chip">非アクティブ</span><div class="muted">' + esc(row.deactivated?.by ?? "") +
        (row.deactivated?.reason ? " ・ " + esc(row.deactivated.reason) : "") + "</div>";
    }
    if (row.state === "inactive") return '<span class="chip">設定で無効</span>';
    return "稼働中";
  };
  const switchCell = (row) => {
    if (row.state === "inactive") return '<span class="muted">設定ファイルで active: true にする</span>';
    // Shown while stopped too: a stop and a deactivation are different
    // decisions, and one must not hide the other's undo.
    return row.state === "deactivated" || row.deactivated
      ? '<button data-venture-act="activate" data-venture="' + esc(row.ventureId) + '">再開する</button>'
      : '<button data-venture-act="deactivate" data-venture="' + esc(row.ventureId) + '">非アクティブにする</button>';
  };
  $("portfolio").innerHTML =
    '<div style="overflow-x:auto"><table><thead><tr><th>アカウント</th><th>状態</th><th>直近サイクル</th>' +
    "<th>投稿</th><th>中央値</th><th>クリック</th><th>成果</th><th>確定報酬</th><th>型</th><th>計測</th><th></th></tr></thead><tbody>" +
    portfolio.rows.map((row) =>
      "<tr><td>" + esc(row.name) + '<div class="muted">' + esc(row.ventureId) + "</div>" +
        (row.review ? '<div class="chip warn" style="display:inline-block;margin-top:4px">見直し候補</div><div class="muted">' + esc(row.review) + "</div>" : "") + "</td>" +
      "<td>" + stateCell(row) +
        (row.pendingDecisions > 0 ? '<div class="muted">判断待ち ' + row.pendingDecisions + "</div>" : "") + "</td>" +
      "<td>" + esc(row.lastCycle) + "</td><td>" + row.posts + "</td><td>" + row.medianScore + "</td>" +
      "<td>" + row.clicks + "</td><td>" + row.conversions + "</td><td>" + esc(row.approved) + "</td>" +
      "<td>" + esc(row.playbook) + "</td>" +
      "<td>" + (row.measurement === "closed"
        ? "閉じている"
        : '<span class="chip warn">未完成</span>' +
          // Which step is open, not just that one is. There is no terminal to
          // run "doctor" in when this is deployed to a host. (No backticks in
          // here: this file is one big template literal.)
          (row.measurementStep ? '<div class="muted">' + esc(measurementStepLabel(row.measurementStep)) + "</div>" : "")) + "</td>" +
      "<td>" + switchCell(row) + '<div class="err" id="verr-' + esc(row.ventureId) + '"></div></td></tr>').join("") +
    "</tbody></table></div>";

  const proposals = state.proposals ?? [];
  $("proposals").innerHTML = proposals.length === 0
    ? '<p class="empty">提案はありません。<code>amp scout</code> で探索担当に次のアカウント候補を出させられます。</p>'
    : proposals.map(renderProposal).join("");

  $("stats").innerHTML = '<div class="card stat-row">' + state.stats.map((stat) =>
    '<div class="stat"><b>' + esc(stat.value) + "</b><span class=\\"muted\\">" + esc(stat.label) + "</span></div>").join("") + "</div>";

  $("activity").innerHTML = state.activity.length === 0
    ? '<p class="empty">まだ記録がありません。</p>'
    : '<div class="card">' + state.activity.map((entry) =>
        '<div class="muted">' + esc(entry.at) + " · " + esc(entry.actor) + "</div><div>" + esc(entry.summary) + "</div>").join("<hr style=\\"border:none;border-top:1px solid var(--line);margin:8px 0\\">") + "</div>";
}

function renderProposal(proposal) {
  // The server carries the block for a week after acceptance, so it survives
  // the thirty-second poll and a reload. "amp scout show <id>" has it after.
  const accepted = proposal.status === "accepted" ? proposal.block : undefined;
  return \`
    <div class="card">
      <div class="title">\${esc(proposal.niche)}</div>
      <div class="muted">\${esc(proposal.audience)}</div>
      <div class="chips">
        <span class="chip">\${esc(proposal.market)}</span>
        <span class="chip">\${esc(proposal.category)}</span>
        <span class="chip">\${proposal.offerIds.length > 0 ? "案件 " + esc(proposal.offerIds.join(", ")) : "この市場に使える案件なし"}</span>
        <span class="chip">\${esc(proposal.createdAt)}</span>
      </div>
      <p><b>名前の候補</b> \${esc(proposal.nameCandidates.join(" / "))}</p>
      <p><b>仮説</b> \${esc(proposal.hypothesis)}</p>
      <p class="muted"><b>根拠</b> \${esc(proposal.evidence)}</p>
      <p><b>リスク</b> \${esc(proposal.risk)}</p>
      <p><b>最初の3本</b><br>\${proposal.firstHooks.map((hook) => "「" + esc(hook) + "」").join("<br>")}</p>
      <p><b>やめる条件</b> \${esc(proposal.killSignal)}</p>
      \${accepted
        ? (proposal.appended
            ? '<div class="pr-ok">採用しました。このブロックを設定ファイルの ventures: の下に active: false で追記しました（元のファイルは .amp/config-backups/ に控えがあります）。文体を読んで直し、active: true にして、デーモンを再起動してください。それまで何も動きません。'
            : '<div class="pr-missing">採用しましたが、設定ファイルには追記できていません。下のブロックを platform.config.yaml の ventures: の下に手で貼ってください。')
          + 'あとで見るには <code>amp scout show ' + esc(proposal.id) + '</code>。</div><pre>' + esc(accepted) + "</pre>"
        : \`<div class="row">
            <button class="primary" data-proposal-act="accept" data-proposal="\${esc(proposal.id)}">採用する</button>
            <button data-proposal-act="dismiss" data-proposal="\${esc(proposal.id)}">見送る</button>
          </div>\`}
      <div class="err" id="perr-\${esc(proposal.id)}"></div>
    </div>\`;
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-proposal-act]");
  if (!target) return;
  const proposalId = target.dataset.proposal;
  const act = target.dataset.proposalAct;
  target.disabled = true;
  try {
    const result = await api("/api/proposals/" + encodeURIComponent(proposalId) + "/" + act, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await load();
    if (act === "accept" && result && result.written === false) {
      // The card itself says "not appended" from the server's record; this
      // adds the reason for as long as the page is open.
      const box = $("perr-" + proposalId);
      if (box) box.textContent = "追記できなかった理由: " + (result.writeError ?? "");
    }
  } catch (error) {
    const box = $("perr-" + proposalId);
    if (box) box.textContent = String(error.message ?? error);
    target.disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-venture-act]");
  if (!target) return;
  const ventureId = target.dataset.venture;
  const act = target.dataset.ventureAct;
  let note = "";
  if (act === "deactivate") {
    // The reason is what the portfolio shows next to the account for as long
    // as it is off, and what the audit log keeps. Optional, but asked for.
    note = window.prompt("このアカウントを非アクティブにします。動かず、投稿も出ませんが、データは全部残り、いつでも再開できます。理由（任意）:", "") ?? null;
    if (note === null) return;
  }
  target.disabled = true;
  try {
    const result = await api("/api/ventures/" + encodeURIComponent(ventureId) + "/" + act, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
    await load();
    if (act === "deactivate" && result && (result.heldApproved > 0 || result.beyondRecall > 0)) {
      const box = $("verr-" + ventureId);
      if (box) {
        box.textContent =
          (result.heldApproved > 0 ? "承認済み " + result.heldApproved + " 件は保留され、再開時に出ます。" : "") +
          (result.beyondRecall > 0 ? " チャネル側の予約に渡った " + result.beyondRecall + " 件は、このままだと出ます。チャネル側で消してください。" : "");
      }
    }
  } catch (error) {
    const box = $("verr-" + ventureId);
    if (box) box.textContent = String(error.message ?? error);
    target.disabled = false;
  }
});

function move(entry, itemId, delta) {
  const index = entry.order.indexOf(itemId);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= entry.order.length) return;
  const [removed] = entry.order.splice(index, 1);
  entry.order.splice(target, 0, removed);
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-act]");
  if (!target) return;
  const act = target.dataset.act;
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
    target.disabled = true;
    target.textContent = "送信中…";
    try {
      const ordering = entry.order.filter((id) => entry.selected.has(id));
      await api("/api/decisions/" + encodeURIComponent(decisionId) + "/resolve", {
        method: "POST",
        body: JSON.stringify({ selectedIds: ordering, ordering }),
      });
      draft.delete(decisionId);
      await load();
    } catch (error) {
      const box = $("err-" + decisionId);
      if (box) box.textContent = String(error.message ?? error);
      target.disabled = false;
      render();
    }
  }
});

async function load() {
  try {
    state = await api("/api/state");
    render();
  } catch (error) {
    $("decision-list").innerHTML = '<p class="err">' + esc(error.message ?? error) + "</p>";
  }
}

$("refresh").addEventListener("click", load);
load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
