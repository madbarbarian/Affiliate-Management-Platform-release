# Architecture

## The idea

Six agents, each with one job, arranged as a company rather than a chain of
prompts. What makes it a company and not a script is the two things that sit
around them: a **playbook** that accumulates what actually works, and an
**orchestrator** that owns the day and stops at the two points where a person
is required.

## One day

```
                       ┌──────────────────────────────┐
                       │        Orchestrator          │
                       │  owns sequencing + state     │
                       └──────────────┬───────────────┘
                                      │
   ┌──────────┬──────────┬────────────┼────────────┬──────────┬──────────┐
   ▼          ▼          ▼            ▼            ▼          ▼          ▼
analyze → research →  plan  →  [PROPOSAL GATE] → write → inspect → schedule
                                      │                                  │
                                      │                                  ▼
                                      │                        [PUBLISH GATE]
                                      │                                  │
                                      └── the only two points ───────────┘
                                          a human is involved
                                                                         ▼
                                                                     dispatch
```

Each step persists before the next begins. Killing the process at any moment
loses at most one step of *state*, which matters because a gate can wait hours
for someone to wake up. Side effects inside a step are not yet idempotent: a
crash between a channel accepting a post and the store recording it can publish
that post again on resume, and a crash mid-`write` re-drafts the ideas already
drafted. Both are open items in the requirements.

The cycle id is derived from the venture and the local date
(`cyc_main_2026-04-01`), not generated. Running `cycle run` twice does not start
a second company day.

## Layers

```
  entry points     cli.ts · console/ · scheduler/ · worker/
        │
        ▼
  runtime.ts       builds everything from config, one place
        │
        ▼
  kernel/          orchestrator · approvals · policy · role contract · prompts
        │
        ▼
  roles/           the six agents
        │
        ▼
  domain/          engagement · performance · scheduling
  playbook/        pattern confidence
  affiliate/       links · attribution
        │
        ▼
  ports            llm/ · storage/ · channels/ · networks/
```

Dependencies point one way. A role may use the domain and the ports; nothing
below the kernel knows the orchestrator exists.

`worker/` is the Cloudflare host: `worker/runtime.ts` mirrors `runtime.ts` (same
`assembleRuntime` in `kernel/assemble.ts`, config and prompts from the build
instead of the filesystem, storage from D1). `worker/handler.ts`'s `fetch` hands
every request straight to `console/router.ts` — the daemon and the Worker serve
the same routes from the same code, not two copies to keep in sync.

`console/` itself splits into `router.ts`/`server.ts` (routing, auth, the API)
and `console/page/` (the rendered screen, composed by `ui.ts` from one file per
section under `console/page/client/`). A screen change does not touch routing,
and vice versa.

## The ports

Four seams, each one file to replace:

| Port | Shipped adapters | Replace it when |
|---|---|---|
| `LlmProvider` | `anthropic`, `mock` | never, realistically — but the mock is how tests and dry runs work |
| `Store` | JSON files, in-memory, D1 (via `sql-store.ts`) | you outgrow a single machine and D1 does not fit either — Postgres/Supabase speak the same driver interface |
| `Channel` | `mock`, `threads`, `webhook` | you post somewhere the platform does not ship |
| `OfferNetwork` | `mock`, `csv`, `webhook` | your network has a real API worth speaking natively |

Adapters are resolved by name from config, so adding one is a factory plus a
line in a registry. See [Extending](extending.md).

## Above the cycle: the company

Two things look across ventures instead of running inside one, and both are
deliberately read-only about any single account's content:

- **The portfolio** (`src/domain/portfolio.ts`) — one row per venture:
  state, waiting decisions, last cycle, posts, median, clicks, conversions,
  revenue by currency, proven patterns by name, whether measurement is closed.
  `amp portfolio` and the console's 全アカウント table.
- **The scout** (`src/roles/scout.ts`, run by `src/kernel/exploration.ts`) —
  the seventh role. Weekly, it reads the portfolio and proposes the next
  venture; a person accepts or dismisses; accepting prints a `ventures[]`
  block. It works from aggregates only, so one account's learning never
  becomes another's — the property a buyer of an account relies on.

