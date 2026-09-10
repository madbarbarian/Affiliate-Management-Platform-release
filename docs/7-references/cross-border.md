# Cross-border promotion

Promoting a US product to Japanese readers, or a Japanese product to English
speakers, is not the same job as promoting either at home. This is how the
platform models it, and what it refuses to do.

> The rules quoted here are the platform's shipped starting point, not legal
> advice. Check them against the current regulations for every market you
> operate in, and against every network contract you have signed.

---

## The one rule everything follows

**Compliance follows the audience, not the merchant.**

An ad is regulated where it is *seen*. A US SaaS product promoted to Japanese
readers is governed by 景品表示法 and the stealth-marketing rules, and the
disclosure has to be in Japanese — the FTC's Endorsement Guides are not what
protects that reader, and an English `#ad` is not a disclosure to someone who
does not read English.

The merchant's own country decides something different and narrower: what extra
caveats the reader is owed. Currency. Shipping and duties. Whether there is
support in their language. Who they would actually be contracting with.

Both halves are computed in one place, `src/domain/market.ts`, so the policy
checks, the writing role and the inspection role cannot disagree about them.

## The three fields

```yaml
markets:
  - id: jp        # a place where readers are
    ...

offers:
  - id: offer_us_saas
    originMarket: us          # where the merchant is
    targetMarkets: [us, jp]   # where you may promote it
    crossBorderNote: "米国企業との直接契約です。決済はUSD、日本語サポートはありません。"

ventures:
  - id: ai-tools
    market: jp                # where this account's readers are
```

## What the platform refuses

These are config-time errors. The platform will not start.

**An offer a venture is not licensed to promote.** A venture may only carry an
offer whose `targetMarkets` include its own market. Set `targetMarkets` from
the network's actual territory terms — not from where you would like to sell.
This is the check that stops the most expensive mistake in cross-border
affiliate work: promoting an offer outside its permitted territory, having the
conversions reversed months later, and possibly losing the account.

**A cross-border offer with no caveat.** If `targetMarkets` contains anything
other than `originMarket`, `crossBorderNote` is required. The error names what
it needs:

```
offers[0].crossBorderNote: is required: this offer originates in "us" but is
promoted in "jp". State what a reader there must know before clicking -
currency, shipping, language support, and who they would be buying from.
```

**A category a market bans outright.** `restrictedCategories` with
`prohibited: true` refuses the pairing. Gambling offers targeted at Japan, for
example.

## What the platform enforces at publication

**The disclosure is the audience's, in the audience's language.** A venture in
`jp` gets `markets[jp].disclosureText`, whatever `policy.disclosureText` says.

**Prohibited claims are cumulative.** `policy.prohibitedClaims` ∪ the audience
market's own. A phrase that is merely unwise in one market and unlawful in
another is blocked for the market where it is unlawful.

**Category rules reach the writer.** `restrictedCategories[].note` — 薬機法,
金商法, the FTC/FDA supplement rules — is handed to the writing and inspection
roles as a constraint they must honour, not as background.

**The cross-border caveat must actually appear.** The writer is asked to work
it into the story, because a caveat bolted onto the end reads worse than one
that belongs there. But it is verified by presence, not by asking a model
whether it remembered: if the text is missing after the inspection rewrite, the
platform appends it, and a post that still lacks it is blocked. The reader is
never the one who pays for the model having a bad day.

## Money

**Revenue is never converted between currencies.** A venture promoting a JPY
offer and a USD offer produces two lines, everywhere — `report`, the console,
the analysis role's input, and any licensing statement:

```
approved     7,500 JPY / 30 USD
```

There is no exchange rate in this platform on purpose. A blended figure would
be wrong at a rate nobody recorded, on a date nobody noted, and someone would
eventually be billed against it.

## Setting up a second market

1. Add the market to `markets:`. Copy the shipped `jp` or `us` entry and edit
   the disclosure, the regulator, the prohibited claims and the restricted
   categories for that jurisdiction.
2. Add `<market>` to `targetMarkets` on every offer you are actually permitted
   to promote there, and write the `crossBorderNote`.
3. Add a venture with `market: <id>`, its own `language`, `timezone` and
   `voice`. A second-language account needs its own voice profile — a persona
   translated word-for-word reads translated.
4. `node src/cli.ts doctor`, then `node src/cli.ts cycle run` with
   `llm.provider: mock` to see what comes out before spending anything.

## What the platform still cannot know

- Whether your network's contract actually permits the territory. It enforces
  what you put in `targetMarkets`; it cannot read your agreement.
- Tax, invoicing and withholding on cross-border earnings.
- Whether a channel's own terms restrict promoting foreign offers to its users
  in a given country.
- Whether a specific claim is lawful in a specific market. It blocks the
  phrases you list; it does not know the law.
