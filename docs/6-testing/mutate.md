# 変異テスト — `scripts/mutate.ts`

> 2026-09-23。CLAUDE.md の規則「バグを戻し、テストが落ちるのを見て、それから戻す」
> は変えていない。手作業（ソースを書き換える → 全テスト約11秒を待つ → 出力を読む →
> 書き換えを戻す → 戻しが正確か自分で確かめる）を1コマンドにしただけ。
> ある回で、手作業の復元を裏取りするために手動バックアップと diff を取る羽目になった。
> それ自体が「手でやる復元は信用できない」という証拠だった。

## 使い方

```bash
node scripts/mutate.ts <file> --from <text> --to <text> -- <node --test に渡す引数...>
```

例（実際にこのリポジトリの回帰テストに対して実行し、想定通り落ちた）:

```bash
node scripts/mutate.ts src/kernel/policy.ts \
  --from 'fullText.includes(disclosure)' \
  --to 'declared !== ""' \
  -- test/policy.test.ts
```

これは `policy.ts` に一度実在したバグ（`disclosure` フィールドが空でなければ
何でも通す）をそのまま再現する1行。`test/policy.test.ts` の
「a disclosure the reader's market does not require is not a disclosure」が
これを捕まえて赤くなり、終了コードは **0**。

## 終了コードが本体

- **0** — 変異でテストが落ちた。テストは本物の門番だった。
- **1** — 変異でもテストは緑のまま。**そのテストは飾りである。**
- **2** — 使い方の誤り（`--from` が無い／複数ある）か、`node --test` 自体が
  動かせなかった。前者は何も書き換えていない。後者は表示時点で既に復元済み。
- **3** — 復元したが、元とバイト単位で一致しなかった。**他の全部より優先。**
  すぐ `git diff -- "<file>"` で手で見る。
- **130 / 143** — 実行中に Ctrl-C / SIGTERM。ファイルは復元済み（復元の検証は
  通常どおり行われ、それが失敗していれば 3 が勝つ）。

「実際に赤くなったか」は、もう人がスクロールバックを読んで報告する文章ではない。
終了コードなので誤報できない。

## `--occurrence` は無い

`--from` はファイル中にちょうど1回だけ現れることを要求する。2回以上あれば
「何行目」を指定させるのではなく、前後の文脈を足して一意にすることを求めて拒否する。
**間違った出現箇所に当たる変異は、何も証明しない。** 索引で選べるようにすると、
「本当は曖昧な `--from` を通してしまう」抜け道になる。曖昧さは書式で潰す。

## 制約

- Node組み込みのみ。新規依存なし。
- スペースを含むパス（このリポジトリ自体が `Mobile Documents/...` の下にある）で動作確認済み — `test/mutate.test.ts` のフィクスチャは全て名前にスペースを持つ一時ディレクトリに作る。
- このマシンで `npm run check` に必要な `arch -arm64` は、`mutate.ts` 自身には焼き込んでいない。`mutate.ts` は自分を起動した node バイナリ（`process.execPath`）で `node --test` を起動するので、`arch -arm64 node scripts/mutate.ts ...` と呼べばテストも同じアーキテクチャで動く。

## フェーズ1b（`llm.provider: external-session`）の変異表

2026-09-30。**1行の変異ごとに、対応するテストが赤くなる**ことを示す表。すべて `node scripts/mutate.ts`
の終了コードが **0**（変異でテストが落ちた）になる。**1つでも 1 が返れば、その行のテストは飾りである。**
`--from` はそのファイル中にちょうど1回だけ現れる（無ければ・複数なら mutate.ts が拒否する）。
実行の仕方は上の「使い方」と同じ。表の1行が `node scripts/mutate.ts <File> --from <--from> --to <--to> -- <Tests>` の
1回にあたる（最後の列が `--` のあとに渡すテスト）。この表だけで再実行できる。

