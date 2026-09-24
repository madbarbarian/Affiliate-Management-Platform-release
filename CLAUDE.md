# Working in this repository

An autonomous AI company that runs an affiliate operation. Six agent roles, two
human gates, one config file.

- **`docs/5-project-management/STATUS.md` — read this first, every session.**
  Where the work is, what to do next and in what order, and the things that live
  nowhere else (what has never run for real, what needs cleaning up). It is a
  desk, not a source of truth: when it disagrees with the two below, they win.
  Update its top two sections before you finish.
- `docs/1-requirements/requirements.md` — what this must do and why, and what is
  still undecided. Read it before adding a capability.
- `docs/3-development/architecture.md` — read it before changing anything
  structural.

## Stack

- **TypeScript on Node 22+, run directly.** No build step. Node strips types
  natively, so relative imports carry the real `.ts` extension
  (`import { x } from "./y.ts"`). `tsc` is typecheck-only (`noEmit`).
- **One runtime dependency:** `@anthropic-ai/sdk`. Adding another needs a
  reason a licensee would accept — they audit what they fork.
- **Tests are `node:test`**, run with `npm test`. No test framework.

```bash
npm run check        # typecheck + tests. Run this before every commit.
node src/cli.ts doctor
node src/cli.ts cycle run     # with llm.provider: mock, costs nothing
```

## The shape of the code

```
src/
  core/        Result, Clock, ids, logger, events, and the domain vocabulary
  config/      YAML reader, schema, loader. The one file a licensee edits.
  llm/         The model port + Anthropic adapter + deterministic mock
  storage/     The Store port + JSON file adapter + in-memory adapter
  channels/    The channel port + mock / threads / webhook adapters
  networks/    The affiliate-network port + mock / csv / webhook adapters
  domain/      Engagement, performance windows, slot planning, market rules
  playbook/    Pattern confidence, decay, promotion and retirement
  affiliate/   Tracked links and revenue attribution
  roles/       The six agents. One file each.
  kernel/      Role contract, prompts, policy, approvals, orchestrator
  console/     The approval console and the tracking redirect
  scheduler/   The daemon
prompts/       Role prompts as Markdown. Editing these is a supported action.
docs/          The dev_base 7-category layout:
               1-requirements 2-setup 3-development 4-operations
               5-project-management 6-testing 7-references _proposed
```

Follows `dev_base`. Deviations, and why:

- **Node CLI + daemon, not Next.js.** `dev_base`'s locked stack is for web
  apps. There is no `src/app`, `src/components`; the equivalent layering here
  is ports → domain → roles → kernel.
- **`src/` has no `types/` directory.** The domain vocabulary is one file,
  `src/core/types.ts`, because every role shares it.

**`docs/_proposed/` is `_drafts/` in `dev_base` — ahead of it, not away from
it.** What lives there is written to be shown, and it ships to licensees, so
"draft" was the wrong word and it was being used as a reason the product's own
standards did not apply. The proposal to rename it upstream is
`docs/7-references/dev_base-proposal-drafts-vs-proposed.md`. If `dev_base`
takes it, the two agree; if it does not, *that* is when this gets written down
as a deviation. Recording it as one now is what makes the next repository
inherit the same problem.

## Rules that are not negotiable

**Roles never decide what runs next.** A role takes a typed input, does one
job, returns a typed output. The orchestrator owns sequencing, persistence and
the gates. If a role needs to know about another role, the design is wrong.

**Guardrails are code, not prompts.** The disclosure check, prohibited claims,
channel limits and the AI-smell heuristic live in `src/kernel/policy.ts` and run
*after* the inspection rewrite, not only before it. A model can be talked out of
its opinion; a string check cannot. Never move one of these into a prompt.

**Domain failures are values, not exceptions.** Return `Result` from anything
that can fail for a business reason (the API refused, a channel is down, a
draft was blocked). Throw only for programmer errors. The orchestrator persists
partial cycles; a thrown error costs the day's work.

**Everything a role produces is persisted.** The operating promise is that a
person can audit why a post was proposed. An artifact that only exists in
memory breaks that.

**Anything a licensee might want to change belongs in config or `prompts/`.**
If changing the niche, the voice, a channel or a threshold requires editing
`src/`, that is a bug in `platform.config.yaml`'s schema, not a feature.

**Compliance follows the audience, not the merchant.** A US offer promoted to
Japanese readers is governed by 景表法 and the ステマ規制, and the disclosure
must be in Japanese. `src/domain/market.ts` resolves this once and both
`policy.ts` and the roles use its answer — never re-derive it somewhere else,
and never let the merchant's own country decide the rules.

**The licensee has no terminal.** `docs/1-requirements/requirements.md` §3.1 is
the capability table — who each user is *able* to be, not what they do — and it
says so as a decision, with what follows from it. Never design a licensee-facing
step around a shell, `git clone`, `openssl`, or `doctor`. **And a change to how
the product is delivered or where it runs is a change to that table**: if the
table is not rewritten, the change is not finished. That rule exists because
this repository already learned it expensively — a delivery change made as an
onboarding improvement left the requirements describing a person who no longer
existed, and four defects came out of the gap.

