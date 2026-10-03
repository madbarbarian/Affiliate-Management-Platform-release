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
3. **`scripts/external-session-harness.ts`**, run from the owner's own machine: creates one job, POSTs to the routine's `/fire` (no `text` needed — the routine's own instructions always fetch whichever job is currently pending, since phase 1a holds exactly one), polls `amp-test` for the answer, validates it against `src/llm/validate.ts`, and prints PASS or FAIL together with a timestamp at every stage — the routine's own session URL to watch live, and the elapsed time at job creation, at firing, and at the final result, which is how the per-day launch limit and the real latency (both open questions above) actually get measured. Not wired into the cycle/orchestrator yet — that is phase 1b.

   It reads its four `AMP_EXTERNAL_SESSION_*` variables from `process.env` directly rather than through `src/config/load.ts` (it is a standalone script, not `platform.config.yaml`-driven). Run it with Node 22's own built-in dotenv loader so they come from `.env.local` instead of needing to be exported by hand: `node --env-file=.env.local scripts/external-session-harness.ts`.

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

#### Phase 1b design (2026-09-30, draft for expert review — not yet implemented)

**Decision (owner, 2026-09-30): the provider blocks and polls; the port does not change.** The rejected alternatives were a "pending" outcome plus a new "awaiting answer" state in the cycle step machine (touches every role and the orchestrator, and adds a second kind of waiting beside the approval gates), and batching a step's calls into one job (strains "roles never know about each other" and the per-role schemas).

**Facts this rests on** (from reading the code, 2026-09-30): `LlmProvider` is `{name, completeText, completeJson, stats}` and both completions return `Promise<Result<…>>`; a cycle makes roughly 8–12 sequential calls (analyze, research, plan once; write per approved idea; inspect per draft; publisher comment per post); a failed step is marked `retryable` and the scheduler resumes it with attempts and a 10-minute backoff (`cycle.retry_abandoned` at the limit); the 1a store has one job slot and `POST /job` answers 409 while an unanswered job exists.

**Shape.**
- `src/llm/external-session.ts` — `ExternalSessionProvider implements LlmProvider`. Per call: fold `system`, `user` and `schema` into one prompt; put a job; fire the Routine through an **injected** `fetch`; poll the job store until an answer with the **same job id** arrives or the deadline passes; validate with `src/llm/validate.ts` (same schema path as model output); return a `Result`. Time comes from `services.clock`, never `Date.now()`.
- Calls are strictly serial (one slot). Before putting a job, an unanswered job left by an earlier attempt is discarded, because the cycle that owned it is gone; an answer whose id does not match is ignored.
- **Failure mapping — every one of these is `Err`, retryable, and rides the existing retry budget; no new mechanism:** Routine fire refused or unreachable; deadline exceeded; answer failing the schema after the routine's own 422 loop is exhausted.
- 🔴 **[Superseded by the correction below — the 15-minute wall cap makes this arithmetic wrong.]** **The first timeout aborts the cycle** (it does not retry within the step). Worst case is ~12 calls × the timeout; with a 5-minute timeout that is 60 minutes against a 20-minute lock TTL. Aborting early keeps a hung Routine from holding the cycles lock, and the retry resumes at the failed step.
- **Named constants / config, no bare numbers:** job timeout (default 5 min), poll interval (default 5 s, as the harness). Fire URL and token are environment variables (`.env.local`), never in `platform.config.yaml`.
- `llm.provider` gains `external-session`. Config validation collects every problem at once and names the fix ("llm.provider is \"external-session\" but EXTERNAL_SESSION_FIRE_URL is not set. Put it in .env.local, or set llm.provider to \"anthropic\" or \"mock\".").
- `stats()` reports usage as unknown (no token source); `tier` is ignored.

**Protects / does not protect (per the repo rule on protections).** Protects: a call never silently returns another job's answer (id match); a hung Routine cannot hold the lock beyond one timeout; malformed answers never reach a role (same validator). Does *not* protect: the per-day launch quota (unmeasured — 1b must record launches consumed per cycle on the first real run); the guardrails in `policy.ts` still run after the rewrite as before, this adds no new content check; the Routines API is a research preview and may change.

**Must be measured before implementation (a spike, not an assumption).** Whether a Worker `scheduled()` invocation may wait several minutes on polling (wall time, not CPU — `cloudflare-design.md:43-45` speaks only of CPU). 🔴 **[Superseded below: Cloudflare's documented 15-minute wall for cron (documented figure, not measured here); and the Node path is not unaffected.]** If it may not, the Worker path must fall back to a bounded per-invocation wait and this design changes; the Node daemon path is unaffected.

**🔴 Correction after two independent expert reviews (2026-09-30; parent re-read the cited code and confirmed each item).** The draft above was wrong in these ways; the items here are binding and override the text above.

1. **Wall time is capped at 15 minutes per cron invocation** (Cloudflare limits page; CPU is a separate limit). The "60 min vs 20-min TTL" figure was wrong, and an invocation killed at 15 min runs no `finally`, so the lock stays until the TTL and the cycle row stays `running`. **Rule:** the provider takes a per-invocation budget (named constant, default ≈10 min, shared across all calls in the tick); when it is spent, the next call returns `Err(retryable)` immediately. The first job timeout still aborts the cycle.
2. **D1 reads are a snapshot** (`sql-state.ts` `read()` answers from a snapshot only `refresh()` updates). The routine's answer arrives in a different invocation, so a provider polling `read()` never sees it. **Rule:** the provider is given an async job-store port; every poll refreshes first. A test double whose `read` changes only after `refresh` is a required case.
3. 🔴 **[Contradicted in part by the code, 2026-09-30: the publisher is not on the dispatch tick, and the refusal that premise led to was reversed the same day - see the Reversal note under this item and "Phase 1b: where the code disagreed" below.]** **The slot is global, and "strictly serial" was false.** The publisher calls `llm.completeJson` (`publisher.ts:176`) under `DISPATCH_LOCK`, which can overlap the cycles tick (`CYCLES_LOCK`). **Rule:** external-session calls are serialised by one lock covering both paths, or the publisher path is refused with a named error when the provider is `external-session`. 🔴 **[Reversed the same day — see the note at the end of this item.]** **Decided (owner, 2026-09-30): refuse.** With `llm.provider: external-session`, the publisher's comment path returns a named, fix-naming `Err` instead of calling the provider; the shared-lock alternative was rejected as a larger blast radius. What this protects: the single slot is only ever used by the cycles tick. What it does not: the publisher's comments are not generated at all under this provider until a later phase serialises them.
   🔴 **Reversal (owner, 2026-09-30, same day):** the premise was wrong. The publisher is not on the dispatch tick; it is the cycle's own `schedule` step (`case "schedule"` in `orchestrator.ts`), so refusing it would stop every cycle at `schedule`, non-retryable. **Decided: (b) the publisher's comment call runs inside the `schedule` step, on the same serial slot, under the one cycles lock.** No second caller, no new lock. The earlier "refuse" text above is kept as the record of the mistaken premise.
4. **Stale-job discard races a slow routine** (no compare-and-set on a JSON row). **Rule:** discard is conditional on the id read, and a discard writes a tombstone so the late answer gets 409 rather than landing on a new job. An id mismatch while polling returns an immediate `Err("superseded")`, not a wait to timeout.
5. **The Node daemon path is not unaffected.** The routine runs in Anthropic's cloud and fetches the job over HTTP; the example config binds `127.0.0.1`. The console must be publicly reachable for either path; the design states this as a requirement.
6. **Schema violations never enter the store** (`router.ts` answers 422 first), so the provider's re-validation is defence in depth and its test writes an invalid `result` straight into the store. `completeText` uses a wrapper schema `{text: string}` and returns `.text`.
7. **Tests:** `fixedClock.sleep` is a no-op, so a deadline loop on it never ends. The provider loops on `clock.now()` and the tests use a clock whose `sleep` advances time (opt-in). Add cases: fire refused, fire throws, fire hangs (own `AbortSignal` timeout), boundary `elapsed == max`, refresh-in-poll. Each maps to a one-line mutation.
8. **Reuse, do not duplicate:** extract the harness's pure fire logic (URL, beta/version headers, `interpretFireResponse`) into `src/llm/`; `src/` must not import from `scripts/`. Fold only `system`+`user` into `prompt` with unambiguous framing; keep `schema` in the job's own field (the routine already receives it separately).
9. **Wiring and config:** `buildLlm` needs state, clock and ids (signature change); `provider` enum gains `external-session` and the `apiKeyEnv` check must not fire for it; **four** variables are named, not two — console base URL, job token, fire URL, routine token. On Cloudflare Free, D1 calls count as subrequests (limit 50), so polling every 5 s fails; back the interval off or require Paid.
10. Still unresolved: whether the 15-min cap is identical for hourly crons; the `maxCycleAttempts` default; whether Routine 422 retries happen inside the poll window.

#### Phase 1b: where the code disagreed with this design, found while writing the implementation plan (2026-09-30)

Source: `docs/superpowers/plans/2026-09-30-external-session-provider.md` (kept in our repository; it is not shipped to licensees). The owner's decisions above stand (the provider blocks and polls; the port does not change; the publisher's comment call runs inside `schedule` on the same serial slot). What follows are **corrections to statements above, recorded rather than overwritten** (the originals are left in place and item 3 is marked). Each was read from the code, not assumed.

1. **Item 3 names the wrong second user of the slot.** `publisher.run` is the `schedule` step of the cycle (`orchestrator.ts` `case "schedule"`), not something the dispatch tick calls. It runs wherever a cycle advances: the cycles tick (`CYCLES_LOCK`, 20-minute TTL), a console gate approval (from an HTTP request, **with no lock at all**), the console run button (also from an HTTP request; it takes `CYCLES_LOCK` only where the host has a lock, which is the Worker, and only for `RUN_LOCK_TTL_MS` = 5 minutes, `router.ts:92`), and the CLI. The dispatch cron does not advance cycles: it calls `dispatchDue` and, weekly and off by default, `exploreIfDue`, which runs the **scout** - and the scout calls the model (`scout.ts` `completeJson`). So the other users of the single slot are the scout and the console paths, not the publisher. Overlap is made safe (a retryable `Err`, never another call's answer) by leaving alone a job younger than the job timeout (`busy`), the tombstone, the job-id match, the provider's in-process busy guard and the `superseded` error. A per-process flag could not do it: every Worker request builds its own runtime.
2. **The refusal decided earlier the same day was reversed, and why.** The first decision (owner, 2026-09-30) was that the publisher's comment path refuses under this provider, on the premise of item 1's wrong reading: a publisher on the dispatch tick, overlapping the cycles tick. The premise was wrong. The publisher is the cycle's `schedule` step, a mandatory step between `inspect` and `publish_approval`, so the refusal would have stopped **every** cycle at `schedule` with a non-retryable error: no day could complete under this provider. **Decided (b), same day:** the publisher's comment call runs inside the `schedule` step, on the same serial slot, under the one cycles lock; no second caller, no new lock, no refusal. **What (b) needs in code: nothing** in the publisher or the orchestrator. Its comment call is already an ordinary `completeJson` through the port, and a whole-cycle test proves that the schedule step's calls go through the provider and that a spent run budget stops the cycle at `schedule`, retryably, so that it resumes there. **What (b) does not give:** "under the one cycles lock" holds for the cron path only. A console gate approval reaches `schedule` with no lock, the run button's lock lasts 5 minutes and exists only on the Worker, and the scout shares the slot, so exclusivity rests on the job's age, the tombstone, the id match, the busy guard and `superseded`, not on a lock.
3. **"The first timeout aborts the cycle" needs a latch, not just an `Err`.** The write step continues past a failed idea (`orchestrator.ts`, the loop over `approved` ideas), so an `Err` from idea 1 is followed by a fire and a wait for idea 2. The provider latches: after a timeout or a hung fire every later call in the same run returns `external_session.aborted` immediately. That alone was not enough, because `write` and `inspect` swallowed the latched calls too (item 10).
4. **The provider is not always per invocation.** On a Worker the runtime, and so the provider, is built per request and per cron. On the Node daemon `createRuntime` runs once and one provider serves every tick, so a budget or latch scoped to the instance would leave it out of budget (or latched shut by one old timeout) for good. Both are scoped to a run, and a quiet gap of `INVOCATION_IDLE_GAP_MS` (2 minutes) between calls starts a new one. **[Narrowed by item 17: the gap applies on Node only.]**
5. **The Worker `scheduled()` path already passes `state`.** `createWorkerRuntime` refreshes the SQL-backed state and hands it, with the clock and ids, to `assembleRuntime`. Only `buildLlm`'s signature changed.
6. **Variable names.** The four variables are the ones the phase 1a harness and the owner's `.env.local` already use - `AMP_EXTERNAL_SESSION_BASE_URL`, `AMP_EXTERNAL_SESSION_TOKEN`, `AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL`, `AMP_EXTERNAL_SESSION_ROUTINE_TOKEN` - each named in `llm.externalSession.*Env` so a licensee can rename it. The example error message in the draft (`EXTERNAL_SESSION_FIRE_URL`) used a name nothing reads.
7. **"Config validation collects every problem" is in two places.** `parseConfig` has no environment, so the check that the four variables are present (and that the console address is public https) is `readExternalSessionEnv`, called from `buildLlm`, and reports all of them in one error. The file-only rules (the routes must be switched on for this provider; the budget must cover one job timeout) are collected by `parseConfig`.
8. **The console paths hold an HTTP request open for the whole wait: a stated limitation, not fixed here.** A gate approval or the run button advances `write`, `inspect` and `schedule` inside an HTTP request; under this provider that request waits on the routine, up to the run budget (10 minutes by default). Whether a Worker holds such a request open for minutes is what the spike's Q3 (silent) and Q3b (a byte per beat) were to measure. **[Task 0 ran 2026-10-02: a request held 12 minutes survived, silent and with a byte per 30 s, on the owner's account, so the open-connection part is lessened; see "Task 0 result" below. The run button's lock below is not lessened.]** Whatever they show, the operator's browser and Cloudflare's edge are outside this code and nothing here bounds them; an operator who wants a day to complete should let the hourly cron carry it. See also item 13 (the run button's lock is shorter than a wait may be).
9. **Two screens named a model nothing calls.** The settings screen and `doctor` printed `llm.model` for any provider but the mock; both now say the routine writes the text. The design canvases (`docs/_proposed/design/`) were **not** updated: this is an experimental, owner-only provider, and the settings artboard gets its row when phase 2 decides whether licensees see it.

10. **A budget or latch spent part-way through `write` or `inspect` used to end the day short instead of resuming; the owner ruled that unacceptable, and it is now an orchestrator change.** The provider's run budget spans the whole cycle, but only `schedule` (and an all-failed `write`) failed the step on a provider `Err`; `write` skipped a failed idea and `inspect` recorded "could not be inspected" and moved on (measured in a scratch rig at a 150 s budget: the cycle completed with `Nothing publishes today ... 1 could not be inspected`). Now the errors that end a run carry `PlatformError.abortsRun` (budget spent, the latch, a timeout, a hung fire; **[extended by item 17: also `busy`, `superseded`, and a fire refused with 401/403/404]**) and `write` and `inspect` stop the step, retryably, on that field alone, so the scheduler resumes it there; the orchestrator reads no provider code and imports nothing from the provider. Any other failure is still skipped, and both notes now say `M of N failed`. **What resuming costs (checked in the code):** a resumed `write` drafts every approved idea again, and the drafts written before the abort (new ids, `writer.ts:120,133`) stay in the store referenced by nothing, because the cycle records `draftIds` only when the step succeeds (the `write` step's advance, `artifacts: { write: { draftIds } }`): orphan rows, never scheduled; the tracked link is re-issued from a seed of venture, offer and idea id (`links.ts:33`), so no duplicate link. A resumed `inspect` is safe: reports are keyed by draft id and overwritten, and a passed draft's revision moves on once more; nothing after `schedule` exists yet. Each resume spends one of `maxCycleAttempts` (default 2). Worst-case calls in one run are `3 + 3C` with `C = min(postsPerDay, maxPostsPerDay)` (9 on the example config, 12 at its policy cap), about 35 s each at the phase 1a routine's latency under the default backoff, so it fits the default budget with room; it stops fitting for a routine slower than about 35 s per call, and then the cycle resumes ten minutes later instead of ending short.
11. **A job in the slot is discarded only when it is stale, and an answer already there is adopted.** A live job is tombstoned only when `now - createdAt >= jobTimeoutMs`; a younger one belongs to a caller that is still waiting on it (a console approval, the run button, the scout: none holds the cycles lock, and Worker requests do not share memory), so it is `busy` and nothing is written; a `createdAt` that cannot be parsed is also `busy`. Before firing, an answered job (or a tombstoned one holding an answer) is adopted if its stored prompt equals the new prompt exactly and the answer validates against the new schema: a routine slower than the job timeout answers after the call gave up, and the retry does not pay twice. **[Corrected by item 17: only an answer no caller has been handed (`consumedAt` unset) is adopted.]** The ceiling: `jobTimeoutMs <= invocationBudgetMs <= EXTERNAL_SESSION_MAX_INVOCATION_BUDGET_MS`, and `jobTimeoutMs <= EXTERNAL_SESSION_MAX_JOB_TIMEOUT_MS`, the scheduler's 10-minute retry backoff, so a retry finds its own leftover job already stale.
12. **The wait budget applies on the Worker only, and no wall time has been measured yet (Task 0 not yet run).** **[Superseded 2026-10-02: Task 0 has run; 12 minutes was measured on cron and HTTP. Read the next two sentences as written before it, and the Task 0 result below for what is now known.]** The Node daemon has no wall cap, so its budget is unlimited (`invocationBudgetFor`); the latch and the per-call timeout still apply there. The Worker's budget maximum is 12 minutes (the length the spike is to run, not yet run) less one minute of headroom (11), not 14 minutes derived from the documented 15 that nobody ran. It is a cap chosen to rely on nothing unmeasured beyond that, not a measurement.
13. **The run button's lock is shorter than a wait may be: a stated limitation, not fixed here.** On the Worker the run button holds `CYCLES_LOCK` for `RUN_LOCK_TTL_MS` = 5 minutes (`router.ts:92,528`), and a run under this provider may wait up to the run budget (10 minutes). A run that outlives its lock lets the hourly tick start a second run of the same cycle beside it; the job's age, the tombstone and the id match keep them from corrupting the slot, but both may draft (the in-process `inFlight` map joins only callers in one process). The fix, a longer run TTL or renewing the lock, is a change to `router.ts` that nobody asked for. **[Superseded in part, 2026-10-02: an HTTP request held 12 minutes survived (item 8 and Task 0 result), but nothing past 12 was tried, and the 5-minute lock is still shorter than a wait; that limitation stands.]** Original: not measured either whether a Worker request may run that long (item 8).
14. **The Free plan is refused, by documentation.** A day costs about 100 subrequests (a 9-call day is about 54 from the provider alone, at one D1 query per `refresh()` and per `write()` and about 6 per call; an estimate, not a measurement; **[item 17 adds about 2 per call for the consumed mark: about 72 from the provider]**), and the Free plan allows 50 per invocation. Nothing at run time can tell which plan a Worker is on, so the example config and this note say so instead; the first real run records the actual count.

