# Changelog

All notable changes to this platform. Written for someone who already has a
running operation and one question: *will merging this break my morning?*

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
seen from a licensee's config: a **major** release is one where an existing
`platform.config.yaml` stops validating.

## [Unreleased]

### Added

- **A `Store` contract test**, run against all three implementations (memory,
  JSON files, SQL). It found two divergences the suite could not: the
  file-backed `forCycle` ignored the order its caller asked for, and the
  in-memory audit log read `recent(0)` as the whole log.
- **A SQL `Store` and a SQL state store** — three tables, one JSON document per
  row, so a new field still costs no migration. Tested against real SQLite
  through Node's built-in `node:sqlite`, which is what D1 is, so no dependency
  was added. `sqlite-driver.ts` also gives a licensee a single-file database
  without a server.
- **The stop and the deactivation switch moved behind a `StateStore` port**,
  with fail-closed (the stop) and fail-open (deactivation) decided above it.
  Groundwork for [running on Cloudflare](docs/3-development/cloudflare-design.md).
- **One router and one tick.** The console's routes are now `Request` →
  `Response` with `node:http` as an adapter over them, and a turn of the loop is
  a function the daemon calls on an interval. Both so a host with no process can
  call the same code rather than a second copy of it.
- **The scout** (探索担当), a seventh role that works weekly for the company
  rather than daily for one account. It reads every account's aggregates and
  proposes the next account to try — niche, audience, market, name candidates,
  a voice sketch, permitted offers, the hypothesis and its evidence, the risk,
  three first hooks, and the signal that would mean stop. Market, prohibited
  category, duplicate niche, missing stopping rule and unpermitted offers are
  refused in code after the model answers. `amp scout`, `amp scout list`,
  `amp scout accept <id>` (prints a `ventures[]` block to paste — the config is
  never written), `amp scout dismiss <id>`; the daemon runs it on
  `company.exploration.everyDays` when `enabled`. Off by default.
- **Switching an account off from the console** (`amp venture deactivate`
  / `activate` / `list`, or the button in the 全アカウント table). Nothing is
  deleted and no config is edited: the state lives in
  `.amp/venture-state.json`, the daemon re-reads it every tick, and the
  account's playbook, history and revenue stay. Fails open - a corrupt state
  file switches nothing off. The portfolio flags accounts for review from
  their own numbers (`company.exploration.review`); the switch is the
  operator's.
- **Accepting a proposal appends its block to `platform.config.yaml`** as
  text under `ventures:`, inactive, validated before the swap, with the
  previous file kept in `.amp/config-backups/`. `--print-only` shows it
  instead.
- **A Cloudflare Worker entry point.** `fetch` serves the console's own router
  and `scheduled` runs the same tick the daemon does, so there is one copy of
  each. Storage and the switches are D1; the config and the prompts are bundled
  by `npm run build`. With no config of its own a deploy serves a setup page
  rather than a stranger's example account — and `/healthz` and `/go/<code>`
  answer before any of that, so a link already inside a published post keeps
  redirecting and recording clicks even when nothing else can start.
  A Durable Object stops two overlapping cron fires from publishing twice.
  Verified on real `workerd` with a local D1: the bundle resolves, the SDK
  loads, and a whole day - analyse, research, plan, approve, write, inspect,
  schedule - runs through to the second gate. What is left needs an account or
  a real API key.
- **The licensee guide leads with Cloudflare**, and the release now un-ignores
  `platform.config.yaml` in a licensee's fork — the Worker build bundles it, so
  a config that is not committed is one the deploy never sees. Ours stays
  ignored, and the release script says why in the file it ships.
- **The console says what is missing from the measurement chain**, not just
  that something is. There is no terminal to run `doctor` in on a host.
- **Where a licensee runs this** ([hosting.md](docs/4-operations/hosting.md)):
  what each host costs and asks of them, with the numbers checked — Vercel's
  free tier forbids commercial use and its free cron cannot reach a posting
  slot; Cloudflare has neither limit, bills CPU rather than wall time (so the
  waiting a cycle is mostly made of costs nothing), and comes to $5/month.
  A design for the move is in
  [cloudflare-design.md](docs/3-development/cloudflare-design.md), and the
  decisions behind all of it are in
  [decisions.md](docs/5-project-management/decisions.md).
- **The licensee's first hour redrawn around one link.** Cloudflare's deploy
  button clones the repository into their account, provisions the database,
  prompts for each secret and deploys; `workers.dev` is free and public, so the
  measurement chain closes on day one and the step that asked for a domain is
  gone. Screens in `docs/_drafts/design/onboarding/`.
- **Contract structure written down** (`docs/1-requirements/licensing.md`):
  who the publisher is, what the licensor does and does not promise, a
  responsibility matrix tied to what the code actually enforces, the fee
  options, and the decisions and legal questions still open. Drafts in
  `contracts/`: an early-access licence for the first users, a master licence
  template, and the tenant terms checklist (moved from the repo root, with
  deactivation, the stop, JSON export and AI-text ownership added). None
  reviewed by a lawyer.
