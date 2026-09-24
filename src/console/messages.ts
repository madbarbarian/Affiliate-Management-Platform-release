/**
 * Every word the console says, in one place, per language.
 *
 * The console was Japanese because it was written in Japanese - the strings
 * were in `ui.ts`, inside the HTML they were concatenated into, so changing the
 * language meant editing `src/`. That is the thing this project says a licensee
 * should never have to do to change something about their own operation.
 *
 * `ja` is the source of truth for the key set: `en` is typed as
 * `Record<keyof typeof ja, string>`, so a key added to one and not the other is
 * a compile error rather than a half-translated screen.
 *
 * **The screen's language is not the disclosure's language.** The disclosure,
 * the prohibited claims and the regulator all follow the reader's market
 * (`src/domain/market.ts`), never this setting. An operator reading the console
 * in English while publishing to Japanese readers must still publish
 * 「※PR・アフィリエイトリンクを含みます」, or the post breaks 景表法. Nothing in
 * this file is ever used for anything that reaches a reader.
 *
 * `{name}`-style placeholders are filled by the page's own `fmt`.
 */

import type { CommentPurpose } from "../core/types.ts";

export const LOCALES = ["ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];

const ja = {
  // Punctuation is language too: a Japanese screen separates with ・ and quotes
  // with 「」, and an English one does neither.
  "punct.sep": " ・ ",
  "punct.paren": "（{text}）",
  "punct.quote": "「{text}」",

  // Page furniture
  "page.titleSuffix": "承認画面",
  "page.loading": "読み込み中…",
  "page.refresh": "更新",
  // 誰として見ているかは、状態ではなく枠。承認のたびに変わる件数と同じ場所に
  // 置くと、両方とも読み飛ばされる。監査ログにこの名前が永久に残る以上、
  // 押す前に見えている必要がある。
  "page.operatorTitle": "この画面での承認者。承認の記録にこの名前が残ります",
  // 配色は運用の設定ではなく、その人のブラウザの設定。だから
  // platform.config.yaml ではなくこのボタンにあり、この端末にだけ残ります。
  // 既定の「自動」はOSに従います。合わないときに、押して決められます。
  "page.themeTitle": "画面の配色を切り替えます（自動・明るい・暗い）",
  "theme.auto": "配色：自動",
  "theme.light": "配色：明るい",
  "theme.dark": "配色：暗い",
  // 1日を読み返す入口。毎日の導線ではなく、「なぜこの案が出たのか」を
  // 知りたくなったときだけ開くもの。運用者の30秒は別の画面にある。
  "timeline.open": "この日を見る",
  "timeline.byHuman": "人が決めた",
  // 各段の時刻はアカウントの時計。どの時計かを1度だけ言う — 段ごとに
  // 添えると8回繰り返すことになる。
  "timeline.zone": "時刻は{zone}です",
  "nav.today": "今日",
  "nav.settings": "設定",

  // 会社ぜんたいの設定。読むだけ。とくに autonomy と llm.provider は、
  // 「いま何が起きているか」を決めるのに、これまで画面のどこにも出ていなかった。
  "settings.heading": "この会社の設定",
  "settings.lede": "いま何が効いているかを読む画面です。変更は設定ファイルで行います。",
  "settings.version": "いま動いているバージョン",
  // RELEASE.json が無い控え - このリポジトリを直接動かしている開発中のチェック
  // アウトなど。リリースを経由していないので、比べる相手も存在しない。
  "settings.versionUnknown": "正式なリリースではありません（開発用チェックアウト）",
  "settings.autonomy": "機械に任せている範囲",
  "settings.autonomyManual": "manual — 両方の判断であなたを待ちます（何も事前選択しません）",
  "settings.autonomyAssisted": "assisted — 両方の判断であなたを待ちます（推奨は選択済み）",
  "settings.autonomyAuto": "auto — 機械が両方を自分で決めます。あなたは止めることしかできません",
  "settings.model": "AIモデル",
  "settings.modelMock": "mock — 模擬です。<b>本物の文章ではありません</b>",
  "settings.modelReal": "{model} ・ 速い方は {fastModel} ・ effort {effort}",
  "settings.operator": "承認する人",
  "settings.operatorOne": "{name}（1人）",
  "settings.operatorMany": "{names}（{n}人）",
  "settings.disclosure": "開示文",
  "settings.disclosureOff": "<b>開示のチェックを外しています。</b>市場の規制に触れる可能性があります",
  // 市場ごとに解決される値（src/domain/market.ts）。日本向けと米国向けで
  // 開示文は違う言葉になり、件数も違う。1行に畳めないので、市場の名前を
  // 添えて市場ごとに並べる。
  "settings.disclosureRow": "{market}：{text}",
  "settings.limits": "1日の上限",
  "settings.limitsValue": "{posts}件まで ・ 最低{minutes}分あける ・ AIっぽさ{smell}点で止める",
  "settings.words": "止める言葉",
  "settings.wordsValue": "AIっぽい言い回し {banned} 件",
  // 使わない表現（prohibitedClaims）は会社全体の設定と市場ごとの設定を
  // 合わせた数で、市場によって違う。「止める言葉」の1行に押し込んでいた
  // ころは常に undefined 件になっていた — この行を読む先が
  // policy.prohibitedClaims のままで、その値は市場ごとの compliance[] に
  // 移した後も残っていなかったため。
  "settings.prohibitedClaims": "使わない表現（読者の市場ごと）",
  "settings.prohibitedClaimsRow": "{market}：{n} 件",
  "settings.tracking": "リンクの行き先",
  "settings.trackingBad": "<b>読者がたどれないアドレスです。</b>クリックは記録されません",
  "settings.scale": "規模",
  "settings.scaleValue": "アカウント {ventures} ・ 市場 {markets}",

  // The update notice. One muted line, never an alarm: the operator came here
  // to spend thirty seconds on two decisions, and this is the licensee's
  // business, not theirs. It is still at the top, because a notice nobody
  // scrolls to is the silence this exists to end.
  "update.available": "プラットフォームに更新があります（{version}）",
  "update.since": "いまお使いなのは {version} です",
  "update.what": "何が変わったか",
  "update.how": "取り込み方は、リポジトリの README に書いてあります。設定ファイルは上書きされません。",

  // The top page: which account is in what state, nothing account-specific
  // and actionable. decisions.md, 2026-09-23: with three accounts running,
  // the judgement itself no longer fits on this page - it moved to each
  // account's own screen (#/ventures/<id>), which already filtered to one
  // account's decisions before this row existed. What is left here has to
  // say, at a glance, which account needs a look and why.
  "status.heading": "アカウントの状態",
  "status.empty": "アカウントがありません。",
  // 通常の強さ：承認待ちは、押さなければ「機械が待つ」だけで、遅れても
  // 何かが消えるわけではない。
  "status.approvalsNeeded": "承認が要る（{n}）",
  // 強い表示：唯一「機械が特定の分に人を待っている」もの。枠を過ぎれば
  // その枠は消える。判断待ちより軽い扱いにしてはいけない
  // （decisions.md 2026-09-23「バッジは2種類にする」）。
  "status.handOverBadge": "いま投稿する番です",
  // 例外：console-architecture.md が既に「失敗だけは例外にする」と決めている。
  // 具体的な理由は failureCell() が failureCode から作る（このラベルは
  // 「何かが起きている」という事実だけを言う）。
  "status.failed": "失敗しています",

  // The account's own page (#/ventures/<id>). Filtered here rather than sent
  // pre-filtered: `state.pending` / `state.handOver` / `state.upcoming` are
  // one company-wide fetch, and the account screen and this page's own status
  // strip both read the same arrays so the two can never disagree.
  "today.decisionsEmpty": "今のところ何もありません。次のサイクルが回るとここに出ます。",
  "today.upcoming": "予約中の投稿",
  "today.upcomingEmpty": "予約中の投稿はありません。",
  "today.upcomingTime": "時刻",
  "today.upcomingStatus": "状態",
  "today.upcomingHook": "冒頭",
  // 状態は queued / approved / scheduled … というプラットフォーム側の識別子で、
  // それが日本語の画面にそのまま出ていた。表のセルは狭いので短く。
  // 対応は `labels.ts` の POST_STATUS_KEYS が持つ。
  "postStatus.queued": "順番待ち",
  "postStatus.approved": "承認済み",
  "postStatus.scheduled": "予約中",
  "postStatus.handedOver": "あなたの番",
  "postStatus.published": "公開済み",
  "postStatus.failed": "失敗",
  "postStatus.cancelled": "取り消し",

  // 自分で投稿するチャンネル。ここだけは、押さなければ何も起きません。
  // 文面は投稿時点でチャンネルが組み立てたものをそのまま出しています
  // （画面で作り直すと、実際に渡した文面とズレるため）。
  "handOver.heading": "あなたが投稿する番です",
  "handOver.lede": "この投稿は、あなたのアカウントから手で出してください。文面をコピーして、アプリを開いて、貼って投稿します。",
  "handOver.slot": "予定していた時刻：{at}",
  "handOver.part": "本文 {n}/{total}",
  "handOver.onePart": "本文",
  // 本文とコメントで8回の貼り付けになる日がある。どれを・いつ・どこへ貼るのかを
  // 画面が言わなければ、本文を1つの投稿につなぎ直したり、コメントを最後の本文に
  // ぶら下げたりする。どちらも実際のプラットフォームの組み立てと違う形になる。
  "handOver.order": "貼る順番",
  "handOver.orderFirst": "「{label}」を、新しい投稿として出します。",
  "handOver.orderRest": "残りの本文は、そのひとつ前の投稿への返信として、上から順に出します。連なった投稿になります。",
  "handOver.orderComments": "コメントは、2つめ以降の本文ではなく、どれも最初の投稿（「{label}」）への返信として、上から順に出します。",
  "handOver.orderLink": "アフィリエイトリンクは「{name}」のコメントだけに入っています。これを出さないと、この投稿からの報酬は記録されません。",
  "handOver.orderDone": "全部出し終えたら、下の「{button}」を押します。",
  "handOver.comment": "コメント {n}/{total}：{name}",
  // コメントの目的は self_reply / link_drop / objection / faq という
  // プラットフォーム側の識別子。画面に出す言葉はここで選ぶ。
  "handOver.purpose.self_reply": "補足",
  "handOver.purpose.link_drop": "リンクの案内",
  "handOver.purpose.objection": "反論への返答",
  "handOver.purpose.faq": "よくある質問への答え",
  "handOver.copy": "コピー",
  "handOver.copied": "コピーしました",
  "handOver.copyFailed": "コピーできませんでした。文面を選んで手でコピーしてください。",
  "handOver.open": "アプリを開く",
  "handOver.done": "投稿しました",
  "handOver.sending": "記録しています…",
  "handOver.urlPrompt": "投稿のURLがあれば貼ってください（空のままでもかまいません）",
  "handOver.noEngagement": "このチャンネルでは、いいね・返信は取得できません。クリックと報酬はこれまでどおり記録されます。",
  // 真下の「全アカウント — 直近{days}日」と同じ窓・同じ言い回し。旧い
  // 「直近の数字」は窓を名指ししておらず、隣り合う2つの見出しがどちらも
  // 「直近」とだけ読めた。
  "today.stats": "全アカウント合計 — 直近{days}日",
  "today.activity": "最近の動き",
  "today.activityEmpty": "まだ記録がありません。",
  "today.activityFailed": "{step}で止まりました — {reason}",
  "today.activityExpired": "{day} の判断は、答えのないまま日が変わりました",
  "today.activityClosed": "{day} の判断は、アカウントを止めたので閉じました",
  // 公開ではないので、公開と同じ見た目にしない。1つの投稿がこの欄に2回出る
  // （渡したとき・押したとき）以上、どちらがどちらか読めなければ意味がない。
  "today.activityHandedOver": "あなたが投稿する番です — {hook}",
  // `platform.resumed`. 誰が・いつは行の頭に既に出るので、ここは何が起きたかだけ。
  "today.activityResumed": "全体の停止を解除しました。",
  // Words the server renders. The router runs in the same process as this file
  // and reads it directly rather than shipping a second vocabulary: what a
  // screen says has to have one source, or console.locale becomes a promise
  // only half the page keeps.
  "gate.proposalLabel": "企画の承認",
  "gate.publishLabel": "投稿の承認と順番",
  "gate.questionProposal": "今日の企画のうち、どれを書きますか。",
  "gate.questionPublish": "どれを出しますか。順番も決めてください。",
  "stats.posts": "公開済み投稿",
  // There is no "engagement total" here on purpose - see router.ts's stats
  // array, where the number used to be, for why one is not coming back.
  "stats.clicks": "クリック",
  "stats.conversions": "成果",
  "stats.revenue": "確定報酬",
  "chip.expected": "予測 {n}",
  "chip.aiSmell": "AIっぽさ {n}",
  "chip.findings": "指摘 {n}",
  "run.busy": "いま自動でサイクルが動いています。終わるのを待ってから、もう一度押してください。",
  "preview.angle": "狙い",
  "preview.targetPain": "読者の悩み",
  "preview.promisedOutcome": "提供する結果",
  "preview.rationale": "根拠",
  "preview.risk": "リスク",
  "preview.slotReason": "枠の理由",
  "preview.comment": "コメント",
  "preview.finding": "指摘",


  // The stop
  "stop.all": "停止中 — 何も動かず、何も投稿されません",
  "stop.one": "停止中 — {label}",
  // No {command} here on purpose. This used to name `amp resume`, a terminal
  // command the licensee this screen is built for cannot run
  // (requirements.md §3.1: no shell is assumed). This account's own stop still
  // has no button - see the constraint against a per-venture resume in
  // docs/3-development/console-ux-proposal.md §6.2 - so this names what it is
  // about now that the whole-platform stop above it has one.
  "stop.howToResume": "このアカウントだけの停止を解除するボタンは、この画面にありません。全体を止めているときは上のボタンで解除できます。このアカウントだけの停止は、この仕組みを動かしている人に頼んでください。",
  // pause.ts's synthetic fail-closed record: nobody stopped anything, a slot
  // just could not be read, and it fails safe by reading as a stop. Its `reason`
  // is machine text for a log ("the stop file is not valid JSON — it was
  // treated as a stop"), so this replaces it rather than printing it.
  "stop.failClosedExplain": "状態を保存した場所（ファイルやデータベースの行）が読み込めなかったため、安全のため全体を停止として扱っています。実際に誰かが止めたわけではありません。再開すると、この状態は消えます。",
  "stop.resumeAll": "全体を再開する",
  "stop.resumeConfirmDetail": "{at}に{by}が理由「{reason}」で全体を止めました。",
  "stop.resumeConfirm": "本当にすべて再開しますか？",
  "stop.resumed": "再開しました。次のサイクルから通常どおり動きます。",
  "stop.resumeNothingToDo": "すでに動いています。何も変えていません。",

  // The two gates
  "gate.heading": "{gate} — {venture}",
  // The day is what tells two open gates apart. A day nobody approved leaves
  // its gate standing while the next one opens beside it, and without this the
  // two are the same sentence twice.
  "gate.day": "{day} の分",
  "gate.dayStale": "{day} の分 ・ この日はもう過ぎています",
  "gate.question": "{question} 最大 {max} 件。上から順に投稿されます。",
  // Shown when the cap is reached, beside the boxes that just closed. Without
  // it the screen looks broken rather than full.
  "gate.atMax": "{max} 件選びました。別のものにするには、どれかのチェックを外してください。",
  "gate.approve": "{n} 件を承認して進める",
  "gate.selectRecommended": "推奨をすべて選ぶ",
  "gate.rejectAll": "今日は全部見送る",
  "gate.sending": "送信中…",
  "gate.disclosurePresent": "PR表記あり",
  "gate.disclosureMissing": "PR表記が入っていません。承認する前に理由を確かめてください。",
  "gate.disclosureNotNeeded": "案件なし。PR表記は要りません",
  "gate.openPost": "根拠・指摘・コメント下書き",
  // At this gate the post does not exist yet - it is written after the ideas
  // are chosen. "本文を見る" promised the text and opened the reasoning, and the
  // first person through read the brief looking for the post.
  "gate.openIdea": "ねらいと根拠を見る",

  // 門の中を「推奨」と「そのほか」に割るための3つ。10案が同じ重さで並ぶと
  // 30秒では終わらない、という docs/3-development/console-ux-proposal.md §4.4
  // の実装。推奨が0件、または全件のときは分割せず、この3つは出さない。
  "gate.recommended": "推奨",
  "gate.recommendedWhy": "昨日までの実績から選びました。このまま承認できます。",
  "gate.others": "そのほかの{n}件を見る",

  // 「動かす」と「承認して進める」は、本物のモデルだと数分かかります。返事が
  // 来ないまま黙って元の画面に戻るのが、この画面がついた唯一の嘘でした。
  // 仕事そのものは一歩ごとに保存されているので、言うべきことは「まだ続いて
  // います」であって「何も起きませんでした」ではありません。
  "wait.stillRunning": "まだ動いています。この画面を閉じても処理は続きます。終わりしだい、画面はひとりでに新しくなります。",
  "wait.gateStillRunning": "承認は届きました。いま本文を書いています。この画面を閉じても処理は続きます。終わりしだい、画面はひとりでに新しくなります。",
  "wait.changed": "終わりました。いまの状態を表示しています。",
  "wait.tooLong": "まだ終わりません。処理はサーバー側で続いています。ページを再読み込みして、いまの状態をご確認ください。",

  // The accounts list
  "accounts.heading": "全アカウント — 直近{days}日",
  "accounts.lede": "アカウントを<b>比べる</b>ための表です。どれが成果を出し、どこが止まり、どこが計測できていないか。止める・動かすは、開いた先にあります。",
  "accounts.open": "開く",
  "accounts.resetWidths": "列の幅をもとに戻す",
  "accounts.colName": "アカウント",
  "accounts.colState": "状態",
  "accounts.colCycle": "直近サイクル",
  "accounts.colPosts": "投稿",
  "accounts.colMedian": "中央値",
  "accounts.colClicks": "クリック",
  "accounts.colConversions": "成果",
  "accounts.colRevenue": "確定報酬",
  "accounts.colPlaybook": "型",
  "accounts.colMeasurement": "計測",
  "accounts.stateRunning": "稼働中",
  "accounts.stateStopped": "停止中",
  "accounts.stateDeactivated": "非アクティブ",
  "accounts.stateAlsoDeactivated": "非アクティブでもあります",
  "accounts.stateConfigInactive": "設定で無効",
  "accounts.waiting": "判断待ち {n}",
  "accounts.review": "見直し候補",
  "accounts.measurementClosed": "閉じている",
  "accounts.measurementOpen": "未完成",

  // Why the measurement chain is open, named by the step that is open.
  "measurement.publish": "投稿がチャネルに届いていません",
  "measurement.engagement": "チャネルから数字が返ってきません",
  "measurement.link": "読者がリンクをたどれません（tracking.baseUrl）",
  "measurement.conversion": "ASPから成果が返ってきません",
  "measurement.revenue": "成果に金額がつきません",

  // The account
  "venture.back": "← 全アカウント",
  "venture.lastCycle": "直近のサイクル",
  "venture.neverRan": "まだ一度も動いていません。",
  "venture.stoppedAt": "{step}で止まりました",
  "venture.run": "今日のサイクルを動かす",
  "venture.running": "動かしています…",
  "venture.runWhy": "止まったステップからやり直します。次の自動実行を待たずに、その場で。",
  "venture.runWhyFirst": "このアカウントはまだ一度も動いていません。押すと今日のぶんを最初から動かします。",
  "venture.runAwaiting": "承認待ちになりました。上の判断待ちを見てください。",
  "venture.runCompleted": "今日は最後まで終わりました。",
  "venture.runNext": "（次は{step}）",
  "venture.history": "ここ数日",
  "venture.historyEmpty": "まだ履歴がありません。",
  "venture.published": "{n}件公開",
  "venture.numbers": "直近{days}日",
  "venture.numbersWhy": "比べるための数字は一覧に、このアカウントを読むための数字はここに。同じ計算です。",
  "venture.playbook": "効いている型 {active} / {total}",
  "venture.playbookEmpty": "まだ型がありません。数字が溜まると出てきます。",
  "venture.reviewWhy": "理由はこの数字だけで、勝手に止めることはありません。",
  "venture.measurement": "計測 {state}",
  "venture.measurementOk": "つながっている",

  // The account's settings, read-only
  "setup.heading": "このアカウントの設定",
  "setup.lede": "いま何が効いているかを読む画面です。変更は設定ファイルで行います。",
  "setup.niche": "ニッチ",
  "setup.audience": "読者",
  "setup.voice": "声",
  "setup.voiceFirstPerson": "一人称「{word}」",
  "setup.market": "読者のいる市場",
  "setup.disclosure": "開示文",
  "setup.regulator": "監督",
  "setup.channels": "チャネル",
  "setup.offers": "案件",
  "setup.offersNone": "なし",
  "setup.crossBorder": "越境",
  "setup.cadence": "投稿頻度",
  "setup.cadenceValue": "1日{postsPerDay}件 ・ {startsAt}から ・ 最低{minMinutes}分あける",
  "setup.editInFile": "<b>編集はファイルで。</b> この画面に入力欄が無いのは未完成だからではありません。設定は <code>{path}</code> の1本だけが正本で、画面から書き換えられると「いま何が効いているか」の答えが2つになります。",

  // Switching an account off and on
  "switch.heading": "このアカウントを止める",
  "switch.deactivate": "非アクティブにする",
  "switch.deactivateWhy": "動かず、投稿も出ません。学んだこと・履歴・成果はそのまま残り、いつでも再開できます。削除ではありません。押すと理由を1行聞かれ、この画面と記録に残ります。",
  "switch.deactivatePrompt": "このアカウントを非アクティブにします。動かず、投稿も出ませんが、データは全部残り、いつでも再開できます。理由（任意）:",
  "switch.activate": "再開する",
  "switch.activateWhy": "再開すると、次の朝から通常どおり動きます。止めていた間に承認済みだった投稿があれば、そのとき出ます。",
  "switch.configInactive": "設定ファイルで active: true にすると動きます。",
  "switch.closedGates": "開いていた判断 {n} 件を閉じました。再開しても開き直しません。",
  "switch.heldApproved": "承認済み {n} 件は保留され、再開時に出ます。",
  "switch.beyondRecall": "チャネル側の予約に渡った {n} 件は、このままだと出ます。チャネル側で消してください。",

  // The scout's proposals. Not "the weekly decision": company.exploration.enabled
  // ships false, and the daemon's exploreIfDue is the only thing that ever runs
  // the scout - so on a default install this heading promised a rhythm that
  // never happened once.
  "scout.heading": "探索の提案",
  "scout.empty": "いまは提案がありません。新しいアカウントの候補は、探索担当が見つけしだいここに並びます。設定ファイルで <code>company.exploration.enabled</code> を true にするまで探索担当は動かないので、それまでここは空のままです。",
  "scout.offers": "案件 {ids}",
  "scout.noOffers": "この市場に使える案件なし",
  "scout.names": "名前の候補",
  "scout.hypothesis": "仮説",
  "scout.evidence": "根拠",
  "scout.risk": "リスク",
  "scout.firstHooks": "最初の3本",
  "scout.killSignal": "やめる条件",
  "scout.accept": "採用する",
  "scout.dismiss": "見送る",
  "scout.appended": "採用しました。このブロックを設定ファイルの ventures: の下に active: false で追記しました（元のファイルは .amp/config-backups/ に控えがあります）。文体を読んで直し、active: true にして、デーモンを再起動してください。それまで何も動きません。",
  // Not "could not be written": on Workers the config is baked into the bundle,
  // so the append never succeeds and this is the ordinary path, not a fault.
  // The place to paste is named the way src/worker/setup.ts names it.
  "scout.notAppended": "採用しました。下のブロックを、設定ファイル platform.config.yaml の ventures: の下に貼り付けて、保存してください。貼り付けるまで、このアカウントは動きません。",
  // The card is gone a week after acceptance and the block goes with it, so the
  // deadline is the message. "下の" because the <pre> is rendered after this.
  "scout.showLater": "この内容は、採用した日から1週間このページに残ります。下のブロックは、その間に貼り付けてください。",
  "scout.writeError": "追記できなかった理由: {error}",
} as const;

export type MessageKey = keyof typeof ja;
export type Messages = Readonly<Record<MessageKey, string>>;

/**
 * Typed against `ja`, which is what makes a missing translation a compile
 * error. The screen is the only thing translated here - see the note at the
 * top about what must never follow this setting.
 */
const en: Messages = {
  "punct.sep": " · ",
  "punct.paren": " ({text})",
  "punct.quote": "“{text}”",

  "page.titleSuffix": "Approvals",
  "page.loading": "Loading…",
  "page.refresh": "Refresh",
  "page.operatorTitle": "Who you are approving as. This name goes in the record.",
  "page.themeTitle": "Switch the colour scheme (auto, light, dark)",
  "theme.auto": "Theme: auto",
  "theme.light": "Theme: light",
  "theme.dark": "Theme: dark",
  "timeline.open": "See this day",
  "timeline.byHuman": "decided by a person",
  "timeline.zone": "Times are in {zone}",
  "nav.today": "Today",
  "nav.settings": "Settings",
  "settings.heading": "This company's settings",
  "settings.lede": "What is in force, to read. Changes are made in the config file.",
  "settings.version": "Version running now",
  "settings.versionUnknown": "Not a numbered release (a development checkout)",
  "settings.autonomy": "How much the machine decides",
  "settings.autonomyManual": "manual — both gates wait for you, with nothing pre-selected",
  "settings.autonomyAssisted": "assisted — both gates wait for you, with the recommendation pre-selected",
  "settings.autonomyAuto": "auto — the machine decides both. You can only stop it",
  "settings.model": "Model",
  "settings.modelMock": "mock — simulated. <b>Not real writing</b>",
  "settings.modelReal": "{model} · fast: {fastModel} · effort {effort}",
  "settings.operator": "Who approves",
  "settings.operatorOne": "{name} (1)",
  "settings.operatorMany": "{names} ({n})",
  "settings.disclosure": "Disclosure",
  "settings.disclosureOff": "<b>The disclosure check is off.</b> This may breach your market's rules",
  "settings.disclosureRow": "{market}: {text}",
  "settings.limits": "Daily limits",
  "settings.limitsValue": "up to {posts} · at least {minutes} min apart · blocked above AI-smell {smell}",
  "settings.words": "Words that stop a post",
  "settings.wordsValue": "{banned} machine-sounding phrases",
  "settings.prohibitedClaims": "Claims never made (per reader market)",
  "settings.prohibitedClaimsRow": "{market}: {n}",
  "settings.tracking": "Where links go",
  "settings.trackingBad": "<b>Readers cannot follow this.</b> Clicks are not recorded",
  "settings.scale": "Scale",
  "settings.scaleValue": "{ventures} account(s) · {markets} market(s)",

  "update.available": "The platform has an update ({version})",
  "update.since": "You are running {version}",
  "update.what": "What changed",
  "update.how": "Your repository's README says how to take it. Your config file is never overwritten.",

  "status.heading": "Account status",
  "status.empty": "There are no accounts.",
  "status.approvalsNeeded": "Needs approval ({n})",
  "status.handOverBadge": "Time to post now",
  "status.failed": "Failing",

  "today.decisionsEmpty": "Nothing right now. The next cycle will put something here.",
  "today.upcoming": "Scheduled posts",
  "today.upcomingEmpty": "Nothing is scheduled.",
  "today.upcomingTime": "Time",
  "today.upcomingStatus": "State",
  "today.upcomingHook": "Opening",
  "postStatus.queued": "Queued",
  "postStatus.approved": "Approved",
  "postStatus.scheduled": "Scheduled",
  "postStatus.handedOver": "Yours to post",
  "postStatus.published": "Published",
  "postStatus.failed": "Failed",
  "postStatus.cancelled": "Cancelled",

  "handOver.heading": "Your turn to post",
  "handOver.lede": "This one goes out from your own account. Copy the text, open the app, paste, post.",
  "handOver.slot": "Slot it was planned for: {at}",
  "handOver.part": "Post {n}/{total}",
  "handOver.onePart": "Post",
  "handOver.order": "The order to paste them",
  "handOver.orderFirst": "Post “{label}” as a new post.",
  "handOver.orderRest": "Post the rest of the body in order, each one as a reply to the one before it. That is what makes it a thread.",
  "handOver.orderComments": "Post the comments in order, each one as a reply to the first post (“{label}”) — not to the last part of the body.",
  "handOver.orderLink": "The affiliate link is only in the “{name}” comment. Leave it out and nothing this post earns is recorded.",
  "handOver.orderDone": "When they are all up, press “{button}” below.",
  "handOver.comment": "Comment {n}/{total}: {name}",
  "handOver.purpose.self_reply": "Follow-up",
  "handOver.purpose.link_drop": "Link and context",
  "handOver.purpose.objection": "Answer to an objection",
  "handOver.purpose.faq": "Answer to a common question",
  "handOver.copy": "Copy",
  "handOver.copied": "Copied",
  "handOver.copyFailed": "Could not copy. Select the text and copy it by hand.",
  "handOver.open": "Open the app",
  "handOver.done": "I posted it",
  "handOver.sending": "Recording…",
  "handOver.urlPrompt": "The URL of the post, if you have it (you can leave this empty)",
  "handOver.noEngagement": "Likes and replies cannot be read back on this channel. Clicks and revenue are recorded as usual.",
  "today.stats": "All accounts total — last {days} days",
  "today.activity": "Recently",
  "today.activityEmpty": "Nothing recorded yet.",
  "today.activityFailed": "Stopped at {step} — {reason}",
  "today.activityExpired": "The gate for {day} lapsed unanswered",
  "today.activityClosed": "The gate for {day} was closed when the account was switched off",
  "today.activityHandedOver": "Your turn to post — {hook}",
  "today.activityResumed": "Lifted the stop on everything.",
  "gate.proposalLabel": "Proposals",
  "gate.publishLabel": "Posts and their order",
  "gate.questionProposal": "Which of today's proposed posts should be written?",
  "gate.questionPublish": "Which posts go out, and in what order?",
  "stats.posts": "Posts published",
  "stats.clicks": "Clicks",
  "stats.conversions": "Conversions",
  "stats.revenue": "Approved revenue",
  "chip.expected": "Expected {n}",
  "chip.aiSmell": "AI smell {n}",
  "chip.findings": "{n} findings",
  "run.busy": "A cycle is running on the schedule right now. Wait for it to finish, then press again.",
  "preview.angle": "Angle",
  "preview.targetPain": "Reader's problem",
  "preview.promisedOutcome": "Promised outcome",
  "preview.rationale": "Rationale",
  "preview.risk": "Risk",
  "preview.slotReason": "Why this slot",
  "preview.comment": "Comment",
  "preview.finding": "Finding",


  "stop.all": "Stopped — nothing runs and nothing publishes",
  "stop.one": "Stopped — {label}",
  "stop.howToResume": "There is no button on this screen to lift this account's own stop. When everything is stopped, the button above clears it. This account's own stop is something only whoever runs this system can undo.",
  "stop.failClosedExplain": "The place this state is stored (a file, or a database row) could not be read, so for safety this is being treated as a stop on everything. Nobody actually stopped it. Resuming clears this.",
  "stop.resumeAll": "Resume everything",
  "stop.resumeConfirmDetail": "Everything was stopped at {at} by {by}. Reason: {reason}.",
  "stop.resumeConfirm": "Resume everything now?",
  "stop.resumed": "Resumed. It runs normally from the next cycle.",
  "stop.resumeNothingToDo": "Already running. Nothing was changed.",

  "gate.heading": "{gate} — {venture}",
  "gate.day": "For {day}",
  "gate.dayStale": "For {day} · that day has already passed",
  "gate.question": "{question} At most {max}. They publish in this order.",
  "gate.atMax": "{max} selected. Untick one to choose something else.",
  "gate.approve": "Approve {n} and continue",
  "gate.selectRecommended": "Select all recommended",
  "gate.rejectAll": "Reject everything today",
  "gate.sending": "Sending…",
  "gate.disclosurePresent": "Disclosure present",
  "gate.disclosureMissing": "No disclosure. Satisfy yourself why before approving.",
  "gate.disclosureNotNeeded": "No offer. No disclosure needed",
  "gate.openPost": "Evidence, findings, comment draft",
  "gate.openIdea": "Aim and evidence",

  "gate.recommended": "Recommended",
  "gate.recommendedWhy": "Chosen from what has worked so far. You can approve them as they are.",
  "gate.others": "See the other {n}",

  "wait.stillRunning": "Still running. The work carries on even if you close this page, and the screen will bring itself up to date when it finishes.",
  "wait.gateStillRunning": "Your approval went through and the posts are being written. The work carries on even if you close this page, and the screen will bring itself up to date when it finishes.",
  "wait.changed": "Finished. This is where it got to.",
  "wait.tooLong": "Still not finished. The work carries on on the server. Reload the page to see where it got to.",

  "accounts.heading": "All accounts — last {days} days",
  "accounts.lede": "This table is for <b>comparing</b> accounts: which earn, which are stuck, which measure nothing. Stopping and running belong to the account behind it.",
  "accounts.open": "Open",
  "accounts.resetWidths": "Reset column widths",
  "accounts.colName": "Account",
  "accounts.colState": "State",
  "accounts.colCycle": "Last cycle",
  "accounts.colPosts": "Posts",
  "accounts.colMedian": "Median",
  "accounts.colClicks": "Clicks",
  "accounts.colConversions": "Conversions",
  "accounts.colRevenue": "Approved",
  "accounts.colPlaybook": "Patterns",
  "accounts.colMeasurement": "Measured",
  "accounts.stateRunning": "Running",
  "accounts.stateStopped": "Stopped",
  "accounts.stateDeactivated": "Switched off",
  "accounts.stateAlsoDeactivated": "and switched off",
  "accounts.stateConfigInactive": "Inactive in config",
  "accounts.waiting": "{n} waiting",
  "accounts.review": "Worth a look",
  "accounts.measurementClosed": "Closed",
  "accounts.measurementOpen": "Incomplete",

  "measurement.publish": "Posts are not reaching the channel",
  "measurement.engagement": "The channel is not returning numbers",
  "measurement.link": "Readers cannot follow the link (tracking.baseUrl)",
  "measurement.conversion": "The network is not returning conversions",
  "measurement.revenue": "Conversions carry no amount",

  "venture.back": "← All accounts",
  "venture.lastCycle": "Last cycle",
  "venture.neverRan": "This account has never run.",
  "venture.stoppedAt": "stopped at {step}",
  "venture.run": "Run today's cycle",
  "venture.running": "Running…",
  "venture.runWhy": "It resumes at the step it stopped on. No need to wait for the next scheduled run.",
  "venture.runWhyFirst": "This account has never run. Pressing it starts today from the beginning.",
  "venture.runAwaiting": "It is waiting on you now. See the decisions above.",
  "venture.runCompleted": "Today ran all the way through.",
  "venture.runNext": " (next: {step})",
  "venture.history": "The last few days",
  "venture.historyEmpty": "No history yet.",
  "venture.published": "{n} published",
  "venture.numbers": "Last {days} days",
  "venture.numbersWhy": "The numbers for comparing are in the list; the numbers for reading this account are here. Same computation.",
  "venture.playbook": "Patterns that work {active} / {total}",
  "venture.playbookEmpty": "No patterns yet. They appear once there are numbers.",
  "venture.reviewWhy": "That is the only reason, and nothing switches itself off.",
  "venture.measurement": "Measurement {state}",
  "venture.measurementOk": "closed",

  "setup.heading": "This account's settings",
  "setup.lede": "What is in force, to read. Changes are made in the config file.",
  "setup.niche": "Niche",
  "setup.audience": "Audience",
  "setup.voice": "Voice",
  "setup.voiceFirstPerson": "first person “{word}”",
  "setup.market": "Where the readers are",
  "setup.disclosure": "Disclosure",
  "setup.regulator": "Regulator",
  "setup.channels": "Channels",
  "setup.offers": "Offers",
  "setup.offersNone": "none",
  "setup.crossBorder": "cross-border",
  "setup.cadence": "Cadence",
  "setup.cadenceValue": "{postsPerDay}/day · from {startsAt} · at least {minMinutes} minutes apart",
  "setup.editInFile": "<b>Edit it in the file.</b> There are no input fields here on purpose: <code>{path}</code> is the single answer to what is in force, and a screen that could write would make two.",

  "switch.heading": "Switch this account off",
  "switch.deactivate": "Switch off",
  "switch.deactivateWhy": "It stops running and stops posting. Everything it learned, its history and its revenue stay, and you can start it again whenever. This is not a delete. You will be asked for a one-line reason, which stays on this screen and in the record.",
  "switch.deactivatePrompt": "Switching this account off. It stops running and posting, but all its data stays and you can start it again whenever. Reason (optional):",
  "switch.activate": "Start it again",
  "switch.activateWhy": "It runs normally from the next morning. Anything approved while it was off publishes then.",
  "switch.configInactive": "Set active: true in the config file to run it.",
  "switch.closedGates": "{n} decision(s) that were waiting have been closed. Switching it back on does not reopen them.",
  "switch.heldApproved": "{n} approved post(s) are held and will publish when it starts again.",
  "switch.beyondRecall": "{n} post(s) already handed to the channel's own scheduler will still publish. Delete them there.",

  "scout.heading": "Proposals",
  "scout.empty": "No proposals yet. New account ideas appear here as the scout finds them. The scout does not run until <code>company.exploration.enabled</code> is true in your config file, so until then this stays empty.",
  "scout.offers": "Offers {ids}",
  "scout.noOffers": "No permitted offer in this market",
  "scout.names": "Name candidates",
  "scout.hypothesis": "Hypothesis",
  "scout.evidence": "Evidence",
  "scout.risk": "Risk",
  "scout.firstHooks": "First three hooks",
  "scout.killSignal": "Stop when",
  "scout.accept": "Accept",
  "scout.dismiss": "Dismiss",
  "scout.appended": "Accepted. The block was appended under ventures: in your config with active: false, and the previous file is kept in .amp/config-backups/. Read the voice, fix it, set active: true and restart the daemon — nothing runs until you do.",
  "scout.notAppended": "Accepted. Paste the block below under ventures: in your config file, platform.config.yaml, and save it. This account does not run until you do.",
  "scout.showLater": "This stays on the page for a week from the day you accepted it. Paste the block below before then.",
  "scout.writeError": "Could not append: {error}",
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { ja, en };

export function messagesFor(locale: string): Messages {
  return (MESSAGES as Record<string, Messages | undefined>)[locale] ?? MESSAGES.ja;
}

/**
 * A message with its {placeholders} filled.
 *
 * The page carries its own copy of this, because the page is inlined
 * JavaScript and cannot import. Two copies of four lines; one vocabulary.
 */
export function fill(messages: Messages, key: MessageKey, values: Record<string, string | number>): string {
  return messages[key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole);
}

/**
 * The word for a comment's purpose, as the operator reads it.
 *
 * `self_reply`, `link_drop`, `objection` and `faq` are this platform's own
 * identifiers, chosen for the prompt and the code. The hand-over card printed
 * them - 「最初のコメント（link_drop）」 - on the one screen a licensee has, with
 * no terminal and nowhere to look them up, and the three it showed all called
 * themselves 「最初の」 so none of them was.
 *
 * A `switch` rather than a lookup table on purpose: a purpose added to
 * `CommentPurpose` without a word to go with it fails the typecheck here,
 * instead of reaching a licensee's screen in English.
 */
export function commentPurposeKey(purpose: CommentPurpose): MessageKey {
  switch (purpose) {
    case "self_reply":
      return "handOver.purpose.self_reply";
    case "link_drop":
      return "handOver.purpose.link_drop";
    case "objection":
      return "handOver.purpose.objection";
    case "faq":
      return "handOver.purpose.faq";
  }
}
