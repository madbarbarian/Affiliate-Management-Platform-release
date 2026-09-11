# Licensee guide

You have been given access to a release repository. This is how you go from
that to a running operation, and how you keep taking updates afterwards.

**There are two routes, and you only walk one.** Cloudflare is the default and
needs no server and no domain. Your own machine is the other, and everything
that follows section 1b applies to both.

---

## 1a. The short route: Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/madbarbarian/Affiliate-Management-Platform-release)

Press it. Cloudflare copies this repository into **your** GitHub account,
creates the database, asks for **one** secret, builds and deploys, and wires it
so every later push redeploys.

**Tick "Create private Git repository" on that screen.** It is off by default,
and your copy will hold your `platform.config.yaml` — your niche, your
audience, your voice. No secrets live there by design, but your strategy does,
and a public copy publishes it.

One other thing on the same screen: give the D1 database a **new** name rather
than picking an existing one, or the deploy writes into whatever that database
already holds.

The single secret is:

| | |
|---|---|
| `AMP_CONSOLE_TOKEN` | The passphrase for your approval console. **There is no generate button** — decide 20 characters or more that nobody would guess, type them in, and keep a copy; your password manager's generator is the reliable way. Without it, anyone who knows your address can open the console — the tracking redirect and the console answer on the same address. |

**No model key is asked for, and that is deliberate.** The config ships on the
simulated model, so the console opens and a whole day runs before you hold a
key or spend anything. You add it at step 4, when the proposals are worth
paying for.

You end up at `https://amp-<name>.<your subdomain>.workers.dev`. **That address
is public and free, and it is where the links in your posts point** — there is
no domain to buy and no redirect to host.

Open it. Until you have a config of your own it serves a setup page telling you
exactly what is done and what is not. Then:

1. Open your copy of the repository on GitHub.
2. Copy `platform.config.example.yaml` to `platform.config.yaml`.
3. Edit `company:` and the first entry under `ventures:` — the niche, the
   audience and the voice do more work than everything else combined. Give it
   an `id` and a `name` that say what the account *is* (`beauty`, `美容`), not
   what position it holds (`main`): the id goes into the console's addresses
   and into every record kept, so it cannot be changed later without orphaning
   the history, and the name is what you will be reading in the accounts table
   on the day there are three of them.
4. Set `tracking.baseUrl` to the address above. **Until you do, clicks are not
   recorded** and the console's 計測 column says 未完成 with the reason.
5. Commit. A minute later the setup page has become the approval console.

Costs $5/month on Workers Paid, which is a minimum charge rather than a cap —
one account running this stays well inside the included allowances, so in
practice it is $5 flat.

The free plan is not an option, though not for the reason you might expect: it
places no restriction on commercial use, and it will run a cron every minute.
What it will not do is give you more than **10 ms of CPU** per request and per
cron trigger, and a cycle spends more than that before it has finished reading
your config. It deploys, and then it fails — which is worse than refusing.
What each host costs is in [Where to run it](../4-operations/hosting.md).

**Two differences from running it yourself.** Secrets live in the Cloudflare
dashboard, not in `.env.local`. And `cycleStartsAt` is honoured to the hour,
because the heavy half of the loop runs on an hourly schedule where it is
given fifteen minutes of CPU rather than thirty seconds.

There is no terminal, so `doctor` is not available — the console's 全アカウント
table carries the same measurement check, and says what is missing.

---

## 1b. The other route: your own machine

Fork the release repository into your own account or organisation. Your fork is
yours: your config, your prompts, your operating history. Nothing you run
reports back.

```bash
git clone https://github.com/<you>/<your-fork>.git
cd <your-fork>
npm install
```

Requires Node 22.18 or newer. There is no build step.

## 2. Configure

```bash
node src/cli.ts init
```

This creates two files, both git-ignored:

- **`platform.config.yaml`** — everything about your operation. Start by
  editing the single `ventures[]` entry: the niche, the audience, and the
  voice. Those three do more work than everything else combined.
  Then check `markets:` — the shipped `jp` and `us` entries are a starting
  point, and the disclosure text and prohibited claims there are what the
  platform will actually enforce. If you promote across markets, read
  [Cross-border promotion](../7-references/cross-border.md) before you add the
  offers.
- **`.env.local`** — your secrets. A console token is generated for you; add your
  `ANTHROPIC_API_KEY`.