| # | What it proves the tests guard | File | `--from` | `--to` | Tests (after `--`) |
|---|---|---|---|---|---|
| M1 | timeout boundary: elapsed == max is a timeout | `src/llm/external-session.ts` | `if (remainingMs <= 0) {` | `if (remainingMs < 0) {` | `test/external-session-provider.test.ts` |
| M2 | the first timeout latches the run | `src/llm/external-session.ts` | `if (win.tripped) {` | `if (false) {` | `test/external-session-provider.test.ts` |
| M3 | a stale job is discarded before a new one is written | `src/llm/external-session.ts` | `await writeJob(tombstoneJob(again.job, clock.nowIso()))` | `ok(undefined)` | `test/external-session-provider.test.ts` |
| M4 | the discard is conditional on the id that was read | `src/llm/external-session.ts` | `if (again.job.id !== first.job.id) {` | `if (false) {` | `test/external-session-provider.test.ts` |
| M5 | an id mismatch is superseded, never waited out or returned | `src/llm/external-session.ts` | `if (job.id !== jobId) return {` | `if (false) return {` | `test/external-session-provider.test.ts` |
| M6 | a schema violation is an Err | `src/llm/external-session.ts` | `if (!checked.ok) {` | `if (false) {` | `test/external-session-provider.test.ts` |
| M7 | a refused fire is an Err | `src/llm/external-session.ts` | `if (outcome.kind === "failed") {` | `if (false) {` | `test/external-session-provider.test.ts` |
| M8 | a hung fire is cut by its own abort signal | `src/llm/external-session.ts` | `signal: AbortSignal.timeout(options.fireTimeoutMs),` | `signal: undefined,` | `test/external-session-provider.test.ts` |
| M9 | a fire that throws is an Err, not an exception | `src/llm/external-session.ts` | `const name = (cause as { name?: unknown } \| null)?.name;` | `throw cause; const name = (cause as { name?: unknown } \| null)?.name;` | `test/external-session-provider.test.ts` |
| M10 | every read refreshes first (D1 is a snapshot) | `src/llm/external-session.ts` | `await store.refresh();` | `void 0;` | `test/external-session-provider.test.ts` |
| M11 | budget boundary: elapsed == budget refuses | `src/llm/external-session.ts` | `if (callStartedMs - win.startedAtMs >= options.invocationBudgetMs) {` | `if (callStartedMs - win.startedAtMs > options.invocationBudgetMs) {` | `test/external-session-provider.test.ts` |
| M12 | a wait is clamped to the end of the budget | `src/llm/external-session.ts` | `return poll(job, Math.min(timeoutEndMs, budgetEndMs), budgetEndMs < timeoutEndMs, win);` | `return poll(job, timeoutEndMs, false, win);` | `test/external-session-provider.test.ts` |
| M13 | a quiet gap starts a new run (a long-lived daemon provider) | `src/llm/external-session.ts` | `if (!current \|\| nowMs - current.lastCallEndedAtMs > gapMs) {` | `if (!current) {` | `test/external-session-provider.test.ts` |
| M14 | two concurrent calls on one provider: the second is refused | `src/llm/external-session.ts` | `if (busy) {` | `if (false) {` | `test/external-session-provider.test.ts` |
| M15 | an unreadable database mid-wait is waited through | `src/llm/external-session.ts` | `if (slot.kind === "unreadable") return { kind: "pending" };` | `if (slot.kind === "unreadable") return { kind: "superseded", why: "unreadable" };` | `test/external-session-provider.test.ts` |
| M16 | calls that fail fast do not extend the window (a stream of them cannot hold a latched window open) | `src/llm/external-session.ts` | `if (didRealWork) win.lastCallEndedAtMs` | `if (true) win.lastCallEndedAtMs` | `test/external-session-provider.test.ts` |
| M17 | an answered job in the slot is read as settled, not as a live job to age out (first `isLiveJob` guard in `prepareSlot`; the second guard shadows it, so this row is red through the neighbouring tests - the `never tombstoned` assertion in `an answered job for a different prompt is never adopted` goes red only with both guards removed) | `src/llm/external-session.ts` | `if (!isLiveJob(first.job)) return ok(` | `if (false) return ok(` | `test/external-session-provider.test.ts` |
| M18 | a database write that throws is a retryable Err, not an exception | `src/llm/external-session.ts` | `return fail("storage", EXTERNAL_SESSION_ERROR.storeWriteFailed,` | `return ok(undefined); fail("storage", EXTERNAL_SESSION_ERROR.storeWriteFailed,` | `test/external-session-provider.test.ts` |
| A1a | a live job younger than the job timeout is never discarded (its caller is still waiting) | `src/llm/external-session.ts` | `if (!(ageMs >= options.jobTimeoutMs)) {` | `if (false) {` | `test/external-session-provider.test.ts` |
| A1b | the staleness boundary: a job exactly as old as the job timeout is stale | `src/llm/external-session.ts` | `if (!(ageMs >= options.jobTimeoutMs)) {` | `if (!(ageMs > options.jobTimeoutMs)) {` | `test/external-session-provider.test.ts` |
| A3a | an answer is adopted only for the identical prompt | `src/llm/external-session.ts` | `if (job.result === undefined \|\| job.prompt !== prompt) return undefined;` | `if (job.result === undefined) return undefined;` | `test/external-session-provider.test.ts` |
| A3b | an adopted answer must still fit the schema | `src/llm/external-session.ts` | `return validate(schema, job.result.value).ok ? {` | `return true ? {` | `test/external-session-provider.test.ts` |
| A4 | the wait budget applies on the Worker only | `src/llm/external-session.ts` | `return wallLimited ? configuredMs : UNLIMITED_INVOCATION_BUDGET_MS;` | `return configuredMs;` | `test/external-session-provider.test.ts` |
| R1 | the router refuses a late answer to a discarded job | `src/console/router.ts` | `if (job.id !== id \|\| !isLiveJob(job)) {` | `if (job.id !== id \|\| job.result !== undefined) {` | `test/external-session.test.ts` |
| R2 | a live job blocks a new one, a discarded one does not | `src/console/router.ts` | `if (existing && isLiveJob(existing)) {` | `if (existing && existing.result === undefined) {` | `test/external-session.test.ts` |
| S1 | an unreadable state is not an empty slot | `src/kernel/external-session.ts` | `if (slot.kind === "unreadable") return { kind: "unreadable", detail: slot.detail };` | `if (slot.kind === "unreadable") return { kind: "none" };` | `test/external-session-store.test.ts` |
| Q1 | abortsRun is true only for a retryable error | `src/core/result.ts` | `return error.retryable && error.abortsRun === true;` | `return error.abortsRun === true;` | `test/external-session-provider.test.ts` |
| F1 | the fire request carries the beta header | `src/llm/routine-fire.ts` | `"anthropic-beta": ROUTINE_BETA_HEADER,` | `"anthropic-beta-x": ROUTINE_BETA_HEADER,` | `test/routine-fire.test.ts` |
| F2 | advancingClock really advances | `test/helpers.ts` | `base.advance(ms);` | `void ms;` | `test/routine-fire.test.ts` |
| C1 | external-session with the routes off is a config error | `src/config/schema.ts` | `if (llm.provider === "external-session" && !ext.enabled) {` | `if (false) {` | `test/external-session-config.test.ts` `test/cli.smoke.test.ts` |
| C2 | a budget below one job timeout is a config error | `src/config/schema.ts` | `if (ext.invocationBudgetMs < ext.jobTimeoutMs) {` | `if (false) {` | `test/external-session-config.test.ts` |
| C3 | a job timeout past the scheduler's retry backoff is a config error | `src/config/schema.ts` | `export const EXTERNAL_SESSION_MAX_JOB_TIMEOUT_MS = 10 * 60_000;` | `export const EXTERNAL_SESSION_MAX_JOB_TIMEOUT_MS = 20 * 60_000;` | `test/external-session-config.test.ts` |
| E1 | a console address the routine cannot reach is refused | `src/llm/external-session-env.ts` | `if (requirePublic && !isPubliclyReachableHost(url.hostname)) {` | `if (false) {` | `test/external-session-config.test.ts` |
| E2 | http:// is refused because a token is sent to it | `src/llm/external-session-env.ts` | `if (url.protocol !== "https:") {` | `if (false) {` | `test/external-session-config.test.ts` |
| W1 | buildLlm builds the external-session provider | `src/kernel/assemble.ts` | `if (config.llm.provider === "external-session") {` | `if (false) {` | `test/external-session-wiring.test.ts` |
| W2 | a dry run never needs the external variables | `src/kernel/assemble.ts` | `if (dryRun \|\| config.llm.provider === "mock") {` | `if (config.llm.provider === "mock") {` | `test/external-session-wiring.test.ts` `test/cli.smoke.test.ts` |
| W3 | the Worker says it is wall-limited | `src/worker/runtime.ts` | `wallLimited: true,` | `wallLimited: false,` | `test/worker.test.ts` |
| W4 | the flag reaches buildLlm | `src/kernel/assemble.ts` | `wallLimited: parts.wallLimited ?? false` | `wallLimited: false` | `test/worker.test.ts` |
| D1 | doctor does not print a model nothing calls | `src/cli.ts` | `runtime.config.llm.provider === "external-session"` | `false` | `test/cli.smoke.test.ts` |
| N1 | the settings screen does not print a model nothing calls | `src/console/page/client/settings.ts` | `: s.llm.provider === "external-session"` | `: false` | `test/console.test.ts` |
| Y1 | a failed comment call fails the schedule step | `src/roles/publisher.ts` | `if (!comments.ok) return comments;` | `if (false) return comments;` | `test/external-session-cycle.test.ts` |
| Y2 | one budget spans the steps of a run | `src/llm/external-session.ts` | `if (!current \|\| nowMs - current.lastCallEndedAtMs > gapMs) {` | `if (true) {` | `test/external-session-cycle.test.ts` |
| Y3 | a provider Err is retryable, so the cycle resumes at schedule | `src/llm/external-session.ts` | `retryable: true, abortsRun: endsRun,` | `retryable: false, abortsRun: endsRun,` | `test/external-session-cycle.test.ts` |
| Y4 | the errors that end a run carry abortsRun | `src/llm/external-session.ts` | `endsRun = ABORTS_RUN_CODES.has(code),` | `endsRun = false,` | `test/external-session-provider.test.ts` `test/external-session-cycle.test.ts` |
| O1 | a provider abort stops the write step (retryably) instead of skipping the idea | `src/kernel/orchestrator.ts` | `` return stoppedByProvider(result.error, `${draftIds.length} of ${approved.length} drafts written`); `` | `void 0;` | `test/external-session-cycle.test.ts` |
| O2 | a provider abort stops the inspect step (retryably) instead of skipping the draft | `src/kernel/orchestrator.ts` | `` return stoppedByProvider(result.error, `${reports.length} of ${draftIds.length} drafts inspected`); `` | `void 0;` | `test/external-session-cycle.test.ts` |
| O3 | the write note always says how many failed | `src/kernel/orchestrator.ts` | `` const writeTally = `${draftFailures.length} of ${approved.length} failed`; `` | `const writeTally = "";` | `test/external-session-cycle.test.ts` |
| O4 | the inspect note always says how many failed | `src/kernel/orchestrator.ts` | `` const inspectTally = `${uninspected.length} of ${draftIds.length} failed`; `` | `const inspectTally = "";` | `test/external-session-cycle.test.ts` |
| P2 | every failure code has words on the console | `src/console/labels.ts` | `"external_session.timeout": {` | `"external_session.timeout_x": {` | `test/external-session-cycle.test.ts` |
| X1 | our implementation plans do not ship to licensees | `scripts/make-release.ts` | `"docs/superpowers",` | `"docs/superpowers.off",` | `test/release.test.ts` |
| FX1 | on the Worker no idle gap starts a new run (the latch and the budget hold for the whole invocation) | `src/llm/external-session.ts` | `const gapMs = wallLimited ? Number.POSITIVE_INFINITY : (` | `const gapMs = false ? Number.POSITIVE_INFINITY : (` | `test/external-session-provider.test.ts` |
| FX2 | on the Worker the run starts when the provider is built, not at the first call | `src/llm/external-session.ts` | `let current: Window \| undefined = wallLimited ? {` | `let current: Window \| undefined = false ? {` | `test/external-session-provider.test.ts` |
| FX3 | buildLlm hands the Worker's wall cap to the provider itself, not only to the budget | `src/kernel/assemble.ts` | `wallLimited: deps.wallLimited,` | `wallLimited: false,` | `test/external-session-wiring.test.ts` |
| FX4 | a busy slot ends write/inspect retryably instead of dropping the remaining items | `src/llm/external-session.ts` | `EXTERNAL_SESSION_ERROR.busy, EXTERNAL_SESSION_ERROR.superseded,` | `EXTERNAL_SESSION_ERROR.superseded,` | `test/external-session-provider.test.ts` `test/external-session-cycle.test.ts` |
| FX5 | a superseded call ends write/inspect the same way | `src/llm/external-session.ts` | `EXTERNAL_SESSION_ERROR.busy, EXTERNAL_SESSION_ERROR.superseded,` | `EXTERNAL_SESSION_ERROR.busy,` | `test/external-session-provider.test.ts` |
| FX6 | a fire refused with 401/403/404 ends the run; 429/5xx do not | `src/llm/external-session.ts` | `RUN_ENDING_FIRE_STATUSES.has(outcome.status),` | `false,` | `test/external-session-provider.test.ts` |
| FX7 | an answer already returned is never adopted again (plan.no_ideas retry) | `src/llm/external-session.ts` | `if (isConsumedJob(job)) return undefined;` | `if (false) return undefined;` | `test/external-session-provider.test.ts` |
| FX8 | a polled answer is marked consumed when it is returned | `src/llm/external-session.ts` | `await markConsumed(job.id);` | `void 0;` | `test/external-session-provider.test.ts` `test/external-session.test.ts` |
| FX9 | an adopted answer is marked consumed too | `src/llm/external-session.ts` | `await markConsumed(prepared.value.adopted.jobId);` | `void 0;` | `test/external-session-provider.test.ts` |
| FX10 | the consumed mark is conditional on the id, so it never overwrites another caller's job | `src/llm/external-session.ts` | `if (slot.kind !== "job" \|\| slot.job.id !== jobId \|\| isConsumedJob(slot.job)) return;` | `if (slot.kind !== "job") return;` | `test/external-session-provider.test.ts` |
| FX11 | consumed is not the tombstone: the poller is still told done | `src/kernel/external-session.ts` | `return { ...job, consumedAt: atIso };` | `return { ...job, discardedAt: atIso };` | `test/external-session.test.ts` `test/external-session-store.test.ts` |
| FX12 | a slot whose consumedAt is not a string is not a job | `src/kernel/external-session.ts` | `(record["consumedAt"] === undefined \|\| typeof record["consumedAt"] === "string")` | `true` | `test/external-session-store.test.ts` |
| FX13 | a store that throws on refresh/read is read as unreadable, not an exception | `src/llm/external-session.ts` | ``return { kind: "unreadable", detail: `the store threw: ${String(cause)}` };`` | `throw cause;` | `test/external-session-provider.test.ts` |

