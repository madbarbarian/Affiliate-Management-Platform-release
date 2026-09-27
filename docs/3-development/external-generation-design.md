> **English is the record; the Japanese version follows below as a supplement** (owner decision, 2026-09-26). If they disagree, the English wins.

# Using the licensee's own Claude for generation (design memo, not implemented)

A continuation of `docs/5-project-management/decisions.md`, 2026-09-20 and 2026-09-25 (two entries). The decisions and their reasons are there. **Not to be implemented yet.**

## 🔴 This does not replace the existing mechanism (owner, 2026-09-25)

**The current Cron + Anthropic API autopilot is not being removed. It stays the default.**

The form described here merely **adds a third option** to `llm.provider: anthropic | mock`; it does not replace `anthropic`. When implementing, and when recording, leave the existing descriptions untouched and set the new option beside them.

**It is irrelevant to licensees on the Free plan.** As described below, this feature itself is available only on Pro or above, so Free-plan users can only choose the API route (online mode), as they do today.

## 🔴 Correction (2026-09-25, second time): the "means" of reversing the direction was wrong

The previous version wrote this here:

> ✕ The platform (Worker) goes out and calls the licensee's Claude
> ○ The licensee's own Cowork scheduled run (or a script of their own)
>   comes and calls the platform's endpoint

**The premise that "the platform cannot call the licensee's Claude" was a guess that had not been checked.** When actually investigated, the opposite is true: **an official Anthropic route for calling it exists.**

### Confirmed information (verified in the official documentation)