- **`company.principles` and `company.boundaries`**: how the company thinks and
  what it never does, in prose, read by every role in every account.
- **The portfolio**: `amp portfolio` and a 全アカウント table in the console —
  per account: state, waiting decisions, last cycle, posts, median, clicks,
  conversions, revenue by currency, proven patterns, whether measurement is
  closed. Totals are counts and per-currency only.
- **Emergency stop** `amp pause` / `amp resume`, fail-closed, works without a
  valid config, API key or adapter. `doctor` checks the measurement chain per
  venture. Smoke tests spawn the real binary; the console has HTTP tests.

### Changed

- The inspector's AI-smell verdict compares the model's score of its **rewrite**
  with the heuristic's score of the same rewrite. It used to compare the score
  of the original against the rewrite's heuristic and blocked nearly everything
  an honest model produced.
- `tracking.baseUrl` is the bare host; the example and `.env` no longer end in
  `/go`, which produced `/go/go/<code>`.
- Exploration slots in planning are switched off at one or two posts a day
  (keyed on `postsPerDay`, not on the shortlist size).
- The publish gate marks a missing disclosure red only on posts that carry an
  offer.
- Japanese terminology fixed across the documents (see `docs/7-references/glossary.md`).
- `--dry-run` no longer gets its own answer to what is running: it swaps
  storage, the model and the adapters, but reads the operator's real stop and
  deactivations. A dry run that disagreed with the live one was worse than
  useless, since checking is why anyone runs it.

## [0.2.0] - 2026-08-27

### Added

- **Markets and cross-border promotion.** A new required `markets:` section
  declares where your readers are and what the law expects of an ad shown to
  them. Compliance follows the **audience**, not the merchant: a US offer
  promoted to Japanese readers is governed by 景表法 and the ステマ規制, and
  the disclosure is written in Japanese.
  - Offers gain `originMarket`, `targetMarkets` and `crossBorderNote`.
  - A venture can only carry an offer whose `targetMarkets` include its own
    market. Config validation refuses to start otherwise.
  - A cross-border offer must declare what a foreign reader is owed before
    clicking — currency, shipping, language support, who they are contracting
    with. The writer is asked to work it into the post; if it is missing after
    the inspection rewrite, the platform adds it and the post is blocked
    without it.
  - A market may prohibit a category outright (e.g. gambling in Japan); such a
    pairing is refused at config time.
- **`csv` affiliate-network adapter.** Reads the conversion reports networks
  actually give publishers — A8.net, もしも, バリューコマース, afb,
  アクセストレード, ShareASale, CJ, Impact, Rakuten Advertising, Amazon
  Associates. Handles Shift_JIS, Japanese date formats, quoted fields, and
  deduplicates re-imported files by the network's own order id.
- **Post formats per channel.** `options.format` is `short`, `thread` or
  `longform`, and the writing role is told which it is producing. Config
  presets shipped for X, note and YouTube descriptions.
- **Release workflow**, matching the `release-repo-split` pattern: a pre-push
  hook, a `/release` skill, and `.github/workflows/sync-to-release.yml`.

### Changed

- **`version: 2` is required in `platform.config.yaml`.** A version-1 file now
  fails validation with a message naming the version rather than running an
  operation with no jurisdiction attached to it.
- **Revenue is reported per currency and never summed across them.** There is
  no exchange rate in this platform on purpose. `report`, the console and the
  analysis role all show `7,500 JPY / 30 USD` rather than one wrong number.
- **Secrets moved to `.env.local`.** `.env` now holds shared, non-secret
  defaults and is committed; `.env.local` holds keys and tokens and is
  git-ignored. Precedence is real environment variables > `.env.local` >
  `.env`. `amp init` creates `.env.local` and generates the console token there.
- **Docs restructured** into the `dev_base` seven-category layout. Every link
  in the README and in `CLAUDE.md` was updated; nothing was deleted.
- `prompts/writer.user.md`, `prompts/inspector.user.md` and
  `prompts/analyst.user.md` gained the market-rules block. **Licensees who have
  customised these three files will get a conflict there and nowhere else.**

### Migration from 0.1.0

1. Add `version: 2` at the top of `platform.config.yaml`.
2. Add a `markets:` section — copy the `jp` / `us` entries from
   `platform.config.example.yaml` and edit them for your jurisdiction.
3. Add `market: <id>` to every venture.
4. Add `originMarket`, `targetMarkets` and (where they differ)
   `crossBorderNote` to every offer.
5. Rename your `.env` to `.env.local`.
6. Run `node src/cli.ts doctor` — it reports every remaining problem at once.

## [0.1.0] - 2026-08-26

### Added

- Initial platform: six agent roles (analyst, research, planning, writing,
  inspection, publishing), a resumable daily cycle with two human gates,
  the playbook with recency-weighted pattern confidence, tracked links and
  revenue attribution, the approval console and tracking redirect, the
  scheduler daemon, and the licensee release packaging script.
