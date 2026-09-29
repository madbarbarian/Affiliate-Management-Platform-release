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

## Phasing (owner, 2026-09-27): prove it works before deciding whether to hand it to licensees

**"まず機能として、ちゃんと動くかを私の環境で試し、ライセンシーに機能提供するかは、次の段階と考えてもいいです。"** ("First try it as a feature, in my own environment, to see whether it actually works — whether to offer it to licensees is a decision for the next stage.") Agreed: every open question below (the per-day launch limit, whether `text` meshes with a saved routine's own instructions, real latency, whether a full Claude Code session behaves as expected end to end) is answered only by running it, and the owner already has what running it needs — a Max-plan account, at a desktop, able to create a Routine right now. Building the licensee-facing half (the settings switch, the Free-plan messaging, a procedure document handed to someone else) before any of that is known would be spending effort on a shape nobody has confirmed works.

**🔴 Scope boundary, so this is not misread later:** `docs/1-requirements/requirements.md` §3.1 ("the licensee has no terminal") governs the *licensee-facing* stage only. The owner acting as the platform's own developer, testing against their own deployment, is not that stage — nothing here is a plan to hand a terminal to a licensee. If phase 1's procedure is ever reused as a licensee's own setup step, that reuse is what has to satisfy §3.1, not this phase.

### Phase 1a — prove the mechanical loop, not wired into the orchestrator's cycle yet

The smallest thing that answers "does this work at all", built in the real codebase, in the real deployment (`amp-test`), off by default.

1. **The owner creates their own Routine** (`claude.ai/code/routines`), with saved instructions telling it to read a small authenticated endpoint, do the job it describes, and POST back JSON in the schema it names. Adds an API trigger, gets the `routine_id` and a bearer token. Allows `amp-test`'s domain in the routine's own environment settings (the network-reach step E-10 already flagged as required).
2. **Four routes in `src/console/router.ts`**, gated by a real, documented, off-by-default config field (see "🔴 Correction, 2026-09-28" below — this is where the design actually landed, after a detour). `GET` returns the pending job's prompt and JSON Schema; `POST` accepts the answer.
3. **A standalone script**, run from the owner's own machine: creates one job, POSTs to the routine's `/fire` (no `text` needed — the routine's own instructions always fetch whichever job is currently pending, since phase 1a holds exactly one), polls `amp-test` for the answer, validates it against `src/llm/validate.ts`, prints pass or fail. Not wired into the cycle/orchestrator yet — that is phase 1b.

This alone proves or disproves the mechanism: push → the owner's own Claude Code session wakes, reads the job, does it, writes back → the platform sees a schema-valid answer, inside whatever time the retry budget allows.

### Phase 1a: the owner's Routine setup procedure

Read directly (grade P, fetched 2026-09-28) from https://code.claude.com/docs/en/routines and https://code.claude.com/docs/en/cloud-environments. Two facts here were not known when the design above was written, and change the procedure:

- **A routine needs at least one GitHub repository selected** ("Select repositories: Add one or more GitHub repositories for Claude to work in. Each repository is cloned at the start of a run"). The repository is never used by this harness's own instructions — any repository the account can access satisfies the form.
- **Claude Code has a purpose-built mechanism for exactly this platform's own secret, better than an environment variable: "API credentials"** (Pro/Max plans only — confirmed available on this plan). A credential is a header value Anthropic's own agent proxy attaches to outbound requests whose host matches, *after* the request leaves the session's VM — "the key never reaches Claude, the commands it runs, or the session's environment variables." This is a stronger property than a plain environment variable (which the docs say is "visible to anyone who uses the environment"), so `AMP_EXTERNAL_SESSION_TOKEN`'s value goes here, not into the instructions text or a plain environment variable. A side effect, also confirmed: a host listed on a credential is reachable even under **Trusted** network access, without editing **Allowed domains** separately.

**Procedure:**

1. `claude.ai/code/routines` → **New routine**.
2. **Name**: anything descriptive.
3. **Instructions** (the saved prompt — see the exact text below).
4. **Select repositories**: any one repository.
5. **Select an environment**: **Default**, for now — it has to already exist before step 8 can add a credential to it (see the docs quote: "You add credentials one at a time from the editor of an environment that already exists. The dialog for a new environment doesn't offer them.").
6. **Select a trigger**: **API**. Not Schedule, not GitHub event.
7. **Connectors**: remove every one that's included by default. This harness's whole discipline is "talk to nothing but the one endpoint," and a routine can use every tool of every included connector, unsupervised, during a run.
8. **Behaviour**, **Notification**: 🔴 **not found in the fetched documentation under these names.** Left unconfirmed rather than guessed — read whatever the live form actually offers before deciding, and update this section once confirmed.
9. **Create**.
10. 🔴 **Correction, 2026-09-28 (twice): step 10 works after all — see E-25.** First attempt: the documented path showed no **API credentials** section, on a personal Max account, editing an already-created environment — every documented precondition met. Recorded as an open discrepancy and worked around with a plain Environment variable instead. **Second attempt, same day: the section was there** — it appears inside the **Update cloud environment** dialog reached via the routine's own edit screen (routine → **Edit** → the cloud-icon environment selector below **Instructions** → hover the environment → the settings icon on the right), not from a more general environment-management page. The first attempt had not reached that specific dialog. **E-25 is downgraded from "feature gap" to "findability issue"; the fix is the navigation path, not a fallback.** Use **API credentials**, as originally planned: **Add credential** → Credential type **Bearer** (default), Name anything, **Allowed websites** `amp-test.madbarbarian.workers.dev`, **Custom headers** one row (Name `Authorization`, Prefix `Bearer`, Value = `AMP_EXTERNAL_SESSION_TOKEN`'s actual value — the same string set as the Cloudflare secret on `amp-test`) → **Connect**. Remove the plain Environment variable if it was added during the first attempt — the credential supersedes it and is never visible to the session.
11. Still in **Edit** → **Select a trigger** → **Add another trigger** → **API** → copy the URL, **Generate token**, copy the token immediately (shown once). This token is **not** the same secret as step 10 — it is what the platform uses to wake the routine (`POST .../fire`), the opposite direction from `AMP_EXTERNAL_SESSION_TOKEN` (what the routine uses to call the platform).

**The Instructions text** (English — design documents are English-first; the routine's own tool use, `curl`, is language-agnostic either way):

```
Do only the following. Do not modify anything in the repository and do not use any tool other than the two commands below.

1. Fetch the pending job:
   curl -s https://amp-test.madbarbarian.workers.dev/api/external-session/job
   (Do not add an Authorization header yourself — it is attached automatically.)

2. If the response is 404, there is no job to do. Stop here and do nothing else.

3. If the response is 200, carry out the instruction in its "prompt" field, and
   produce JSON that matches its "schema" field exactly (no extra fields beyond
   what the schema allows).

4. Post your answer back (<id> is the job id from step 1, <value> is the JSON
   from step 3):
   curl -s -X POST https://amp-test.madbarbarian.workers.dev/api/external-session/job/result \
     -H "Content-Type: application/json" \
     -d '{"id": "<id>", "value": <value>}'

5. If the status code is 422, read the "issues" field, fix the JSON to match
   the schema, and POST again. If it is 200, you are done — do nothing further.
```

**Environment-variable fallback version** (kept in case API credentials is ever genuinely unavailable — e.g. a Team/Enterprise plan, per E-24 — not needed on a personal Pro/Max account):

```
Do only the following. Do not modify anything in the repository and do not use any tool other than the two commands below.

1. Fetch the pending job:
   curl -s -H "Authorization: Bearer $AMP_EXTERNAL_SESSION_TOKEN" https://amp-test.madbarbarian.workers.dev/api/external-session/job

2. If the response is 404, there is no job to do. Stop here and do nothing else.

3. If the response is 200, carry out the instruction in its "prompt" field, and
   produce JSON that matches its "schema" field exactly (no extra fields beyond
   what the schema allows).

4. Post your answer back (<id> is the job id from step 1, <value> is the JSON
   from step 3):
   curl -s -X POST -H "Authorization: Bearer $AMP_EXTERNAL_SESSION_TOKEN" \
     -H "Content-Type: application/json" \
     https://amp-test.madbarbarian.workers.dev/api/external-session/job/result \
     -d '{"id": "<id>", "value": <value>}'

5. If the status code is 422, read the "issues" field, fix the JSON to match
   the schema, and POST again. If it is 200, you are done — do nothing further.
```

### 🔴 Design review, 2026-09-27: the first shape crossed a line and was sent back

A full design (endpoints in `src/console/router.ts`, sharing `StateStore`/`src/storage/sql-state.ts`, a `src/llm/validate.ts` validator, the on/off token read as a bare `AMP_EXTERNAL_SESSION_TOKEN` env var with no config field) was produced by one agent, then reviewed by two independent agents. Reviewer 1 (validator/storage correctness) approved with four must-fix items (kept — see below). Reviewer 2 (auth design and scope discipline) **sent the routing half back for rework**, on this finding:

> `src/console/router.ts` is the file every licensee's own fork runs, and it is wholesale inside `scripts/make-release.ts`'s `INCLUDE` list. Putting these four routes there, gated only by an env var invisible to `platform.config.yaml`'s schema, means **the code ships to every licensee's fork the moment this merges and releases**, discoverable only by reading the open-source router — "not licensee-facing" was true of the operator's *intent*, not of what the merge would have shipped.

**First resolution (superseded the next day — see the 2026-09-28 correction just below): move the harness entirely outside `src/`, into a separate, unshipped top-level directory and a second Cloudflare Worker.** This was overcorrection, and it did not survive the owner's own review of it.

### 🔴 Correction, 2026-09-28: the separate-Worker resolution was itself wrong, and was undone

The owner's objection, in their own words: *"変な仕組みを作って開発者の私だけの機能を作ると言うよりは、将来的には大勢が使う可能性もあるわけなんだから、あるべき設計をやった上で、どこかに蓋をして送ってこれから正しいんじゃないの？"* ("Rather than building a strange mechanism that makes this a feature for me the developer alone — since it might be used by many people eventually — isn't it right to do the proper design, then cap it off somewhere, and ship from there?")

Re-examined, this is correct, and the separate-Worker plan (committed to `main` the day before as `owner-only/external-session-harness/`, now removed) was the wrong fix for a real problem:

- **What reviewer 2 actually found fault with was never "this code lives in `router.ts`."** It was specifically that the on/off switch was a *bare environment variable with no config-schema presence* — invisible to `platform.config.example.yaml`, undocumented, discoverable only by reading source. That is a real gap. It is not a gap that required moving the feature out of the shared codebase to close.
- **The blast radius reviewer 2's finding actually describes is single-tenant, not cross-tenant.** Each licensee's deployment is their own isolated Worker and D1 database. A licensee who discovers and enables this uses *their own* Claude Code Routine and *their own* bearer token to answer jobs on *their own* deployment. There is no path from this feature to another licensee's data or to the platform's own infrastructure. The actual risk was never "a security breach"; it was "an unreviewed, unlabelled capability existing in shipped code" — the same shape of gap `CLAUDE.md`'s own recorded precedent describes, and the fix for *that* is to make it reviewed and labelled, not to hide it in a deployment nobody else has.
- **A separate Worker is throwaway architecture for something phase 1b explicitly intends to become real** (`llm.provider: external-session`). Building it twice — once as a disposable harness, once "for real" in phase 1b — is exactly the "変な仕組み" (strange, contorted mechanism) the owner objected to, and phase 1a's own harness would have been discarded rather than becoming phase 1b's foundation.

**The actual fix: move the on/off switch and the token's env-var name into `platform.config.yaml`'s schema, the same pattern `channels[].credentialEnv`/`networks[].credentialEnv`/`company.exploration.enabled` already use** — a real, documented, schema-validated field, defaulting to off, shown (commented out, labelled experimental and unsupported) in `platform.config.example.yaml`, the same way `company.exploration.enabled: false` is real, shipped, and off by default. This is a deliberate, documented product decision to build the mechanism but not yet support or advertise it — not a hidden backdoor, and not a second deployment:

```yaml
llm:
  provider: anthropic       # anthropic | mock
  # ...
  # 🧪 実験的・未サポート機能。予告なく変更・削除されることがあります。
  # フェーズ1a（docs/3-development/external-generation-design.md）の検証専用。
  externalSession:
    enabled: false
    tokenEnv: AMP_EXTERNAL_SESSION_TOKEN
```

`owner-only/external-session-harness/` (the directory, the separate Worker, the Durable Object, the `test/release.test.ts` case asserting it never ships) is removed. The four routes, the validator, and the job-storage module all live in the shared codebase as originally designed on 2026-09-27, with reviewer 1's and reviewer 2's *other* findings still binding:

- **Reviewer 1's four must-fix items for `validate.ts`**: never let `JSON.stringify` throw inside a truncated-value preview (circular references, `BigInt`) — wrap it; guard every recursion entry against the schema fragment itself being `null` or non-an-object, not only the top-level call; pin the path-string convention explicitly (root is `"$"`, a property is `$.name`, an array index is `$.items[0]`) before implementation; add a real round-trip test proving the `sql-state.ts` fix works for a third key, not only "old tests still pass".
- **Reviewer 2's job-identity finding**: `POST /job` must refuse (409), not silently replace, when an unanswered job already exists, and `GET /job/result`'s "done" response must echo the job's own id and `createdAt` — closing the misattribution where a slow answer to job N arrives after job N+1 already exists, and a poller can't tell which job its "done" answer belongs to.
- **Reviewer 2's auth-mechanism finding stands** (`safeEqual`, dispatched before `identify()`, its own bearer secret) — only the *discoverability* of the on/off switch was wrong, not the token-check mechanism itself.

### Phase 1b — wire it into a real `llm.provider`, still owner-only

Only once 1a has run for real: turn the harness into `llm.provider: external-session`, a real adapter the orchestrator can select, still gated by a config value only the owner sets on their own deployment. This is where the asynchronous shape (push a job, wait for a callback, possibly across the retry budget in `cycle.retry_abandoned`) has to be designed properly against the orchestrator's own persistence model — deferred until 1a says the mechanism itself is worth that design cost.

### Phase 2 — decide whether to offer it to licensees at all

Not started, and not decided. Only after 1a and 1b have run for real does it become a real question rather than a guess: the settings-screen switch, Free-plan messaging, and a procedure document written for someone who is not the platform's own developer.

## Phase 1a status: implemented, off by default, not yet released

**Done (2026-09-28), reviewed and merged:** `llm.externalSession` in `platform.config.yaml`'s schema (`enabled`, `tokenEnv`, defaulting to off); the four job routes in `src/console/router.ts`; `src/llm/validate.ts`; the `sql-state.ts` key-list fix; `src/kernel/external-session.ts`. Two independent design reviews, a parent-level correction between them (see above), and the parent's own re-run of the resulting tests and `mutate.ts` proofs — recorded in `decisions.md`.

**Still to do before this proves anything real:**
- The owner creates their own Routine and runs the standalone script against a real deployment with `llm.externalSession.enabled: true` set.
- Measuring the per-day launch limit — one of the things this exists to find out, not yet known.
- Whether the information passed in the routine's saved instructions actually meshes with what `text` carries at fire time — also unverified until run for real.

## Not doing yet

- `llm.provider: external-session` itself, and wiring an answer into the orchestrator's cycle (phase 1b — deferred until phase 1a has run for real)
- The settings-screen switch (phase 2)
- A template of the routine instructions to hand to licensees (phase 2 — phase 1a's instructions are the owner's own, not licensee-facing)

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