A `Cowork` scheduled run runs on time alone and cannot be started by an outside call (this part of the previous version's understanding was correct).

**However, `Claude Code` has a separate feature called `Routines`, and it has an API trigger:**

```
POST https://api.anthropic.com/v1/claude_code/routines/{routine_id}/fire
Authorization: Bearer <token issued by the licensee themselves>
```

- **The URL and token are issued by the licensee themselves for their own routine** (on the `claude.ai/code/routines` screen, "Add trigger → API")
- **Simply POSTing to this URL starts a cloud session of the licensee's own Claude Code**
- **The started session consumes the usage allowance of the licensee's own account and subscription** ("Routines draw down subscription usage the same way interactive sessions do")
- **Available on Pro / Max / Team / Enterprise. Not available on the Free plan** ("Routines are available on Pro, Max, Team, and Enterprise plans.")
- **The instructions (prompt) that run are only those the licensee saved beforehand.** The `text` that can be passed at POST time is merely supplementary information; it is wrapped as `<routine-fire-payload>` in a frame of "untrusted external data", and Claude does not execute it as a command unless the routine's own instructions explicitly refer to it. This is a safety design in which **the platform cannot inject arbitrary instructions into the licensee's Claude**
- The started session is a **full Claude Code session** and can use shell commands, skills and connected connectors. Where the network can reach depends on the environment settings, and **by default the allowlist is narrow**; for the session to be able to call this platform's endpoint, the licensee must explicitly allow the domain in their routine's environment settings

Sources: [Automate work with routines - Claude Code Docs](https://code.claude.com/docs/en/routines),
[Schedule recurring tasks in Claude Cowork](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)

### So the conclusion about direction is corrected as follows

```
✕ (previous understanding) The platform cannot go out and call the licensee's Claude
○ (corrected)              The platform can "wake up" the licensee's Claude Code routine,
                           using a token the licensee issued themselves
```

It becomes essentially the same thing as genie's `launchd → claude -p`, hosted by Anthropic itself in the cloud and **callable from outside on nothing more than the licensee's own signal (issuing the token)**. The skeleton of the conclusion, "reverse the direction", does not change, but instead of "the licensee's side comes to read (polling)" it becomes "the platform goes to wake it up (push)"; **a form closer to Cron, with less delay.**

## What was used as reference (still valid)

`scripts/inbox-triage.sh` in `genie` (a separate repository, the same developer's own). A real, working example in which `launchd` (scheduled execution) starts `claude -p` (headless) directly.

The disciplines borrowed from it:

1. **Give Claude no tools.** The caller does all input and output; Claude is handed an already-assembled prompt and returns only JSON
2. **Always attach a timeout watchdog** (a headless call can hang)
3. **Accept only structured JSON.** Do not interpret free-form text

Item 1 is the same discipline as this platform's `context.llm.completeJson(...)`, so **it can be plugged in as is.** However, a Routine is a **full session** (the no-tools restriction cannot be imposed), so this discipline takes effect not on the "hand to Claude" side but as **making the routine's saved instructions enforce it**: the instructions themselves say "use no other tools, interact only with this endpoint, return JSON".

## Shape (proposal, after correction)

| | |
|---|---|
| Configuration | Add one value, `llm.provider: anthropic \| mock \| external-session` (`anthropic` remains) |
| Secret the platform side holds | The licensee-issued **routine URL and bearer token** (a new setting value, paired with `ANTHROPIC_API_KEY`) |
| Trigger | When the cycle reaches the writing / inspection stage, the platform POSTs to that routine's `/fire` (putting in `text` only the minimum information pointing at which job) |
| One-time setup on the licensee side | (1) Create the routine and save its instructions (content such as "read this platform's endpoint and return JSON in the specified schema"; handed over in a procedure document). (2) Add an API trigger, issue the token, and give it to the platform. (3) In the routine's environment settings, allow network reach to this platform's domain |
| Execution on the licensee side | The started Claude Code session, following the instructions, calls the platform's endpoint (read and write) and generates with its own Claude |
| Validation | The returned JSON is validated with the **same schema** (`src/llm/schema.ts`) that validates model responses today. Inspection (`policy.ts`) does not care about provenance, so it passes through as is (confirmed on 2026-09-25) |
| If it hangs / no reply | Reuse as is the already-implemented **cycle retry limit** (`cycle.retry_abandoned`). Build no new mechanism |

## What has not been confirmed (honestly)

- **The specific number of launches per day allowed is unconfirmed.** The documentation only states that a limit exists
- **This is at the "research preview" stage** ("Behavior, limits, and the API surface may change"). The form that works today is not guaranteed to be the same next month. The same wariness is needed as with the Agent SDK credits matter (announced, then paused)
- **Whether the information passed in `text` can be written so that it meshes with the saved instructions** (the instructions are assumed to be written by the licensee by hand, once, so it depends on the quality of the wording in the procedure document) is unverified
- It is settled that a Free-plan licensee cannot have this option at all. What wording to use to guide those users has not been considered

## Where the on/off setting lives

**It was decided to put it on the settings screen** (owner, 2026-09-25).

**But for now only the decision is placed.** Showing a switch that can be pressed on screen when there is no backend (endpoint, validation, the cycle's new waiting state) would recreate the "the screen lies" pattern we have been fixing all day today. It will be placed together with the backend when that is built.

## Not doing yet

- Implementing `llm.provider: external-session`
- The endpoint (read and write) API
- The cycle's new waiting state
- The settings-screen switch
- A template of the routine instructions to hand to licensees
- Measuring the per-day launch limit

---

# 日本語版（補足・原本）

# ライセンシー自身の Claude を、生成に使う（設計メモ・未実装）

`docs/5-project-management/decisions.md` 2026-09-20・2026-09-25（2件）の続き。判断と理由は
そちらにある。**まだ実装しない。**

## 🔴 これは既存の仕組みを置き換えるものではない（オーナー・2026-09-25）

**いまの Cron＋Anthropic API の自動運転は消さない。既定のまま残る。**

ここに書く形は、`llm.provider: anthropic | mock` に**3つ目の選択肢を足すだけ**であって、
`anthropic` を置き換えるのではない。実装するときも、記録するときも、既存の記述には
手を入れず、隣に選択肢を並べる形にする。

**フリープランのライセンシーには関係ない。**後述のとおり、この機能自体が Pro 以上でしか
使えないため、フリープランの人はいまどおり API 経由（オンモード）しか選べない。

## 🔴 訂正（2026-09-25・2回目）——向きを逆にする「手段」が間違っていた

前の版はここで、こう書いていた：

> ✕ プラットフォーム（Worker）が、ライセンシーの Claude を呼びに行く
> ○ ライセンシー自身の Cowork の予約実行（か自作スクリプト）が、
>   プラットフォームの窓口を呼びに来る

**「プラットフォームがライセンシーの Claude を呼びに行けない」という前提が、確認しないままの
推測だった。**実際に調べたら逆で、**呼びに行く経路が Anthropic 公式に存在する。**

### 確定した情報（公式ドキュメントで確認済み）

`Cowork` の予約実行は時刻だけで動き、外部からの呼び出しでは起動できない
（ここは前の版の理解で合っていた）。

**しかし `Claude Code` には `Routines` という別機能があり、そこに API トリガーがある：**

```
POST https://api.anthropic.com/v1/claude_code/routines/{routine_id}/fire
Authorization: Bearer <ライセンシー本人が発行したトークン>
```

- **URLとトークンは、ライセンシー本人が自分のルーティンに対して発行する**
  （`claude.ai/code/routines` の画面で「Add trigger → API」）
- **このURLに POST するだけで、ライセンシー本人の Claude Code のクラウドセッションが起動する**
- **起動したセッションは、ライセンシー自身のアカウント・サブスクの使用枠を消費する**
  （"Routines draw down subscription usage the same way interactive sessions do"）
- **Pro / Max / Team / Enterprise で使える。Free プランでは使えない**
  （"Routines are available on Pro, Max, Team, and Enterprise plans."）
- **実行される指示文（プロンプト）は、あらかじめライセンシー本人が保存したものだけ**が使われる。
  POST 時に渡せる `text` は補足情報にすぎず、`<routine-fire-payload>` として
  「信頼できない外部データ」の枠に包まれる——ルーティン自身の指示文が明示的に参照しない限り、
  Claude はそれを命令として実行しない。**プラットフォームがライセンシーの Claude に
  勝手な指示を注入できない**という安全設計
- 起動したセッションは**フルの Claude Code セッション**で、シェルコマンド・スキル・
  接続済みのコネクタを使える。ネットワーク到達先は環境設定に依存し、**既定では許可リストが
  絞られている**——このプラットフォームの窓口を呼べるようにするには、ライセンシーが
  自分のルーティンの環境設定で明示的にドメインを許可する必要がある

出典：[Automate work with routines - Claude Code Docs](https://code.claude.com/docs/en/routines)、
[Schedule recurring tasks in Claude Cowork](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)

### なので、向きの結論はこう直る

```
✕（前の理解）プラットフォームが、ライセンシーの Claude を呼びに行くことはできない
○（訂正後）  プラットフォームが、ライセンシー本人が発行したトークンで、
              ライセンシーの Claude Code ルーティンを「起こしに行ける」
```

genie の `launchd → claude -p` と本質的に同じことを、Anthropic 自身がクラウド上で
ホストしていて、**ライセンシー本人の合図（トークン発行）だけで外部から叩ける**、
という形になる。「向きを逆にする」という結論の骨格は変わらないが、
「ライセンシー側が読みに来る（ポーリング）」ではなく「プラットフォームが起こしに行く（push）」
になる——**より Cron に近い、遅延の少ない形。**

## 参考にしたもの（変わらず有効）

`genie`（別リポジトリ、同じ開発者の私物）の `scripts/inbox-triage.sh`。
`launchd`（定期実行）が `claude -p`（ヘッドレス）を直接起動している、実際に動いている実例。

そこから借りる規律：

1. **Claude にツールを渡さない。**入出力は呼び出し側が全部やり、Claude には
   組み立て済みのプロンプトを渡して JSON だけ受け取る
2. **タイムアウトの見張りを必ず付ける**（ヘッドレス呼び出しは固まりうる）
3. **構造化 JSON でしか受け取らない。**自由記述を解釈しない

1番目は、このプラットフォームの `context.llm.completeJson(...)` と同じ規律なので、
**そのまま差し込める。**ただし Routine は**フルセッション**（ツール無しの縛りはできない）
なので、この規律は「Claude に渡す」側ではなく「**ルーティンの保存済み指示文に、
この規律を守らせる**」形で効かせることになる——指示文自体に
「他のツールは使うな、この窓口とだけやり取りしろ、JSONで返せ」と書く。

## 形（案・訂正後）

| | |
|---|---|
| 設定 | `llm.provider: anthropic \| mock \| external-session` を1つ足す（`anthropic` は残る） |
| プラットフォーム側が持つ秘密 | ライセンシーが発行した **routine の URL とベアラートークン**
  （`ANTHROPIC_API_KEY` と対になる、新しい設定値） |
| きっかけ | サイクルが執筆・検品の段になったら、プラットフォームがその routine の
  `/fire` に POST（`text` に、どの仕事かを指す最小限の情報だけ乗せる） |
| ライセンシー側の一度きりの設定 | ① routine を作り、指示文を保存
  （「このプラットフォームの窓口を読み、指定のスキーマでJSONを返せ」という内容。
  手順書に書いて渡す）② API トリガーを追加してトークンを発行し、プラットフォームに渡す
  ③ routine の環境設定で、このプラットフォームのドメインへのネットワーク到達を許可する |
| ライセンシー側の実行 | 起動した Claude Code セッションが、指示文どおりにプラットフォームの
  窓口（読む・書く）を叩き、自分の Claude で生成する |
| 検証 | 返ってきた JSON は、いま model の応答を検証しているのと**同じスキーマ**
  （`src/llm/schema.ts`）で検証。検品（`policy.ts`）は出所を問わないので、
  そのまま通る（2026-09-25 に確認済み） |
| 固まったら・返事が無ければ | いま実装済みの**サイクルの再試行上限**
  （`cycle.retry_abandoned`）をそのまま流用する。新しい仕組みは作らない |

## 確認できていないこと（正直に）

- **1日あたりの起動回数の上限が、具体的に何回かは未確認。**ドキュメントには上限の存在だけ
  書かれている
- **これは「研究プレビュー」段階**（"Behavior, limits, and the API surface may change"）。
  いま動く形が、来月も同じ形とは限らない。Agent SDK credits の一件（発表→一時停止）と
  同じ扱いの警戒が要る
- **`text` に渡した情報が、保存済みの指示文と噛み合うように書けるか**（指示文は
  ライセンシーが一度手で書く前提なので、手順書の文言の質に懸かる）は未検証
- Free プランのライセンシーはこの選択肢自体を持てないことは確定済み。
  そのユーザー向けの案内文言をどうするかは未検討

## 設定のオン/オフの置き場所

**設定画面に置く、と決めた**（2026-09-25 オーナー）。

**ただし、いま置くのは決定だけ。**バックエンド（窓口・検証・サイクルの新しい待ち状態）が
無いのに、押せるスイッチだけ画面に出すと、今日ずっと直してきた「画面が嘘をつく」形に
なる。バックエンドを作るときに、一緒に置く。

## まだやらないこと

- `llm.provider: external-session` の実装
- 窓口（読む・書く）の API
- サイクルの新しい待ち状態
- 設定画面のスイッチ
- ライセンシーに渡す、routine の指示文のひな形
- 1日あたりの起動回数上限の実測
