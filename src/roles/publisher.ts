/**
 * Publishing.
 *
 * Turns inspected drafts into scheduled posts: picks the slot from measured
 * data, writes the comments that will sit under the post from minute one, and
 * hands the result to the human as an ordered queue.
 *
 * This role does not send anything. Dispatch happens after the human has said
 * which order they want, which is the second and last thing they are asked to
 * do all day.
 */

import { ok, type PlatformError, type Result } from "../core/result.ts";
import { formatTimeOfDay } from "../core/clock.ts";
import { bestSlots, computePerformance } from "../domain/performance.ts";
import { DEFAULT_SLOT_MINUTES, planSlots } from "../domain/scheduling.ts";
import { shortUrl } from "../affiliate/links.ts";
import { ventureBrief, type Role, type RoleContext } from "../kernel/role.ts";
import { checkComments, type LinkContext } from "../kernel/policy.ts";
import { findMarket, resolveCompliance } from "../domain/market.ts";
import { array, enumOf, object, string } from "../llm/schema.ts";
import type { CommentDraft, CommentPurpose, Draft, ScheduledPost } from "../core/types.ts";
import { formatDraftContent, formatOffer, truncate } from "./format.ts";

export type ScheduleInput = {
  /** Drafts that cleared inspection, in the planner's ranking order. */
  readonly drafts: readonly Draft[];
};

export type ScheduleOutput = { readonly posts: readonly ScheduledPost[] };

const COMMENT_PURPOSES = ["self_reply", "faq", "objection", "link_drop"] as const;

const COMMENTS_SCHEMA = object({
  comments: array(
    object({
      purpose: enumOf(COMMENT_PURPOSES),
      text: string("The comment as it would be posted. Looser than the post itself."),
    }),
    { description: "Ordered. Skip link_drop entirely when there is no offer.", maxItems: 4 },
  ),
});

type CommentsResponse = { comments: { purpose: string; text: string }[] };

export const publisher: Role<ScheduleInput, ScheduleOutput> = {
  id: "publisher",
  title: "投稿担当 / Publisher",
  description:
    "Picks each post's slot from measured data and prepares the comments that go under it, ready for the operator's final ordering.",

  async run(context: RoleContext, input: ScheduleInput): Promise<Result<ScheduleOutput, PlatformError>> {
    const { venture, config, store, clock } = context;
    if (input.drafts.length === 0) return ok({ posts: [] });

    const offers = config.offers.filter((offer) => venture.offers.includes(offer.id));
    const performance = await computePerformance(store, {
      ventureId: venture.id,
      nowMs: clock.now(),
      sinceMs: clock.now() - 60 * 86_400_000,
      offers,
      defaultCurrency: offers[0]?.currency ?? "JPY",
    });

    // Do not double-book against posts already waiting to go out.
    const pending = await store.posts.find(
      (post) =>
        post.ventureId === venture.id &&
        (post.status === "queued" || post.status === "approved" || post.status === "scheduled"),
    );

    const capacity = Math.min(
      input.drafts.length,
      venture.cadence.postsPerDay,
      config.policy.maxPostsPerDay,
    );
    const drafts = input.drafts.slice(0, capacity);

    const slots = planSlots({
      count: drafts.length,
      measured: bestSlots(performance.rows, venture.timezone, 6),
      fallbackMinutes: DEFAULT_SLOT_MINUTES,
      nowMs: clock.now(),
      timezone: venture.timezone,
      minGapMinutes: Math.max(venture.cadence.minMinutesBetweenPosts, config.policy.minMinutesBetweenPosts),
      occupied: pending.map((post) => post.scheduledFor),
    });

    const posts: ScheduledPost[] = [];
    for (const [index, draft] of drafts.entries()) {
      const slot = slots[index];
      if (!slot) {
        context.logger.warn("no slot available, draft left unscheduled", { draftId: draft.id });
        continue;
      }

      const offer = draft.offerId ? config.offers.find((entry) => entry.id === draft.offerId) : undefined;
      const link = draft.linkId ? await store.links.get(draft.linkId) : undefined;

      const postId = context.ids.next("post");
      // The link record travels, not a URL: deciding which URL a reader sees
      // is `formatOffer`'s job and nowhere else's.
      const comments = await writeComments(context, {
        draft,
        postId,
        slotLabel: `${formatTimeOfDay(slot.minutesOfDay)} ${venture.timezone}`,
        slotReason: slot.reason,
        ...(offer ? { offerName: offer.name } : {}),
        linkContext: { issued: link, tracking: config.tracking },
      });
      if (!comments.ok) return comments;

      posts.push({
        id: postId,
        cycleId: context.cycleId,
        ventureId: venture.id,
        draftId: draft.id,
        channel: draft.channel,
        content: draft.content,
        scheduledFor: slot.at,
        slotReason: slot.reason,
        // The planner's ranking is the proposed order. The human's decision at
        // the publish gate overwrites this.
        order: index + 1,
        status: "queued",
        commentDrafts: comments.value,
        ...(draft.offerId ? { offerId: draft.offerId } : {}),
        ...(draft.linkId ? { linkId: draft.linkId } : {}),
        ...(draft.patternId ? { patternId: draft.patternId } : {}),
      });

      // Bind the link to the post now that the post has an id, so revenue
      // attribution has something to join on.
      if (link) await store.links.put({ ...link, postId });
    }

    await store.posts.putMany(posts);
    await context.note("role.schedule.completed", `Scheduled ${posts.length} post(s) for approval.`, {
      postIds: posts.map((post) => post.id),
      slots: posts.map((post) => new Date(post.scheduledFor).toISOString()),
    });

    return ok({ posts });
  },
};

