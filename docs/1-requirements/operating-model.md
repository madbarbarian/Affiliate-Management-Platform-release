# The operating model

## Your two jobs

Everything in this platform is arranged around a single promise: the person in
charge does two things a day and nothing else.

**1. Say OK to the proposals.** Each morning the planning role hands you a
slate. Every idea carries the take, the reader problem it speaks to, what it
promises, the evidence it rests on, and the honest way it fails. You pick the
ones worth writing.

**2. Decide what goes out first.** Later, the posts that cleared inspection come
back with their slots. You reorder them and confirm.

That is the whole job. If you find yourself doing anything else — rewriting a
draft, checking a disclosure, remembering to post — something has gone wrong and
it is worth reading [Configuration](../7-references/configuration.md) rather than working
around it.

## A day

| Time | What happens | You |
|---|---|---|
| 06:30 local | The analyst reads yesterday's numbers and revenue and re-scores the playbook | — |
| | Research collects what travelled and extracts reproducible shapes | — |
| | Planning proposes the slate | — |
| **gate** | **Proposal approval** | **~30 seconds** |
| | The writer drafts each approved idea | — |
| | The inspector rewrites the machine out of them and blocks what must not ship | — |
| | The publisher picks slots and drafts the comments | — |
| **gate** | **Publish approval and ordering** | **~30 seconds** |
| at each slot | Posts go out, with their comments | — |
| next 06:30 | Metrics and conversions are pulled in as the next cycle starts (the analyst runs first) | — |

## Three levels of autonomy

Set `company.autonomy` in `platform.config.yaml`.

**`manual`** — both gates wait for you, with nothing pre-selected. Use this for
the first week or two of a new account, while you are still learning what the
planning role gets wrong.

**`assisted`** (default) — both gates wait for you, pre-filled with the
platform's recommendation. Approving is one click. This is the model everything
is designed around.

**`auto`** — the machine resolves both gates itself using that same
recommendation. Before a slot you can still stop everything with `amp pause`;
there is no command yet that cancels one post (see the requirements' open
items). Only worth reaching for once the playbook has real confidence behind it
and you have watched a few weeks of `assisted` without disagreeing.

Moving to `auto` is a decision about your compliance exposure, not just your
time. The code guardrails still hold, but nobody is reading the posts.

## Approving

From the terminal:

```bash
node src/cli.ts pending                      # see what is waiting
node src/cli.ts approve dec_abc              # take the recommendation
node src/cli.ts approve dec_abc --select a,c # choose, in this order
node src/cli.ts approve dec_abc --order c,a  # same choice, different order
node src/cli.ts approve dec_abc --none       # skip today entirely
```

Or from a browser:

```bash
node src/cli.ts console
# → http://127.0.0.1:4321/?token=…
```

The console shows each item with its evidence and its risk, a checkbox, and
arrows to reorder. It works on a phone, which is the point.

## Rejecting everything is a real answer

Some mornings the whole slate deserves to die. `--none` resolves the decision
as a rejection, the cycle ends cleanly, and nothing is written. That is a
supported outcome, not an error — and it is information: three of those in a
week means the planning prompt or the playbook needs attention.

## What happens when you do not answer

Nothing bad. The cycle sits at the gate with its state persisted. The daemon
keeps publishing anything already approved from previous days and starts the
next day's cycle on schedule, which is when metrics are collected. Answer
whenever you get to it.

## Stopping it

The third thing you can do, and the one you hope never to need.

```bash
amp pause --reason "wrong offer went out"   # everything, now
amp pause --venture beauty-care             # one operation
amp resume                                  # start again
```

It is designed for the moment you cannot yet explain what is wrong:

- **It does not need the daemon killed.** The stop takes effect on the next
  tick, from a second terminal, while the daemon holds the data lock.
- **It does not need anything else to be working.** `pause` reads only enough
  config to know where your data lives, and falls back to the raw file when
  the config no longer validates. An expired API key, a broken channel adapter,
  a half-edited config — likely reasons you are reaching for this — cannot
  prevent a stop.
