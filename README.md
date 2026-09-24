# Affiliate Management Platform

**v0.12.2** — what changed, and whether it breaks your morning: [CHANGELOG.md](CHANGELOG.md)

An autonomous AI company that runs an affiliate operation, built so the human
in charge has exactly two jobs:

1. Say **OK** to the day's proposals.
2. Decide **what goes out first**.

Everything else — finding what is working, deciding what to write, writing it,
catching the parts that read like a machine wrote them, choosing the time,
drafting the comments, measuring what happened, and updating what the company
believes — runs without you.

This is a **platform**, not one operator's account. It ships as a repository a
licensee forks, configures in one file, and runs. Nothing about a particular
niche, voice, channel, market or offer lives in the code.

---

## The company

Six roles, one job each.

| | Role | What it does each day |
|---|---|---|
| 1 | **分析担当** Analyst | Reads yesterday's numbers and revenue, then updates what the company believes works. Runs first, so today's plan is made from yesterday's evidence. |
| 2 | **リサーチ担当** Research lead | Collects what travelled in the niche and extracts only the **reproducible** shapes — not the topics. |
| 3 | **企画担当** Planning lead | Proposes the day's slate, each idea carrying the evidence behind it and the way it could fail. |
| 4 | **ライティング担当** Writer | Turns one approved idea into one finished post, hook first. |
| 5 | **検品担当** Inspector | A *different* model reads it as a stranger would, rewrites the machine out of it, and blocks anything that must not ship. |
| 6 | **投稿担当** Publisher | Picks the slot from measured data and writes the comments that sit under the post from minute one. |
| 7 | **探索担当** Scout | *Weekly, not daily.* Reads every account's numbers and proposes the next account to try, with evidence, a risk and the signal that would mean stop. You accept or dismiss. |

```
analyze → research → plan → [YOU: approve] → write → inspect → schedule → [YOU: order] → publish
```

The two brackets are the only places the machine stops each day. Once a week
there is a third question — *should we try another account?* — and the scout
prepares it; `company.principles` is what keeps every account one company.

---

## Run it on Cloudflare (the short way)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/madbarbarian/Affiliate-Management-Platform-release)

(The button's link is filled in when a release is cut; in this development
repository it is a placeholder, and the button only works from the public
release repository a licensee forks.)

One button. Cloudflare copies this repository into your own account, creates
the database, asks for two secrets — only one of which is required — builds it
and deploys it. You get an address of your own, `https://amp-….workers.dev`,
which is where the approval console and the tracking redirect both answer.
**There is no domain to buy**: the links in your posts work from day one, so
clicks are recorded from day one.

Open the address and it tells you what to do next: copy
`platform.config.example.yaml` to `platform.config.yaml`, edit the top of it,
and save. A push redeploys, and the setup page becomes the approval console.

Costs $5/month (Workers Paid), plus what you spend on the model. Cloudflare's
free plan will deploy this and then fail: it allows 10 ms of CPU per request and
per cron trigger, and a cycle spends more than that before it has finished
reading your config. What each host costs and asks of you is in
[docs/4-operations/hosting.md](docs/4-operations/hosting.md).

## Run it on your own machine

Requires Node 22.18 or newer. No build step.

```bash
npm install
node src/cli.ts init          # creates platform.config.yaml and .env.local
```

Everything ships with simulated adapters, so you can walk the entire loop
before you have an API key, a channel token, or an affiliate account. The
generated config starts on `llm.provider: mock`, so this costs nothing and
calls nothing. `--dry-run` goes further and simulates storage and the channels
too, without writing anything:

```bash
node src/cli.ts cycle run --dry-run   # runs until it needs you
node src/cli.ts pending --dry-run     # see what is waiting
node src/cli.ts approve <id> --dry-run
node src/cli.ts console --dry-run     # or do it in a browser
```

When you are ready for the real thing: put `ANTHROPIC_API_KEY` in `.env.local`,
swap `adapter: mock` for a real channel, run `node src/cli.ts doctor` until it
is clean, and then

```bash
node src/cli.ts daemon        # starts cycles on time, publishes on time
```

---

## Taking an update

The approval console says when the platform has changed, and points here. This
is the whole procedure, and none of it needs a terminal.

**Once, on your first day: install the updater.** The copy the Deploy button
makes has **no workflows at all** — GitHub does not let Cloudflare's app write
under `.github/workflows/`, and a real deploy's Actions tab came up empty. So
the updater arrives as an ordinary file, `update-workflow.yml`, at the top of
your copy. Put it where it runs:

1. Open `update-workflow.yml` and copy all of it (the copy icon, top right).
2. **Add file → Create new file**, name it `.github/workflows/take-updates.yml`
   (typing `/` makes the folders), paste, **Commit changes**.

It is a short file on purpose. No update can rewrite it — GitHub does not let a
workflow write under `.github/workflows/` — so all it does is run
`scripts/take-updates.ts`, which arrives with every update like any other
file. Fixes to the updater reach you that way, without pasting again.

**Replacing an older, longer version?** Merge the update's pull request first,
then paste. The short file runs a script that only arrives with that merge;
pasted before it, the run stops red and says so.

Until you do, **nothing can bring you an update** — the steps below have no
button to press. When the **Actions** tab shows *Take updates from the
platform*, it is in.

**Then, whenever you want an update:**

1. Open **your own copy** of this repository on GitHub — the one the Deploy
   button made, not the platform's.
