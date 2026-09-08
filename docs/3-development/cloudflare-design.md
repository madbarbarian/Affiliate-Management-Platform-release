# Cloudflare で動かす設計

> **段1〜5は実装済み（2026-09-04）。残るのは段6（実デプロイでの検証）と段7。** 実装で分かったことは
> 各節に反映してある。調べた事実と、他の置き場所との比較は
> [どこで動かすか](../4-operations/hosting.md)。
> ここは「Cloudflare Workers を既定にするなら、コードをどう変えるか」だけを書く。

ライセンシーがフォークして Cloudflare に繋ぐと、`https://<自分のドメイン>` に
承認画面と `/go/` のリダイレクトが立ち、Cron が毎日のサイクルと投稿を回す。
月 $5、ドメインと TLS は自動、常駐サーバは要らない。

---

## 1. 設計の原則

**Worker は入口を1つ増やすだけで、置き換えではない。**
`node src/cli.ts daemon` は今までどおり動く。理由は3つ。

- 先行利用者は来週から動かす。Workers 対応が間に合わなくても、その人の運用は止まらない。
- `workerd` は Node ではない。CLI（`doctor`、`cycle run`、`scout accept`）は手元で動く必要があり、
  **実行環境は2つになる。** 片方を消すと、もう片方のデバッグ手段が消える。
- 実際に動かしてみるまで分からないことが2つ残っている（6節）。逃げ道を残す。

**変えるのは「外の世界に触る部分」だけ。** 役割（`src/roles/`）、判断
（`src/domain/`、`src/playbook/`）、ガードレール（`src/kernel/policy.ts`）、
プロンプト（`prompts/`）は**1行も変えない。** ポートは足す、置き換えない。

## 2. 配置

```
  Cron Trigger  0 * * * *   ──►  scheduled()  ──►  due な運用アカウントのサイクル
  Cron Trigger  * * * * *   ──►  scheduled()  ──►  投稿の枠 ＋ 指標の取り込み
                                      │
  ブラウザ ─── fetch() ──► 承認画面 ／ /go/<code>
                                      │
                          ┌───────────┼───────────┐
                          ▼           ▼           ▼
                        D1        Durable      Anthropic ／
                    （保存先）    Object       チャネル ／ ASP
                                （排他制御）      （fetch）
```

**Cron を2本に分ける理由は CPU 枠。** Cloudflare の Cron Trigger は、間隔が
1時間以上なら CPU 15分、1時間未満なら 30秒。サイクルは6役割ぶんのモデル呼び出しで、
**待ち時間は CPU に数えられない**とはいえ、JSON の組み立てとスコア計算は積み上がる。
重いほうを1時間 Cron に置いて 15分枠を取り、軽いほうを毎分 Cron に置く。

これで `cycleStartsAt` の精度は「時」単位に落ちる（毎分 Cron からサイクルを
起動すると 30秒枠になるため）。運用上は問題ない — 1日1回のサイクルが 9:00 に
始まるか 9:07 に始まるかは、誰にも影響しない。**設定の意味が変わるので、
`cycleStartsAt` の分は Workers では無視されると明記する。**

## 3. 変える6か所

### 3.1 保存先 — `Store` の SQL アダプタ

`src/storage/store.ts` の `Store` は最初からポートで、コメントにこう書いてある。
「swapping the shipped JSON store for Postgres, D1 or Supabase is one file」。
そのとおりにする。

```
src/storage/sql-store.ts     Store の実装。SQL は SqlDriver 越しに発行する
src/storage/sql-driver.ts    型: all / run / batch
src/storage/sqlite-driver.ts node:sqlite。テストと、サーバ不要の1ファイルDB
src/storage/d1-driver.ts     D1Database を SqlDriver に合わせる薄い層（未実装）
```

