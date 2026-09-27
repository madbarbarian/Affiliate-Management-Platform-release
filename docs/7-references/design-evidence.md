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
- 🔴 **Largely resolved (2026-09-27), see E-19.** This prohibition is about extracting the link out of the **HTML ad code** ("通常広告用") without authorization. A8 ships a **separate, dedicated link-only feature for SNS posting** ("SNS・note用") that is explicitly link-only by design. Posting only a link on Threads through that feature is not the case this rule describes. The remaining open question narrowed from "is link-only content allowed at all" to the redirect question in E-03/Q-1.

### E-03 · A8.net: no explicit ban on redirects, shortened URLs or intermediate pages found

- **Grade:** A (`prohibited-matter.php` and https://support.a8.net/a8/as/faq/manual/how_to_post.php, 2026-09-26; also `media-userpolicy.php` §8.1.12 on 2026-09-22 with zero hits for リダイレクト／転送／短縮; **extended 2026-09-27** to the SNS-specific pages in E-19 — same zero hits)
- **Consequence:** unresolved. **Silence is not permission.** Amazon, by contrast, states the ban and the consequence.
- **Depends on:** keeping `redirect` as the default link mode while A8 is unanswered.
- **Sharper after E-19 (2026-09-27):** A8's own SNS-only link already has a stated tracking limitation — E-19 quotes it as unable to fully capture referrer, varying by platform. Putting our own `/go/` redirect in front of a link that already has irregular referrer behaviour is a second, compounding unknown, not a resolved one. This raises the stakes of Q-1, it does not answer it.

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

### E-19 · A8.net ships an official, link-only posting feature for SNS, and names Threads by name

- **Grade:** P (all four pages fetched and read directly by the parent, 2026-09-27, `get_page_text` — raw extraction, not a summary)
- **Sources:**
  - https://support.a8.net/a8/as/faq/2022/post_1955.html ("SNSに広告を掲載できますか？")
  - https://support.a8.net/a8/as/faq/2026/post_2971.html ("SNS・note投稿用リンクに関する注意事項")
  - https://www.a8.net/as/sns/ ("A8.net SNSアフィリエイトガイドライン")
  - https://www.a8.net/as/Instagram/ ("Instagramを使ったアフィリエイトガイド", the link-creation steps apply platform-agnostically)
- **What it says:**
  - Supported SNS list, verbatim, includes Threads: 「Instagram／YouTube／TikTok／X／Threads／Pinterest／note」.
  - Two officially named methods of SNS affiliating: 「投稿にアフィリエイトリンクを直接掲載する方法」and「SNSを利用して集客を行い、アフィリエイトサイトへ誘導する方法」 — posting the affiliate link directly on the post is one of the two sanctioned methods, not a workaround.
  - A dedicated link-creation tab, **「SNS・note用」**, distinct from **「通常広告用」** (the HTML ad code used on a blog/website). Quote: 「コピーされるのはリンクのみで、HTMLコードは含まれません。」 — link-only output is the intended, designed behaviour of this feature, not an improvised trimming of the HTML ad code.
  - A separate link must be generated per destination SNS: 「リンクは掲載するSNSごとに作成してください」.
  - Two stated limitations of links made this way: (a) referrer capture is incomplete and varies by platform — 「SNS・note投稿用リンクでは、リファラ（流入元）を完全に取得することができません」; (b) impression counts do not appear in reports for links from this feature — 「本機能で発行したリンクを利用した場合、レポートにインプレッション数は反映されません」. Clicks/conversions are not stated as affected — only referrer detail and impressions.
  - Only stated prohibition specific to SNS use: private/access-restricted posting — 「外部非公開又は閲覧制限のある環境での利用は、禁止しております」. A public Threads post does not fall under this.
  - PR-labelling and 広告掲載URL submission are required regardless of link-only or full-code use, and explicitly apply even to posts with **no link at all** (a review or a mention driving traffic elsewhere) — 「アフィリエイトリンクの有無に関わらず…」.
- **Consequence:** narrows E-02 (see the correction there) — link-only content on Threads, made through this feature, is a sanctioned use case, not the prohibited "link part only" extraction. This was the larger of the two original worries in the inquiry drafted 2026-09-26; it is now answered from a primary source, so Q-1's old question 2 is dropped from the enquiry (see revised Q-1).
- **Does not say anything about:** the redirect question (E-03/Q-1) — none of these four pages mentions a redirect, shortener, or intermediate domain, in either direction.
- **Invalidated by:** any of these four pages changing; re-fetch before relying on this for a licensee-facing claim.

### E-20 · The advertising-URL-submission form takes a list of URLs, and individual SNS posts are explicitly not treated as a shared display area

- **Grade:** P (fetched and read directly, 2026-09-27)
- **Sources:**
  - https://www.a8.net/compliance/prNotation-urlSubmission.php ("PR等の表記と広告掲載URLのご提出について")
  - https://support.a8.net/a8/as/faq/manual/ad_url_manage.php ("広告掲載URL管理の使い方")
- **What it says:** submission is per affiliate program, and the form itself accepts **up to 100 URLs per submission**, or up to ~10,000 via a CSV upload — built for many individual URLs, not one URL per program. A published FAQ on the same page draws the one case where a *single* representative URL is enough: 「Webサイトの共通表示エリア…同一ドメインでの全ページ共通表示エリアへ…掲載している場合」（a sidebar or header repeated identically across every page of one site）. The same page separately states that the PR-labelling duty applies per act of promotion, explicitly including 「SNS上での自身の運営サイト・メディアへの誘導や、商品レビュー等」 — each such post is being treated as its own instance, not folded into a site-wide "common area".
- **Consequence:** a Threads post is a discrete URL, not a "common display area" repeated across pages of one site — the shared-area exception does not obviously extend to it. The evidence leans toward **each individual post's URL needing its own submission**, though no page says the words "one row per SNS post" outright.
- **Depends on:** answers Q-1's old question 3 (dropped from the revised enquiry below); still worth confirming with A8 support if volume ever makes 100-or-10,000-per-submission a real constraint.
- **Invalidated by:** an A8 reply saying otherwise; either page changing.

### E-21 · A8.net advertises 27,000+ advertisers, dated

- **Grade:** P (fetched 2026-09-27) — https://www.a8.net/as/Instagram/: 「A8.netは累計で27,000社を超える広告主が...出稿しているASPです。※2026年9月現在」. Marketing copy, not a design input; recorded only because it is dated and could be cited if scale ever matters to a decision.

### E-22 · Not reached in this pass (flagged, not guessed)

- **Grade:** A (2026-09-27) — the "注意事項・禁止事項" tab specific to the Instagram guide did not visibly switch content when clicked (tooling limitation, not a content finding); Hootsuite's and Later's actual approval screens (see E-15) remain unverified; A8's 成果データ連携API manual (E-08) remains unread.

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

### E-14 · Buffer and Metricool dashboards (superseded by E-15–E-18 below)

- **Grade:** observed by eye, 2026-09-25 (`buffer.com/insights`, `metricool.com`); **no screenshots were saved.** Patterns noted: a label → number → coloured delta stack for headline figures; icon + short label navigation; channel identity shown by a small platform badge; soft card backgrounds with one dark colour reserved for primary buttons.
- **Use:** inspiration only. Decisions taken from it are in `visual-polish-proposal.md`.
- 🔴 **Correction (2026-09-27):** this entry was graded on memory of eyeballing, with nothing saved. A second pass (E-15–E-18) re-visited these two sites plus four more, saved screenshots, and — for the two claims below load-bearing enough to matter — the parent opened the saved screenshot directly rather than trusting the sub-agent's description. Kept here so the earlier, weaker pass is on record rather than silently replaced.

### E-15 · Six competitor sites give a "needs approval" queue its own named place, separate from the routine calendar (confirmed, screenshot-verified)

- **Grade:** P (screenshots taken 2026-09-27 of live marketing pages; **the two claims below were opened and read directly by the parent**, not taken on the sub-agent's word — the rest of this entry's sites were not independently re-opened)
- **Sprout Social** — `sproutsocial.com`, screenshot verified by the parent: the Publishing sidebar lists `New post / Calendar / Sprout queue / Drafts / Needs approval / Rejected / Campaigns` as separate items — "Needs approval" is its own line, not folded into Calendar or a general feed.
- **Publer** — `publer.com`, screenshot verified by the parent: the Collaborate screen has two side-by-side filters, "Scheduled" and "Pending Approve", and a post card with three actions — red "Decline", neutral "Edit", green filled "Approve".
- **Not independently re-opened by the parent** (sub-agent's report only): Buffer (`buffer.com/insights` — headline stats as label → bold number → coloured delta arrow; a "Top channels" list with small colour-square platform icon + name; a channel sidebar with avatar + small circular platform-logo badge overlaid at the corner), Metricool (`metricool.com` — icon+label top nav; a multi-channel line chart with a coloured-dot legend per platform), Hootsuite (`hootsuite.com/platform/analytics` — a small platform icon inline in each metric card's own title, e.g. "📷 Post reach"; an "18 Social Networks" filter; **no screenshot of an actual approval-workflow screen was found**, only prose), Later (`later.com/social-media-scheduler/` — header avatars with a brand-colour ring + small dark platform-icon badge at bottom-right + a checkmark badge top-right; **the linked "Approvals" pages 404'd, so that screen is unverified**).
- **Consequence:** the console's existing decision to give judgment items ("承認待ち"/gates) their own visually distinct treatment (`console-ux-proposal.md` §4.3/§4.4, shipped) is independently corroborated by real, screenshotted competitor UI — at least two competitors do the same thing, not as inspiration copied from them but as convergent confirmation after the fact.
- **Does not say anything about:** whether an *empty* approval queue should be hidden entirely (`console-ux-proposal.md` §6.1, still unshipped) — no marketing page from any of the six sites showed an empty state, so this evidence is silent on that specific question.
- **Invalidated by:** a redesign of any of these products; re-fetch before citing again.

### E-16 · Channel identity is shown as a small badge overlaid on an avatar, not a bare monogram in text (weak analogy to our case)

- **Grade:** P\* (sub-agent's report on saved screenshots; not independently re-opened by the parent)
- **Pattern:** Buffer (sidebar avatars), Later (header avatars), Publer (post-card avatar) all pair a profile picture with a small circular platform-logo badge at one corner — three sites, one consistent shape.
- **Why it's a weak analogy for us:** all three pair the badge with an actual photo/avatar. This platform's "account" is a venture/niche, not a person or a branded profile picture — there is no avatar for the badge to sit on. The owner's monogram-chip idea (`visual-polish-proposal.md` §4) is not confirmed or refuted by this; the direct comparison doesn't transfer.
- **Consequence:** do not cite this entry as "competitors validate the chip design" — it validates only the general idea that channel identity is shown visually, not the specific chip form.
- 🔴 **Correction (2026-09-27, same day):** the first version of this entry stopped at "weak analogy" and left it there. That undersold it. Hootsuite's pattern (E-15's list) is a *different* shape from Buffer/Later/Publer's: a small platform icon **inline in text, with no avatar at all** ("📷 Post reach"). That is exactly the shape `visual-polish-proposal.md` §4.2–4.3 already specified for us — a monogram in a `.chip` pill, no avatar involved — and it has shipped nowhere in this product yet (confirmed: no icon, badge, or monogram appears anywhere in the current `amp-test` screens, checked 2026-09-27). So the evidence, read correctly, is: the no-avatar icon-in-label shape is directly comparable and unremarkable among competitors (Hootsuite ships it); the avatar-badge shape is not comparable (no avatar exists here). Framing this as "not confirmed either way" buried a real, applicable data point under a caveat about a shape nobody proposed building.

### E-17 · Green = affirmative action, on an Approve button

- **Grade:** P (parent-verified screenshot, Publer, 2026-09-27 — see E-15) — the "Approve" button is filled green, "Decline" is a lighter/red tone, "Edit" is neutral grey.
- **Consequence:** reinforces, rather than originates, the console's own already-shipped rule that green marks "waiting on you" (`console-ux-proposal.md` §4.3). External confirmation after the fact, not the source of the decision.

### E-18 · Iconosquare was not visited

- **Grade:** A (2026-09-27) — time budget was spent on the other six sites; nothing here should be read as "Iconosquare has no such pattern."

---

## D. Open questions and the enquiry to send

### Q-1 · Enquiry to A8.net support (owner sends; text below is ready to paste)

Revised on 2026-09-26 after reading E-05 (added the parameter-export question). **Revised again on
2026-09-27 after E-19/E-20: dropped the old questions 2 and 3 — both are now answered from A8's own
SNS-affiliate pages, not from this enquiry.** Old Q2 ("is link-only content a violation") is resolved:
A8 ships a dedicated link-only feature for exactly this ("SNS・note用", E-19), naming Threads by name.
Old Q3 ("is URL registration per post") is answered closely enough (E-20) not to need asking. What
remains genuinely unanswered by any primary source is the redirect question — now sharper, because
E-19 shows A8's own SNS link already has irregular referrer capture, so our own redirect in front of it
is a second, compounding unknown, not a smaller one.

> 貴社の広告主の商品を、SNS（Threads）の投稿でご紹介する予定です。次の2点を教えてください。
>
> 1. 貴社の「SNS・note用」機能で発行した成果測定リンクを、自社ドメインの中継URL（例：`https://自分のドメイン/go/xxxx`。アクセスを1回記録してから、そのまま貴社のリンクへ即座に転送するのみ）経由で読者に届ける形式は、認められますか。「アフィリエイトリンクのリダイレクトはご遠慮ください」というご案内を見かけたのですが、これは禁止でしょうか。認められない場合、成果は承認されないのでしょうか。なお、このリンクは元々リファラを完全には取得できないとヘルプに記載されていましたが、中継を挟むことでさらに取得できる情報が変わる可能性はありますか。
> 2. パラメータ計測（`id1`〜`id5`）の集計結果は、CSVまたはAPIで取得できますか。また、パラメータ別のクリック数は確認できますか。

**Superseded questions (kept for the record, not sent):**

> ~~2. SNSの投稿には広告コードの画像タグ（1pxのトラッキング画像）を含められず、リンクのみを載せる形になります。禁止事項にある「広告コードからリンク部分のみを使用すること」に該当しますか。~~ → answered by E-19: A8's own "SNS・note用" feature is designed to output link-only.
> ~~3. 「広告掲載URL管理」への登録は、SNSの個別の投稿URLごとに必要ですか。~~ → answered closely enough by E-20: the form is built for many URLs per program, and the one named exception (a site-wide common display area) does not describe an individual SNS post.

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