2. **Actions** tab → **Take updates from the platform** → **Run workflow**.
3. A few minutes later, a pull request appears under **Pull requests**. Read
   it. It says what changed and why.
4. **Merge pull request**. Cloudflare rebuilds and redeploys on the merge;
   there is nothing else to press.

You do not have to press anything: the same job runs **on the first of each
month** and opens the same pull request. Nothing here is urgent enough to
interrupt a day, and a monthly pull request is one a person still reads.

**Your `platform.config.yaml` is never in that pull request.** Your niche, your
audience, your voice and your accounts are yours. Your secrets live in
Cloudflare's dashboard, not in the repository, so there is nothing there for an
update to disturb either. The same goes for `wrangler.jsonc`, which holds the
id of *your* database.

**If you edited anything under `prompts/`**, an update replaces it with the
shipped version. Close the pull request, point `runtime.promptsDir` at a
directory of your own, copy your prompts there, and take the update again.

## What makes it trustworthy

Running an account unattended only works if the failure modes are handled in
code rather than by asking a model to behave.

- **The disclosure, the prohibited claims and the channel limits are checked by
  code**, before and *after* the inspection rewrite. A model asked "is this
  compliant?" says yes; a check for the disclosure string does not.
- **A second, independent AI-smell heuristic** runs alongside the inspecting
  model, and the *worse* of the two scores is the one that counts.
- **A pattern needs repeated evidence before it is believed**, and old evidence
  decays. Three good posts is not proof.
- **Every decision is auditable.** Every proposal carries its rationale and its
  risk; every published post traces back through its draft, its idea, its
  pattern and the evidence that pattern rested on.
- **Cycles are resumable.** State is persisted after every step, because a gate
  may wait hours for someone to wake up.
- **Nothing publishes without a slot you approved**, and anything you did not
  pick is cancelled rather than left to leak out tomorrow.
- **`amp pause` stops everything in one command**, without needing the daemon
  killed, an API key that still works, or an explanation. It fails closed — a
  stop file it cannot read counts as stopped — and it delays rather than
  cancels, so held posts go out when you resume. It cannot recall a post a
  channel's own scheduler already accepted; `amp pause` lists those and tells
  you to cancel them in the channel.
- **Compliance follows the audience, not the merchant.** A US offer promoted to
  Japanese readers is governed by 景表法 and the ステマ規制, and the disclosure
  is written in Japanese. An offer may only be carried by a venture its network
  terms actually permit it in.
- **Revenue is never summed across currencies.** There is no exchange rate in
  this platform on purpose.

---

## Documentation

| | |
|---|---|
| [Architecture](docs/3-development/architecture.md) | How the parts fit, and where the seams are |
| [Requirements（要件定義）](docs/1-requirements/requirements.md) | What the platform must do, who uses it, and what is still undecided |
| [用語集](docs/7-references/glossary.md) | The Japanese terms the documents use, and which code identifier each maps to |
| [Operating model](docs/1-requirements/operating-model.md) | Your two jobs, the three autonomy levels, what a day looks like |
| [契約体系と責任分担](docs/1-requirements/licensing.md) | Who is the publisher, what the licensor does and does not promise, the fee options, and what still needs a lawyer. Drafts in `contracts/` |
| [The roles](docs/3-development/roles.md) | What each role is responsible for and how to tune it |
| [Configuration](docs/7-references/configuration.md) | Every field in `platform.config.yaml` |
| [Licensee guide](docs/2-setup/licensee-guide.md) | Fork → configure → operate, and how to take upstream updates |
| [オンボード設計](docs/2-setup/onboarding.md) | A design for the first hour (not yet built), and why five of its nine steps need no credentials at all |
| [先行利用者の最初の一週間](docs/2-setup/first-week.md) | Posting for real from day one, and the three conditions that make that safe enough |
| [Extending](docs/3-development/extending.md) | Adding a channel, a network, or a seventh role |
| [Running many ventures（複数の運用アカウント）](docs/3-development/multi-venture-architecture.md) | A proposal: fork per project vs one instance, what a buyer of an account needs, and the order to build it in |
| [探索（Exploration）](docs/3-development/exploration-design.md) | The scout, the portfolio and `company.principles`: how the machine proposes the next account and a person decides |
| [Cross-border promotion](docs/7-references/cross-border.md) | Promoting across markets, and what the platform refuses to do |

---

## Commands

`amp` is the package's bin name. Until you `npm link` (or install the package),
write `node src/cli.ts` wherever the documents say `amp`.

```
init                    Create platform.config.yaml and .env.local from the examples
doctor                  Validate config and check every credential and adapter
roles                   Print the org chart

cycle run               Run today's cycle until it needs you, or finishes
cycle status            Show where today's cycle got to
pending                 List what is waiting on your decision
approve <decision-id>   Approve and order, from the terminal
dispatch                Publish anything whose slot has arrived
daemon                  Run continuously
console                 Serve the approval console and the tracking redirect

pause                   Stop everything now. Nothing runs and nothing publishes
resume                  Start again

scout                   Ask which accounts to try next (weekly; accept appends an inactive block to the config)
portfolio               Every account on one page, with review flags
venture deactivate <id> Switch an account off without editing config or deleting anything
venture activate <id>   Switch it back on

report                  What published, what it earned, what the playbook learned
statement               What each venture owes under the configured billing terms
```

## Development

```bash
npm run typecheck
npm test
npm run check     # both
```
