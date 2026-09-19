/**
 * Writing.
 *
 * One approved idea in, one finished post out. The role also issues the
 * tracked link before writing, so the writer can place a real URL in the text
 * rather than a placeholder someone has to remember to swap later.
 */

import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import { publishedHooks } from "../domain/coverage.ts";
import { issueLink, shortUrl } from "../affiliate/links.ts";
import { describeCompliance, findMarket, resolveCompliance, type ComplianceProfile } from "../domain/market.ts";
import { describeFormat } from "../channels/format.ts";
import { ventureBrief, type Role, type RoleContext } from "../kernel/role.ts";
import { array, object, string } from "../llm/schema.ts";
import type { Draft, DraftContent, Idea, Pattern } from "../core/types.ts";
import { formatOffer, truncate } from "./format.ts";

export type WriteInput = {
  readonly idea: Idea;
  /** Which channel this draft is written for. Defaults to the first enabled. */
  readonly channelId?: string;
};

const WRITE_SCHEMA = object({
  hook: string("Line one. Its only job is to stop the scroll."),
  body: string("The post. One person telling one story to one person."),
  cta: string("One ask, following from the post."),
  disclosure: string("The affiliate disclosure, verbatim, or an empty string when there is no offer."),
  hashtags: array(string(), { description: "At most three, or none at all.", maxItems: 3 }),
  threadParts: array(string(), {
    description:
      "Only when the post genuinely needs more than one post. Each part under the character limit. Empty otherwise.",
  }),
});

type WriteResponse = {
  hook: string;
  body: string;
  cta: string;
  disclosure: string;
  hashtags: string[];
  threadParts: string[];
};

export const writer: Role<WriteInput, Draft> = {
  id: "writer",
  title: "ライティング担当 / Writer",
  description: "Turns one approved idea into one finished post, hook first.",

  async run(context: RoleContext, input: WriteInput): Promise<Result<Draft, PlatformError>> {
    const { venture, config, store, clock } = context;
    const idea = input.idea;

    const channelId = input.channelId ?? venture.channels[0];
    if (!channelId) {
      return fail("config", "write.no_channel", `Venture "${venture.id}" has no channels configured.`);
    }
    const channel = context.channels.get(channelId);
    if (!channel.ok) return channel;

    const pattern = idea.patternId ? await store.patterns.get(idea.patternId) : undefined;
    const offer = idea.offerId ? config.offers.find((entry) => entry.id === idea.offerId) : undefined;

    // Issue the link now so the writer places a real URL, not a placeholder.
    let linkUrl: string | undefined;
    let linkId: string | undefined;
    if (offer) {
      const network = context.networks.get(offer.network);
      if (!network.ok) return network;
      const link = issueLink({
        ventureId: venture.id,
        offer,
        discriminator: idea.id,
        network: network.value,
        tracking: config.tracking,
        nowMs: clock.now(),
      });
      if (!link.ok) return link;
      await store.links.put(link.value);
      linkId = link.value.id;
      linkUrl = shortUrl(config.tracking, link.value);
    }

    const recentHooks = await recentHookList(context, 8);
    const profile = resolveCompliance({
      policy: config.policy,
      market: findMarket(config.markets, venture.market),
      ...(offer ? { offer } : {}),
    });

    const response = await context.llm.completeJson<WriteResponse>({
      purpose: "write.draft",
      tier: "primary",
      system: `${ventureBrief(venture, config)}\n\n${context.prompts.render("writer.system")}`,
      user: context.prompts.render("writer.user", {
        title: idea.title,
        angle: idea.angle,
        targetPain: idea.targetPain,
        promisedOutcome: idea.promisedOutcome,
        rationale: idea.rationale,
        risk: idea.risk,
        pattern: describePattern(pattern),
        offer: formatOffer(offer, linkUrl),
        channel: channelId,
        format: describeFormat(channel.value.capabilities.format, channel.value.capabilities.maxCharacters),
        maxCharacters: channel.value.capabilities.maxCharacters,
        disclosure: profile.disclosureText,
        compliance: describeCompliance(profile),
        recentHooks: recentHooks.length === 0 ? "(nothing published yet)" : recentHooks.join("\n"),
      }),
      schema: WRITE_SCHEMA,
    });
    if (!response.ok) return response;

    const content = normaliseContent(response.value, {
      requireDisclosure: Boolean(offer) && config.policy.requireDisclosure,
      profile,
    });

    const draft: Draft = {
      id: context.ids.next("drf"),
      ideaId: idea.id,
      cycleId: context.cycleId,
      ventureId: venture.id,
      channel: channelId,
      content,
      ...(offer ? { offerId: offer.id } : {}),
      ...(linkId ? { linkId } : {}),
      ...(pattern ? { patternId: pattern.id } : {}),
      createdAt: clock.nowIso(),
      revision: 1,
    };

    await store.drafts.put(draft);
    await context.note("role.write.completed", `Drafted "${truncate(idea.title, 60)}".`, {
      draftId: draft.id,
      ideaId: idea.id,
      offerId: offer?.id ?? null,
      parts: content.threadParts?.length ?? 1,
    });

    return ok(draft);
  },
};

