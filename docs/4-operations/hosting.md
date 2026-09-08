# どこで動かすか — 調査結果と、まだ決まっていないこと

> **決定前の調査記録。** 2026-09-03 時点で確かめた事実と、その含意。
> 価格と上限は変わる。数字を根拠に何かを決める前に、必ず一次情報で確かめ直すこと。
> 現行の実装は「常駐プロセス ＋ ローカルの JSON ファイル」で、そのまま動くのは
> 4節の「今のまま動く置き場所」だけ。

ライセンシーは、フォークしたあと**どこかでこれを動かし続ける**必要がある。
毎朝サイクルを回し、投稿の枠が来たら公開し、`/go/<code>` のリダイレクトを
公開ドメインで受ける。この3つを満たす場所を選ぶ話。

リダイレクトが公開されていないと**クリックが1件も記録されない**（`doctor` が
`measurement: INCOMPLETE` と言い続ける）。だから「ドメインと常時稼働」は
運用の前提であって、あとから足せる飾りではない。

---

## 1. Vercel を前提にできるか — 調べた結果

**結論: 動かせる。ただしライセンシーは有料プラン（Pro）が要り、コード側に4つの変更が要る。**

### 1.1 Hobby（無料）は使えない

Vercel の Fair Use Guidelines は Hobby を**非商用の個人利用**に限っている。
商用の定義は「そのプロジェクトの制作に関わった誰かの金銭的利得を目的とする
デプロイ」。アフィリエイト運用はそれ自体が金銭的利得なので、例外の余地はない。

→ **ライセンシーは Pro。** $20/席/月。$20 ぶんの利用クレジットが含まれ、
超過は従量（転送量 1TB 込み、以降 $0.15/GB）。

### 1.2 Cron の頻度が、プランで決定的に変わる

| | ジョブ数 | 最短の間隔 |
|---|---|---|
| Hobby | （最近 100/プロジェクトに緩和との情報あり。要確認） | **1日1回** |
| Pro | 同上 | **毎分** |

Hobby で `0 * * * *`（毎時）を書くとデプロイが
`Hobby accounts are limited to daily cron jobs` で落ちる。

→ **投稿枠のディスパッチは Hobby では原理的に不可能。** 枠は分単位で来る。
Pro なら問題ない。

### 1.3 ファイルシステムは読み取り専用

書けるのは `/tmp` だけ（最大 500MB）で、呼び出しをまたぐと消える。

→ `.amp/` 以下の JSON ストアは動かない。`paused.json`、`venture-state.json`、
`config-backups/` も同じ。**保存先は外部の DB になる。**

→ **探索担当の提案を採用したときの `platform.config.yaml` への追記も動かない。**
`--print-only` 相当（ブロックを画面に出し、ライセンシーが自分のフォークに貼って
push、再デプロイ）が Vercel での唯一の経路になる。これは劣化ではなく、
「設定はライセンシーのもので、履歴は git に残る」という元の思想どおり。

### 1.4 実行時間は足りる

Fluid compute を有効にすると Pro / Enterprise で最大 **800秒** が正式提供、
Node と Python は最大 **30分** がベータ。300秒を超える設定には Pro 以上が要る。

→ 1サイクル（6役割ぶんのモデル呼び出し、出力上限は最大64Kまで設定可能）でも
収まりうる。ただし**1回の起動で1役割だけ進める**ほうが安全。オーケストレータは
元々そのために再開可能に作ってある。

### 1.5 データベースは Neon

Vercel 自身の Postgres は 2025年6月に終了し、後継として Neon がマーケット
プレイスに統合された。接続文字列は自動で注入され、プール接続がサーバレス向き。
無料枠がある。

→ **保存先アダプタの既定は Neon（Postgres）。**

### 1.6 未確認のまま残っている1点

このリポジトリは「ビルド無し・`import { x } from "./y.ts"` と拡張子つき」で書く。
esbuild は `.ts` を解決できるが、**Vercel のデプロイで相対 `.ts` import が失敗し、
`.js` に変えたら通った**という報告がある。