Then:

```bash
node src/cli.ts doctor
```

It validates the whole file and reports every problem at once.

## 3. Walk the loop before spending anything

Everything ships with simulated adapters. With `llm.provider: mock` and
`adapter: mock`, the whole day runs with no API calls and nothing published:

```bash
node src/cli.ts cycle run
node src/cli.ts pending
node src/cli.ts approve <decision-id>
node src/cli.ts console
```

Look at what comes out. This is the cheapest possible way to find out that your
`audience` field is too vague, and it costs nothing to repeat.

## 4. Turn on the model

In `platform.config.yaml`:

```yaml
llm:
  provider: anthropic
```

On Cloudflare, add the key as a secret in the same move — there is no
`.env.local` there. In the dashboard, with no terminal:

**Workers & Pages → your Worker → Settings → Variables and Secrets → Add**,
named `ANTHROPIC_API_KEY`. Or from a terminal, if you have one:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

The deploy screen does not ask for it, and that is deliberate rather than an
oversight: it treats every field it shows as required, so listing the key there
would mean nobody could deploy without inventing a value for it. The setup page
your address serves says the same thing, in case you meet this question before
you meet this guide.

Run a cycle. Now the proposals are real. Spend the first week in
`autonomy: manual` — nothing pre-selected — and pay attention to *which* ideas
you reject. Each rejection is a rule you can write into
`prompts/planner.system.md` so it stops appearing.

## 5. Connect a channel

Two supported routes:

**Native.** Set `adapter: threads` and provide a long-lived access token and
user id for a Threads professional account. Verify the current scopes and API
version against Meta's documentation; both are config
(`options.apiVersion`, `options.baseUrl`), not code.

**Webhook.** Point `adapter: webhook` at your own service, or at a Make / Zapier
/ n8n scenario you already have. This is often the faster route. The contract
is four endpoints and is documented in [Extending](../3-development/extending.md).

Run `node src/cli.ts doctor` — it health-checks credentials for real.

## 6. Host the redirect (not needed on Cloudflare)

**On Cloudflare this is already done** — your `workers.dev` address is public,
and step 1a set `tracking.baseUrl` to it. Skip to section 7.

The links in your posts point at `tracking.baseUrl`, which should be a domain
you control. The platform builds links as `<baseUrl>/go/<code>` and the console
serves that path, so `baseUrl` is your bare domain — do not add `/go` yourself.
The simplest setup is to run the daemon somewhere reachable and put your domain
in front of it:

```yaml
tracking:
  baseUrl: "https://go.yourdomain.com"
```

Until you do this, the links in your posts are dead: they point at your
redirector, not at the network, so a reader gets a 404 and no click is ever
recorded. `doctor` reports this as `measurement: INCOMPLETE` — do not start
posting for real while it says so.

## 7. Run it (not needed on Cloudflare)

**On Cloudflare the two cron triggers are already running.** Skip to the
paragraph about your day, below.

```bash
node src/cli.ts daemon
```

The daemon starts each venture's cycle at its local `cycleStartsAt`, publishes
posts when their slot arrives, collects metrics at the start of each cycle, and
serves the console. Run it under whatever keeps a process alive on your
machine — systemd, pm2, a container, a small VM. What each option costs and
what it asks of you is in [Where to run it](../4-operations/hosting.md).

The daemon reads `platform.config.yaml` once, at start. After editing it,
restart the daemon; a CLI command run meanwhile uses the new file while the
daemon still holds the old one.

Then your day is: open the console, approve, order, close the console.

## Reading the console in English

```yaml
console:
  locale: en     # ja | en
```

**Not the disclosure's language.** The disclosure, the prohibited claims and the
regulator all follow the market your *readers* are in — set per venture, resolved
in `markets:`. Reading the console in English while publishing to Japanese
readers still publishes a Japanese disclosure, because that is what 景表法 asks
for. Nothing about `console.locale` reaches a reader.

## Someone else operating it with you

Give them their own passphrase, not yours. In `platform.config.yaml`:

```yaml
console:
  tokenEnv: AMP_CONSOLE_TOKEN     # yours
  operators:
    - name: "みどり"
      tokenEnv: AMP_CONSOLE_TOKEN_MIDORI
```

and set that variable where your secrets live — `.env.local` on your own
machine, **Workers & Pages → your Worker → Settings → Variables and Secrets**
on Cloudflare. `node src/cli.ts doctor` lists everyone who can open the console
and names anyone who is listed but has no passphrase set.

