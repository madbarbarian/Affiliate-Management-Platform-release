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
  "page.waitingCount": "{n} 件の判断待ち",
  "page.waitingNone": "判断待ちはありません",
  "page.asOperator": " ・ {name} として",

  // The day's own page
  "today.decisions": "あなたの判断待ち",
  "today.decisionsEmpty": "今のところ何もありません。次のサイクルが回るとここに出ます。",
  "today.upcoming": "予約中の投稿",
  "today.upcomingEmpty": "予約中の投稿はありません。",
  "today.upcomingTime": "時刻",
  "today.upcomingStatus": "状態",
  "today.upcomingHook": "冒頭",
  "today.stats": "直近の数字",
  "today.activity": "最近の動き",
  "today.activityEmpty": "まだ記録がありません。",
  "today.activityFailed": "{step}で止まりました — {reason}",
  // Words the server renders. The router runs in the same process as this file
  // and reads it directly rather than shipping a second vocabulary: what a
  // screen says has to have one source, or console.locale becomes a promise
  // only half the page keeps.
  "gate.proposalLabel": "企画の承認",
  "gate.publishLabel": "投稿の承認と順番",
  "gate.questionProposal": "今日の企画のうち、どれを書きますか。",
  "gate.questionPublish": "どれを出しますか。順番も決めてください。",
  "stats.posts": "公開済み投稿",
  "stats.engagement": "エンゲージ合計",
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
  "stop.howToResume": "再開するには {command} を実行してください。",

  // The two gates
  "gate.heading": "{gate} — {venture}",
  "gate.question": "{question} 最大 {max} 件。上から順に投稿されます。",
  "gate.approve": "{n} 件を承認して進める",
  "gate.selectRecommended": "推奨をすべて選ぶ",
  "gate.rejectAll": "今日は全部見送る",
  "gate.sending": "送信中…",
  "gate.disclosurePresent": "PR表記あり",
  "gate.disclosureMissing": "PR表記が入っていません。承認する前に理由を確かめてください。",
  "gate.disclosureNotNeeded": "案件なし。PR表記は要りません",
  "gate.openPost": "根拠・指摘・コメント下書き",
  "gate.openIdea": "本文を見る",

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
  "switch.heldApproved": "承認済み {n} 件は保留され、再開時に出ます。",
  "switch.beyondRecall": "チャネル側の予約に渡った {n} 件は、このままだと出ます。チャネル側で消してください。",

  // The weekly proposals
  "scout.heading": "探索の提案 — 週に1回の判断",
  "scout.empty": "提案はありません。<code>amp scout</code> で探索担当に次のアカウント候補を出させられます。",
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
  "scout.notAppended": "採用しましたが、設定ファイルには追記できていません。下のブロックを platform.config.yaml の ventures: の下に手で貼ってください。",
  "scout.showLater": "あとで見るには <code>amp scout show {id}</code>。",
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
  "page.waitingCount": "{n} waiting on you",
  "page.waitingNone": "Nothing waiting on you",
  "page.asOperator": " · as {name}",

  "today.decisions": "Waiting on you",
  "today.decisionsEmpty": "Nothing right now. The next cycle will put something here.",
  "today.upcoming": "Scheduled posts",
  "today.upcomingEmpty": "Nothing is scheduled.",
  "today.upcomingTime": "Time",
  "today.upcomingStatus": "State",
  "today.upcomingHook": "Opening",
  "today.stats": "Recent numbers",
  "today.activity": "Recently",
  "today.activityEmpty": "Nothing recorded yet.",
  "today.activityFailed": "Stopped at {step} — {reason}",
  "gate.proposalLabel": "Proposals",
  "gate.publishLabel": "Posts and their order",
  "gate.questionProposal": "Which of today's proposed posts should be written?",
  "gate.questionPublish": "Which posts go out, and in what order?",
  "stats.posts": "Posts published",
  "stats.engagement": "Engagement total",
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
  "stop.howToResume": "Run {command} to start again.",

  "gate.heading": "{gate} — {venture}",
  "gate.question": "{question} At most {max}. They publish in this order.",
  "gate.approve": "Approve {n} and continue",
  "gate.selectRecommended": "Select all recommended",
  "gate.rejectAll": "Reject everything today",
  "gate.sending": "Sending…",
  "gate.disclosurePresent": "Disclosure present",
  "gate.disclosureMissing": "No disclosure. Satisfy yourself why before approving.",
  "gate.disclosureNotNeeded": "No offer. No disclosure needed",
  "gate.openPost": "Evidence, findings, comment draft",
  "gate.openIdea": "Read the post",

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
  "switch.heldApproved": "{n} approved post(s) are held and will publish when it starts again.",
  "switch.beyondRecall": "{n} post(s) already handed to the channel's own scheduler will still publish. Delete them there.",

  "scout.heading": "Proposals — the weekly decision",
  "scout.empty": "No proposals. <code>amp scout</code> asks the scout for the next account to try.",
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
  "scout.notAppended": "Accepted, but the config could not be written. Paste the block below under ventures: in platform.config.yaml by hand.",
  "scout.showLater": "To see it later: <code>amp scout show {id}</code>.",
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
