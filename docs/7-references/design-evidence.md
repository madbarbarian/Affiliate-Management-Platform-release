# Design evidence

The external facts and experiments that current design decisions rest on: what was
read, where, when, how far it can be trusted, and which decision depends on it.

`decisions.md` records *what was decided and why*. This file records *what we knew when
we decided it*, so that when a source changes (a policy is revised, a page moves, a
reply arrives) the affected decisions can be found and reopened instead of quietly going stale.
Requirement of the owner, 2026-09-26: research findings are kept as evidence, not only in chat.

## How to read an entry

Every entry has a **grade**. It says how far the claim can be trusted, not how important it is.

| Grade | Meaning |
|---|---|
| **P** | Primary source, read directly (the vendor's own page). |
| **P\*** | Primary source read through a summarising fetch tool. The quote is what the tool returned, not a byte-exact copy. Re-read the live page before relying on it for anything contractual. |
| **X** | Our own experiment against our own code. Reproducible; the command is given. |
| **S** | Secondary: a blog, a search-result summary, a forum. Someone else's reading of a source. |
| **A** | Absence: we looked and did not find it. **Not found is not the same as does not exist**, and never means "permitted". |

An entry that is only `S` or `A` must not be the sole basis of a design change.

Each entry also says **what would invalidate it** (so it can be re-checked) and **which decisions depend on it**.

---

## A. Affiliate networks and link handling

### E-01 · Amazon Associates forbids redirected links, and pays nothing for purchases reached that way

- **Grade:** P (read 2026-09-22; recorded in `decisions.md` 2026-09-22. **Not re-fetched on 2026-09-26.**)
- **Sources:** `affiliate-program.amazon.com/help/operating/policies` and `affiliate.amazon.co.jp/help/operating/policies`
- **What it says:** Operating Agreement §6(v) forbids obscuring the referring URL, including through a redirect page; §6(w) forbids link shortening that hides that a link is an Amazon link; fee schedule §2(e) excludes from qualifying purchases those reached through an intermediate site. Japanese text: 「全ての特別リンクは、乙のサイトから直接アクセスしなければなりません」.
- **Consequence:** with the platform's own `/go/<code>` in front, an Amazon link is both a terms violation and earns nothing.
- **Depends on:** v0.10.0's config-validation refusal of Amazon offers; the deferred `direct` link mode (B2b).
- **Invalidated by:** a revision of the Associates Operating Agreement. Re-read before building `direct` mode.

### E-02 · A8.net prohibits using only the link part of an ad code

- **Grade:** P (fetched 2026-09-26)
- **Source:** https://www.a8.net/compliance/prohibited-matter.php ("広告素材の改変")
- **Quote:** 「生成された広告コードを広告主に無断で変更すること。バナー画像の変更、テキスト広告の文言の変更、広告コードからリンク部分のみを使用すること等が該当します。」
- **Why it matters:** Threads cannot carry the ad code's 1px tracking image, so every post that shows only the URL is "link only". This applies **with or without** the redirect and is the larger open question. We do not know whether A8 treats social posts differently.
- **Depends on:** the assumption that posting A8 links on Threads is allowed at all.
- **Invalidated by:** an A8 reply (see the inquiry below); a revision of the media-member terms (A8 announced a revision on 2026-04-01, effective 2026-05-01 — https://a8pr.jp/2026/04/01/kiyaku-revision-20260501/, not read).

### E-03 · A8.net: no explicit ban on redirects, shortened URLs or intermediate pages found

- **Grade:** A (`prohibited-matter.php` and https://support.a8.net/a8/as/faq/manual/how_to_post.php, 2026-09-26; also `media-userpolicy.php` §8.1.12 on 2026-09-22 with zero hits for リダイレクト／転送／短縮)
- **Consequence:** unresolved. **Silence is not permission.** Amazon, by contrast, states the ban and the consequence.
- **Depends on:** keeping `redirect` as the default link mode while A8 is unanswered.

### E-04 · A8.net support reportedly answered "アフィリエイトリンクのリダイレクトはご遠慮ください"

- **Grade:** S — **unverified.** One blog post (https://webkaihatsu.com/a8-redirect/) quotes it as A8 support's reply. No date, no enquiry text, no ticket. The author links it to "リンク部分のみを使用" by inference.
- **Weight:** "ご遠慮ください" (please refrain) is softer than a prohibition. It is a reason to ask, not a reason to conclude.
- **Correction on record:** an earlier search-result summary in this project asserted "A8 prohibits redirects". That repeated this blog; no primary source backed it. Retracted in `decisions.md` 2026-09-26.
- **Invalidated by:** the A8 reply.

### E-05 · A8.net parameter measurement: `id1`–`id5`, screen-only report

- **Grade:** P\* (fetched 2026-09-26) — https://support.a8.net/a8/as/faq/manual/a8-parameter-guide.php
- **What it says (as returned):** append `&id1=<value>` … `&id5=<value>` to the affiliate link, e.g. `http://px.a8.net/svt/ejp?a8mat=XXXXXXX&id1=…`. The `id1` part must not be changed. Values: at most 50 bytes, half-width alphanumerics only, no symbols such as `?` or `&`, no personal data. Results are viewed in the "パラメータ計測レポート画面". Described as an advanced feature, **not supported by A8 support**; Amazon and Rakuten programs are not covered.
- **Not stated on the page:** CSV or API export of that report; clicks per parameter; use on social media or without the HTML ad code; any relation to redirects or short URLs.
- **Consequence:** per-post attribution without a redirect is possible in principle (`id1` = our 10-character link code fits). **Getting those figures into the platform automatically is not established.**
- **Depends on:** the shape of `direct` mode for A8; open item 18 (how conversions are imported on Cloudflare).
- **Invalidated by:** the page changing; an A8 reply on export.

### E-06 · The shipped A8 template overwrote A8's own material id (`a8mat`)

- **Grade:** X (2026-09-26)
- **Experiment:** call the real `createCsvNetwork(...).buildTrackedUrl` with an A8-shaped link.
  ```
  landingUrl = https://px.a8.net/svt/ejp?a8mat=3ABCDE+1FGHIJ+2KLMN+OPQRS
  subIdParam: a8mat  →  https://px.a8.net/svt/ejp?a8mat=k7m2p9x4qa
  subIdParam: id1    →  https://px.a8.net/svt/ejp?a8mat=3ABCDE+1FGHIJ+2KLMN+OPQRS&id1=k7m2p9x4qa
  ```
  Cause: `url.searchParams.set(subIdParam, subId)` replaces a parameter of the same name (`csv.ts`, `webhook.ts`).
- **Not tested:** what A8's servers do with a link whose `a8mat` is missing. We changed the template because A8 itself says to leave `a8mat` alone (E-05).
- **Status:** template, `integrations.md` and `test/csv.test.ts` corrected (commit 36b936e). **A guard that fails when the link already carries the parameter is proposed, not built** (`decisions.md` 2026-09-26): editing the template does not stop a licensee writing `a8mat`.

### E-07 · A8.net reports show clicks

- **Grade:** P\* (fetched 2026-09-26) — https://support.a8.net/a8/as/faq/manual/report.php. 「クリック」 is listed as a report item ("広告がクリックされた回数") and used in the CVR formula. Per-parameter clicks: not stated.

### E-08 · A8.net "成果データ連携API" is for sending conversions to ad platforms

- **Grade:** S (search-result summary; the primary manual `https://support.a8.net/as/api/pdf/a8api_manual.pdf` was **not read**).
- **What it appears to be:** hourly push of A8 conversions to Google/Meta/LINE/TikTok ads for media members running paid ads. **Not a general "pull my report" API.**
- **Depends on:** the belief that A8 offers no report API to ordinary media members. **Unverified — read the manual before concluding.**

### E-09 · Amazon: no conversion-report API found; PA-API is product data

- **Grade:** A / S (search only, 2026-09-26). Amazon's help pages describe the Product Advertising API as product data, requiring qualifying sales to keep access.
- **Not established:** whether reports can be downloaded, and how many tracking IDs an account may hold.

---

## B. Using the licensee's own Claude subscription

### E-10 · Claude Code Routines can be triggered from outside, under the account owner's own plan

- **Grade:** P\* (fetched 2026-09-25) — https://code.claude.com/docs/en/routines
- **Quotes / facts:** "trigger on demand by sending an HTTP POST to a per-routine endpoint with a bearer token"; endpoint `POST https://api.anthropic.com/v1/claude_code/routines/{id}/fire`, beta header `experimental-cc-routine-2026-04-01`; "Routines are available on Pro, Max, Team, and Enterprise plans." (**not Free**); "Routines draw down subscription usage the same way interactive sessions do"; the saved prompt is authored in advance, and `text` sent at fire time arrives wrapped as untrusted data; "Routines are in research preview. Behavior, limits, and the API surface may change."; the `/fire` endpoint "is available to claude.ai users only and is not part of the Claude Platform API surface". A daily cap on runs exists; **its size was not read.**
- **Depends on:** `docs/3-development/external-generation-design.md` (not built).
- **Invalidated by:** the research preview changing. Re-read before building.

### E-11 · Cowork scheduled tasks are time-only

- **Grade:** S (search-result summary, 2026-09-25): fixed cadences only; no external trigger; a feature request exists (anthropics/claude-code issue #94918). The Cowork help page `support.claude.com/en/articles/13854387` was not read.

### E-12 · Programmatic use of a subscription is currently allowed; a billing change was announced then paused

- **Grade:** P\* (fetched 2026-09-25) — https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- **Quote:** "We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits."
- **Consequence:** volatile. A separate credit pool ($20–$200/month) was announced for 2026-06-15 and paused the same day. Treat any design that assumes today's terms as provisional.

### E-13 · Consumer Terms: "resell the Services"

- **Grade:** P\* (fetched 2026-09-25) — https://www.anthropic.com/legal/terms, section 3. The tool reported the terms do **not** spell out a distinction between using Claude for your own business and providing it to customers.
- **Our reading (not a legal opinion):** the platform is licensed software; each licensee uses their own subscription for their own work; the platform never holds their credentials. That is not reselling. The 2026-09-20 rejection reason "the breach is inherited by licensees" was withdrawn on this basis (`decisions.md` 2026-09-25).
- **Not established:** whether Anthropic agrees. No legal review was done.

---

## C. Visual references

### E-14 · Buffer and Metricool dashboards

- **Grade:** observed by eye, 2026-09-25 (`buffer.com/insights`, `metricool.com`); **no screenshots were saved.** Patterns noted: a label → number → coloured delta stack for headline figures; icon + short label navigation; channel identity shown by a small platform badge; soft card backgrounds with one dark colour reserved for primary buttons.
- **Use:** inspiration only. Decisions taken from it are in `visual-polish-proposal.md`.

---

## D. Open questions and the enquiry to send

### Q-1 · Enquiry to A8.net support (owner sends; text below is ready to paste)

Revised on 2026-09-26 after reading E-05: it now asks about the parameter report's export, which the manual does not say.

> 貴社の広告主の商品を、SNS（Threads）の投稿でご紹介する予定です。次の4点を教えてください。
>
> 1. 発行された成果測定リンクを、自社ドメインの中継URL（例：`https://自分のドメイン/go/xxxx`。アクセスを1回記録してから、そのまま貴社のリンクへ即座に転送するのみ）経由で読者に届ける形式は、認められますか。「アフィリエイトリンクのリダイレクトはご遠慮ください」というご案内を見かけたのですが、これは禁止でしょうか。認められない場合、成果は承認されないのでしょうか。
> 2. SNSの投稿には広告コードの画像タグ（1pxのトラッキング画像）を含められず、リンクのみを載せる形になります。禁止事項にある「広告コードからリンク部分のみを使用すること」に該当しますか。SNSでの掲載方法として、貴社が想定・推奨している形があれば教えてください。
> 3. 「広告掲載URL管理」への登録は、SNSの個別の投稿URLごとに必要ですか。
> 4. パラメータ計測（`id1`〜`id5`）の集計結果は、CSVまたはAPIで取得できますか。また、パラメータ別のクリック数は確認できますか。

**Reply log** (fill in when the reply arrives; a reply supersedes E-03/E-04):

| Date received | Question | Reply (verbatim) | Who replied / ticket | Effect on decisions |
|---|---|---|---|---|
| — | — | — | — | — |

### Q-2 · To read before building `direct` mode

- A8 media-member terms revision effective 2026-05-01 (https://a8pr.jp/2026/04/01/kiyaku-revision-20260501/) — E-02/E-03 were read after it took effect, but the revision itself was not read.
- A8 "成果データ連携API" manual (E-08).
- Amazon: report export and tracking-ID limits (E-09); re-read the Operating Agreement (E-01).

### Q-3 · To measure before relying on them

- Daily run cap of Claude Code Routines (E-10).
- What A8's servers do with a link whose `a8mat` is missing (E-06).

---

## Adding to this file

1. One entry per claim. Give the **URL, the date retrieved, the exact words or the exact command**, and the grade.
2. Say what would invalidate it and which decision depends on it.
3. Never upgrade a grade because a claim was repeated. Two blogs quoting each other are still `S`.
4. When a source is re-read and differs, **keep the old entry, add the correction beside it**, and follow the dependency to the decisions that rested on it (`CLAUDE.md` §4).
