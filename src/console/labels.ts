/**
 * The operator's words for the platform's own vocabulary.
 *
 * A cycle's step and status are English identifiers, chosen for the code. The
 * console is Japanese and is the only surface a hosted operator has - there is
 * no terminal there to look anything up in - so the cell read
 * `2026-09-09 failed → write` to somebody who had no way to find out what
 * "write" was.
 *
 * Kept here rather than inside `ui.ts`'s page template so that a step added to
 * `CycleStep` without a word to go with it fails a test rather than reaching a
 * licensee's screen in English.
 */

import type { CycleStatus, CycleStep, PostStatus } from "../core/types.ts";
import type { MessageKey } from "./messages.ts";

/**
 * The operator's word for a post's status, as a key into `messages.ts`.
 *
 * The key and not the word, unlike everything else in this file: the schedule
 * table printed `scheduled` / `approved` / `queued` - this platform's own
 * identifiers - straight onto a Japanese screen, in the cell directly under the
 * hand-over card, and the design board has always drawn 「予約中」 there. The
 * words themselves belong in `messages.ts` because that file is paired ja/en
 * and this file is not; an English console showing Japanese is the same defect
 * wearing the other language.
 *
 * A `Record` over the union, so a status added to `PostStatus` without a word
 * fails the typecheck here rather than reaching a licensee's screen as its own
 * identifier. Every member is covered even though the schedule only ever shows
 * three of them - the filter that picks those three is somewhere else, and is
 * free to change.
 */
export const POST_STATUS_KEYS: Readonly<Record<PostStatus, MessageKey>> = {
  queued: "postStatus.queued",
  approved: "postStatus.approved",
  scheduled: "postStatus.scheduled",
  handed_over: "postStatus.handedOver",
  published: "postStatus.published",
  failed: "postStatus.failed",
  cancelled: "postStatus.cancelled",
};

export const CYCLE_STATUS_LABELS: Readonly<Record<CycleStatus, string>> = {
  running: "動作中",
  awaiting_approval: "承認待ち",
  completed: "完了",
  failed: "失敗",
  cancelled: "中止",
};

/**
 * What a failed day says on the accounts list: a short verdict and one line
 * under it, chosen by the failure's **code**.
 *
 * Never by truncating the message. The message is whatever the API said - it
 * begins in English, it can be a paragraph, and cutting it at n characters
 * lands mid-clause or, worse, before the "not" that carried the meaning. The
 * code is a small closed set, and this is a lookup on it.
 *
 * An unknown code falls back to the code itself, which is ugly on purpose: the
 * test enumerates every code a cycle can store, so the ugly path is what a new
 * failure looks like in a test run rather than on a licensee's screen.
 */
export type FailureSummary = { readonly short: string; readonly hint: string };

