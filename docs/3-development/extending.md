# Extending the platform

Four seams. Each is one file plus one line in a registry.

---

## Adding a channel

A channel is anywhere the company posts. Implement `Channel` from
`src/channels/channel.ts`:

```ts
import { ok, type PlatformError, type Result } from "../core/result.ts";
import type { Channel, ChannelFactoryContext } from "./channel.ts";

export function createMyChannel(context: ChannelFactoryContext): Channel {
  return {
    id: context.id,
    adapter: "mychannel",
    capabilities: {
      format: "short",          // short | thread | longform - the writer is told
      nativeScheduling: false,  // can the platform hold a post until a time?
      threads: true,            // can a post be multi-part?
      discovery: true,          // can we search it for the swipe file?
      comments: true,
      maxCharacters: 500,
    },
    async discover(request) { /* → SwipeItem[] */ },
    async publish(request) { /* → { externalId, url?, scheduled } */ },
    async comment(request) { /* → { externalId } */ },
    async metrics(externalIds) { /* → Record<externalId, EngagementSnapshot> */ },
    async healthCheck() { return ok("connected as @…"); },
  };
}
```

Register it in `src/channels/index.ts`:

```ts
export const builtinChannelFactories: Record<string, ChannelFactory> = {
  mock: createMockChannel,
  threads: createThreadsChannel,
  webhook: createWebhookChannel,
  mychannel: createMyChannel,   // ← here
};
```

Then use `adapter: mychannel` in config.

Notes that will save you a debugging session:

- **`nativeScheduling: false` is the safe default.** The daemon then holds the
  post and publishes at the slot. Set it true only if the platform itself
  queues, and return `scheduled: true` from `publish` when it did.
- **`discovery: false` is fine.** Most channels cannot be searched. The
  research role just gets less material.
- **Never throw.** Return `Result`. A channel going dark should cost that
  channel's input, not the day.
- **Mark rate limits and 5xx as `retryable: true`** in the error you return.

---

## The webhook contract

If you would rather not write an adapter, `adapter: webhook` speaks to your own
service (or a Make / Zapier / n8n scenario). Four `POST` endpoints, all JSON in
and JSON out, all optional except `publish`.

Configure them under `options`, and set `credentialEnv.token` for a bearer
token that will be sent as `Authorization: Bearer …`.

### `publishUrl`

```jsonc
// request
{
  "postId": "post_abc",
  "ventureId": "main",
  "scheduledFor": "2026-04-01T12:15:00.000Z",  // or null
  "content": {
    "hook": "…", "body": "…", "cta": "…",
    "disclosure": "#PR", "hashtags": [], "threadParts": null
  }
}
// response
{ "externalId": "12345", "url": "https://…", "scheduled": false, "publishedAt": "…" }
```

`externalId` is required — it is how metrics and comments find the post later.

### `metricsUrl`

```jsonc
// request
{ "externalIds": ["12345", "12346"] }
// response
{ "12345": { "impressions": 8200, "likes": 310, "replies": 22, "reposts": 9, "saves": 40, "linkClicks": 55 } }
```

Only `likes`, `replies` and `reposts` are required; the rest improve scoring.

### `commentUrl`

```jsonc
// request  { "parentExternalId": "12345", "text": "…" }
// response { "externalId": "12399" }
```

### `discoverUrl`

```jsonc
// request
{ "queries": ["副業"], "minLikes": 300, "maxItems": 40, "since": "2026-03-31T…" }
// response
{ "items": [
    { "id": "…", "text": "…", "author": "…", "url": "…", "capturedAt": "…",
      "metrics": { "likes": 900, "replies": 40, "reposts": 25 } }
] }
```

The affiliate-network webhook adapter follows the same pattern — see
`options.offersUrl` and `options.conversionsUrl` in `src/networks/webhook.ts`.

---

## Adding an affiliate network

Try `adapter: csv` first. Most consumer networks give publishers a report to
download rather than an API, and the shipped CSV adapter reads it — column
mapping, Shift_JIS, Japanese dates, and deduplication by the network's own
order id. See [Configuration](../7-references/configuration.md#the-csv-adapter).

If your network genuinely has an API worth speaking natively, implement
`OfferNetwork` from `src/networks/network.ts` and register it in
`src/networks/index.ts`. Three methods matter:

- `fetchConversions(sinceIso)` → conversions keyed by the **sub-id** the
  platform put on the link. That sub-id is the whole attribution chain.
- `buildTrackedUrl({ landingUrl, subId })` → the network's tracked URL. Most
  networks just take a query parameter, which is what the default does.
- `listOffers()` → return `[]` if there is no catalogue API. Nothing calls it
  yet: every role reads offers from config, so a catalogue is informational
  until an import command exists.

---

## Adding a role

A role is one job. Write `src/roles/legal.ts`:

```ts
import { ok, type PlatformError, type Result } from "../core/result.ts";
import { ventureBrief, type Role, type RoleContext } from "../kernel/role.ts";
import { object, string } from "../llm/schema.ts";

export type LegalInput = { readonly draft: Draft };
export type LegalOutput = { readonly cleared: boolean; readonly reason: string };

export const legal: Role<LegalInput, LegalOutput> = {
  id: "legal",
  title: "法務担当 / Legal reviewer",
  description: "Checks each draft against the offer's contractual constraints.",
  async run(context: RoleContext, input: LegalInput) {
    const response = await context.llm.completeJson<LegalOutput>({
      purpose: "legal.review",
      tier: "primary",
      system: `${ventureBrief(context.venture, context.config)}\n\n${context.prompts.render("legal.system")}`,
      user: context.prompts.render("legal.user", { draft: /* … */ }),
      schema: object({ cleared: /* … */, reason: string() }),
    });
    if (!response.ok) return response;
    await context.note("role.legal.completed", response.value.reason);
    return ok(response.value);
  },
};
```

Then:

1. Add `prompts/legal.system.md` and `prompts/legal.user.md`.
2. Export it from `src/roles/index.ts` and add it to `roster`.
3. Add a `CycleStep` in `src/core/types.ts`, put it in `CYCLE_STEPS`, give it a
   slot in `CycleArtifacts`.
4. Handle it in the `switch` in `src/kernel/orchestrator.ts`, and add it to
   `STEP_ORDER` in the position it should run.

The orchestrator's step order is the org chart. Two lists still need the new
name by hand: `CYCLE_STEPS` in `src/core/types.ts` (what `--until` accepts) and
the role-name list `doctor` checks prompts against in `src/cli.ts`.

---

## Adding a gate

Gates are decisions a human resolves. `src/kernel/approvals.ts` handles
creation, resolution and auto-resolution generically; the orchestrator's
`gate()` function is where a new one is wired in. Follow the shape of
`buildProposalDecision` — build `DecisionItem[]` with a `recommended` flag and
enough `detail` for someone to decide without opening anything else.

Keep the count low. The platform's promise is two decisions a day; a third
needs to earn its place.

---

## Replacing storage

Implement `Store` from `src/storage/store.ts`. It is deliberately narrow — a
keyed collection with predicate search, plus an append-only audit log — so a
Postgres, D1 or Supabase adapter is one file.

Wire it in `src/runtime.ts`, which is the only place storage is constructed.

The shipped JSON adapter is sized for a single operator running a handful of
accounts. If you are running dozens, or across more than one machine, that is
the signal to replace it.

---

## Changing what a role pays attention to

Do not fork the code. Edit `prompts/<role>.system.md`.

To keep your edits clear of upstream updates entirely, point
`runtime.promptsDir` at a directory of your own and copy the shipped prompts
into it.
