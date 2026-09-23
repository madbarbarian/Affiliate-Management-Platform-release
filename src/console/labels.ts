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