`company.principles` and `company.boundaries` are the thread through all of it:
prose in config, rendered into every role's brief, so the twentieth account
still reasons like the first.

## Why roles are this dumb

A role takes a typed input, does one job, returns a typed output or a failure.
It does not decide what runs next, does not call another role, and does not know
a human exists.

That constraint buys three things:

- **The orchestrator can be resumable**, because it is the only thing holding
  state.
- **Any role can be tested alone**, with a scripted model response.
- **A seventh role is additive.** A legal reviewer, a translator, a thumbnail
  designer: write one file, add one step.

## Where the guardrails are

Deliberately *not* in the prompts.

`src/kernel/policy.ts` checks the affiliate disclosure, the prohibited claims,
the channel's character limit and the AI-smell heuristic — in code, with no
model in the loop. The inspection role runs them **before** the rewrite (as
facts the model must resolve) and **again after** it, on the rewrite. The
second run is the one that decides; the orchestrator trusts the report's
`passed` and never re-checks at dispatch. Both runs live in
`src/roles/inspector.ts`, which is why that file is not a place to be creative.

The AI-smell score held to the limit is the *worse* of the inspecting model's
score of its own rewrite and the heuristic's score of the same rewrite. A model
grading its sibling's work is not a disinterested party; nor is one grading its
own, which is why the heuristic keeps a vote.

## How the playbook learns

```
 swipe posts ──► candidate pattern ──► used in a plan ──► published ──► measured
                        ▲                                                  │
                        └────────── evidence attached, re-scored ◄─────────┘
```

Confidence is recency-weighted and shrunk toward "unknown" until there is
enough evidence to justify a claim (`src/playbook/playbook.ts`). Promotion
needs less evidence than retirement: wrongly promoting costs one mediocre post,
wrongly retiring throws away something that works.

Planning always reserves about a quarter of its slots for untested candidates.
Without that the playbook converges on whatever worked first and stops learning.

## How money ties back to content

```
post ──► tracked link ──► click ──► conversion ──► pattern
```

Link codes are derived deterministically from (venture, offer, post), so the
same post always maps to the same code — a restart or a rebuilt data directory
cannot orphan revenue already earned. The short URL in the post points at the
operator's own redirector rather than the network, so switching networks does
not invalidate every post ever made.

Conversions the network reports against an unknown sub-id are counted as
*unattributed* rather than dropped: the count is in the audit log and in the
analysis report, though not yet in `amp report`. That number going up is a
symptom worth seeing.

## State

Everything lives under `runtime.dataDir` (default `.amp/`) as plain JSON, one
file per collection, plus `audit.jsonl`. It is meant to be readable: when
something looks wrong, `cat .amp/cycles.json` is a legitimate debugging step.

A `mkdir`-based lock stops `amp cycle run` from racing the daemon. Read-only
commands do not take it.

Two small files beside the collections are *operating state*, not data, and
are written atomically (`src/storage/atomic.ts`) because the daemon reads them
on every tick:

- `paused.json` — the stop. Fails closed: unreadable means stopped.
- `venture-state.json` — which accounts the operator has switched off, by whom
  and why. Fails open: unreadable means everything runs, with a warning in
  `doctor`. The config says what an account *is*; this file says whether it is
  running this season, so switching one off needs no config edit and no
  restart.

`config-backups/` holds a dated copy of `platform.config.yaml` from before
each block the scout appended to it — the config is git-ignored, so git does
not have these.

All three of those are files when the platform runs as a process on a machine
(`node src/cli.ts daemon`). On the Worker, which has no writable filesystem,
the same collections live in D1 instead (`storage/sql-store.ts`), and the two
small operating-state files become two rows read through `storage/sql-state.ts`
— same `StateStore` port `pause.ts` and `venture-state.ts` already used, same
fail-closed/fail-open split. **This is shipped, not a proposal**: it is how
every licensee that deploys with the Deploy button runs. What building it
changed and what it cost is in [Running on Cloudflare](cloudflare-design.md).
