> **English is the record; the Japanese version follows below as a supplement** (owner decision, 2026-09-26). If they disagree, the English wins.

# A Proposal on Visual Polish: Along the Axis of Appearance, Not Information Structure

> **This is a proposal, not an implementation.** Not a single line of `src/` was touched.
> This document is a **sibling** of [`console-ux-proposal.md`](console-ux-proposal.md).
> That one deals with "what goes where" (information structure); this one deals with "how what has been placed looks" (the visual axis).
> It does **not contradict** the decisions made there (the recommended / other split, the status band, the settlement of table width).
> Wherever it appears to contradict them, each time it states which decision there it is dealing with, and how.

---

## 0. The conclusion first

**The cause of "looking lame" is not a bad choice of colour palette. It is that the palette is unused on 90% of the screen.**

The palette held by `:root` in `src/console/page/style.ts` (`--bg #fbfbfa`, `--ink #1a1a19`,
`--muted #6b6b66`, `--accent #2f6f4f`) is plain when viewed alone, but it is not broken.
Checking on a real screen, **the elements that actually use this palette are the 「開く」 (Open) link, the green border of `.card.handover`,
and the disclosure chips (`.pr-ok` / `.pr-missing`), and little else; everything else (headings, numbers, labels,
body text) is either the black of `--ink` or the grey of `--muted`.** The four numbers for all accounts combined,
and the five numbers for each individual account, are all bold black. Headings are all the same 14px, uppercase, wide letter-spacing, grey
(`style.ts:58`, applied equally to every `<h2>`). **The most meaningful number for this product (confirmed reward)
and the least meaningful number (the total count of patterns) line up on the screen with the same weight and the same colour.**

In addition, **there is primary data found by measurement** (§2.2): at an ordinary desktop window width,
the all-accounts table is physically cut off right after the 「成果」 (Conversions) column, and everything from the 「確定報酬」 (Confirmed reward) column onward (confirmed reward, patterns, tracking) is
invisible without horizontal scrolling. The owner's remark, "the part from the revenue column onward also has somehow inconsistent widths," is
neither a metaphor nor a misperception; **it is happening exactly as stated, down to the measured pixel.**

On mobile, I checked on a real screen (§5). **The hunch that "it will probably turn out the same" is half right and
half wrong.** The unused palette (poverty of expression) is exactly the same on mobile too:
there are only three responsive CSS rules to begin with (described below), and with no mechanism for changing the rules of colour, weight and hierarchy,
that is only natural. On the other hand, the problem of the table being cut off at revenue **does not occur on mobile**:
below `stackBelow` window width the table turns into stacked cards, and this particular loss does not reproduce.

---

## 1. What was looked at, and how it was verified

### 1.1 The real screen (browser)

`https://amp-test.madbarbarian.workers.dev/` has a login wall (a passphrase), and
no credentials were given to this session. **Rather than give up on checking a real screen, I ran the same code
on my own machine, still on mocks, and checked there.** Concretely:

1. I copied `platform.config.example.yaml` to make `platform.config.yaml` (gitignored,
   not committed), enabled the `by-hand` (manual posting) channel, and set up three accounts
   (`ai-tools`, `gadget-life`, `home-cooking`).
2. I ran a mock cycle with `node src/cli.ts cycle run` and produced one planning approval gate.
3. I stood up the approval screen locally with `npm run console` and opened it from a real browser using
   `mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`
   (Chrome DevTools MCP).

This is not `amp-test` itself, but it is the same HTML/CSS drawn by **the same `src/console/` code as `amp-test`**.
If there is a difference, it is only the amount of real data; the visual rules are identical. From here on,
descriptions of screenshots come from this real-screen check unless stated otherwise.

**I did not perform the approval itself.** The act of pressing the gate's 「承認して進める」 (Approve and proceed) button from the browser
was rejected by this session's safety mechanism as "self-approval," and I think that was the right restraint. Pressing on someone's behalf
an operation that this product has decided from the start "only the operator presses," merely to check appearance, is out of line
even with local mock data. **As a result, there is no real-screen screenshot of the hand-over posting card (`.card.handover`).**
In §5.3 I limit myself to a reproduction based on the source code, explicitly labelled as such.

### 1.2 The mobile viewport: as the brief warned, I chose the tool again

As the brief pointed out, `mcp__claude-in-chrome__resize_window` did not actually change the viewport in this environment.
Instead I called Chrome DevTools MCP's `emulate` with a `viewport` string, and
**`window.innerWidth` did return `390`** (with only the `width`/`height` arguments of `resize_page`,
`innerWidth` stayed at `500`, which also could not be relied on; the `viewport` argument of `emulate` was the one that
actually worked). The mobile descriptions from here on are based on screenshots at this measured 390px width (iPhone-equivalent,
`devicePixelRatio:2`, `isMobile:true`).

### 1.3 The two sites used as references

- **Buffer** (`buffer.com/insights`): the row of headline numbers has a three-tier structure: "small grey uppercase
  tracked label", then "large bold number", then "a coloured delta with an arrow (up 7%, green for an increase) plus the raw comparison value
  added small". **The most concrete reference, one that can be applied as is to this product's "all accounts combined".**
- **Metricool** (`metricool.com`): nav of icon plus short label, a gradient line under the active tab, cards
  with pastel backgrounds, rounded corners, and dark colour reserved for the primary button only.
  In the list of connected channels, a small circular platform icon sits next to the name;
  this is the very source of the owner's "icon plus small label" idea.

---

## 2. What the appearance actually is: a breakdown based on measurement

### 2.1 The palette is unused (measured)

I captured a full-page screenshot of the 「今日」 (Today) screen in light mode on desktop (1440x900). What was visible:

- Headings (`h2`): 「アカウントの状態」 (Account status), 「全アカウント — 直近30日」 (All accounts: last 30 days), 「全アカウント合計 — 直近30日」 (All accounts total: last 30 days),
  「最近の動き」 (Recent activity): all the grey of `--muted`, all the same 14px, all uppercase and tracked
  (`style.ts:58`, one rule applied unconditionally to every `<h2>`).
- The four numbers of 「全アカウント合計」 (published posts, clicks, conversions, confirmed reward):
  all the black of `--ink`, all 20px bold, all the same margin (`.stat b { font-size:20px }`, `style.ts:352`).
  **Confirmed reward (money) and the total count of patterns (meta information) get the same treatment.**
- The only things with colour are: the 「開く」 (Open) link (green text, `a.open`, `style.ts:387-388`), and
  the grey chip 「承認が要る（1）」 (Approval needed (1)) (`.status-badge`, no colour, `style.ts:372`).

**The one place where colour was deliberately assigned** (the account screen and the planning approval card) really does work well:
the `予測 400` (Forecast 400) chip, the `PR` chip (green), the risk note chip, and the green / red / grey of `disclosure`
(`.pr-ok` / `.pr-missing` / `.pr-none`, `style.ts:272-274`). **This is a counterexample to "no colour sense."**
This product knows where colour carries meaning; it has simply placed colour only where it knows.

### 2.2 The all-accounts table is physically cut off just before 「確定報酬」 (Confirmed reward) (measured, needs fixing)

`console-ux-proposal.md` already deals with this table's width problem, and records that with `fix/portfolio-table-width` it settled on
the trade-off "fit the table to the same width as main, and leave whatever overflows to the horizontal scroll of `.table-wrap`"
(stated explicitly in the comment at `style.ts:110-137`). **I think that trade-off
itself is a correct judgement, but what happens beyond it had not been verified.**

