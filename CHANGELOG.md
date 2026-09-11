# Changelog

All notable changes to this platform. Written for someone who already has a
running operation and one question: *will merging this break my morning?*

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
seen from a licensee's config: a **major** release is one where an existing
`platform.config.yaml` stops validating.

## [Unreleased]

## [0.3.0] - 2026-09-11

### Added


- **The console tells you when a fix exists.** One quiet line above the day's
  work, with what changed folded underneath it, and nothing at all when you are
  current. Someone who does not know an update is out keeps hitting a bug that
  is already fixed and has no occasion to find out — worse off than someone who
  knows and has to click three times. It needs no credential and no git: the
  copy carries its own identity in `RELEASE.json`, and the check reads what the
  release repository publishes. If GitHub is unreachable, or this copy was never
  released, you see nothing rather than an error.

- **A day nobody answered closes when the day is over.** The gate is marked
  `expired`, its cycle ends `cancelled`, and "最近の動き" says which day lapsed.
  Nothing is deleted — the ideas and the record stay readable.

  **This changes what an unattended day does.** Before, the gate stayed open and
  could be approved later; doing so wrote that day's posts onto slots that had
  all passed, so the whole day published at once, with the minimum spacing
  between posts observed by nothing. If you were relying on approving yesterday
  today, you no longer can; the reasoning is in `docs/1-requirements/requirements.md`
  section 4.


- **Each account's data is its own, and every read across accounts has a name.**
  A `Store` was one shared space that every reader filtered by `ventureId`, so
  "this account learned this by itself" was a claim about the code doing the
  filtering. It is now a fact about where the data is: `Services` holds a
  `StoreRegistry` and no store, a role is handed its own account's, and the
  eight readers that legitimately compare accounts — the accounts list, the
  scout, the dispatcher, the day's page, the tracking redirect, resolving a
  gate, listing what is pending, and `amp pause` — say so by calling `each()`.
  Nothing else can cross. On SQL this is one database with `venture` in the
  primary key; on files it is a directory per account, which is what makes
  handing an account over a matter of handing over a folder. A contract test
  runs against all three implementations. **Your data is migrated on first
  start**, and a licensee running more than one account is asked rather than
  guessed at — see [the design](docs/3-development/store-split.md).

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
- **A failed day says why on the console.** The 全アカウント table's 直近サイクル
  cell used to read `2026-09-09 failed → write` and stop there; the reason the
  step failed went to a log, and on a host there is no terminal to read one in.
  The reason now travels with the cycle, into that cell and into
  `amp portfolio`. Two failures were carrying nothing to report in the first
  place: a write step where every idea failed said only that they had, and a
  draft the inspector could not *read* was reported as one it had turned
  down — opposite instructions to the operator, since one asks for a rewrite
  and the other for a retry.
- **「今日のサイクルを動かす」** on each active account in the 全アカウント table. The route
  existed and nothing on the page pressed it, so a hosted operator's only way to
  start or retry a day was to wait for the next hourly cron — there is no
  terminal to run `cycle run` in. It takes the same lock the cycles tick takes,
  so a run and the schedule cannot draft the same day twice; where the host has
  no lock (a machine, whose data directory already holds one) it runs as before.
- **The example account is named for what it is, not for its rank**
  (`main` / メインアカウント → `ai-tools` / AI仕事術). The id goes into the
  console's addresses and every record kept, so it cannot be changed later
  without orphaning the history — the file now says so where it is set. Existing
  configs are untouched: this is the example a new licensee copies.
- **The 直近サイクル cell speaks Japanese.** It read `2026-09-09 failed → write`
  on a page that is otherwise entirely Japanese, to an operator with no
  terminal to look "write" up in. The status and the step have words of their
  own now (`2026-09-09 失敗（執筆）`), kept in `src/console/labels.ts` rather
  than inside the page, so a step added to `CycleStep` without one fails a test
  instead of reaching a screen.
- **The accounts table gives every column a width of its own, and lets you
  change them.** One long value in 直近サイクル took the whole table: the other
  nine columns were squeezed to a character wide and their headers rendered one
  letter per line. Fixed layout with declared widths, the table scrolling inside
  its own container rather than being compressed, numbers right-aligned, and a
  drag handle on every header border (remembered in the browser, with 列の幅を
  もとに戻す to undo).

- **A second operator gets their own passphrase, and their own name in the
  record.** `console.operators` lists anyone beyond the owner, each naming their
  own env var; the console header says whose passphrase you are holding, and
  every approval, deactivation and accepted proposal is stored against that
  name instead of `company.operator`. `doctor` lists who can open the console
  and fails on anyone listed without a passphrase. No roles: everyone named can
  still do everything. The point is only that the audit trail is true — an
  approval recorded while one passphrase was shared can never be attributed
  afterwards, so this is worth doing before a second person starts rather than
  after. A single-operator config is unchanged.

- **The console splits into three levels: today, all accounts, one account.**
  Everything used to be one scroll written from the all-accounts point of view,
  with no place to be inside a single account — so account-shaped things got
  pushed into the comparison row, which is how one API error took a whole table
  with it. `#/ventures/<id>` opens the account: the failure in full with 今日の
  サイクルを動かす directly under it, the last few days, its numbers and
  patterns, what is in force from the config with each field's source, and the
  switch. The list keeps one control, 開く. Reasoning and the screens are in
  [console-architecture.md](docs/3-development/console-architecture.md).