async function writeComments(
  context: RoleContext,
  input: {
    draft: Draft;
    postId: string;
    slotLabel: string;
    slotReason: string;
    offerName?: string;
    /** Always passed, whether or not a link was issued. `checkComments` judges it. */
    linkContext: LinkContext;
  },
): Promise<Result<CommentDraft[], PlatformError>> {
  const { venture, config } = context;
  const offer = input.draft.offerId
    ? config.offers.find((entry) => entry.id === input.draft.offerId)
    : undefined;
  const link = input.linkContext.issued;
  // The one place in this file that turns a link into a URL. A per-offer
  // `direct` mode would have to change this line and `formatOffer` together.
  const linkUrl = link ? shortUrl(config.tracking, link) : undefined;
  // Resolved once, from the reader's market - never re-derived from
  // `policy.disclosureText`, which is the platform-wide fallback and is the
  // wrong language the moment a venture targets a market with its own wording.
  const profile = resolveCompliance({
    policy: config.policy,
    market: findMarket(config.markets, venture.market),
    ...(offer ? { offer } : {}),
  });

  const response = await context.llm.completeJson<CommentsResponse>({
    purpose: "schedule.comments",
    tier: "fast",
    system: `${ventureBrief(venture, config)}\n\n${context.prompts.render("publisher.system")}`,
    user: context.prompts.render("publisher.user", {
      post: formatDraftContent(input.draft.content),
      offer: formatOffer(offer, link, config.tracking),
      slot: input.slotLabel,
      slotReason: input.slotReason,
      disclosure: profile.disclosureText,
    }),
    schema: COMMENTS_SCHEMA,
  });
  if (!response.ok) return response;

  const drafts = response.value.comments
    .filter((comment) => comment.text.trim() !== "")
    // A link_drop with no offer is a comment with nothing in it.
    .filter((comment) => comment.purpose !== "link_drop" || Boolean(linkUrl))
    .map((comment) => ({
      id: context.ids.next("cmt"),
      purpose: toPurpose(comment.purpose),
      text: comment.text.trim(),
    }));

  // The link must actually appear in the link drop, whatever the model wrote.
  if (linkUrl) {
    const index = drafts.findIndex((comment) => comment.purpose === "link_drop");
    if (index === -1) {
      drafts.push({
        id: context.ids.next("cmt"),
        purpose: "link_drop",
        text: `${linkUrl}\n\n${profile.disclosureText}`,
      });
    } else if (!drafts[index]?.text.includes(linkUrl)) {
      const existing = drafts[index] as CommentDraft;
      drafts[index] = { ...existing, text: `${existing.text}\n\n${linkUrl}` };
    }
  }

  // Comments used to be exempt from every guardrail in policy.ts, which made
  // them the way round all of them: the link drop is where the affiliate URL
  // actually is, and a prohibited claim reads the same to a regulator whether
  // it sits in the post or in the reply beneath it.
  const checked = checkComments({
    comments: drafts,
    profile,
    policy: config.policy,
    hasOffer: offer !== undefined,
    link: input.linkContext,
  });
  for (const finding of checked.findings) {
    await context.note("comment.compliance", finding.message, { code: finding.code });
    if (finding.severity === "blocking") {
      context.logger.warn("a comment guardrail refused a comment", {
        postId: input.postId,
        code: finding.code,
      });
    }
  }

  context.logger.debug("prepared comments", {
    postId: input.postId,
    count: checked.comments.length,
    hook: truncate(input.draft.content.hook, 50),
  });
  return ok([...checked.comments]);
}

function toPurpose(value: string): CommentPurpose {
  return (COMMENT_PURPOSES as readonly string[]).includes(value) ? (value as CommentPurpose) : "self_reply";
}