**設計時の想定が1つ良いほうに外れた。** SQL をフェイクのドライバでしか試せないと
書いたが、**`node:sqlite` が Node に内蔵されている**（依存は増えない）。D1 は SQLite なので、
**本番で D1 が実行するのと同じ文が、テストで本物の SQLite に対して走る。**
5節の「フェイクドライバ」は不要になった。ついでに、サーバを立てたくないライセンシー
向けの1ファイルDBがそのまま手に入る。

テーブルは3つだけ。**コレクションごとにテーブルを作らない。**

```sql
CREATE TABLE records (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  seq        INTEGER NOT NULL,   -- 並び順のためだけ。差し替えても位置は動かない
  json       TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX records_order ON records (collection, seq);
CREATE TABLE audit (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  venture_id TEXT,
  cycle_id   TEXT,
  json       TEXT NOT NULL
);
CREATE INDEX audit_venture ON audit (venture_id, seq DESC);
CREATE INDEX audit_cycle   ON audit (cycle_id, seq DESC);
CREATE TABLE state (key TEXT PRIMARY KEY, json TEXT NOT NULL);
```

`seq` は契約テストが要求する「`all()` は最初に入れた順」を満たすためだけにある。
upsert は `seq` を書き換えないので、差し替えても末尾に動かない。

理由は**挙動を変えないこと**に尽きる。`Collection` の `find(predicate)` は
JavaScript の述語を受け取る。SQL に翻訳する道はない。いまの JSON ストアは
コレクションを丸ごと読んでメモリで絞っているので、SQL 版も同じにする
（`SELECT json FROM records WHERE collection = ?` → JS で `filter`）。
**型ごとの列を作った瞬間に、型を変えるたび移行が要る**（未決事項 14）。
1行1 JSON なら、いまと同じく型の変更に移行が要らない。

行数の見積もり: 1アカウントが1日3本出して1年で、投稿・案・草稿・検品・指標・
クリックを足して数万行。読みは1サイクルあたり数千行。**D1 の有料枠（読み250億行/月）
はもちろん、無料枠（読み500万行/日）にも収まる。** 速さのために列を切るのは、
遅くなってからでいい。

`flush()` は何もしない（書きは即時）。`close()` も何もしない。

### 3.2 状態3つ — ファイルから `state` テーブルへ

いま `.amp/` に3つのファイルがある。

| いま | 何を守っているか | Workers では |
|---|---|---|
| `paused.json` | 緊急停止。**壊れていたら止まったものとみなす**（fail-closed） | `state` の1行 |
| `venture-state.json` | 非アクティブ。**壊れていたら何も止めない**（fail-open） | `state` の1行 |
| `config-backups/` | 設定を追記する前の控え | **無くなる**（3.3） |

`src/kernel/pause.ts` と `src/kernel/venture-state.ts` は `readFileSync` を直接呼んでいる。
これを `StateStore`（`read(key)` / `write(key, text)` / `label(key)` /
`refresh()`）越しにする。**fail-closed と fail-open の性質はポートの外側に残す** —
そこが安全性の本体で、保存先が変わっても変わってはいけない。

**読みは同期のまま。** tick は公開する前にこれを見るので、そこに `await` を挟むと
停止を見落とす窓ができる。同期で答えられない DB 版は、`refresh()` が読み込んだ
スナップショットから答える。**最初の `refresh()` が成功するまで、すべての読みは
`unreadable`** — つまり停止扱い。refresh を忘れた入口は、止まる側に倒れる。

### 3.3 設定とプロンプト — 同梱して読む

**実装のかたち:** `npm run build`（= `scripts/bundle-worker.ts`）が
`src/worker/bundled.generated.ts` を書く。中身は設定の全文、プロンプト14枚、
そして**ライセンシー自身の設定があるかどうか**。Cloudflare は配置の前に
`build` を実行するので、これは自動で走る。生成物は commit しない。

Workers のファイルシステムは書けない（`node:fs` はあるが、リクエストごとに
独立した揮発の仮想 FS）。だから設定とプロンプトは**ビルド時に同梱**する。

- 設定: `buildConfig(text, path, env)` が既に純粋関数なので、
  Worker は import した文字列を渡すだけ。`loadConfig`（fs 版）はそのまま残る。