- **A failed day on the list reads 実行できませんでした**, with one smaller line
  under it — **chosen by the failure's code, never by truncating the message.**
  Truncation gives an English fragment or a sentence cut before the word that
  carried the meaning. A code with no words of its own prints the code and fails
  a test.
- **`console.locale`: ja or en.** Every word the console says now lives in
  `src/console/messages.ts`, typed so `en` must answer every key `ja` does — a
  half-translated screen is a compile error. **The screen's language is never
  the disclosure's**: that follows the reader's market, so an operator reading
  English while publishing to Japanese readers still publishes a Japanese
  disclosure. A test holds both halves of that.

### Fixed

- **A control you could not use looked exactly like one you could.** Both the
  cap on a gate ("最大2件") and a gate whose day has passed were already
  enforced, and neither was visible: the checkbox went dead with no change in
  appearance, so the cap read as advice the screen was ignoring. The two closed
  states are now drawn differently, because the way out of them differs — a
  card closed by the cap recedes but keeps its text readable, since unticking
  something else brings it back, while a lapsed day dims as a whole and keeps
  only its heading and its date legible, since nothing there is coming back.

- **Two gates open on different days looked like one gate drawn twice.** The
  card said the gate and the account and nothing else, so an unapproved day
  standing next to today's read as a repeated row. It now says which day it is
  for, and says so when that day has passed — decided in the account's own
  timezone, not the browser's.

- **The update workflow was broken three ways and none of them showed.** It
  never reached a copy made by the Deploy button (GitHub does not let an app
  write under `.github/workflows/`), it could not have pushed if it had (the
  same rule binds `GITHUB_TOKEN`), and it was not valid YAML, so GitHub would
  have refused to load it. The same file now also ships as `update-workflow.yml`
  in the repository root, which a copy does receive; installing it is one paste
  in the browser, once. See the licensee guide.


- **The console did nothing at all.** Its whole script is one inline module,
  and `(s) => {"running":"動作中"}[s]` parses that brace as a block — so the
  module died at the first colon, and with it every line of the page's
  behaviour. The page served its headings and sat on 読み込み中… forever. Two
  more escapes had been eaten by the template literal the page is written in
  (`\w` reaches the browser as `w`): `fmt`'s placeholder pattern, so no `{n}`
  was ever filled in, and the hash router's, which is what made the syntax
  error fatal rather than local. Every other test reads the page as text; two
  new ones parse the program the browser actually receives, and refuse a lone
  backslash anywhere in `ui.ts` that is not escaping a backtick or a `${`.
- **A day that failed left no trace in the audit log.** The orchestrator wrote
  the reason onto the cycle and into a logger, and the console's 最近の動き
  reads the audit log — so the feed said nothing had happened while the cycle
  was failing every hour. Two days ended that way on Cloudflare, under a
  heading that claims to be the record of what the company did, and finding out
  took a query against the database. A failed step now records a
  `cycle.failed` event carrying the step, the code, whether it is retryable
  and the message; the feed renders it in the operator's language from the same
  code the accounts table uses, in bold, and the API's own sentence stays in
  `data` where the account screen reads it. Recording the failure can never
  replace the failure: if the audit write itself fails, the caller still gets
  the original error.
- **A cycle that recovered on a retry went on calling itself failed.** The
  console shows a failure whenever one is stored, and a resumed cycle kept the
  one it had already got past — so an account that recovered on the next hourly
  retry sat there saying 実行できませんでした directly above its own approval
  gate. The reason is dropped when the day resumes; the failure that did happen
  is in the audit log, which is where history belongs.
- **`effort` was sent to models that refuse it**, which ended the cycle at its
  first call with `400 "This model does not support the effort parameter."`
  The cheap tier ships as `claude-haiku-4-5`, and Haiku 4.5 rejects both
  `output_config.effort` and `thinking: adaptive`. The adapter now decides
  per model, and **a model it does not recognise is sent neither** — losing
  effort costs some quality on that call, sending it wrongly costs the day.
  If you name a newer model than your copy of the adapter knows about, that is
  the direction it will err in; the table is at the bottom of
  `src/llm/anthropic.ts`. An effort level a model does not have is lowered to
  its highest rather than sent — `effort: max` on Opus 4.5, which stops at
  `high`, was the same lost cycle from a setting the config invites you to set.
  A test stands a real HTTP server in front of the real
  SDK and reads the body it sends, which is the only way this class of bug is
  visible at all — the mock provider never sees a request.
- **No role's structured output could ever have worked.** The first real model
  call this platform made came back
  `400 output_config.format.schema: For 'array' type, property 'maxItems' is
  not supported`, and every role's schema used at least one keyword from that
  list — `maxItems`, `minItems`, `maxLength`, `minimum`, `maximum`. The whole
  suite passed because it runs on the mock, which accepts anything. The bounds
  are now written into the field's description, where the model reads them,
  and `stripUnsupported` runs on every schema in the adapter so a hand-written
  one cannot 400 either. A test walks the schemas the roles really send.
  **Nothing enforces those bounds any more** — the API never did — so a role
  that needs one honoured has to check it itself.

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