export const FAILURE_SUMMARIES: Readonly<Record<string, FailureSummary>> = {
  "write.all_failed": {
    short: "実行できませんでした",
    hint: "下書きの生成でモデルの呼び出しが断られました。理由の全文は開いた先に。",
  },
  "cycle.step_threw": {
    short: "途中で止まりました",
    hint: "想定していない失敗です。開いて理由を確認してください。",
  },
  "cycle.unknown_venture": {
    short: "このアカウントが見つかりません",
    hint: "設定ファイルから消えた可能性があります。",
  },
  "cycle.venture_inactive": {
    short: "止まっています",
    hint: "設定で active: false になっています。",
  },
  "venture.deactivated": {
    short: "非アクティブです",
    hint: "あなたが止めました。再開すると次の朝から動きます。",
  },
  "platform.stopped": {
    short: "全体を止めています",
    hint: "非常停止が入っています。解除するまで何も動きません。",
  },
  "llm.auth": {
    short: "実行できませんでした",
    hint: "モデルの鍵が拒否されました。ANTHROPIC_API_KEY を確認してください。",
  },
  // 401（鍵そのものが拒否された）とは別の失敗。403は鍵は受理されたうえで、
  // その操作を断られている。「鍵が間違っている」とは書かない — 間違っていれば
  // 401になる。実際に起きた例：利用上限・与信切れ、設定したモデルへの
  // アクセス権がその鍵に無い、鍵が無効化された、のいずれか。
  "llm.permission_denied": {
    short: "実行できませんでした",
    hint: "鍵は受理されましたが、この操作は許可されませんでした。利用上限に達している、設定したモデル（llm.model）をこの鍵で使えない、または鍵が無効化されている、のいずれかが考えられます。",
  },
  // platform.config.yaml でライセンシーが自分で編集する数少ない項目の一つが
  // llm.model — 打ち間違えても検証する手段がなく（端末が無いのでモデル一覧を
  // 見比べられない）、気づくのはここで失敗したときだけになる。
  "llm.model_not_found": {
    short: "実行できませんでした",
    hint: "設定したモデル（llm.model）が見つかりませんでした。名前が間違っているか、そのモデルが提供終了になっている可能性があります。",
  },
  // llm.provider: external-session (phase 1b). Every one of these is retried by
  // the scheduler on its next tick, the schedule step's comment calls included.
  "external_session.busy": { short: "外部セッションが使用中です", hint: "別の呼び出しが同じジョブ置き場を使っています。次の実行で再開します。" },
  "external_session.aborted": {
    short: "先の失敗のため見送りました",
    hint: "同じ実行の中で、ルーティンが一度答えなかったため、続きは次の実行に回しました。",
  },
  "external_session.budget_exhausted": {
    short: "待ち時間の上限に達しました",
    hint: "1回の実行で待ってよい時間（llm.externalSession.invocationBudgetMs）を使い切りました。次の実行で続きから再開します。",
  },
  "external_session.store_unreadable": { short: "ジョブ置き場を読めません", hint: "データベースに届きませんでした。次の実行で再試行します。" },
  "external_session.store_write_failed": { short: "ジョブを書き込めません", hint: "データベースへの書き込みに失敗しました。次の実行で再試行します。" },
  "external_session.fire_refused": {
    short: "ルーティンを起こせません",
    hint: "ルーティンの起動が断られました。起動用のURLとトークン（ジョブ用の合言葉とは別物）を確認してください。",
  },
  "external_session.fire_unreachable": { short: "ルーティンに届きません", hint: "起動用のURLに届きませんでした。回線かURLを確認してください。" },
  "external_session.fire_timeout": { short: "ルーティンの起動が遅すぎます", hint: "起動の要求が時間内に返りませんでした。次の実行で再試行します。" },
  "external_session.timeout": {
    short: "ルーティンが答えませんでした",
    hint: "claude.ai/code/routines で、ルーティンの直近の実行を確認してください。起動していなければ、URL・トークン・承認画面の公開アドレスを見直します。",
  },
  "external_session.superseded": { short: "別の仕事に置き換わりました", hint: "同じジョブ置き場を別の呼び出しが使いました。次の実行で再試行します。" },
  "external_session.schema_violation": { short: "答えの形式が違いました", hint: "ルーティンの答えがスキーマに合いませんでした。次の実行で再試行します。" },
  "llm.no_api_key": {
    short: "実行できませんでした",
    hint: "モデルの鍵が設定されていません。",
  },
  "llm.rate_limited": {
    short: "実行できませんでした",
    hint: "モデルの呼び出しが混み合っています。しばらく待つと通ります。",
  },
  "llm.connection": {
    short: "実行できませんでした",
    hint: "モデルに届きませんでした。回線かAPIの障害です。",
  },
  "llm.bad_request": {
    short: "実行できませんでした",
    hint: "モデルへの依頼の形が拒否されました。プラットフォーム側の不具合です。",
  },
  "llm.api_error": {
    short: "実行できませんでした",
    hint: "モデルの呼び出しが断られました。理由の全文は開いた先に。",
  },
  "llm.invalid_json": {
    short: "返事を読めませんでした",
    hint: "モデルの返事が壊れていました。もう一度動かすと通ることがあります。",
  },
  "llm.empty_response": {
    short: "返事が空でした",
    hint: "モデルが何も返しませんでした。もう一度動かしてください。",
  },
  "llm.truncated": {
    short: "返事が途中で切れました",
    hint: "出力の上限に当たりました。llm.maxOutputTokens を増やしてください。",
  },
  "llm.refusal": {
    short: "モデルが断りました",
    hint: "安全側の判断で応答が返りませんでした。企画を見直してください。",
  },
  "llm.unknown": {
    short: "実行できませんでした",
    hint: "モデルの呼び出しで想定外の失敗が起きました。",
  },
  "state.unreadable": {
    short: "いま読み込めません",
    hint: "状態を確認できないため、見えていない停止を消してしまう恐れがあり、再開できませんでした。少し待ってからもう一度お試しください。",
  },
};

/** Every failure code a cycle can end on. The test's list, and this file's contract. */
export const CYCLE_FAILURE_CODES: readonly string[] = Object.keys(FAILURE_SUMMARIES);

export const CYCLE_STEP_LABELS: Readonly<Record<CycleStep, string>> = {
  analyze: "分析",
  research: "調査",
  plan: "企画",
  proposal_approval: "企画の承認",
  write: "執筆",
  inspect: "検品",
  schedule: "枠決め",
  publish_approval: "投稿の承認",
  dispatch: "投稿",
};