Measurement (numbers read directly from the browser's `getBoundingClientRect` / `scrollWidth`):

```
Visible width of main (.table-wrap.clientWidth)     : 828px
Actual width of the table (table.grid.scrollWidth)   : 1107px
The part invisible without scrolling (overflowPx)    : 279px

Left / right edge of each column header (1440px window, absolute coordinates with main centred):
  アカウント (Account)             306.5 – 482.5
  (開く) (Open)                   482.5 – 550.5
  状態 (Status)                   550.5 – 654.5
  直近サイクル (Latest cycle)       654.5 – 850.5
  投稿 (Posts)                     850.5 – 906.5
  中央値 (Median)                  906.5 – 968.5
  クリック (Clicks)                 968.5 – 1036.5
  成果 (Conversions)              1036.5 – 1128.5   <- the visible region ends here (right edge 1134.5px)
  確定報酬 (Confirmed reward)     1128.5 – 1228.5  <- only 6px of the left edge is visible. Effectively zero
  型 (Patterns)                   1228.5 – 1300.5   <- completely invisible
  計測 (Tracking)                 1300.5 – 1412.5   <- completely invisible
```

Because of `main { max-width: 860px }` (`style.ts:56`), this visible width of 828px **does not change however
much you widen the window beyond 1440px.** In other words this is not a bug at the specific window width of 1440px; **it always occurs
on any desktop that opens a screen containing this table.**

**This is the substance of the owner's "the part from the revenue column onward also has somehow inconsistent widths."** It is not a metaphor.
At the right edge of the 「成果」 column (1134.5px) the table visually ends (its border and rounded corners look complete there),
and the 「確定報酬」 column that should come right after shows only what looks like a 6px sliver of margin, while 「型」 and 「計測」
cannot even be known to exist. By default there is also no hint of a scrollbar (in particular, macOS overlay
scrollbars are invisible until you interact). **That the table reads as "ending right there"
is itself what became the words "inconsistent widths."**

`console-ux-proposal.md` proposes moving this table down to band C (§4.1, §8c), and the implementation appears to be
postponed for now. **Moving it down to a band and this loss being visible are separate problems.** Wherever the table is,
as long as it is a scrolling table, the same thing happens unless the screen says that it can scroll.
§6.1 gives a remedy.

### 2.3 The same "number widget" is assembled in two different ways

`src/console/page/client/today.ts:194-195` (company-wide total) and
`src/console/page/client/venture.ts:203-208` (per account) both have the same role, "line up a label and a number,"
but their DOM is assembled differently.

```
today.ts:194-195 (company-wide total)
  <div class="stat"><b>{value}</b><span class="muted">{label}</span></div>
  -> Appearance: number on top, label below (because .stat b is display:block)

venture.ts:203-208 (per account)
  <span class="stat">{label}<b>{value}</b></span>
  -> Appearance: label on top, number below. But the label is plain text (.muted is not attached)
```

On adjacent screens of the same product (Today screen, then Open, then account screen), **the numbers for the same concept are
assembled in the opposite vertical order, and the label text also differs in how faint it is.** Neither is broken
in appearance, but the traces of two implementations having grown independently remain as they are. This too can be a cause of the
"inconsistency": the experience of the rules changing within a single screen transition.

### 2.4 Amounts concatenate multiple currencies into one line

When there are multiple currencies, `formatMoney` in `src/affiliate/attribution.ts:214-223` returns
a single string joined with `" / "`, like `"1,234 JPY / 567 USD"`. This is the result of keeping the promise in `CLAUDE.md`
not to sum amounts across currencies (`totalsByCurrency`), but **the visual side merely squeezes
that promise into one long string**, which fits poorly with a Buffer-style "one big number"
layout. While there is one currency it is no problem, but from the second currency on, the length
translates directly into poor readability. §3.3 deals with this.

### 2.5 There are actually only three places with responsive CSS

I recounted and confirmed the brief's point myself. There are only three media queries in all of `style.ts`:

```
line 40  @media (prefers-color-scheme: dark)                 (colours only)
line 210 @media (max-width: ${stackBelow-1}px)                (the single point of table -> cards)
line 246 @media (min-width:560px) and (max-width:${stackBelow-1}px) (an intermediate tier of the same)
```

**The status band, hand-over card, headline numbers and decision cards have not a single line of dedicated mobile handling.**
They are "not broken" but also "not designed for mobile": a state that block elements and
flexbox wrapping happen to have by chance. The measurements in §5 bear this out.

---

## 3. Redesigning the headline numbers

### 3.1 Can a delta be produced from the data we have? Verification result: no

`computePerformance` in `src/domain/performance.ts` receives only `sinceMs` (the window start), and
there is no argument called `untilMs` (the window end); **the structure always computes "from then until now"**
(confirmed at `performance.ts:35`, `:53`, `:101`; there is not a single `until`-type field in the code).
`buildPortfolio` in `src/domain/portfolio.ts` likewise only builds `sinceMs = nowMs - days*...` from `days`,
and `nowMs` is always "now" (`portfolio.ts:126`).

So "the last 30 days" can be produced, but **there is no mechanism in today's code to produce "the 30 days before that."**
To make a Buffer-style "up 7%," at minimum the following changes are needed:

1. Add `untilMs` (the window end) to `computePerformance` / `buildPortfolio`.
2. Call the aggregation **twice**, once for the last 30 days and once for the 30 days before that (double the cost of
   the current single call. The comment at `router.ts:895-897` already warns that "this portfolio computation
   runs on every 30-second poll and is not light").
3. Confirmed reward is independent per currency (§2.4), so the delta also has to be produced per currency:
   this becomes **multiple delta sentences** such as "JPY is +12%, USD is new since this period,"
   and does not fit the simple form of Buffer's single "up 7%."

**This is not a visual change but the addition of new aggregation logic.** It exceeds the scope of this proposal (appearance).
In §6 it goes under "later."

### 3.2 What we will not do: divide the same 30 days and pass it off as a delta

A rejected idea: if we only have the last 30 days of data, split that into "the last 15 days" and "the 15 days before that"
and present a pseudo-delta. **I reject this.** It is not "a comparison with the previous period"
but "just cutting the same window," and would present noise between periods of half the sample size as a "trend."
It would be the same kind of dishonesty as the "lifetime figures the billing command then charged
against" that `CLAUDE.md` names: **diluting data that does not exist to look as if it does.**
What does not exist is said not to exist.

### 3.3 The smallest honest visual improvement we can make now

Without producing a delta, fix only the following three points. **All are changes to CSS and markup; no new aggregation is needed.**

**(a) Unify the assembly of `.stat` into one.** Align the two different orderings of `today.ts` and `venture.ts`
(§2.3), following Buffer, into a single pattern: "label (small, grey, wide letter-spacing) on top, number (large, bold) below."
The `venture.ts` side is already close to this order, so aligning the `today.ts` side
is the smaller change.

```
Now (today.ts)                After the proposal (both)
┌──────────────┐            ┌──────────────┐
│      24        │            │ 公開済み投稿    │ <- small, grey, wide letter-spacing
│  公開済み投稿    │            │      24        │ <- large, bold
└──────────────┘            └──────────────┘
```

(公開済み投稿 = published posts.)

**(b) Split lines per currency for confirmed reward only.** Stop putting the `"1,234 JPY / 567 USD"` returned by `formatMoney`
into `<b>` as a single line of text; split on `" / "` and make one line per currency
(the shape of the data does not change; only the display side splits it).

```
Now                           After the proposal
┌──────────────┐            ┌──────────────┐
│ 1,234 JPY / 567 USD │        │ 確定報酬       │
│    確定報酬          │        │ 1,234 JPY     │
└──────────────┘            │   567 USD     │
                              └──────────────┘
```

(確定報酬 = confirmed reward.)

**(c) Instead of a delta, state in words what is being compared against.** The heading 「全アカウント合計 — 直近{days}日」 (All accounts total: last {days} days)
already exists (`messages.ts:204/555`). This does not change. Under the number we **do not add** wording such as
「先月との比較はまだ出せません」 (Comparison with last month cannot be shown yet); going out of our way to say what we cannot say
would instead raise a new question, "why is it missing?" As in §3.1, this gets added
once the "later" feature exists. **Saying nothing for now is the more honest course.**

### 3.4 Why `--accent` (green) is not used to dress up numbers

The idea "if we want to make good numbers stand out, why not use that green?" is natural, but **we do not adopt it.**
This product's `--accent` is already in operation with a single meaning: "something that will not happen unless you act"
(`.card.handover`, stated explicitly in the comment at `style.ts:255-257` /
`status-badge--handover`, `style.ts:373-377`). Confirmed reward growing is welcome, but
**it is not waiting on the operator's action.** If the same green were also repurposed for "good news," every time
you saw green somewhere on the screen you would have to wonder "is this something I must press, or just news that things are going well?";
it would dilute the colour grammar this product has only recently established (only the decisions of (2) are green) for the sake of the staging of (1).
**Rank numbers not by adding colour but by weight and placement alone**; (a) and (b) suffice.

---

## 4. On the icon proposal

### 4.1 Correcting the premise (after the parent's remark, which I also checked myself)

The premise first handed to me was: "`ChannelId` is a general string, and this product does not mechanically know which
social network it is, so a brand icon would always be dishonest." **This is only half right.**
I checked the code and the config myself:

- `ChannelConfig.id` is indeed a free string, and for every intended channel other than Threads, the `adapter` becomes
  `"webhook"` (`src/config/schema.ts:137-138`). **From the adapter type alone one cannot
  mechanically distinguish "is it X, or the licensee's own personal Zapier scenario?"**
  Here the original premise holds as stated.
- **However**, `platform.config.example.yaml` ships `id: x`, `id: note` and `id: youtube` as commented-out templates
  (all `adapter: webhook`,
  `platform.config.example.yaml:299-330`), alongside the actually working `id: threads`
  (`:232-249`), and `docs/3-development/integrations.md` §3
  (`:65-75`) documents this by name: "templates for X / note / YouTube are included as comments."
  This is **not conjecture; it is a fact that this product itself has decided and distributes: "if it comes in under this name, it is that social network."**

**Conclusion: the icon proposal may be adopted, within this boundary.** Only when `channel.id`
matches a known name that this product itself ships and documents (`threads`, `x`, `note`, `youtube`)
do we show the mark corresponding to that name; this reflects what the licensee's own config file
says, and is not guesswork. For any other `id` (a custom webhook destination the licensee named themselves),
**always use the same single kind of "unknown" mark.** Known name to known mark, unknown name to an honest "unknown" mark:
this honesty is preserved in both cases.

### 4.2 Even so, we do not draw the real logos

Just because we have come inside the boundary, we do not propose **reproducing the exact brand logos of Threads / X / note / YouTube
as inline SVG.** Three reasons:

1. The act of hand-drawing a reproduction of a trademarked logo carries risk on both accuracy and trademark
   (if the official logo changes this becomes stale too, and under the constraint in `CLAUDE.md`, "no icon library,
   hand-drawn SVG only," we would keep paying that cost of keeping up).
2. This product has no duty to draw logos accurately; **it is enough that "what channel is this" can be told.**
3. `.chip` / `.who` (`style.ts:68-71` / `:318`) already has the component of "put text in a
   round-background pill." **Without building a new mechanism, repurposing it as a one- to two-character monogram
   badge** is the smallest implementation.

```
threads -> round background + "T"      x -> round background + "X"
note    -> round background + "n"      youtube -> round background + "YT"
by-hand (manual) -> round background + "手" (one kanji character. Since this product's first-person voice and prose are Japanese,
                              it says "not automatic" at a glance better than the Roman letter "M")
unknown webhook -> round background + "?" (same shape, only the content states "unknown")
```

Emoji (🤖 / ✋ and so on) were also considered and **rejected.** Emoji render differently by OS and font,
and cannot meet the brief's requirement to "use only what you have verified for rendering consistency yourself."
Putting text in a round pill is the same mechanism as the existing `.chip`, so no consistency check is needed
(it is just text).

### 4.3 Where to show it: only two places for now

At present there are only two places where a channel identifier appears on screen:

- The 「チャネル」 (Channel) field under 「このアカウントの設定」 (Settings for this account) on the account screen (a settings field of `venture.ts`,
  confirmed on the real screen as a `by-hand` chip).
- The 「予定していた時刻」 (Scheduled time) row of the hand-over posting card, where `post.channel` appears as plain text as is
  (`src/console/page/client/hand-over.ts:55`).

The all-accounts table has no channel column (see the column list in §2.2). Adding one badge next to the hand-over card's `post.channel`
is the natural first place to apply it. **However, this is not a
direct answer to "looks lame."** As the owner himself stated, "this is a new idea that came to me this time, and
I have never proposed it before," so in §6 it goes under "later."

---

## 5. Checking the real thing on mobile

Captured at 390x844 (measured `window.innerWidth === 390` confirmed), in light mode.

### 5.1 Header: not broken, but it always takes up 15% of the screen

```
Measured: header height 123px / viewport height 844px = 15%
```

The `header` avoids breaking thanks to `flex-wrap: wrap` (`style.ts:49-53`), but
the five elements (title, nav, `owner` pill, colour-scheme toggle, refresh button) do not fit in 390px width,
and the two buttons 「配色：自動」 (Colour scheme: auto) and 「更新」 (Refresh) drop to the second line. Because it is `position: sticky; top: 0`
(`style.ts:52`), **the height of these two lines keeps occupying the top 15% of the screen throughout scrolling.**
Since it is not broken it cannot be called a "bug," but it is one factor in the impression of "more cramped than expected."

### 5.2 Status band, all accounts (as cards), headline numbers: the real thing

The 「アカウントの状態」 (Account status) status band, and the all-accounts table that turned into stacked cards below `stackBelow` window width,
**read plainly.** As far as I confirmed in real-screen screenshots,
the label (generated from the `data-label` attribute, `style.ts:233-235`) sits in grey above each value, and the layout with numbers in a
three-column grid is not broken. The desktop table clipping of §2.2 **does not reproduce
on mobile**, because once turned into cards there is no need for horizontal scrolling.

The headline numbers of 「全アカウント合計」 also fit on one line as long as the value is a short string like "0".
**There is one thing I could not verify, however:** I tried to check by substituting realistic-length values (strings such as `128`, `4,802`,
`¥182,400`), but **the 30-second polling
(`load-poll.ts:281`) overwrote the DOM with real data both times before I could take the screenshot, so I could not
capture the appearance with the injected values.** To write it honestly,
**this is not a real-screen screenshot but an inference from the CSS:**
`.stat-row` has `flex-wrap: wrap` (`style.ts:351`), so even if values get longer,
it is guaranteed to **wrap rather than overflow sideways.** However,
whether the vertical alignment of label and number lines up after wrapping is not confirmed;
with uneven value lengths, the last one alone may end up stranded on the second line.

### 5.3 Hand-over posting card: no real screen. A reproduction from source (marked as needing verification)

As in §1.1, I could not actually make a hand-over card occur without performing an approval.
The following is only a **desk-based reproduction, made by matching the markup of `src/console/page/client/hand-over.ts` with the existing CSS
(`.card.handover`, `.handover-part`, `.handover-order`, `style.ts:255-274`); it is not a picture seen on a real screen.**

```
┌─────────────────────────────┐  <- .card.handover (green left border, style.ts:257)
│ あなたが投稿する番です — AI仕事術  │   (It's your turn to post: AI work skills)
│ 予定していた時刻：9/26 12:15       │  <- the §4.3 badge is intended to be added here
│                                │   (Scheduled time: 9/26 12:15)
│ 貼る順番                        │   (Order to paste)
│ 1. 本文を投稿                    │   (1. Post the body)
│ 2. コメントに貼る                 │   (2. Paste into the comment)
│                                │
│ [本文のプレビュー枠]              │  <- pre.post, white-space:pre-wrap, so
│ [コピー]                        │    wrapping itself is safe (style.ts:83-87)
│                                │   (body preview frame / Copy)
│ [投稿しました]  [開く]            │  <- .row (flex-wrap). Whether the combined width of the 2 buttons
└─────────────────────────────┘     fits in 390px is unverified  (I have posted / Open)
```

`pre.post` already has `white-space: pre-wrap; word-break: break-word`
(`style.ts:83-87`, plus an override on `.post` at `:250`), so from the code we can say there is no worry
of a long body overflowing sideways. **Whether the two buttons fit on one line or
drop to two lines has not been measured.** I leave this as a candidate for "check on a real device later."

### 5.4 Decision card (planning approval): the real thing is available

I was able to capture `gadget-life`'s planning approval gate (left unapproved) at 390px width. The checkbox,
the 「推奨」 (Recommended) heading, the chips (forecast, PR, risk) and the reorder up/down buttons **all fit
without breaking.** There were places where a Japanese title split at the end of a line like 「捨て」 / 「た話」,
but **this is not a bug**: Japanese has no inter-word spaces as English does, and
a wrap that cuts at any character at the end of a line is grammatically normal. It looks unnatural to English eyes, but I judged
it is not something to fix.

### 5.5 Answer to the owner's hunch

"Won't it turn out the same when viewed on mobile?": **on poverty of colour and absence of hierarchy, that is
right.** With only three places of responsive CSS (§2.5), weight, colour and hierarchy do not change at all between desktop and
mobile. On the table clipping of §2.2 it **does not apply**: that is a desktop-specific loss occurring
only at window widths of 1138px and above.

---

## 6. Do now / do later

### Do now (CSS and markup only. No new aggregation, no new dependency)

| Order | What to do | Scope touched | Basis |
|---|---|---|---|
| 1 | **Make the screen itself say that the all-accounts table can scroll.** A faint gradient fade at the right edge, or keep a thin scrollbar always visible on `.table-wrap` (`scrollbar-width: thin` etc.). At minimum, one line under the table: 「→ 確定報酬・型・計測は横にスクロールできます」 (Confirmed reward, patterns and tracking can be scrolled horizontally). | Around `.table-wrap` in `style.ts` | §2.2. Measured: 279px, three columns' worth, always invisible. The owner's remark itself |
| 2 | **Unify the assembly of `.stat` into one pattern** (label on top, number below). | Align `today.ts:194-195` to the order of `venture.ts:203-208`, and make it a common CSS class both read | §2.3, §3.3(a) |
| 3 | **Break lines per currency for confirmed reward.** | The revenue display in `today.ts` / `venture.ts`, the markup inside `.stat` | §2.4, §3.3(b) |
| 4 | **For the decision-gate section, give the green border that `console-ux-proposal.md` §4.3 proposed to its present location (the top of `#/ventures/<id>`).** That proposal was about the top-screen structure of the time; the decision of 2026-09-23 only changed the gate's address, and the rule itself, "give a border to what is waiting on you," has not been negated by any decision. This is **a proposal to carry that visual idea over to the present address**, not an objection to the information structure. | The wrapper of the gate section in `venture.ts`, `style.ts` | §2.5. Confirmed on a real screen: the gate section still looks the same as the other sections |

### Do later (needs a design decision, or new aggregation)

| What to do | Prerequisite |
|---|---|
| Add a period-over-period delta to the headline numbers (Buffer-style up 7%) | **It does not exist in today's code.** A design is needed that adds `untilMs` to `computePerformance` / `buildPortfolio` and runs the aggregation twice. Confirmed reward becomes a per-currency delta, so it does not fit a single "up 7%" like Buffer's; how to present multiple delta sentences needs separate design (§3.1) |
| ~~Channel monogram badge (§4)~~ **Done (2026-09-27).** `src/console/channel-monogram.ts` maps the known ids (`threads`/`x`/`note`/`youtube`/`by-hand`) to their letters and everything else to `?`, exactly as §4.2 specified; wired into both places §4.3 names (`venture.ts`'s channel chips, `hand-over.ts`'s slot line), styled off `.chip` in `style.ts`, with the `channel.unknownTitle` ja/en pair in `messages.ts` for the `?` badge's title. | — |
| Check on a real device whether the hand-over card's button row fits on one line at mobile 390px | §5.3. After preparing a safe way to create the hand-over state without going through an approval (for example, using test fixture data) |
| Decide whether to add mobile-specific CSS adjustments to the status band, all accounts and headline numbers | As in §5.5, "not broken" so not urgent, but the fact that there are only three dedicated media queries (§2.5) also means there is no mechanism to notice the next time even one thing breaks |

---

## 7. What was rejected

**(a) Overhauling the colour palette entirely.** The conclusion of the verification is "the palette is not broken. It is just unused"
(§2.1). An overhaul has a large implementation cost, and also carries the risk of new collisions with the colours that already have meaning,
`--warn` and `--danger`. **What to fix is not the choosing but the using.**

**(b) Repurposing `--accent` (green) to dress up "good numbers."** Detailed in §3.4. It dilutes the grammar this product
has only recently established, "green = waiting on you."

**(c) Drawing inline SVG that accurately reproduces the official logos of Threads/X/note/YouTube.** §4.2.
It is not worth the trademark-accuracy risk and the cost of keeping up. A one- to two-character monogram badge is enough.

**(d) Emoji-based icons (🤖 / ✋ and so on).** §4.2. We cannot verify rendering consistency ourselves.

**(e) Splitting the last 30 days in two to make a pseudo-delta.** §3.2. It is the act of diluting data that does not exist to look as if it does,
and the same kind of defect as the "lifetime figures" that `CLAUDE.md` names.

**(f) Treating mobile as verified using only `claude-in-chrome`'s `resize_window`.**
As the brief warned, it did not actually change the viewport, so I switched the tool to Chrome DevTools MCP's
`emulate`, and confirmed via `window.innerWidth` that it really was 390px
before going further (§1.2). There is no value in this document that I wrote without confirming it.

---

## 8. What could not be verified (honestly)

- **`amp-test` itself could not be opened.** It has a login wall and I had no credentials. I ran the same source code
  locally on mocks and checked there. The visual rules (CSS) should be identical,
  but I cannot say "I saw it on the real `amp-test`."
- **There is no real-screen screenshot of the hand-over posting card.** It could not be made to occur without performing an approval,
  and the safety mechanism rightly refused the approval click. §5.3 is limited to a desk-based reproduction from the source code.
- **I have not confirmed the appearance of the headline numbers after wrapping on mobile.** The 30-second polling
  overwrote the injected test values both times, so I could not take a real-screen screenshot.
  I confirmed as far as the CSS guarantee of `flex-wrap: wrap` (it does not overflow sideways),
  but the alignment after wrapping is unconfirmed (§5.2).
- **I looked at dark mode only on desktop and in part on mobile.** I have not done an exhaustive
  re-audit element by element.

---

> This document is a proposal; the owner decides whether to accept it or send it back.
> `src/`, `test/`, `prompts/` and `docs/_proposed/design/` were not touched by so much as a byte.
> The `platform.config.yaml` and `.amp/` used for the local real-screen check were both gitignored
> and were deleted when the work ended: they remain neither in a commit nor in this worktree.

---

# 日本語版（補足・原本）

# 見映えの提案 — 情報構造ではなく、見た目の軸で

> **これは提案であって実装ではない。** `src/` は1行も触っていない。
> 本書は [`console-ux-proposal.md`](console-ux-proposal.md) の**きょうだい文書**である。
> あちらは「どこに何を置くか」（情報構造）、本書は「置いたものがどう見えるか」（視覚の軸）を扱う。
> あちらの決定（推奨／そのほかの分割、状態帯、表の幅の決着）とは**矛盾しない**。
> 矛盾するように見える箇所は、そのつど「あちらのどの決定を、どう扱うか」を明示する。

---

## 0. 結論を先に

**「ダサイ」の正体は配色の選択ミスではない。配色が、画面の9割で使われていないことである。**

`src/console/page/style.ts` の `:root` が持つ配色（`--bg #fbfbfa` ・ `--ink #1a1a19` ・
`--muted #6b6b66` ・ `--accent #2f6f4f`）は、単体で見れば地味だが破綻していない。
実機で確かめると、**この配色を実際に使っている要素は「開く」リンクと `.card.handover` の緑枠、
そして開示チップ（`.pr-ok` / `.pr-missing`）くらいで、残り全部——見出し・数字・ラベル・
本文——は `--ink` の黒か `--muted` の灰色のどちらかである。** 全アカウント合計の4つの数字も、
アカウント個別の5つの数字も、太字の黒。見出しは全部同じ14px・大文字・字間広め・灰色
（`style.ts:58`、全`<h2>`に等しくかかる）。**この製品にとって一番意味のある数字（確定報酬）と、
一番意味のない数字（型の総数）が、画面の上で同じ太さ・同じ色で並ぶ。**

これに加えて、**実測で見つけた一次データがある**（§2.2）——デスクトップの通常の窓幅で、
全アカウント表が「成果」列の直後で物理的に切れ、「確定報酬」列から先（確定報酬・型・計測）が
横スクロールしないと見えない。オーナーの発言「レベニュー以降のところも何か幅がちぐはぐ」は、
比喩でも勘違いでもなく、**実測したピクセル単位でそのまま起きている。**

モバイルについては実機で確認した（§5）。**「同じ感じになるんじゃないか」という予感は半分正しく、
半分外れている。** 配色の使われなさ（表現の乏しさ）はモバイルでも寸分違わず同じ——
レスポンシブなCSSがそもそも3か所しかなく（後述）、色・太さ・階層のルールを変える仕組みが
無いのだから当然である。一方、表がレベニューで切れる問題は**モバイルでは起きない**——
`stackBelow`未満の窓幅では表がカード積みに変わり、この特定の欠けは再現しない。

---

## 1. 何を見て、何で確かめたか

### 1.1 実機（ブラウザ）

`https://amp-test.madbarbarian.workers.dev/` はログイン壁（合言葉）があり、
このセッションに渡された認証情報は無かった。**実機での確認は諦めず、同じコードを
自分のマシンでモックのまま動かして確かめた。** 具体的には：

1. `platform.config.example.yaml` をコピーして `platform.config.yaml` を作り（gitignore対象、
   コミットしていない）、`by-hand`（手動投稿）チャネルを有効化し、アカウントを3つ
   （`ai-tools` ・ `gadget-life` ・ `home-cooking`）にした。
2. `node src/cli.ts cycle run` でモックのサイクルを回し、企画の承認ゲートを1件発生させた。
3. `npm run console` でローカルに承認画面を立て、`mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`
   （Chrome DevTools MCP）で実際のブラウザから開いた。

これは `amp-test` そのものではないが、**`amp-test` と同じ `src/console/` のコード**が描く同じ
HTML/CSSである。差があるとすれば実データの量だけで、見た目のルールは同一。以後の
スクリーンショットの記述は、断りが無い限りこの実機確認から得たものである。

**承認そのものは行っていない。** ゲートの「承認して進める」ボタンをブラウザから押す操作は、
このセッションの安全機構に「自己承認」として拒否された——正しい制止だと考える。この製品が
最初から「運用者しか押さない」と決めている操作を、見た目を確かめるためだけに代打で押すのは、
たとえローカルのモックデータであっても筋が違う。**そのため、手渡し投稿カード（`.card.handover`）
の実機スクリーンショットは無い。** §5.3 で、ソースコードに基づく明示ラベル付きの再現に留める。

### 1.2 モバイルのビューポート — brief の警告どおり、道具を選び直した

ブリーフの指摘どおり、`mcp__claude-in-chrome__resize_window` はこの環境で実際のビューポートを
変えなかった。代わりに Chrome DevTools MCP の `emulate` を `viewport` 文字列付きで呼んだところ、
**`window.innerWidth` が確かに `390` を返した**（`resize_page` の `width`/`height` 引数だけでは
`innerWidth` が `500` のままで、これも当てにならなかった——`emulate` の `viewport` 引数が
実際に効く方だった）。以後のモバイルの記述は、この実測された390px幅（iPhone相当、
`devicePixelRatio:2`、`isMobile:true`）でのスクリーンショットに基づく。

### 1.3 参考にした2サイト

- **Buffer**（`buffer.com/insights`）: 見出し数字の並びが「小さく灰色・大文字トラッキングの
  ラベル」→「大きく太い数字」→「矢印付きの色つき差分（↗7%、上げは緑）＋比較対象の生数値を
  小さく添える」という3段構成。**この製品の「全アカウント合計」にそのまま当てはめられる、
  最も具体的な参考。**
- **Metricool**（`metricool.com`）: アイコン＋短いラベルのナビ、アクティブなタブの下の
  グラデーション線、パステル背景のカード、丸角、プライマリボタンだけに濃色を予約。
  接続チャネルの一覧では、名前の横に小さな円形のプラットフォームアイコンが付く——
  オーナーの「アイコン＋小さいラベル」案の出どころそのもの。

---

## 2. 見映えの正体 — 実測にもとづく内訳

### 2.1 配色が使われていない（実測）

ライトモード・デスクトップ（1440×900）で「今日」画面をフルページ撮影した。見えたもの：

- 見出し（`h2`）: 「アカウントの状態」「全アカウント — 直近30日」「全アカウント合計 — 直近30日」
  「最近の動き」——全部 `--muted` の灰色、全部同じ14px、全部大文字トラッキング
  （`style.ts:58`、全 `<h2>` に無条件でかかる1本のルール）。
- 「全アカウント合計」の4つの数字（公開済み投稿・クリック・成果・確定報酬）——
  全部 `--ink` の黒、全部20px・太字、全部同じ余白（`.stat b { font-size:20px }`、`style.ts:352`）。
  **確定報酬（お金）と型の総数（メタ情報）が同じ扱い。**
- 色が付いているのは：「開く」リンク（緑のテキスト、`a.open`、`style.ts:387-388`）、
  「承認が要る（1）」の灰色チップ（`.status-badge`、色なし、`style.ts:372`）だけ。

**唯一、狙って色を割り当てている箇所**（アカウント画面・企画承認カード）は実際によく効いている：
`予測 400` チップ、`PR` チップ（緑）、リスクの注記チップ、`disclosure` の緑／赤／灰
（`.pr-ok` / `.pr-missing` / `.pr-none`、`style.ts:272-274`）。**これは「配色のセンスが無い」の
反例である。** この製品はどこに色を置けば意味を持つかを知っている——知っている場所にしか
置いていないだけである。

### 2.2 全アカウント表が「確定報酬」の直前で物理的に切れる（実測・要修正）

`console-ux-proposal.md` は既にこの表の横幅問題を扱い、`fix/portfolio-table-width` で
「表を main と同じ幅に合わせ、はみ出た分は `.table-wrap` の横スクロールに任せる」という
トレードオフに決着したと記録している（`style.ts:110-137` のコメントに明記）。**そのトレードオフ
自体は正しい判断だと考える——だが、その先に何が起きているかまでは検証されていなかった。**

実測（ブラウザの `getBoundingClientRect` / `scrollWidth` を直接読んだ数値）：

```
main の可視幅（.table-wrap.clientWidth）      : 828px
表の実際の幅（table.grid.scrollWidth）        : 1107px
スクロールしないと見えない分（overflowPx）      : 279px

各列ヘッダーの左端／右端（1440px窓、main中央寄せ時点の絶対座標）:
  アカウント     306.5 – 482.5
  （開く）       482.5 – 550.5
  状態           550.5 – 654.5
  直近サイクル    654.5 – 850.5
  投稿           850.5 – 906.5
  中央値         906.5 – 968.5
  クリック       968.5 – 1036.5
  成果          1036.5 – 1128.5   ← ここまでが可視域（右端 1134.5px）
  確定報酬       1128.5 – 1228.5  ← 左端の6pxしか見えない。実質ゼロ
  型            1228.5 – 1300.5   ← 完全に不可視
  計測          1300.5 – 1412.5   ← 完全に不可視
```

`main { max-width: 860px }`（`style.ts:56`）なので、この828pxという可視幅は**窓を1440pxから
どれだけ広げても変わらない。** つまりこれは1440pxという特定の窓幅のバグではなく、**この表を
持つ画面をどんなデスクトップで開いても常に起きる。**

**これがオーナーの「レベニュー以降のところも何か幅がちぐはぐ」の実体である。** 比喩ではない。
「成果」列の右端（1134.5px）で表が視覚的に終わり——枠線も角丸もそこで完結して見える——
その直後にあるはずの「確定報酬」列は6px分の余白のような線しか見えず、「型」「計測」は
存在すら分からない。スクロールバーの気配も、デフォルトでは（特にmacOSのオーバーレイ
スクロールバーは操作するまで見えない）何も無い。**表が「そこで終わっている」ように読める
ことが、そのまま「幅がちぐはぐ」という言葉になっている。**

`console-ux-proposal.md` はこの表を帯Cへ下げる提案をしており（§4.1・§8c）、実装はまだ
先送りのようだ。**帯へ下げることと、この欠けが見えることは別の問題である。** 表がどこに
あっても、スクロールする表である以上、スクロールできることを画面が言わない限り同じことが
起きる。§6.1 で対処案を出す。

### 2.3 同じ「数字ウィジェット」が、2つの異なる組み方をしている

`src/console/page/client/today.ts:194-195`（全社合計）と
`src/console/page/client/venture.ts:203-208`（アカウント個別）は、どちらも「ラベルと数字を
並べる」という同じ役目を持つが、DOM の組み方が違う。

```
today.ts:194-195（全社合計）
  <div class="stat"><b>{value}</b><span class="muted">{label}</span></div>
  → 見た目: 数字が上、ラベルが下（.stat b が display:block のため）

venture.ts:203-208（アカウント個別）
  <span class="stat">{label}<b>{value}</b></span>
  → 見た目: ラベルが上、数字が下。ただしラベルは無地の文字（.muted が付いていない）
```

同じ製品の、隣り合う画面（今日の画面→開く→アカウント画面）で、**同じ概念の数字が
上下逆の順序で組まれ、しかもラベルの文字の弱さも違う。** どちらも見た目としては破綻して
いないが、2つの実装が独立に育った跡がそのまま残っている。これも「ちぐはぐ」の一因になりうる
——1つの画面遷移の中でルールが変わる、という体験として。

### 2.4 金額は複数通貨を1行で連結する

`src/affiliate/attribution.ts:214-223` の `formatMoney` は複数通貨があると
`"1,234 JPY / 567 USD"` のように `" / "` で連結した1本の文字列を返す。金額は通貨をまたいで
合算しない、という `CLAUDE.md` の約束（`totalsByCurrency`）を守った結果だが、**見た目の側は
その約束を1行の長い文字列に押し込めているだけ**で、Buffer 式の「大きな数字1個」という
レイアウトとは相性が悪い。1通貨のうちは問題にならないが、2通貨目からは長さが読みにくさに
直結する。§3.3 で対処する。

### 2.5 レスポンシブなCSSは、実際に3か所しかない

ブリーフの指摘を自分で数え直して確認した。`style.ts` 全体でメディアクエリは3つだけ：

```
line 40  @media (prefers-color-scheme: dark)                 — 配色のみ
line 210 @media (max-width: ${stackBelow-1}px)                — 表→カードの1点
line 246 @media (min-width:560px) and (max-width:${stackBelow-1}px) — 同上の中間段
```

**ステータス帯・手渡しカード・見出し数字・判断カードには、専用のモバイル対応が1行も無い。**
これらは「崩れてはいない」が「モバイル用に設計されてもいない」——ブロック要素と
flexbox の折り返しが偶然もっている、という状態。§5 の実測はこれを裏付ける。

---

## 3. 見出し数字の再設計

### 3.1 今あるデータで、差分は作れるか — 検証結果：作れない

`src/domain/performance.ts` の `computePerformance` は `sinceMs`（窓の開始）だけを受け取り、
`untilMs`（窓の終わり）という引数は存在しない——**常に「そこから今まで」を計算する構造**
（`performance.ts:35`、`:53`、`:101` を確認。`until` 系のフィールドはコード中に一つも無い）。
`src/domain/portfolio.ts` の `buildPortfolio` も同様に `days` から `sinceMs = nowMs - days*…` を
作るだけで、`nowMs` は常に「いま」である（`portfolio.ts:126`）。

つまり「直近30日」は出せるが、**「その前の30日」を出す仕組みは今のコードに存在しない。**
Buffer 式の「↗7%」を作るには、最低でも次の変更が要る：

1. `computePerformance` / `buildPortfolio` に `untilMs`（窓の終わり）を追加する。
2. 直近30日ぶんと、その前の30日ぶんの、**2回分**の集計を呼ぶ（現状の1回に対して倍のコスト。
   `router.ts:895-897` のコメントが既に「このポートフォリオ計算は30秒ポーリングのたびに
   走る、軽くはない」と釘を刺している）。
3. 確定報酬は通貨ごとに独立している（§2.4）ので、差分も通貨ごとに出す必要がある——
   「JPYは+12%、USDは今期からの新規」のような**複数の差分文**になり、Buffer の
   「↗7%」1個という単純な形には収まらない。

**これは視覚の変更ではなく、集計ロジックの新規追加である。** 本提案の範囲（見た目）を超える。
§6 では「あとで」に置く。

### 3.2 やらないこと — 同じ30日を割って差分のふりをする

検討して却下した案：直近30日のデータしか無いなら、その中を「直近15日」と「その前15日」に
割って擬似的な差分を出す——というアイデアがあり得る。**却下する。** これは「前期間との比較」
ではなく「同じ窓を切っただけ」で、母数が半分の期間同士のノイズを「トレンド」として見せる
ことになる。`CLAUDE.md` が名指しする「lifetime figures the billing command then charged
against」と同じ種類の不誠実さ——**無いデータを、薄めて有るように見せる**——になる。
無いものは無いと言う。

### 3.3 いま出せる、誠実な最小の見た目の改善

差分を作らずに、次の3点だけを直す。**すべてCSSとマークアップの変更で、新しい集計は要らない。**

**(a) `.stat` の組み方を1つに統一する。** `today.ts` と `venture.ts` の2つの異なる並び順
（§2.3）を、Buffer に倣って「ラベル（小さく・灰色・字間広め）が上、数字（大きく・太字）が
下」の1パターンに揃える。今の `venture.ts` 側は既にこの順序に近いので、`today.ts` 側を
合わせる方が変更が小さい。

```
いま（today.ts）              提案後（両方とも）
┌──────────────┐            ┌──────────────┐
│      24        │            │ 公開済み投稿    │ ← 小さく・灰色・字間広め
│  公開済み投稿    │            │      24        │ ← 大きく・太字
└──────────────┘            └──────────────┘
```

**(b) 確定報酬だけ、通貨ごとに行を分ける。** `formatMoney` が返す `"1,234 JPY / 567 USD"` を
1行のテキストとしてそのまま `<b>` に入れるのをやめ、`" / "` で分割して1通貨1行にする
（データの形は変わらない。表示側で分けるだけ）。

```
いま                          提案後
┌──────────────┐            ┌──────────────┐
│ 1,234 JPY / 567 USD │        │ 確定報酬       │
│    確定報酬          │        │ 1,234 JPY     │
└──────────────┘            │   567 USD     │
                              └──────────────┘
```

**(c) 差分の代わりに、比べる先を言葉で示す。** 「全アカウント合計 — 直近{days}日」という
見出しは既にある（`messages.ts:204/555`）。これは変えない。数字の下に小さく
「先月との比較はまだ出せません」のような文言は**足さない**——言えないことをわざわざ言うと、
かえって「なぜ無いのか」という新しい疑問を生む。§3.1 のとおり、これは「あとで」機能が
できてから足す。**今は何も言わないほうが誠実。**

### 3.4 なぜ `--accent`（緑）を数字の演出に使わないか

「良い数字を目立たせるなら、あの緑を使えばいいのでは」という発想は自然だが、**採らない。**
この製品の `--accent` は既に1つの意味を持って運用されている——「あなたが動かないと
起きないもの」（`.card.handover`、`style.ts:255-257` のコメントに明記／
`status-badge--handover`、`style.ts:373-377`）。確定報酬が伸びたことは喜ばしいが、
**運用者の行動を待ってはいない。** 同じ緑を「良い知らせ」にも流用すると、画面のどこかで
緑を見たときに「これは押さないといけないのか、ただの好調の知らせなのか」を毎回考える
羽目になる——この製品が最近ようやく確立した色の文法（②の判断だけが緑）を、①の演出のために
薄める。**色を足すのではなく、太さと配置だけで数字の優劣を出す**——(a)(b)で足りる。

---

## 4. アイコンの提案について

### 4.1 前提の訂正（親からの指摘を受けて、自分でも確認した）

最初に渡された前提は「`ChannelId` は一般文字列で、この製品はどのSNSかを機械的に知らない
ので、ブランドアイコンは常に不誠実になる」というものだった。**これは半分だけ正しい。**
自分でコードと設定を確認した：

- `ChannelConfig.id` は確かに自由文字列で、`adapter` は Threads 以外の想定チャネル全部が
  `"webhook"` になる（`src/config/schema.ts:137-138`）。**アダプタの種類だけでは
  「X なのか、ライセンシー個人の Zapier シナリオなのか」を機械的に区別できない**——
  ここは元の前提どおり。
- **しかし** `platform.config.example.yaml` は、コメントアウトの雛形として
  `id: x` ・ `id: note` ・ `id: youtube`（いずれも `adapter: webhook`、
  `platform.config.example.yaml:299-330`）を、実際に動いている `id: threads`
  （`:232-249`）と並べて出荷しており、`docs/3-development/integrations.md` §3
  （`:65-75`）が「X／note／YouTube は雛形がコメントで入っている」とそのまま名指しで
  文書化している。これは**推測ではなく、この製品自身が「この名前で来たらこのSNSである」
  と決めて配っている事実**である。

**結論：アイコン案は、この境界のなかでなら採用してよい。** `channel.id` が
この製品自身が出荷・文書化している既知の名前（`threads` ・ `x` ・ `note` ・ `youtube`）と
一致するときだけ、その名前に対応する印を出す——これはライセンシー自身の設定ファイルが
言っている事実の反映であって、当て推量ではない。それ以外の `id`（ライセンシーが自分で
名付けたカスタムの webhook 先）は、**常に同じ1種類の「わからない」印**にする。
既知の名前→既知の印、未知の名前→正直に「未知」の印、という誠実さは両方の場合に保たれる。

### 4.2 それでも、本物のロゴは描かない

境界の中に入ったからといって、Threads / X / note / YouTube の**正確なブランドロゴを
インラインSVGで再現する**ことは提案しない。理由は3つ：

1. 商標のロゴを手描きで再現する行為そのものが、精度と商標の両面でリスクを持つ
   （公式のロゴが変わればここも古くなり、`CLAUDE.md` が求める「アイコンライブラリ不使用・
   手描きSVGのみ」という制約の下でその追従コストを払い続けることになる）。
2. この製品はロゴを正確に描く責務を持たない——**「これは何のチャネルか」が分かればよい。**
3. `.chip` / `.who` （`style.ts:68-71` ／ `:318`）は既に「文字を丸背景のピルに入れる」
   という部品を持っている。**新しい仕組みを作らず、これを1文字〜2文字のモノグラム
   バッジに転用する**のが最小の実装で済む。

```
threads → 丸背景 + "T"      x → 丸背景 + "X"
note    → 丸背景 + "n"      youtube → 丸背景 + "YT"
by-hand（手動）→ 丸背景 + "手"（漢字1文字。この製品の一人称と地の文が日本語なので、
                              ローマ字の "M" より一目で「自動でない」と伝わる）
未知のwebhook → 丸背景 + "?"（同じ形、中身だけ「わからない」を明示）
```

絵文字（🤖／✋など）も検討して**却下した。** 絵文字はOS・フォントによって描画が変わり、
「レンダリングの一貫性を自分で確認したものだけを使う」というブリーフの要求を満たせない。
文字を丸ピルに入れる方式は、既存の `.chip` と同じ仕組みなので一貫性の検証が要らない
（ただの文字だから）。

### 4.3 どこに出すか — 今は2か所だけ

現状、チャネルの識別子が画面に出る場所は2つしかない：

- アカウント画面の「このアカウントの設定」→「チャネル」欄（`venture.ts` の設定フィールド、
  実機で `by-hand` のチップとして確認済み）。
- 手渡し投稿カードの「予定していた時刻」の行、`post.channel` がそのまま地の文で出る
  （`src/console/page/client/hand-over.ts:55`）。

全アカウント表にはチャネル列が無い（§2.2 の列一覧を参照）。手渡しカードの `post.channel`
の隣にバッジを1個添えるのが最初の適用場所として自然——**ただし、これは「ダサイ」への
直接の回答ではない。** オーナー自身が「これは今回思いついた新しいアイデアで、これまで
提案したことはない」と明言している通り、§6で「あとで」に置く。

---

## 5. モバイルの実物確認

390×844（実測 `window.innerWidth === 390` を確認済み）、ライトモードで撮影。

### 5.1 ヘッダー — 崩れてはいないが、常に画面の15%を占め続ける

```
実測: header の高さ 123px / ビューポート高 844px = 15%
```

`header` は `flex-wrap: wrap` で崩れずに済んでいる（`style.ts:49-53`）が、
タイトル・ナビ・`owner`ピル・配色切替・更新ボタンの5要素は390px幅に収まらず、
「配色：自動」「更新」の2ボタンが2行目に落ちる。`position: sticky; top: 0`
（`style.ts:52`）なので、**この2行ぶんの高さがスクロール中ずっと画面の上15%を占め続ける。**
崩れてはいないので「バグ」とは言えないが、「思ったより窮屈」という感触の一因ではある。

### 5.2 ステータス帯・全アカウント（カード化）・見出し数字 — 実物

`アカウントの状態`（ステータス帯）と、`stackBelow` 未満の窓幅でカード積みに変わった
全アカウント表は、**素直に読める。** 実機のスクリーンショットで確認した限り、
ラベル（`data-label` 属性から生成、`style.ts:233-235`）が各値の上に灰色で付き、
３列グリッドで数字が並ぶレイアウトは崩れていない。§2.2 のデスクトップの表クリップは
**モバイルでは再現しない**——カード化された時点で横スクロールの必要が無くなるため。

「全アカウント合計」の見出し数字も、値が「0」のような短い文字列である限りは1行に収まる。
**ただし、これは検証できなかった点がある：** 現実的な長さの値（`128` ・ `4,802` ・
`¥182,400` のような文字列）に差し替えて確かめようとしたが、**30秒ごとのポーリング
（`load-poll.ts:281`）が2回とも、スクリーンショットを撮る前にDOMを実データで
上書きしてしまい、注入した値のままの見た目を撮ることができなかった。** 誠実に書くと
——**ここは実機のスクリーンショットではなく、CSSの根拠に基づく推論**である：
`.stat-row` は `flex-wrap: wrap` を持つ（`style.ts:351`）ので、値が長くなっても
**横に食み出す（overflow）ことは無く、折り返す**ことは保証されている。ただし、
折り返した先でラベルと数字の縦の並びが揃うかどうかまでは確認できていない——
値の長さが不揃いだと、最後の1個だけが2行目に孤立する見た目になる可能性がある。

### 5.3 手渡し投稿カード — 実機なし。ソースからの再現（要検証と明記）

§1.1 のとおり、承認を伴わずに手渡しカードを実際に発生させることができなかった。
以下は `src/console/page/client/hand-over.ts` のマークアップと、既存のCSS
（`.card.handover` ・ `.handover-part` ・ `.handover-order`、`style.ts:255-274`）を
突き合わせただけの**机上の再現であり、実機で見た絵ではない。**

```
┌─────────────────────────────┐  ← .card.handover（緑の左枠、style.ts:257）
│ あなたが投稿する番です — AI仕事術  │
│ 予定していた時刻：9/26 12:15       │  ← ここに §4.3 のバッジを足す想定
│                                │
│ 貼る順番                        │
│ 1. 本文を投稿                    │
│ 2. コメントに貼る                 │
│                                │
│ [本文のプレビュー枠]              │  ← pre.post、white-space:pre-wrap なので
│ [コピー]                        │    折り返し自体は安全（style.ts:83-87）
│                                │
│ [投稿しました]  [開く]            │  ← .row（flex-wrap）。2ボタンの合計幅が
└─────────────────────────────┘     390pxで収まるかは未検証
```

`pre.post` は `white-space: pre-wrap; word-break: break-word` を既に持つ
（`style.ts:83-87` に加えて `:250` で `.post` に上書き）ので、本文が長くても
横に食み出す心配は無い、とコードからは言える。**2つのボタンが1行に収まるか、
2行に落ちるかは実測していない。** ここは「あとで実機で確認する」候補として残す。

### 5.4 判断カード（企画の承認） — 実物あり

`gadget-life` の企画承認ゲート（未承認のまま）を390px幅で撮影できた。チェックボックス、
「推奨」の見出し、チップ（予測・PR・リスク）、並び替えの↑↓ボタンは**すべて崩れずに
収まっている。** 日本語のタイトルが行末で「捨て」「た話」のように分かれる箇所があったが、
**これはバグではない**——日本語には英語のような単語間スペースが無く、行末がどの文字で
切れても文法上は正常な折り返しである。英語の目で見ると不自然に映るが、直す対象ではない
と判断した。

### 5.5 オーナーの予感への回答

「モバイルで見たら同じ感じになるんじゃないか」——**配色の乏しさ・階層の無さについては
正しい。** レスポンシブなCSSが3か所しか無い（§2.5）以上、太さも色も階層も、デスクトップと
モバイルで一切変わらない。§2.2 の表クリップについては**当てはまらない**——あれは
1138px以上の窓幅でのみ起きる、デスクトップ固有の欠けである。

---

## 6. いまやる／あとでやる

### いまやる（CSSとマークアップのみ。新しい集計・新しい依存は無し）

| 順 | やること | 触る範囲 | 根拠 |
|---|---|---|---|
| 1 | **全アカウント表に、スクロールできることを画面自身が言わせる。** 右端に薄いグラデーションのフェード、または `.table-wrap` に細いスクロールバーを常時見せる（`scrollbar-width: thin` 等）。最小でも表の下に「→ 確定報酬・型・計測は横にスクロールできます」の1行。 | `style.ts` の `.table-wrap` 周辺 | §2.2。実測で279px・3列ぶんが常に不可視。オーナーの発言そのもの |
| 2 | **`.stat` の組み方を1パターンに統一する**（ラベル上・数字下）。 | `today.ts:194-195` を `venture.ts:203-208` の順に合わせ、両方が読む共通のCSSクラスにする | §2.3・§3.3(a) |
| 3 | **確定報酬を通貨ごとに改行する。** | `today.ts` / `venture.ts` の revenue 表示、`.stat` 内のマークアップ | §2.4・§3.3(b) |
| 4 | **判断ゲートの節に、`console-ux-proposal.md` §4.3 が提案していた緑枠を、いまの置き場所（`#/ventures/<id>` の先頭）に対して与える。** あちらの提案は当時のトップ画面の構造に対するものだったが、2026-09-23の決定でゲートの住所が変わっただけで、「あなた待ちのものには枠を与える」というルール自体は決定によって否定されていない。**あちらの視覚のアイデアを、いまの住所に引き継ぐ提案**であり、情報構造への異論ではない。 | `venture.ts` のゲート節のラッパ、`style.ts` | §2.5 実機で確認：ゲート節は今も他の節と同じ見た目 |

### あとでやる（設計判断か、新しい集計が要る）

| やること | 前提 |
|---|---|
| 見出し数字に前期間比の差分を足す（Buffer式の↗7%） | **今のコードに無い。** `computePerformance` / `buildPortfolio` に `untilMs` を足し、集計を2回走らせる設計が要る。確定報酬は通貨ごとの差分になるので、Buffer のような単一の「↗7%」には収まらない——複数の差分文をどう見せるかは別途デザインが要る（§3.1） |
| チャネルのモノグラムバッジ（§4） | 実装コストは小さいが、**オーナー自身が「思いつき」と明言した新規機能**であり、「ダサイ」への直接の回答ではない。`messages.ts` に ja/en のペアを足す必要もある |
| 手渡しカードのボタン列がモバイル390pxで1行に収まるか、実機で確認する | §5.3。承認を経ずに手渡し状態を作る安全な方法（例えばテスト用のfixtureデータを使うなど）を用意してから |
| ステータス帯・全アカウント・見出し数字に、モバイル専用のCSS調整を足すかどうか判断する | §5.5のとおり「崩れてはいない」ので急ぎではないが、専用のメディアクエリが3つしか無いという事実（§2.5）は、次に何か1つでも崩れたときに気づく仕組みが無いことも意味する |

---

## 7. 却下したもの

**(a) 配色を全面的に刷新する。** 検証の結論は「配色は破綻していない。使われていないだけ」
（§2.1）。刷新は実装コストが大きい上、`--warn` ・ `--danger` という既に意味を持つ色との
新しい衝突を生むリスクがある。**直すのは選び方ではなく、使い方。**

**(b) `--accent`（緑）を「良い数字」の演出に流用する。** §3.4 で詳述。この製品が
最近ようやく確立した「緑＝あなた待ち」という文法を薄める。

**(c) Threads/X/note/YouTube の公式ロゴを正確に再現したインラインSVGを描く。** §4.2。
商標の精度リスクと追従コストに見合わない。文字1〜2文字のモノグラムバッジで十分。

**(d) 絵文字ベースのアイコン（🤖／✋など）。** §4.2。レンダリングの一貫性を自分で
検証できない。

**(e) 直近30日を2つに割って擬似的な差分を作る。** §3.2。無いデータを薄めて有るように
見せる行為で、`CLAUDE.md` が名指しする「lifetime figures」の欠陥と同じ種類。

**(f) `claude-in-chrome` の `resize_window` だけでモバイルを検証したことにする。**
ブリーフの警告どおり実際のビューポートを変えなかったため、道具を Chrome DevTools MCP の
`emulate` に切り替え、`window.innerWidth` で実際に390pxになっていることを確認してから
先へ進んだ（§1.2）。確認せずに書いた値は、この文書のどこにも無い。

---

## 8. 検証できなかったこと（正直に）

- **`amp-test` そのものは開けなかった。** ログイン壁があり、認証情報が無い。同じソースコードを
  ローカルでモック運用し、そちらで確かめた（§1.1）。見た目のルール（CSS）は同一のはずだが、
  「`amp-test` の実機で見た」とは言えない。
- **手渡し投稿カードの実機スクリーンショットは無い。** 承認操作を伴わずに発生させられず、
  安全機構が承認クリックを正しく拒否した。§5.3はソースコードからの机上の再現に留めた。
- **モバイルでの見出し数字の「折り返した先」の見た目は確認できていない。** 30秒ポーリングが
  注入したテスト値を2回とも上書きし、実機のスクリーンショットが取れなかった。
  `flex-wrap: wrap` というCSSの保証（横に食み出さない）までは確認できたが、
  折り返した後の整列は未確認（§5.2）。
- **ダークモードはデスクトップと、モバイルの一部しか見ていない。** 要素ごとの網羅的な
  再監査はしていない。

---

> 本書は提案であり、通すか突き返すかはオーナーが決める。
> `src/` ・ `test/` ・ `prompts/` ・ `docs/_proposed/design/` は1バイトも触っていない。
> ローカルでの実機確認に使った `platform.config.yaml` と `.amp/` はどちらも gitignore
> 対象で、作業終了時に削除した——コミットにも、この worktree にも残っていない。