- プロンプト: `createPromptLibrary(directory)` の隣に
  `createPromptLibraryFrom(files: Record<string, string>)` を足す。
  レンダリングのロジックは共有。
- 秘密: `.env.local` の代わりに `wrangler secret put`。
  `ANTHROPIC_API_KEY`、`AMP_CONSOLE_TOKEN`、チャネルと ASP のトークン。
  **設定ファイルに秘密を書かない**という規則はそのまま守られる。

**設定を変える手順が変わる。** ライセンシーは自分のフォークの
`platform.config.yaml` を編集して push、再デプロイ。git に履歴が残るので、
`config-backups/` は要らなくなる。

その帰結として、**探索担当の提案を採用したときの追記が動かない。**
Workers では `--print-only` 相当だけになる — ブロックを画面に出し、
ライセンシーが自分のフォークに貼って push。承認画面は既に「追記できたか／
できなかったか」を記録から表示するので、**画面の作りは変えなくていい**。

### 3.4 入口 — ルータを1つにする

`src/console/server.ts` の `handle()` は、いまも実質「URL とメソッドを見て
分岐し、本文を返す」関数で、`node:http` の `IncomingMessage` /
`ServerResponse` に直結しているだけ。ここを切る。

```
src/console/router.ts    handleRequest(request: Request, runtime): Promise<Response>
src/console/server.ts    node:http のアダプタ。router を呼ぶ
src/worker/index.ts      fetch() で router を呼ぶ。scheduled() で tick を呼ぶ
```

**認証（Bearer と Cookie、`timingSafeEqual`）、UI、承認の判断は1つのまま。**
2実装になると、片方だけ直したセキュリティ修正が生まれる。ここは以前
実際に穴（空トークンで全ルートが通る）が見つかった場所なので、二重化しない。

### 3.5 スケジューラ — 1 tick を関数にする

`src/scheduler/daemon.ts` は `setInterval` の中に「1 tick 分の仕事」を抱えている。
それを `src/scheduler/tick.ts` に出す。

```ts
export async function runTick(runtime, memory: TickMemory, nowMs: number, parts?: TickParts): Promise<void>
```

- デーモン（Node）: 毎分、両方。`TickMemory` はプロセスが持つ。いまと同じ。
- Worker: 毎分 Cron が `{ dispatch: true, cycles: false }`、1時間 Cron が `{ cycles: true }`。
  毎回まっさらな `TickMemory` を渡す。

**同じ関数を呼ぶ。** 分岐は「いつ呼ぶか」だけ。まっさらな記憶で呼んでも二重には
ならない — 1日を繰り返さない保証はオーケストレータの `cyc_<venture>_<date>` であって、
記憶ではない（`test/tick.test.ts` がそれを言う）。

### 3.6 排他制御 — `LockPort`

いまは `.amp/.lock` ディレクトリ（15分で失効）。Workers では Durable Object。

```
src/storage/lock.ts       LockPort: acquire(name, ownerId) / release()
src/worker/lock-do.ts     Durable Object 実装
```

**Cron は重複して起動しうる**（前回が長引いた、Cloudflare 側の再試行）。
ロックが無いと、同じアカウントのサイクルが二重に走り、同じ投稿が二度出る。
いまの JSON ストアはプロセスロックでこれを防いでいる。Workers では
Durable Object が「1アカウントにつき同時に1つ」をそのまま表現する。

**これは未決事項 13（ステップ途中で落ちたときの二重投稿）とは別問題で、
そちらは残る。** Workers に移ると Cron の再試行という新しい引き金が増えるので、
未決 13 の優先度は上がる。実運用の前に片づける。

## 4. 変えないもの

- `src/roles/`、`src/domain/`、`src/playbook/`、`src/affiliate/`、`src/kernel/policy.ts`
- `prompts/` の全ファイル
- `platform.config.yaml` のスキーマ（`cycleStartsAt` の分が Workers で無視される点だけ注記）
- 既存のテスト。`test/helpers.ts` はメモリストアで組むので、そのまま通る