**Task 0 result (2026-10-02).** The wall-time spike has run and **passed**. Source and grade: our own experiment, one account (the owner's), a throwaway Worker `amp-spike-wall-time` with no bindings, deleted afterwards (grade X in `design-evidence.md` terms: not a documented figure, not reproduced by anyone else). The summariser script printed 2026-09-30 only because that date was hard-coded in it; the runs were on 2026-10-02.

| Question | Result |
|---|---|
| Q1: sub-hourly cron (`*/30 * * * *`) waits 12 minutes | PASS, two runs: 720175 ms and 720188 ms, outcome ok |
| Q2: hourly cron (`0 * * * *`, the schedule the real cycles cron uses) waits 12 minutes | PASS, 720295 ms, outcome ok |
| Q3: an HTTP GET held silently 12 minutes | PASS: curl exit 0, HTTP 200, 720.24 s |
| Q3b: the same with one byte per 30 s | PASS: exit 0, HTTP 200, 720.26 s, 24 bytes |
| Q4: `Date.now()` against `performance.now()` | drift 0.0% |

Each run made one real subrequest on every second 30-second beat (about 12 per run). **Gate verdict: proceed; Tasks 1-9 stand.** The 11-minute cap is now the measured 12 minutes less one minute of headroom, and the constant is `EXTERNAL_SESSION_MEASURED_WALL_MS` again (it was renamed `ASSUMED` while it was not measured; item 17).

**Not measured, and still not known.** Anything longer than 12 minutes (Cloudflare documents 15; that figure is still only documented). The Cloudflare plan of the account (wrangler does not show it), so **nothing here says a 12-minute cron works on the Free plan**; the Free plan stays refused by documentation (item 14). D1 latency. Subrequest limits under real polling (the spike made about 12, a real day about 70-100). Overlapping invocations. The latency of Routine calls across runs (phase 1a measured one launch, about 21 s). The per-day Routine launch quota. And **a real end-to-end cycle with the provider**, which needs the provider deployed on `amp-test`, which needs a release decision that has not been made.

**What has not changed.** The provider is **implemented, unreleased, off by default (`llm.externalSession.enabled` is false)**. It is still not to be enabled on any deployment, or released, until a real end-to-end cycle has run on `amp-test` and its result is recorded here. The run button's 5-minute lock (`RUN_LOCK_TTL_MS`) is still shorter than a wait may be (item 13). **Slip worth recording:** the first Q3 attempt got a 404 (Cloudflare error 1042) in 0.28 s because the `workers.dev` route was not live yet right after the deploy; it was not a wall-time result and the second attempt is the one reported.

**[Superseded 2026-10-02: the paragraph below was written before Task 0 ran. It is kept as the record of what was unmeasured then.]** *Original:* **Measurements from the pre-implementation spike: NOT YET RUN (Task 0 of the plan).** The wall-time spike needs the owner's Cloudflare login, so it has not been run. By a controller ruling the implementation was built first, with the 11-minute budget cap, and **Task 0 is a gate: this provider is not to be enabled on any deployment, or released, until it has run and its result is pasted here.** Until then the provider is **implemented, unreleased, off by default (`llm.externalSession.enabled` is false), and unmeasured on real infrastructure.** Not measured: the wall time one Cloudflare invocation may wait (so whether the 10-minute default budget and the 11-minute maximum hold; 12 minutes is the length the spike would run, 11 is that less a minute, neither is a result), the subrequest count of a real day, how long a Worker holds a console request open (Q3, Q3b), and the routine's latency across runs (phase 1a measured one launch, about 21 s). If the spike shows K under 4 minutes, or a clock drift of 5% or more, the blocking design itself goes back to the owner.

15. **The one job slot has no compare-and-set: a stated limitation, not fixed here.** The state store offers read and write, not an atomic swap, so two overlapping callers can both read an empty or stale slot and both write. Exclusion rests on the job's age, the tombstone, the id match, the busy guard and `superseded`; a lost race is narrowed and surfaces as a retryable `Err` (`store_write_failed` and `superseded`), not eliminated.
16. **Skipped ideas and drafts are not counted in "(M of N failed)".** A missing idea or draft (an id that resolves to nothing) is skipped without being counted as a failure, so the note's M counts provider failures only. Not fixed here.
17. **Final-review corrections (2026-10-01).** Four defects found by the whole-branch review, each fixed with a test proven red and a row in `docs/6-testing/mutate.md` (FX1-FX13). (a) **The Worker's run no longer restarts inside one invocation.** Item 4's idle gap is a Node-daemon mechanism; on a wall-limited host the provider's run opens when it is built (time spent before the first model call counts) and no gap restarts it, because a pause inside one invocation does not give its wall time back. `buildLlm` passes `wallLimited` to the provider itself. (b) **`busy` and `superseded` end the `write`/`inspect` loop** (they carry `abortsRun`), like item 10's codes: a slot another caller holds would otherwise fail every remaining item and end the day short. A fire refused with 401, 403 or 404 does too (a wrong or revoked token or URL cannot clear within the run); 429 and 5xx do not. (c) **An answer is adopted only once.** The job gets `consumedAt` when the provider returns its answer (polled or adopted); item 11's adoption skips such a job, because an identical prompt after that is a retry of an answer the caller could not use (the planner's `plan.no_ideas`) and adopting it would fail the retry the same way every time. It is not the tombstone: the result route still reports `done`. The mark is conditional on the job id and best effort (a failed mark leaves the answer adoptable, the old behaviour); it costs one more refresh and write per call. (d) **A store whose `refresh`/`read` throws is read as `unreadable`.** The port now states they must not throw; the provider's catch is the backstop. Also: `EXTERNAL_SESSION_MEASURED_WALL_MS` was renamed `EXTERNAL_SESSION_ASSUMED_WALL_MS` **[renamed back to `MEASURED` on 2026-10-02, after Task 0 measured 12 minutes]**, and the code, its comments, the budget-exhausted message and the example config no longer describe the 12 minutes as measured (item 12 already said so).

