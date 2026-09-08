# Terms of Service — template for Tier 3

> **This is a drafting checklist, not a contract, and it has not been reviewed
> by a lawyer.** Take it to counsel before you put it in front of anyone.
>
> Use it when you — a licensee running this Platform — let *other people*
> operate accounts on your instance. That is the third tier of the licence
> structure described in `LICENSE`: you are the operator, they are tenants.
> Your own master licence must carry the tenant clause first, and you cannot
> grant a tenant more than you were granted.
>
> If you only run your own accounts, you do not need this file at all.
>
> **Not yet:** the current version keeps one store and one console token for
> every account, so tenants cannot be told apart in the audit trail (open item
> 11 in `docs/1-requirements/requirements.md`). Do not put tenants on an
> instance until that is built.

Everything in `[SQUARE BRACKETS]` is a decision only you can make.

---

## 1. What the tenant is getting

Name the service, and be precise about what it is: an automated system that
drafts and publishes social content and promotes affiliate offers on the
tenant's own accounts, under the tenant's own affiliate network agreements.

State plainly what it is **not**: it is not a managed service, you are not
writing their content, and you are not their agency.

## 2. Accounts and credentials

- The tenant connects their own channel accounts and their own affiliate
  network accounts. Those relationships are between the tenant and those
  platforms, not with you.
- The tenant is responsible for keeping their credentials valid, and for any
  action taken by the Platform using them.
- Say what you do with the credentials they give you, where you store them, and
  what happens to them on termination.

## 3. Content and approval

This is the clause that matters most, because the Platform generates content.

- **Content is AI-generated and may be wrong.** Say it in those words. It may
  be inaccurate, may misstate a product, and may resemble text published
  elsewhere.
- **The tenant approves what publishes.** Under `autonomy: manual` or
  `assisted`, nothing goes out without a human decision. Under `auto`, the
  tenant has chosen to publish without reading first, and that choice is
  theirs — make the terms say so explicitly, because it is the case you will
  actually be argued with about.
- **The tenant is responsible for everything published from their accounts**,
  whoever or whatever drafted it. Say that whatever rights exist in AI-drafted
  text belong to the tenant *to the extent the law recognises them* — in some
  jurisdictions machine-generated text attracts no copyright at all, so do not
  promise ownership you cannot deliver.
- Reserve the right to suspend a tenant whose content puts your instance, your
  own accounts, or your other tenants at risk.

## 4. Compliance

- The tenant is responsible for advertising-disclosure law in every market they
  operate in, and for the terms of every affiliate network and channel they
  connect.
- The Platform enforces the rules recorded in its configuration. It cannot know
  a rule that was never entered. Say who is responsible for entering them —
  and if that is you, price it accordingly, because it is real work with real
  exposure.
- Prohibited uses: name the categories you will not host. [ADULT? GAMBLING?
  CRYPTO? MEDICAL? MLM? DEBT?] Each of these is a category where a regulator or
  a channel is materially more likely to take an interest in your instance.

## 5. Fees

Whichever of these you configure in `licensing:` must match what the terms say:

- **Subscription** — `[AMOUNT]` per `[PERIOD]` per venture, in `[CURRENCY]`.
  Owed whether or not anything converted.
- **Revenue share** — `[RATE]%` of *approved* affiliate revenue. Define
  precisely: approved by the network, not pending; gross of the tenant's own
  costs; reported per currency and never converted.
- Say when statements are issued, how disputes are raised, and what a lapse in
  payment does. The `amp statement` command produces the arithmetic; it is not
  an invoice and applies no tax.

## 6. Data

- What operating data you hold (drafts, posts, metrics, conversion records).
- Whether the tenant can export it, and how. The Platform keeps it as plain
  JSON under `.amp/`, so "a copy of your account's records as JSON files" is a
  promise you can keep.
- What is deleted on termination, and when.
- Whether you use tenant data to improve the service. If you do, say so.

## 6a. Switching an account off, and the stop

Two things you can do to a tenant's account without deleting anything, and the
terms should say when you will:

- **Deactivation** (`amp venture deactivate`, or the console). Nothing runs or
  publishes for that account; its playbook, history and revenue stay; you can
  switch it back on. Say what triggers it — non-payment, a review flag, a
  complaint — and what notice the tenant gets.
- **The stop** (`amp pause`). Everything on the instance halts at once. Say
  that you may use it without notice when you judge the instance, your own
  accounts or other tenants to be at risk, and that posts a channel's own
  scheduler already accepted still go live there.

## 7. Availability

Say what you actually promise. If the honest answer is "no uptime commitment",
write that; a promise you cannot keep is worse than no promise. If you do
commit to something, state what a breach entitles them to.

## 8. Liability

- Disclaim warranties, in the same terms as `LICENSE`.
- **Cap your liability.** A common shape is the total fees the tenant paid in
  the preceding `[3]` months. Without a cap, a single suspended account or a
  reversed commission run is an unbounded claim against you.
- Exclude indirect, incidental and consequential loss — expressly including
  lost affiliate revenue, account suspension, and regulatory penalties.
- Say what the tenant indemnifies you for: content they approved, claims from
  their networks or channels, and their own breach of these terms.

## 9. Termination

- Notice period, on both sides.
- What happens to scheduled-but-unpublished posts. (The Platform cancels
  anything unapproved; say what you do with what *is* approved.)
- Survival: which clauses outlive the agreement.

## 10. Governing law

`[JURISDICTION]`, and how disputes are resolved.

---

## Before you use this

- [ ] Reviewed by a lawyer in your jurisdiction
- [ ] The fee clause matches `licensing:` in `platform.config.yaml`
- [ ] The prohibited-category list matches what your `markets:` config actually
      refuses
- [ ] Consistent with the master distribution agreement you signed — you cannot
      grant a tenant more than you were granted