**Anything about distribution, updates or releases reads
`docs/3-development/taking-updates.md` first.** Which update mechanisms are
structurally unavailable and why, what was rejected (a GitHub App holding write
access to every licensee's repository) and on what grounds, what was decided,
and the conditions that reopen it. Say what it already decided rather than
reasoning from scratch — the decision can be reopened; re-deriving it by
accident cannot.

**Anything about a second person reads `docs/3-development/adding-people.md`
first.** Users, operators, members, tenants, roles, permissions, invitations,
sign-up, `console.operators` — read it before proposing or writing anything,
and say what it already decided rather than reasoning from scratch. It settles
which of two different things is being asked for (the question is *whose
revenue is it*), why tenants are not being built, why the roles are deferred
and what would make that judgement wrong, and why the store split comes first.
The decision can be reopened; re-deriving it by accident cannot.

## Conventions

- **Comments explain why, not what.** The non-obvious decision, the failure it
  prevents, the thing the next reader would otherwise undo. No comment that
  restates the line below it.
- **Error messages name the fix.** `"llm.provider is \"anthropic\" but
  ANTHROPIC_API_KEY is not set. Put it in .env.local, or set llm.provider to
  \"mock\"."` Not `"missing api key"`.
- **Config validation collects every problem before failing.** One run should
  fix the whole file.
- **Time is injected.** `services.clock`, never `Date.now()`. Ids are injected.
  Both exist so a cycle replays identically in a test.
- **Prompts are files.** Never inline a role's instructions in a `.ts` file.
- **The design canvases move with the code.** `docs/_proposed/design/` (the
  operator's daily screens) and `docs/_proposed/design/onboarding/` (the
  licensee's first hour) are the picture of what the requirements and the
  console actually do. A change to a requirement, a console section, a gate,
  a command the screens mention, or a term in the glossary is not finished
  until the affected artboards say the same thing, the canvases are re-seeded
  and republished to the same URLs, and the READMEs there still describe
  them. Copy on those screens is written for the licensee or the operator, in
  です・ます; the reasons behind a design go in `canvas.json` annotations, not
  on the screen.
- **Money is never summed across currencies.** `totalsByCurrency`, not one
  number. There is no exchange rate in this platform on purpose.
- **Env split (`dev_base`):** `.env` holds shared non-secret defaults and *is*
  committed. `.env.local` holds keys and tokens and never is. Precedence is
  real environment variables > `.env.local` > `.env`.
- **Commits (`dev_base`):** `[type]: [concise description]` with types `feat`,
  `fix`, `docs`, `style`, `refactor`, `test`, `chore`. Branches are
  `[type]/[brief-description]`.
- **Work reaches `main` through a pull request.** Open one by default when a
  branch is pushed — do not wait to be asked. The PR body is where the
  reasoning behind a change lives, and where anything needing the operator's
  judgement (a legal review, an unverified integration, a placeholder) is
  stated plainly rather than left in a commit message nobody re-reads.

  **One finished thing per pull request, merged as it lands.** Open it, check
  it is green, merge it with a **merge commit** (never squash), and say it is
  ready to deploy. Waiting to be asked each time is what produced a branch of
  41 commits whose title still described its first one, and left `main` behind
  the public release repository — so a sync from `main` would have rolled
  licensees *backwards*. A pull request nobody can hold in their head is not
  a review, and every commit inside it is a record of what was broken and why
  it was fixed that way; a squash throws that away.

  Merging does not deploy and does not reach licensees. Deploying is
  `npm run deploy` from a person's own machine; licensees are reached only by
  a push to `release` or a manual run of the sync workflow.

## Working on the Claude integration

`src/llm/anthropic.ts` is the only file that imports the SDK. Two things there
are easy to get wrong and expensive to discover in production:

- Current models take `output_config.effort`, **not** `temperature` — sending
  `temperature` to the Opus 5 family is a 400.
- Every call streams, because the output cap is configurable up to 64K and a
  non-streaming request that size risks an HTTP timeout.

Structured output uses `output_config.format` with a JSON Schema built by
`src/llm/schema.ts`, so roles never parse prose.

## Testing

`test/helpers.ts` builds a whole company with a fixed clock, sequential ids,
in-memory storage and the mock adapters. Use it. `test/orchestrator.test.ts`
covers the loop closing across simulated days — if you change the cycle, that
file is where it will show.

Tests state a behaviour, not an implementation: "posts the operator did not
pick are cancelled, not left to leak out later".

**`test/cli.smoke.test.ts` spawns the real binary.** `helpers.ts` mocks out
storage, the model and every adapter — right for the domain, and structurally
blind to argument dispatch, loading a config off disk, adapter wiring and the
data directory. Every elementary bug found in this project has lived in that
band, and that band is a licensee's whole first day. A change to `cli.ts`,
`runtime.ts`, `config/` or the shipped example config needs a smoke test, not
another unit test.

**A regression test that does not fail on the bug is decoration.** Before
committing one, put the bug back, watch the test go red, then restore. It takes
a minute and it is the only thing that distinguishes a guard from a comment.
`node scripts/mutate.ts <file> --from <text> --to <text> -- <test args>` does
those four steps as one command with an inverted exit code — see
`docs/6-testing/mutate.md` — but the rule is still to actually run it, not to
own the tool.

**Run `/code-review` on the diff before pushing, not after.** The four worst
defects in this repo — a disclosure check that accepted any non-empty string, a
disclosure sliced off the end of a Threads post, a stop that kept dropping
affiliate links, and a report whose totals were lifetime figures the billing
command then charged against — were all found by review, none by the tests
that were passing at the time.

## Releasing

Two repositories, the `release-repo-split` pattern from `dev_base`: this one is
private and holds everything; a public release repository holds the licensee
subset and is what licensees fork.

`git push origin main` is intercepted by `.claude/hooks/pre-push-release-check.sh`
and asks whether this is a formal release.

- **No** → `git push origin HEAD:main` (plain development push)
- **Yes** → the `/release` skill: CHANGELOG, `HEAD:main`, then `main:release`,
  which fires `.github/workflows/sync-to-release.yml`

`scripts/make-release.ts` defines the file set and refuses to write if
`.env.local`, `platform.config.yaml` or `.amp/` reached the output. Details in
`docs/4-operations/release-process.md`.