/**
 * The writer is asked for the disclosure and the cross-border caveats, but the
 * platform does not rely on it remembering either. Whatever is missing is
 * filled in here; inspection then checks it survived the rewrite.
 *
 * Appending is a last resort, not the intent - a caveat welded onto the end
 * reads worse than one the writer worked into the story. It exists so the
 * reader is never the one who pays for the model having a bad day.
 */
function normaliseContent(
  response: WriteResponse,
  options: { requireDisclosure: boolean; profile: ComplianceProfile },
): DraftContent {
  const threadParts = (response.threadParts ?? []).filter((part) => part.trim() !== "");
  const body = response.body.trim();

  const declared = response.disclosure.trim();
  const lines: string[] = [];
  if (declared !== "") lines.push(declared);
  else if (options.requireDisclosure) lines.push(options.profile.disclosureText);

  for (const notice of options.profile.crossBorderNotes) {
    const trimmed = notice.trim();
    if (trimmed === "") continue;
    const alreadySaid = body.includes(trimmed) || threadParts.some((part) => part.includes(trimmed)) || declared.includes(trimmed);
    if (!alreadySaid) lines.push(trimmed);
  }
  const disclosure = lines.join("\n");

  return {
    hook: response.hook.trim(),
    body: response.body.trim(),
    cta: response.cta.trim(),
    disclosure,
    hashtags: (response.hashtags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== ""),
    ...(threadParts.length > 1 ? { threadParts } : {}),
  };
}

function describePattern(pattern: Pattern | undefined): string {
  if (!pattern) return "(no pattern - write it the way the idea demands)";
  return [
    `- name: ${pattern.name}`,
    `- template: ${pattern.template}`,
    `- why it works: ${pattern.whyItWorks}`,
    `- track record here: confidence ${pattern.confidence.toFixed(2)} over ${pattern.evidence.length} observations`,
    "",
    "Execute the shape. Do not copy the wording of the examples it came from.",
  ].join("\n");
}

async function recentHookList(context: RoleContext, limit: number): Promise<string[]> {
  // Only the ones that were published. The prompt says "Recent posts from this
  // account - do not repeat their openings", and a draft that was written and
  // never chosen is not a post: nobody has read that opening, so retiring it
  // spends a hook the account never used. The same defect the planner had with
  // angles, one layer down.
  const [drafts, posts] = await Promise.all([
    context.store.drafts.find((draft) => draft.ventureId === context.venture.id),
    context.store.posts.find((post) => post.ventureId === context.venture.id),
  ]);
  return publishedHooks({ drafts, posts }, limit).map((draft) => `- ${truncate(draft.content.hook, 90)}`);
}