**Still open after the plan.** Whether Routine 422 retries happen inside the poll window (the provider only ever sees a stored, already-valid answer, so a routine stuck in its own 422 loop looks like a timeout). The `maxCycleAttempts` default of 2 (`schema.ts` `DEFAULT_MAX_CYCLE_ATTEMPTS`) means one retry after a timeout or a stop at any of `write`, `inspect` and `schedule`, ten minutes later. The per-day launch quota (unmeasured; the first real run records launches per cycle in `stats().calls`). The subrequest count of a real day (item 14 estimates it; Free is refused, not measured). The run button's lock and request length on the Worker (items 8 and 13).

**日本語補足。** 実装計画を書くために実物のコードを読んだところ、この設計の記述と食い違う点があった（上の1〜14）。特に、(1) スロットを共有するのは publisher ではなくスカウトとコンソールの経路であること（承認にはロックが無く、実行ボタンのロックは Worker だけで5分）、(2) 同じ日に決めた「publisher は拒否する」は前提が誤りで、拒否すると**どのサイクルも `schedule` で止まる**ため、オーナーが「publisher のコメント呼び出しは `schedule` の中で同じ枠を使う」に訂正したこと（publisher のコードの変更は不要、サイクル全体のテストで証明）、(3) 最初のタイムアウトでサイクルを止めるには `Err` だけでは足りないこと、(4) 予算が `write`・`inspect` の途中で尽きると1日が短く終わる問題は、**オーナーが「許容できない」と判断し、オーケストレータの変更で直した**こと（provider の中断を示す `abortsRun` を見て、その段を再試行可能な失敗として止め、そこから再開する。再開した `write` は前の試行の下書きを孤児として残す。これは明記した費用）、(5) 別の呼び出しがまだ待っているジョブは捨てず（作成から待ち時間より新しければ `busy`）、答えが既にあれば同じプロンプトのときだけ流用すること、(6) 待ち時間の予算は Worker だけに効かせること（Node に壁時計の上限はない）。予算の上限は、測る予定の12分から余裕1分を引いた11分（※当時はまだ測っていない。2026-10-02 に12分を測った。下の追記）、(7) コンソールの承認・実行ボタンが長い待ちを HTTP リクエストで持つこと、実行ボタンのロックが待ちより短いこと、無料プランでは足りないことは、**既知の制約として書いた（直していない）**。オーナーの決定（ブロックしてポーリング・ポートは変えない・publisher は `schedule` の中）は変えていない。**[2026-10-02 に更新：下の「2026-10-02 追記（Task 0）」を読むこと。この太字は Task 0 が走る前に書いたもので、元の記述として残す。]** ~~なお、Worker の待ち時間のスパイク（Task 0）はオーナーの Cloudflare ログインが要るため未実施で、provider は「実装済み・未リリース・既定オフ・実機では未測定」である。Task 0 を通すまで、どの環境でも有効にせず、リリースしない。~~ほかに、1つのジョブ枠に compare-and-set が無いこと、「(M of N failed)」に欠けた案・下書きが数えられないことも、既知の制約として項目15・16に書いた。**2026-10-01 追記（項目17）：** 最終レビューで見つかった4点を直した。Worker では1回の起動の中で予算とラッチが再開しない（起動時から数え、間が空いても新しい回にしない）。`busy`・`superseded`・401/403/404 の fire 拒否でも `write`/`inspect` を止めて再開する。呼び出し元に返した答えには `consumedAt` を付け、同じプロンプトで二度と流用しない（`discardedAt` とは別。結果の窓口は `done` のまま）。ストアの `refresh`/`read` が例外を投げても「読めない」として扱う。あわせて、12分を「実測」と読める名前・文言（定数名・コメント・エラー文・設定例）を直した。