## 5. テストをどう当てるか

**`Store` の契約テストを1本書き、3実装すべてに当てた。**（メモリ、JSON、SQL）
順番としてこれが先だったのは正しく、書いた時点で**2件の食い違いが出た** —
ファイル版の `forCycle` が呼び出し側の並び順を無視していたのと、メモリ版の
`recent(0)` が `slice(-0)` で全件返していたの。

SQL 版は `node:sqlite` に対して同じ契約を通す。**本物の D1 は
`wrangler dev --local` で1本だけスモークを回す** — `records` に書いて読める、
`audit` が順番に並ぶ、それだけ。

`test/cli.smoke.test.ts` は本物のバイナリを起動する。**Worker 側は守らない。**
そこは `wrangler dev --local` に対する HTTP スモーク（承認画面が開く、
`/go/` が 302 を返す、Cron が1回走る）を別に置く。

## 6. 実際に動かして分かったこと（2026-09-04）

**アカウントは要らなかった。** `wrangler dev --local` は本物の `workerd` と
ローカルの D1 を立てる。文書では決着しないと書いた2つは、ここでほぼ潰れた。

1. **`./y.ts` 付きの import を wrangler が解決するか → する。**
   `wrangler deploy --dry-run` でバンドルが通った。790 KiB（gzip 184 KiB）で、
   有料プランの上限 10 MB に対して十分小さい。**`src/` の書き方を変える必要はない。**
2. **`@anthropic-ai/sdk` が `workerd` で読み込めるか → 読み込める。**
   モジュールグラフ全体が起動し、`/healthz`、承認画面、`/go/` が答えた。

さらに、**1日ぶんの流れが丸ごと `workerd` の上で通った。**

```
Cron（毎分・毎時）を叩く
  → 分析 → リサーチ → 企画（10案）→ 承認①（人）
  → 執筆 → 検品 → 枠決め → 承認②（AIっぽさ 22 / PR 警告 / 22:30 の枠）
```

保存先は本物のローカル D1。スキーマは初回リクエストで自分から張られた。
承認画面の `/api/state` は 200 を返し、全アカウント表もプレイブック（0/3）も出た。
`wrangler dev` は `.env.local` を読むので、手元では合言葉も鍵もそのまま効く。

### まだ確かめていないこと

- **Anthropic への実際のストリーミング呼び出し。** 上の検証は `llm.provider: mock`。
  鍵を持ち込めば分かるが、`output_config` と SSE の経路だけは本番の鍵が要る。
- **ホストされた側**: `workers.dev` のアドレス、Cron が本当に毎分来るか、
  Deploy ボタンの一連（複製・D1 の自動作成・秘密の入力欄）、`wrangler secret`。
  ここだけは Cloudflare のアカウントが要る。

## 7. 段取りと、先行利用に間に合うか

| 段 | 中身 | Workers に行かなくても価値があるか |
|---|---|---|
| 1 | `Store` の契約テスト（3実装共通） | **済。** 実装の食い違いが2件見つかって直った |
| 2 | `StatePort` を切る | **済。** fail-closed / fail-open はポートの外に残した |
| 3 | `router.ts` と `tick.ts` の抽出 | **済。** 振る舞いは変えていない |
| 4 | `sql-store.ts`（＋ `sql-state.ts`）と、本物の SQLite に対する契約テスト | **済** |
| 5 | `src/worker/`、`d1-driver.ts`、Durable Object のロック、`wrangler.jsonc`、同梱、秘密、設定が無くても起動してセットアップ画面を出すこと | **済** |
| 6 | **実デプロイでの検証**（6節） | 未。Cloudflare アカウントが要る |
| 7 | 手順書、`doctor` の Workers 対応、オンボードの第9段の書き換え | 未 |

段1〜5で `npm run check` は 265 テスト。`/code-review` は段1〜4で4件（うち2件は `--dry-run` と探索担当が実際に壊れていた）、
段5で12件を出した。段5でとくに効いたのは3つ。

