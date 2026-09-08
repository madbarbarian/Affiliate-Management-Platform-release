# The roles

Six agents in the daily cycle and a seventh that works weekly for the company.
Each is one file in `src/roles/`, and each has its instructions in two Markdown
files in `prompts/` — a `.system.md` (stable, cached) and a `.user.md` (this
cycle's material).

Editing a prompt is a **supported action**. It is how you change what a role
pays attention to without forking the code that runs it, and it shows up
cleanly in your git history.

---

## 分析担当 — Analyst

`src/roles/analyst.ts` · `prompts/analyst.*.md` · runs **first**

Refreshes engagement metrics for anything published inside
`policy.metricsWindowHours`, imports conversions from every enabled network,
attaches what actually happened to the patterns that claimed it would, and
re-scores the playbook.

It runs before research and planning so today's plan is made from yesterday's
evidence rather than last week's.

**Tune it when:** the summaries read as vague. The prompt tells it to name what
to *stop* doing — if it never does, the evidence is probably too thin and the
fix is more posts, not a better prompt.

---

## リサーチ担当 — Research lead

`src/roles/researcher.ts` · `prompts/researcher.*.md`

Collects what travelled from every discovery-capable channel, then extracts only
the **reproducible shapes** — templates with `{placeholders}`, not topics.

Two things the platform enforces regardless of what the model says:

- A pattern must cite swipe posts that **actually exist** in the collection. One
  citing invented ids is dropped as a hallucinated claim.
- A pattern the model marks as a variation of an existing one merges into it,
  bringing its evidence, rather than becoming a fifth near-duplicate.

**Tune it when:** the playbook fills with patterns that are really topics. The
system prompt's three-part test for "reproducible" is the lever.

---

## 企画担当 — Planning lead

`src/roles/planner.ts` · `prompts/planner.*.md`

Proposes `cadence.ideasPerCycle` posts, ranked. Each carries its angle, the
reader problem, what it promises, the evidence behind it, and its risk.

The platform drops any pattern or offer reference that does not exist rather
than passing a dangling id to the writer, who would quietly invent something to
fill it.

The prompt asks for a balanced slate: mostly proven patterns, at least two
untested candidates, at most half carrying an offer. That last constraint is
the one operators are most tempted to relax and most regret relaxing.

**Tune it when:** you keep rejecting the same kind of idea. Add what you are
rejecting to `prompts/planner.system.md` as a rule, and it stops appearing.

---

## ライティング担当 — Writer

`src/roles/writer.ts` · `prompts/writer.*.md`

One approved idea in, one finished post out. Issues the tracked link *before*
writing so the model places a real URL rather than a placeholder someone has to
remember to swap.

The prompt is mostly about the first line, because the first line is most of
the outcome. Concrete before interesting; open a loop; no preamble; short.

**Tune it when:** the voice is wrong. Most of that is `ventures[].voice` in
config, not the prompt — persona, first person, tone, signature phrases, and
especially `bannedPhrases`.

---

## 検品担当 — Inspector

`src/roles/inspector.ts` · `prompts/inspector.*.md`

A **different** call reads the writer's work as a stranger would, and rewrites
the machine out of it.

The order matters and is the whole design:

1. Deterministic checks run and their findings are handed to the model as facts
   it must resolve.
2. The model rewrites.
3. The **same deterministic checks run again on the rewrite**, and those results
   decide whether the draft passes.

The AI-smell score used is the worse of the model's own judgement and the
heuristic in `src/kernel/policy.ts`.

Signals the heuristic looks for, in order of how much damage they do: no first
person, uniform sentence rhythm, stacked hedging, a listicle where a story
belongs, superlatives with nothing behind them, an abstract hook.

**Tune it when:** things get through that should not. Add the phrase to
`policy.bannedPhrases` — that list is the cheapest quality lever in the system.
If drafts are being blocked that read fine, raise `policy.maxAiSmellScore`;
the default of 35 is strict on purpose.

---

## 投稿担当 — Publisher

`src/roles/publisher.ts` · `prompts/publisher.*.md`

Picks each slot from measured data — the times this account's own posts have
actually done best, falling back to sensible defaults until there are at least
two observations per slot. Respects the minimum gap and the daily cap, and rolls
into tomorrow rather than bunching posts together.

Then it writes the comments that sit under the post from minute one: the
continuation, the link drop (with the honest "who this is *not* for"), the
answer to the sharpest objection, and the question that will be asked three
times.

The platform guarantees the link actually appears in the link-drop comment,
whatever the model wrote.

**Tune it when:** the comments read as staged. They should be looser than the
post — shorter sentences, no structure at all.

---

## 探索担当 — Scout

`src/roles/scout.ts` · `prompts/scout.*.md` · runs **weekly, for the company**

Not part of the daily cycle. Reads the portfolio — every account's aggregates,
never its posts — plus the markets and offers the company is configured for,
and proposes the next account to try: niche, audience, market, name candidates,
a voice sketch, permitted offers, the hypothesis with its evidence, the risk,
three first hooks, and the signal that would mean stop.

The platform enforces, in code, after the model answers:

- the market must be one the company is configured for, and the category must
  not be one that market prohibits;
- offer references that do not exist or are not permitted in that market are
  dropped (an empty list is a valid answer — "no contract for this market");
- a niche the company already runs is refused;
- a proposal with no stopping rule is refused. A hypothesis that cannot say
  what would disprove it is not one.

Every refusal is in the audit log. Accepting a proposal appends its `ventures[]`
block to the config as text — inactive, under `ventures:`, validated first,
with the previous file backed up. The config is never rewritten, so every
comment survives.

**Tune it when:** the proposals are random rather than adjacent. The system
prompt's "adjacent, not random" section is the lever — and so is writing
`company.principles` down, because the scout has nothing else to reason from
about what this company is for.

---

## Adding an eighth

A role is a `Role<Input, Output>`: one typed input, one job, one typed output.
A role that works for the company rather than a venture takes a
`CompanyContext` instead (`Role<Input, Output, CompanyContext>`), as the scout
does. See [Extending](extending.md#adding-a-role).