**2026-10-02 追記（Task 0）。**Worker の待ち時間のスパイクを走らせ、**通った**（等級X：自分たちの実験・オーナーのアカウント1つ・使い捨ての Worker `amp-spike-wall-time`・bindings なし・終了後に削除）。測ったのは12分まで。毎時でない cron（`*/30`）で12分待つ：通過（720175 ms と 720188 ms）。毎時 cron（`0 * * * *`、実際のサイクルの cron と同じ形）：通過（720295 ms）。HTTP GET を無言で12分保持：通過（curl 終了コード0、HTTP 200、720.24秒）。30秒ごとに1バイトを送る場合も通過（720.26秒、24バイト）。`Date.now()` と `performance.now()` のずれ：0.0%。各回、30秒の拍の1つおきに実際の subrequest を1回出した（1回あたり約12回）。（集計スクリプトの表示が 2026-09-30 だったのは日付が書き込まれていたため。実行は 2026-10-02。）**関門の判定：進める。Task 1〜9 はそのまま。**予算の上限11分は「測った12分から余裕1分」になり、定数名は `EXTERNAL_SESSION_MEASURED_WALL_MS` に戻した。
**項目8の訂正：**12分保持した HTTP リクエストが持ちこたえたので、「開いたままの接続」の心配は軽くなった。**ただし実行ボタンの5分のロック（`RUN_LOCK_TTL_MS`）は待ちより短いままで、その制約は残る（項目13）。**
**測っていないこと：**12分より長い待ち（文書上は15分だが、文書上の数字のまま）／アカウントの Cloudflare プラン（wrangler では分からない。**無料プランで12分の cron が動くとは言えない。無料プランは引き続き文書で断る**）／D1 の遅延／実際のポーリングでの subrequest の上限（スパイクは約12回、実際の1日は約70〜100回の見積もり）／起動の重なり／Routine の遅延の分布／Routine の1日の起動上限／**provider を使った本物の1サイクル**（`amp-test` に provider を載せる必要があり、それにはリリースの判断が要る。未決）。**provider は引き続き実装済み・未リリース・既定オフ。`amp-test` で本物の1サイクルが動き、その結果がここに記録されるまで、有効にもリリースもしない。**最初の Q3 は 404（Cloudflare エラー 1042）だった。デプロイ直後で workers.dev のルートがまだ生きていなかったためで、待ち時間の結果ではない（2回目を採用）。

