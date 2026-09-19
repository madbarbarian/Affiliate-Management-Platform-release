# Configuration

One file: `platform.config.yaml`. Create it with `node src/cli.ts init`, which
copies `platform.config.example.yaml`.

It is git-ignored on purpose — that is what lets you pull upstream updates
without a merge conflict on every release.

**Secrets never go in this file.** Config names an environment variable; the
value lives in `.env.local`, which is git-ignored. `.env` holds shared,
non-secret defaults and *is* committed. `${VAR}` and `${VAR:-default}` are
expanded at load time, and an unset variable with no default is a startup error
rather than a silently empty string.

Every field is validated at startup, and *all* problems are reported at once so
one run fixes the whole file.

---

## `company`

| Field | Meaning |
|---|---|
| `name` | Shown in the console and used in prompts |
| `operator` | Whose name goes on approvals in the audit trail |
| `autonomy` | `manual` · `assisted` (default) · `auto` — see [Operating model](../1-requirements/operating-model.md#three-levels-of-autonomy) |
| `principles` | How the company thinks, as a list of sentences. Read by every role in every venture, so a second account still sounds like the same company. Optional. |
| `boundaries` | What the company never does, whatever an account's numbers say. Also prose, also read everywhere. **Shapes what is proposed; does not block what is published.** Anything that must be blocked belongs in `policy.prohibitedClaims` as well — a boundary is a shared judgement, not a guardrail. |

### `company.exploration`

The weekly question: should the company try another account? See
[Exploration](../3-development/exploration-design.md).

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Let the daemon run the scout on a schedule. Off by default so a fresh install never makes a model call you did not ask for. `amp scout` runs it by hand regardless. |
| `everyDays` | `7` | Days between scheduled runs (1–90) |
| `proposals` | `3` | How many accounts to propose per run (1–10) |
| `lookbackDays` | `30` | How much of each account's history the scout is shown (7–365) |

| `review.afterPosts` | `20` | An account is only judged once it has this many posts in the window |
| `review.belowShareOfMedian` | `0.5` | Flag when its median engagement is below this share of the company's median (needs two or more accounts with enough posts) |

Accepting a proposal **appends** its `ventures[]` block to this file as text,
inactive, under `ventures:`, with the hypothesis and the stopping rule as
comments — nothing else in the file is touched, and the previous file is kept
in `.amp/config-backups/`. Set `active: true` when the voice reads right and
restart the daemon. `amp scout accept --print-only` shows the block instead.

## Switching an account off without editing this file

`amp venture deactivate <id> --reason "…"` (or the button in the console's
全アカウント table) stops an account running and publishing, keeps everything it
has learned, and takes effect on the daemon's next tick. `amp venture activate
<id>` switches it back on. This lives in `.amp/venture-state.json`, beside the
stop file: what an account *is* stays here in config, whether it is *running
this season* is an operating decision. A review flag in the portfolio is the
platform's suggestion; the switch is always yours.

## `runtime`

| Field | Default | Meaning |
|---|---|---|
| `dataDir` | `.amp` | Where operating state is written. Relative to the config file. |
| `promptsDir` | `prompts` | Where role prompts live. Point this elsewhere to keep your prompt edits in a separate directory. |
| `logLevel` | `info` | `debug` · `info` · `warn` · `error` |
| `logFormat` | `pretty` | `pretty` for a terminal, `json` for a log collector |

## `llm`

| Field | Default | Meaning |
|---|---|---|
| `provider` | `anthropic` | `anthropic` or `mock`. `mock` runs the whole loop with no API calls — useful for demos and for testing config changes. |
| `model` | `claude-opus-5` | Judgement work: research, planning, writing, inspection |
| `fastModel` | = `model` | Mechanical work: analysis summaries, comment drafts |
| `effort` | `high` | `low` · `medium` · `high` · `xhigh` · `max`. Reasoning depth for the primary model. |
| `fastEffort` | `medium` | Same, for the fast model |
| `maxOutputTokens` | `4096` | Raise if drafts are being truncated |
| `apiKeyEnv` | `ANTHROPIC_API_KEY` | Name of the env var holding the key |
| `maxRetries` | `3` | Retries for rate limits and 5xx |
| `requestTimeoutMs` | `120000` | Per request |

There is deliberately no `temperature`: current Claude models take `effort`
instead, and sending `temperature` to the Opus 5 family is an error.

## `console`

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether `daemon` also serves the console |
| `host` | `127.0.0.1` | Bind address |
| `port` | `4321` | |
| `tokenEnv` | `AMP_CONSOLE_TOKEN` | Env var holding the bearer token |

Bound to loopback with no token set, one is generated at startup and printed in
the URL. Bound to anything else, a token is **required** and the server refuses
to start without it.

## `policy` — the guardrails

These are enforced in code, before and after the inspection rewrite.

| Field | Default | Meaning |
|---|---|---|
| `requireDisclosure` | `true` | Block any post carrying an offer with no disclosure |
| `disclosureText` | `#PR` | The exact text that must appear |
| `maxAiSmellScore` | `35` | 0 reads as human, 100 as generated. Strict on purpose. |
| `blockOnComplianceFindings` | `true` | **Leave this on.** `false` turns every `compliance.*` block — missing disclosure, prohibited claim, missing cross-border notice — into a warning that publishes anyway. It exists for a market whose rules you have verified do not require them, not for getting a stuck post out. |
| `bannedPhrases` | see example | Phrases that mark text as machine-written. **The cheapest quality lever in the system** — add to it as you spot things. |
| `prohibitedClaims` | see example | Claims no post may make, whatever the offer pays |
| `maxPostsPerDay` | `3` | Ceiling for any one venture's `cadence.postsPerDay`. Per venture, not summed across them. |
| `minMinutesBetweenPosts` | `120` | |
| `metricsWindowHours` | `72` | How long a post keeps being polled for metrics |

## `tracking`

| Field | Meaning |
|---|---|
| `baseUrl` | Your bare domain, e.g. `https://go.yourdomain.com`. The platform appends `/go/<code>` itself — do not add `/go`. The console serves that path; for real use, host it publicly and point this at it. |
| `linkParam` | Query parameter carrying the code on the destination URL |
| `extraParams` | UTM-style parameters appended to every destination |

The link in your posts points at your redirector, not the network. That keeps
the visible link stable, counts clicks before the hand-off, and means switching
networks does not invalidate old posts.

## `markets[]` — required

Where your readers are, and what the law expects of an ad shown to them. See
[Cross-border promotion](cross-border.md) for the reasoning; this is the field
reference.

| Field | Meaning |
|---|---|
| `id` | Referenced by `ventures[].market` and by every offer's `originMarket` / `targetMarkets` |
| `name` | Human-readable, used in findings and prompts |
| `language` | BCP-47. What the audience reads in. |
| `currency` | ISO 4217. Revenue from this market is denominated here and never converted. |
| `timezone` | IANA |
| `disclosureText` | The disclosure this market's regulator expects, **in its language**. Overrides `policy.disclosureText` for ventures in this market. |
| `regulator` | Who would object, and under what rule. Appears in findings so an audit says *why*. |
| `prohibitedClaims` | On top of `policy.prohibitedClaims` |
| `restrictedCategories[]` | `{ category, note, prohibited }`. `note` reaches the writing and inspection roles as a constraint; `prohibited: true` refuses the pairing at config time. |
| `crossBorderNotice` | What a reader here must be told when the merchant is abroad |

## `licensing`

Only relevant if you operate this instance on someone else's behalf — the third
tier of the licence structure in `LICENSE`. Running your own accounts? Leave
`model: none`.

| Field | Default | Meaning |
|---|---|---|
| `model` | `none` | `none` · `subscription` · `revshare` |
| `subscriptionAmount` | `0` | Flat amount per 30 days, prorated by the statement period |
| `subscriptionCurrency` | `JPY` | |
| `revshareRate` | `0` | Fraction (0–1) of **approved** revenue. Pending revenue is shown but never billed. |
| `overrides[]` | `[]` | `{ venture, ...any of the above }` for tenants on different deals |

`node src/cli.ts statement --days 30` prints the arithmetic per venture, per
currency. It is a statement, not an invoice: no tax is applied and no money
moves. Whatever you configure here must match the terms your tenants accepted —
`contracts/tenant-terms.template.md` is a drafting checklist for those.

## `channels[]`

| Field | Meaning |
|---|---|
| `id` | Referenced by `ventures[].channels` |
| `adapter` | `mock` · `manual` · `threads` · `webhook`, or one you register |
| `enabled` | |
| `credentialEnv` | Map of credential name → env var name. Never literal secrets. |
| `research.queries` | What the research role searches for |
| `research.minLikes` | Engagement floor for the swipe file |
| `research.maxItems` | Cap per cycle |
| `research.lookbackHours` | How far back to look |
| `options.maxCharacters` | The channel's own limit |
| `options.format` | `short` · `thread` · `longform`. Changes what the writing role produces — a 280-character post and a note article are different pieces of work, not the same text at two lengths. |
| `options` | Otherwise adapter-specific; for `webhook`, the endpoint URLs. |

### The `manual` adapter — you post it yourself

Connecting a posting API is the longest job in a first hour, and some platforms
have none worth wiring up. This adapter skips it. When a post's slot arrives the
platform composes the text — the same composition an API adapter would publish,
disclosure and all — and the post becomes `handed_over` rather than `published`.
The console shows it under 「あなたが投稿する番です」 with the text, a copy
control, a link to the app and a 「投稿しました」 button. Pressing that is what
makes it `published`, timed to the press.

| Option | Default | Meaning |
|---|---|---|
| `maxCharacters` | `500` | The destination's own limit. The text is composed and cut to it. |
| `format` | `short` | `short` · `thread` · `longform`, as for any channel. |
| `composerUrl` | — | An `https://` (or `http://`) address that opens the destination's composer. The console offers it as a link beside the text. Anything else is ignored, because the console renders it into the page that approves posts. |

`credentialEnv` is empty: there is nothing to connect.

**What you keep.** Clicks, conversions and revenue. The link in the text is this
platform's own `/go/` redirect, so everything downstream of the click is
recorded exactly as it is for a post the platform published itself.

**What you lose.** Likes and replies. Nobody is asking the platform for them, so
engagement for these posts stays empty and the analysis role learns from clicks
and revenue only. `doctor` and the accounts table say so in those words — it is
a deliberate trade, not a broken configuration, and it reads differently from
the `mock` adapter, whose numbers are invented.

**The affiliate link.** On a channel with comments the tracked link lives in the
link drop under the post. This channel has none, so the console hands you that
comment too, under the post text, to paste as the first reply.

## `networks[]`

| Field | Meaning |
|---|---|
| `id` | Referenced by `offers[].network` |
| `adapter` | `mock` · `csv` · `webhook`, or one you register |
| `credentialEnv` | |
| `options.subIdParam` | Query parameter the network reads the sub-id from |
| `options` | Adapter-specific |

### The `csv` adapter

Most consumer affiliate networks give publishers a report to download, not an
API — A8.net, もしも, バリューコマース, afb, アクセストレード, ShareASale, CJ,
Impact, Rakuten Advertising, Amazon Associates. Drop the exports in a directory
and map the columns once.

| Option | Default | Meaning |
|---|---|---|
| `reportsDir` | — | Where you put the exports. A missing directory is an empty inbox, not an error. |
| `encoding` | `utf-8` | `shift_jis` for most Japanese networks |
| `delimiter` | `,` | |
| `currency` | `JPY` | Used when the report has no currency column |
| `columns` | see below | `{ at, externalId, subId, amount, currency, status }` → your report's header names. Matched case- and space-insensitively. |
| `statusMap` | see below | Extra `"あなたの文字列": approved\|pending\|rejected` entries |
| `amountScale` | `1` | Multiply amounts, for reports denominated in minor units |

Defaults for `columns` are `order_id` / `subid` / `date` / `amount` /
`currency` / `status`. `statusMap` already understands 承認・確定・成果確定・
未確定・保留・却下・キャンセル・非承認 and the usual English equivalents.

Re-importing the same file is harmless: conversions deduplicate on the
network's own order id. A mis-mapped column fails loudly, naming the headers it
actually found.

## `offers[]`

Declare offers here when your network has no catalogue API.

| Field | Meaning |
|---|---|
| `id` | Referenced by `ventures[].offers` |
| `network` | Must match a declared network |
| `name`, `landingUrl`, `category` | |
| `payoutModel` | `cpa` · `cpc` · `revshare` |
| `payoutValue` | Fixed amount for cpa/cpc; a fraction (0–1) for revshare |
| `currency` | |
| `originMarket` | Where the merchant is. Must be a declared market. |
| `targetMarkets` | Where you are permitted to promote it. Set it from the network's actual terms. A venture may only carry an offer whose `targetMarkets` include its own market. |
| `crossBorderNote` | **Required** when `targetMarkets` includes anything other than `originMarket`. What a foreign reader must know before clicking: currency, shipping, language support, who they are contracting with. |
| `complianceNotes` | Rules the inspection role must honour. These reach the model as constraints. |
| `active` | |

## `ventures[]`

One per account you operate.

| Field | Meaning |
|---|---|
| `id`, `name` | |
| `niche` | In your own words. Feeds every prompt. |
| `audience` | Who the content is for. Be specific — this does more work than any other single field. |
| `market` | Which market's rules govern this account. Must be a declared market. |
| `timezone` | IANA. All scheduling is evaluated here. |
| `language` | BCP-47, e.g. `ja` |
| `channels`, `offers` | Must reference declared ids |
| `active` | |

### `ventures[].voice`

The written personality all six roles hold to. This is what stops six agents
producing six voices.

| Field | Meaning |
|---|---|
| `persona` | Who the account reads as, in a sentence or two |
| `firstPerson` | The pronoun. Matters enormously in Japanese. |
| `tone` | Adjectives, e.g. `[率直, 自嘲気味]` |
| `signaturePhrases` | Turns of phrase recognisably this account's |
| `bannedPhrases` | Per-venture, on top of `policy.bannedPhrases` |

### `ventures[].cadence`

| Field | Meaning |
|---|---|
| `postsPerDay` | Must not exceed `policy.maxPostsPerDay` |
| `minMinutesBetweenPosts` | |
| `cycleStartsAt` | `HH:MM` local. When the daemon starts the day. |
| `ideasPerCycle` | How many proposals you are shown. Ten is a good number: enough to choose from, few enough to read in thirty seconds. |

---

## Checking your work

```bash
node src/cli.ts doctor
```

Validates everything, checks every prompt file exists, and health-checks every
enabled channel and network with their real credentials.