- **設定が壊れた瞬間に `/go/` が死ぬ設計になっていた。** 公開済みの投稿に入っている
  リンクが全部セットアップ画面に化ける。記録されなかったクリックは後から数えられない。
  → リダイレクトは `Store` と id と時計だけを要求するようにして、他が組み立たなくても答える。
- **`scheduled` がロックを取っていなかった。** 設計（3.6）に書いておきながら、
  `LockPort` を作って呼んでいなかった。Cron の重複起動で同じ投稿が2回出る。
  → Durable Object を実装して繋いだ。テストは「2回目がデータベースに触らないこと」を見る。
- **リリースに私物の設定が混入する経路。** `bundled.generated.ts` は設定の全文を
  文字列として持つ。禁止リストはファイル名しか見ていない。→ 除外に追加。

**1〜4は、Workers を採らなくても捨てにならない。** 振る舞いを変えない整理で、
既存のテストが通り続けることが条件。ここから始めるのが安全。

**間に合うかの判断。** 1〜5 はこちらだけで進められる。読めないのは 6 で、
これには**あなたの Cloudflare アカウントと、繋ぐドメインが要る**。
6.2（SDK が動かない）を引いた場合、追加で半日。

したがって:

- **コードは間に合う見込み。** 段 1〜5 は今日から着手できる。
- **間に合うかを決めるのは段 6。** ここで詰まったら、先行利用者は
  Docker ＋ Cloudflare Tunnel で始める（コード変更ゼロ、いつでも実行可能）。
  1〜4 は無駄にならないので、**賭けにならない。**

## 8. ライセンシーが迷わないこと

**受け取ってから1本目までを、リンク1つから繋げる。** 詳しい流れは
[オンボード設計](../2-setup/onboarding.md)。設計に効く点だけここに書く。

- **Deploy to Cloudflare ボタン**が、リポジトリの複製・D1 と Durable Object の
  作成・秘密の入力・ビルド・配置・CI/CD をやる。こちらが用意するのは
  `wrangler.jsonc`、`.env.example`（秘密の一覧）、`package.json` の
  `cloudflare.bindings`（各入力欄の説明文）、README のボタン1行。
- **`workers.dev` が無料で公開される**ので、ライセンシーはドメインを買わなくてよい。
  `/go/` が初日から動く＝**計測経路が初日に閉じる**。
- **設定が無い状態で Worker が起動できること**（実装済み）。設定が無いフォークでは
  `configSource` が `example` になり、入口はセットアップ画面を返す。
  設定はあるが検証に落ちるとき、鍵が足りないときも同じ画面で、理由だけが変わる。
  **`/healthz` と `/go/` はその手前で答える。**
- **残る食い違いが1つ。** デプロイ画面は「AIモデルの鍵はあとで構いません」と言うが、
  いまの実装では鍵が入るまで承認画面が開かない（練習用の文章で回るのは
  未実装のセットアップ・ウィザードの中の話）。セットアップ画面には
  「鍵が入ってから開きます」と書いてある。ウィザードを作るまでの既知の差。
- **承認画面は設定を保存できない**（読み取り専用FS）。セットアップ画面は
  できあがった YAML を出し、ライセンシーが自分のリポジトリに貼る。貼れば push、
  push すれば再デプロイ。探索担当の採用と同じ経路。

## 9. 決めてもらうこと

1. 段 1〜4 に着手してよいか（振る舞いを変えない整理。Workers を採らなくても価値がある）
2. 段 6 のための Cloudflare アカウントと、`go.<何か>` を生やせるドメインはあるか
3. `cycleStartsAt` の分が Workers で無視されることを受け入れるか
   （受け入れないなら、サイクルも毎分 Cron に置いて 30秒 CPU 枠で回す設計になる）
4. 8節の流れ（メールのボタン → Cloudflare → 承認画面の中でセットアップ →
   YAML を貼る）でよいか。よければオンボードのキャンバスを描き直す