**Tests.** Unit: injected `fetch`, in-memory store, fixed clock. Named failure cases that must go red under `scripts/mutate.ts`: timeout aborts, stale job discarded, id mismatch ignored, schema violation is `Err`, fire refusal is `Err`. Smoke (`cli.smoke.test.ts`): config loads with `llm.provider: external-session` and reports the missing-variable error. Real-infrastructure: one full cycle on `amp-test`, recording latency per call and launches consumed.

### Phase 2 — decide whether to offer it to licensees at all

Not started, and not decided. Only after 1a and 1b have run for real does it become a real question rather than a guess: the settings-screen switch, Free-plan messaging, and a procedure document written for someone who is not the platform's own developer.

## Phase 1a status: proven, end to end, on real infrastructure (2026-09-30)

**Done (2026-09-28), reviewed and merged:** `llm.externalSession` in `platform.config.yaml`'s schema (`enabled`, `tokenEnv`, defaulting to off); the four job routes in `src/console/router.ts`; `src/llm/validate.ts`; the `sql-state.ts` key-list fix; `src/kernel/external-session.ts`. Two independent design reviews, a parent-level correction between them (see above), and the parent's own re-run of the resulting tests and `mutate.ts` proofs — recorded in `decisions.md`.

**🔴 Run for real, 2026-09-30 — the mechanism works.** The owner ran `scripts/external-session-harness.ts` against `amp-test` with a real Claude Code Routine on their own Max-plan account. Result: **PASS**, the answer matched the job's schema exactly. Real measurements, grade X (our own experiment, not a documentation claim) — recorded in `decisions.md` and cross-referenced from `design-evidence.md`:

- **End-to-end latency, one run: ~20.9 seconds** from firing the routine to a validated answer (job creation +1.4s, routine fired +2.3s, done at +20.9s total). One data point, not a distribution — repeat before relying on it for anything time-sensitive.
- The routine's saved instructions (which never reference fire-time `text` at all — see E-23) were sufficient on their own; nothing about `text`-meshing needed resolving, because phase 1a's design sidesteps it entirely (single global job slot, always fetch "the" pending one).
- `GET /job` correctly reported 404 ("not found") once the job was answered, confirmed independently by the parent with a direct `curl` after the run — the full lifecycle, including the state transition, behaved exactly as designed.

**Still open:**
- The per-day launch limit — one run says nothing about it. Needs repeated runs, or reading the number directly at `claude.ai/code/routines` (the docs say a cap exists but don't state the number).
- Whether the ~21s latency holds up across more runs, larger prompts, or when the routine's environment is under other load.

## Not doing yet

- ~~`llm.provider: external-session` itself, and wiring an answer into the orchestrator's cycle (phase 1b)~~ **Implemented 2026-09-30, not yet run for real** (one cycle on `amp-test`, recording latency, launches and subrequests per call, is still to do). The publisher's comment calls run inside `schedule`, so a cycle can complete under this provider; a run that ends part-way now stops the step and resumes there instead of ending the day short ("Phase 1b: where the code disagreed", item 10). Stated limitations, not fixed: the console paths and the run button's lock (items 8, 13), and the Free plan (item 14).
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