**There are no roles yet.** Anyone with a passphrase can do everything you can,
including publishing. What a name buys is the record: every approval, every
account switched off, every proposal accepted is stored against the name whose
passphrase was used, and the console header says which name you are holding
before you press anything.

Do this before a second person starts, not after. **An approval cannot be
attributed later** — everything approved while one passphrase was shared is
recorded under your name, whoever actually pressed it, and no amount of work
afterwards can separate them.

Your week, once the first account has numbers, is one more look at the same
page: the 全アカウント table says which accounts are earning, which are stuck
at a gate, which are measuring nothing, and flags any that deserve a review.
Next to each is 非アクティブにする — it stops that account running without
deleting anything or touching the config, and 再開する brings it back. Below
that, when `company.exploration` is on (or after `amp scout`), the scout's
proposals for the next account wait for 採用 or 見送り; 採用 appends an inactive
`ventures[]` block to your config, with a backup in `.amp/config-backups/`.

---

## Taking updates from upstream

Your copy is set up so upstream changes never collide with your operation.
The things you edit are either kept out of the way (`.env.local`, `.amp/`) or
isolated (`prompts/`).

**`platform.config.yaml` is committed in your copy, and that is deliberate.**
On Cloudflare the build bundles it into the Worker, which has no filesystem to
read it from — a config you have not committed is one your deploy never sees.
It carries no secrets by design: it names environment variables, and the values
live in Cloudflare's dashboard or in `.env.local`. Upstream never touches that
file, so it does not conflict.

### If you came through the Deploy button — no terminal

The button **copies** this repository into your account. A copy is not a GitHub
fork, so there is no "Sync fork" button and nothing for `git merge upstream` to
merge. Your copy carries its own way instead:

**Actions → "Take updates from the platform" → Run workflow.**

A minute later there is a pull request showing exactly what changed. Read it,
merge it, and Cloudflare redeploys the way it does for any push. It also runs
itself on the first of each month, so a copy nobody touches still hears about a
fix — it opens a pull request, it never merges one.

`platform.config.yaml` is not in that pull request: your niche, your audience,
your voice and your accounts are yours. Your secrets are in Cloudflare's
dashboard, not in the repository, so there is nothing there to disturb either.

**Read `CHANGELOG.md` in the diff before merging.** It is written for exactly
that moment.

### If you cloned it yourself

```bash
git remote add upstream https://github.com/<owner>/<release-repo>.git
git fetch upstream
git merge upstream/main
npm install
node src/cli.ts doctor
```

If you have edited files in `prompts/`, a release that also edits them will
conflict there and nowhere else. Two ways to avoid even that:

- Point `runtime.promptsDir` at a directory of your own (`prompts-mine/`) and
  copy the shipped prompts into it. Upstream then never touches your prompts.
- Or keep your prompt edits on a branch and rebase them onto each release.

Read the release notes before merging. Any release that changes
`platform.config.yaml`'s schema says so, and `doctor` will tell you exactly
which fields need attention.

---

## What you are responsible for

The platform enforces what it can in code — the disclosure, the prohibited
claims, the posting caps. It cannot know your jurisdiction, your network's
contract, or your platform's terms of service.

Before you run this against a live account, satisfy yourself about:

- **Disclosure rules where you operate.** `policy.disclosureText` must be
  something a regulator in your market accepts. In Japan, that means 景品表示法
  and the stealth-marketing rules; elsewhere, the FTC endorsement guides or
  their local equivalent.
- **Your affiliate network's terms.** Some prohibit specific claim types,
  some prohibit particular traffic sources, some require pre-approval of
  creative. Put every one of them in that offer's `complianceNotes` — they
  reach the inspection role as constraints it must honour.
- **Your channel's automation policy.** Posting through an API on your own
  account is normally fine; check the current terms for the platform you are
  posting to.
- **What `autonomy: auto` means for you.** The code guardrails still hold, but
  nobody is reading the posts before they go out. That is a decision about your
  exposure, not just your time.

## Getting help

- `node src/cli.ts doctor` — config, credentials, adapters
- `node src/cli.ts cycle status` — where today got to and why it stopped
- `.amp/audit.jsonl` — every action the company took, newest last
- `.amp/*.json` — the state itself, in plain readable JSON