- **It fails closed.** A stop file that cannot be read or parsed counts as
  stopped. If you are in enough of a hurry to type `STOP` into
  `.amp/paused.json` by hand, that works too.
- **It delays, it never cancels.** Posts whose slot passes while stopped are
  held, not dropped. They go out on the first dispatch after you resume. If you
  wanted them gone, resume and reject them, or delete them at the channel.

While stopped, no cycle starts, no gate can be approved, and nothing publishes.
`doctor` says so on its first line, and the approval console shows it above
everything else — so you find out before you press a button, not after. The
stop is checked when a cycle, an approval or a dispatch *begins*: a cycle
under `auto` that is already handing a post to its channel finishes that
hand-off.

**The one thing it cannot do:** recall a post a channel's own scheduler has
already accepted. That post is on the channel's clock now and will go live
whether or not this platform is running. `amp pause` lists exactly which posts
those are, with their channel ids, so you can cancel them where they actually
live. Channels without native scheduling do not have this problem — the
platform holds those posts itself until their slot, and a stop holds them.

## The weekly question

Inside an account the platform forms and tests its own hypotheses. Which
accounts to *have* was the one judgement left entirely to you — and it still is,
but the candidates no longer have to come from you.

Once a week (when `company.exploration.enabled` is on, or whenever you run
`amp scout`) the scout reads every account's aggregates — posts, median
engagement, clicks, revenue by currency, which patterns are proven, which offer
categories earn — and proposes the next account to try. Each proposal carries
the evidence it leaned on, three first hooks so you can picture it, the honest
way it fails, and the signal that would mean stop after a month.

```bash
amp scout                     # ask now
amp scout list                # what is waiting (--all: decided ones too)
amp scout show prp_…          # one proposal, with the block it becomes
amp scout accept prp_…        # prints the ventures[] block to paste
amp scout dismiss prp_… --reason "not this quarter"
amp portfolio                 # every account on one page
```

While the daemon is running it holds the data lock, so accept and dismiss from
the console's 探索の提案 section instead; the CLI form is for when it is not.
The scheduled run waits until at least one cycle has completed — a scout shown
nothing but empty numbers would still propose three accounts.

This is deliberately not a third daily gate. It lives below the daily decisions
in the console, under its own heading. Accepting one appends its `ventures[]`
block to `platform.config.yaml` as text — inactive, commented, with the
previous file kept in `.amp/config-backups/` — and nothing runs until you read
the voice, set `active: true` and restart the daemon. Your day is still two
decisions; your week gains one.

## Switching an account off

Accounts that stop earning should stop costing without becoming unrecoverable.
The portfolio flags an account for review from its own numbers — enough posts
and not one click, or a median far below the company's — and next to the flag is
one button: 非アクティブにする. Nothing is deleted: the playbook, the history and
the revenue stay, the daemon skips it from the next tick, and 再開する puts it
back. From the terminal:

```bash
amp venture deactivate beauty-care --reason "season over"
amp venture activate beauty-care
amp venture list
```

This is not the stop. A stop is an emergency for everything at once and fails
closed; deactivation is a judgement about one account, indefinite, and fails
open — a corrupt state file switches nothing off.

What keeps twenty accounts one company is `company.principles` and
`company.boundaries`: how the company thinks and what it never does, written
once, read by every role in every account.

## What the machine will not do

- Publish a post carrying an offer with no disclosure a reader will see.
- Publish a post making a prohibited claim.
- Publish a draft that still reads as machine-written after the rewrite.
- Publish anything you did not approve — anything unselected is cancelled.
- Publish more than `policy.maxPostsPerDay`, or closer together than
  `policy.minMinutesBetweenPosts`.

## Reading the operation

```bash
node src/cli.ts report --days 30
```

Shows what published, how it did against the median, what it earned, and which
patterns the playbook currently believes in. The number to watch is not
engagement — it is whether the patterns with the highest confidence are also the
ones earning. When those two diverge, the account is being read but not trusted,
and that is a content problem no scheduling change will fix.