### この表が守らないもの

- **fire 拒否時のヒント文**は、どの行でも守られていない（文言を変えても赤くならない）。
- **consumed の印を書く1往復**（読み直してから書くまで）の間に別の呼び出しがスロットに書いた場合は、印が相手のジョブを上書きしうる。捨てる（tombstone）のと同じ窓で、スロットに compare-and-set が無いので閉じられない。印の書き込みが失敗した場合、その答えは採用可能なまま残る（修正前と同じ振る舞い）。
- **Task 6 の孤児ドラフト数とリビジョンの加算**は、テストが事実として固定している。変異行はない（数字を変えるだけの変異になる）。
- **`external_session.*` のコンソール表示ラベル**は、行があるのが P2（`.timeout`）だけ。残り9個のラベルに行はない。
- 1行は「**1か所の変更で赤くなる**」ことしか示さない。同じ関数の別のバグを捕まえるとは限らず、関数にバグが無いことの証明でもない。
- この表は **2026-09-30 に1回だけ**走らせた（全49行（M18 を含む）が終了コード 0）。以後のリファクタで弱まっていないかは、再実行しないと分からない。
  - **2026-10-01 追記（最終レビューの修正）：** FX1〜FX13 を足し、`problem()` の書き換えに合わせて Y3・Y4 の `--from` を差し替えた（旧 `--from` はもう実物に無い）。その上で表の全行（63行）を再実行し、全行が終了コード 0 だった。