→ **1本デプロイして確かめるまで、動くとも動かないとも言えない。** 通らなければ、
Vercel 向けの入口だけをビルド対象にする。`src/` の書き方は変えない。

---

## 2. Cloudflare — 同じ工事で、4分の1の値段

**結論: サーバレスに寄せるなら、Vercel より Cloudflare のほうが条件がいい。**
必要な工事は同じ（3節）で、値段と上限が違う。

### 2.1 無料枠に「非商用限定」がない

Cloudflare の Workers 無料プランには、Vercel のような非商用限定の条項がない。
商用で使ってよい。ただし**無料のままでは足りない**（2.3）。

### 2.2 Cron は無料でも毎分

`* * * * *` が書ける。Cron Trigger の数は無料5・有料250。
**Vercel の「Hobby は1日1回」に相当する壁がない。**

### 2.3 決め手は課金の単位 — 待ち時間は CPU 時間に入らない

Cloudflare は**CPU 時間**で数える。`fetch()` の応答を待っている時間は算入されない。
このプラットフォームの1サイクルは、6役割ぶんのモデル呼び出しの**ほとんどが待ち時間**。
つまり、いちばん高くつくはずの部分がタダで済む。

| | Workers Free | Workers Paid（$5/月） |
|---|---|---|
| HTTP 1回あたり CPU | **10 ms** | 30秒（最大5分まで引き上げ可） |
| Cron 1回あたり CPU | **10 ms** | 30秒（間隔1時間未満）／**15分**（1時間以上） |
| サブリクエスト | 50/回 | 10,000/回 |
| リクエスト | 10万/日 | 1000万/月込み、以降 $0.30/百万 |

→ **無料プランは 10ms CPU で落ちる。** 設定の YAML を読んでスコアを計算するだけで超える。
リダイレクトだけなら無料で足りるが、サイクルは無理。**Workers Paid $5/月**が現実解。

→ 逆に有料なら**1回の起動でサイクル丸ごと**入る。日次サイクルの Cron は間隔が1時間以上なので
CPU 15分、そこに待ち時間は数えられない。**Vercel で必要だった「1回1役割に割る」工夫が要らない。**

### 2.4 保存先は D1（無料枠あり）

SQLite ベース。無料で 5GB・読み500万行/日・書き10万行/日、有料で 25億行/月ほか。
このプラットフォームの規模なら、**有料プランの込み枠に収まる。**

排他制御は Durable Object が使える。DB の行ロックより素直で、
「1つの運用アカウントのサイクルは同時に1つ」をそのまま表現できる。

### 2.5 Node 互換は既定で有効になった

互換日 `2026-08-04` 以降、`nodejs_compat` は既定で有効。`node:fs` も使えるが、
**リクエストごとに独立した揮発の仮想ファイルシステム**なので、保存先にはならない
（D1 が要るのは Vercel と同じ）。設定とプロンプトは同梱して読む形になる。

### 2.6 それでも残る不確かさ

- `workerd` は Node ではない。CLI（`node:test`、`fs`、プロセス起動）は手元に残り、
  **実行環境が2つになる。** 本物のバイナリを起動するスモークテストは Worker 側を守らない。
- バンドルは wrangler（esbuild）。`./y.ts` の解決は Vercel より通りやすいはずだが、
  **これも1本デプロイするまで断定できない。**
- `@anthropic-ai/sdk` が Workers 上で動くかは、実際に叩いて確かめる。

## 3. サーバレスにするなら、実装として何が要るか

Cloudflare を採る場合の具体的な設計は
[Cloudflare で動かす設計](../3-development/cloudflare-design.md)。以下はその要約。

**Vercel でも Cloudflare でも工事は同じ。** 違うのは 3 の粒度（Cloudflare なら
サイクル丸ごと1回でよい）と、4 の実装（Durable Object か DB の行ロックか）。

| # | もの | 大きさ |
|---|---|---|
| 1 | `Store` の SQL アダプタ（D1 か Postgres） | ポート1本。`store.ts` の設計時からの想定（コメントにそう書いてある） |
| 2 | 停止・非アクティブの状態をファイルから DB へ | 小。`pause.ts` と `venture-state.ts` |
| 3 | デーモン → Cron が叩くエンドポイント | 中。Vercel は1回1役割に割る。Cloudflare は丸ごとでよい |
| 4 | ファイルロック → DB の行ロック / Durable Object | 小 |
| 5 | 採用時の追記を print-only に倒す分岐 | 小。経路は既にある |
| 6 | `vercel.json`、環境変数の対応表、手順書 | 小 |

既存のテストは in-memory ストアで書いてあるので、**テストの作り直しは要らない。**
新規に要るのは Postgres アダプタのテストと、Cron 入口のスモークテスト。

---

## 4. 今のまま動く置き場所（コード変更ゼロ）

常駐プロセスと書き込めるディスクがあれば、いまのコードがそのまま動く。
必要なのは Dockerfile 1枚と手順書。

| | 月額の目安 | ドメイン・TLS |
|---|---|---|
| Fly.io | 最小マシン 約$2〜（ボリューム別途、転送 $0.02/GB） | 自分で |
| Render | $7 の Starter | 自分で |
| Railway | Hobby $5 ＋ 従量 | 自分で |
| 自前の VPS ＋ Cloudflare Tunnel | 好きに | **Tunnel なら固定IPも開放ポートも要らない** |

自前の箱に置くなら、公開ドメインの部分だけ Cloudflare Tunnel に任せる手がある。
コードは1行も変えずに、`https://go.<ドメイン>` が生える。

---

## 5. 何を天秤にかけているか

| | Cloudflare Workers | Vercel | Docker（Fly / Render / Railway） |
|---|---|---|---|
| ライセンシーの手間 | フォークして繋ぐだけ。**ドメインと TLS が自動** | 同左 | Dockerfile 1枚。ドメインとTLSは自分で30分〜 |
| ライセンシーの固定費 | **$5/月** ＋ モデル代 | **$20/月〜** ＋ モデル代 | $2〜7/月 ＋ モデル代 |
| 無料枠 | 商用可だが 10ms CPU で足りない | **商用禁止** | — |
| Cron の粒度 | 毎分（無料でも） | 毎分（Pro のみ） | 自前 |
| サイクルの分割 | 不要（待ち時間は課金されない） | 1回1役割に割る | 不要 |
| こちらの実装 | 中規模（3節） | 中規模（3節） | ほぼゼロ |
| オンボードの最難関（第9段） | **消える** | **消える** | 残る |

**ライセンスは無償で、ライセンシーには自分の事業として頑張ってもらう。**
その相手に月いくらの固定費を求めるか。$5 と $20 の差は、初月の説得力の差になる。

両方を用意することはできる（保存先はポート、入口が増えるだけ）。
その場合でも**既定をどちらにするかは決める必要がある** — 手順書とオンボードは
1本道でないと機能しないため。

## 6. 出典

- [Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines) / [Hobby プラン](https://vercel.com/docs/plans/hobby)
- [Cron の課金と上限](https://vercel.com/docs/cron-jobs/usage-and-pricing) / [100 jobs per project](https://vercel.com/changelog/cron-jobs-now-support-100-per-project-on-every-plan)
- [関数の上限](https://vercel.com/docs/functions/limitations) / [最大30分](https://vercel.com/changelog/vercel-functions-can-now-run-up-to-30-minutes)
- [Vercel Postgres から Neon への移行](https://neon.com/docs/guides/vercel-postgres-transition-guide)
- [`allowImportingTsExtensions`](https://www.typescriptlang.org/tsconfig/allowImportingTsExtensions.html)
- Cloudflare: [Workers の上限](https://developers.cloudflare.com/workers/platform/limits/) / [価格](https://developers.cloudflare.com/workers/platform/pricing/) / [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) / [D1 の価格](https://developers.cloudflare.com/d1/platform/pricing/) / [Node.js 互換](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
