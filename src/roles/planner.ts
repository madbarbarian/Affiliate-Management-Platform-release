/**
 * Planning.
 *
 * Produces the slate the human is asked to approve. This is the role whose
 * output a person actually reads, so it is written to be judged: every idea
 * carries the evidence behind it and the way it could fail, and the platform
 * refuses to accept an idea that cites a pattern or offer that does not exist.
 */

import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import { selectForPlanning } from "../playbook/playbook.ts";
import { coveredAngles } from "../domain/coverage.ts";
import { computePerformance } from "../domain/performance.ts";
import { ventureBrief, type Role, type RoleContext } from "../kernel/role.ts";
import { array, integer, number, object, string } from "../llm/schema.ts";
import type { Idea, Offer } from "../core/types.ts";
import { formatOffers, formatPatterns, formatPostPerformance, truncate } from "./format.ts";

export type PlanInput = {
  /** How many ideas to propose. Defaults to the venture's cadence. */
  readonly count?: number;
  /** Performance lookback for the evidence the planner is shown. */
  readonly lookbackDays?: number;
};

export type PlanOutput = { readonly ideas: readonly Idea[] };

const PLAN_SCHEMA = object({
  ideas: array(
    object({
      title: string("A working title for internal use.", { maxLength: 80 }),
      angle: string("The specific, arguable take. Not the topic."),
      targetPain: string("A sentence a real reader would recognise as their own problem."),
      promisedOutcome: string("What the reader has by the last line."),
      rationale: string("Which pattern or past post justifies this, by id, and what its numbers were."),
      risk: string("The honest way this post fails."),
      expectedEngagement: number("Your estimate of the engagement score, on the scale you were shown.", {
        minimum: 0,
      }),
      patternId: string("Id of the pattern this executes, or an empty string."),
      offerId: string("Id of the offer to attach, or an empty string for a post with nothing to sell."),
      rank: integer("1 is what you would publish first.", { minimum: 1 }),
    }),
  ),
});

type PlanResponse = {
  ideas: {
    title: string;
    angle: string;
    targetPain: string;
    promisedOutcome: string;
    rationale: string;
    risk: string;
    expectedEngagement: number;
    patternId: string;
    offerId: string;
    rank: number;
  }[];
};

export const planner: Role<PlanInput, PlanOutput> = {
  id: "planner",
  title: "企画担当 / Planning lead",
  description:
    "Proposes the day's slate of posts, each with the evidence behind it and the way it could fail.",

  async run(context: RoleContext, input: PlanInput): Promise<Result<PlanOutput, PlatformError>> {
    const { venture, config, store, clock } = context;
    const count = input.count ?? venture.cadence.ideasPerCycle;
    const lookbackDays = input.lookbackDays ?? 21;

    const offers = config.offers.filter((offer) => venture.offers.includes(offer.id) && offer.active);
    const patterns = await store.patterns.find((pattern) => pattern.ventureId === venture.id);
    // Show more patterns than ideas so there is genuine choice, but not so many
    // that the strongest evidence gets lost in a wall of candidates.
    const shortlist = selectForPlanning(
      patterns,
      Math.max(6, count),
      clock.now(),
      undefined,
      venture.cadence.postsPerDay,
    );

    const performance = await computePerformance(store, {
      ventureId: venture.id,
      nowMs: clock.now(),
      sinceMs: clock.now() - lookbackDays * 86_400_000,
      offers,
      defaultCurrency: offers[0]?.currency ?? "JPY",
    });

    const winners = performance.rows.filter((row) => row.lift >= 1);
    const losers = performance.rows.filter((row) => row.lift > 0 && row.lift < 0.7);
    // Only angles that actually went out. The prompt calls this list "already
    // covered - do not repeat these angles", so feeding it every idea ever
    // proposed burned an angle the moment it appeared on the approval screen:
    // an idea the operator liked but did not pick that day was suppressed for
    // good, because only one post a day can be picked.
    const [pastIdeas, pastDrafts, pastPosts] = await Promise.all([
      store.ideas.find((idea) => idea.ventureId === venture.id),
      store.drafts.find((draft) => draft.ventureId === venture.id),
      store.posts.find((post) => post.ventureId === venture.id),
    ]);
    const recentAngles = coveredAngles({ ideas: pastIdeas, drafts: pastDrafts, posts: pastPosts })
      .map((angle) => `- ${truncate(angle, 110)}`)
      .join("\n");

    const response = await context.llm.completeJson<PlanResponse>({
      purpose: "plan.ideas",
      tier: "primary",
      system: `${ventureBrief(venture, config)}\n\n${context.prompts.render("planner.system")}`,
      user: context.prompts.render("planner.user", {
        ideaCount: count,
        date: new Date(clock.now()).toISOString().slice(0, 10),
        patterns: formatPatterns(shortlist),
        medianScore: Math.round(performance.medianScore),
        recentPerformance: formatPostPerformance(winners),
        underperformers: formatPostPerformance(losers),
        offers: formatOffers(offers),
        recentAngles: recentAngles === "" ? "(nothing published yet)" : recentAngles,
      }),
      schema: PLAN_SCHEMA,
    });
    if (!response.ok) return response;

    if (response.value.ideas.length === 0) {
      return fail("llm", "plan.no_ideas", "The planning role returned no ideas.", { retryable: true });
    }

    const patternIds = new Set(patterns.map((pattern) => pattern.id));
    const offerById = new Map<string, Offer>(offers.map((offer) => [offer.id, offer]));
    const nowIso = clock.nowIso();
    const droppedReferences: { ideaTitle: string; kind: "pattern" | "offer"; cited: string }[] = [];

    const ideas: Idea[] = response.value.ideas
      // Sorted before it is cut. The other way round threw away whichever
      // ideas the model happened to emit last and kept its worst-ranked ones,
      // so an over-producing model was silently punished for producing.
      .sort((a, b) => a.rank - b.rank)
      .slice(0, count)
      .map((proposed, index) => {
        // A cited pattern or offer that does not exist is dropped rather than
        // carried forward; the writing role would otherwise be handed a
        // dangling reference and quietly invent something to fill it.
        const patternId = patternIds.has(proposed.patternId) ? proposed.patternId : undefined;
        const offerId = offerById.has(proposed.offerId) ? proposed.offerId : undefined;
        if (proposed.patternId && !patternId) {
          droppedReferences.push({ ideaTitle: proposed.title, kind: "pattern", cited: proposed.patternId });
        }
        if (proposed.offerId && !offerId) {
          droppedReferences.push({ ideaTitle: proposed.title, kind: "offer", cited: proposed.offerId });
        }
        return {
          id: context.ids.next("idea"),
          cycleId: context.cycleId,
          ventureId: venture.id,
          title: proposed.title,
          angle: proposed.angle,
          ...(patternId ? { patternId } : {}),
          ...(offerId ? { offerId } : {}),
          targetPain: proposed.targetPain,
          promisedOutcome: proposed.promisedOutcome,
          expectedEngagement: proposed.expectedEngagement,
          rationale: proposed.rationale,
          risk: proposed.risk,
          rank: index + 1,
        } satisfies Idea;
      });

    await store.ideas.putMany(ideas);
    // In the audit log, not only the process log: someone asking "why does this
    // idea have no pattern behind it?" has to be able to find that it once
    // cited one that did not exist.
    if (droppedReferences.length > 0) {
      await context.note(
        "role.plan.dropped_references",
        `${droppedReferences.length} idea reference(s) pointed at a pattern or offer that does not exist and were dropped.`,
        { dropped: droppedReferences },
      );
    }
    await context.note("role.plan.completed", `Proposed ${ideas.length} ideas for approval.`, {
      count: ideas.length,
      withOffer: ideas.filter((idea) => idea.offerId).length,
      medianScore: Math.round(performance.medianScore),
      createdAt: nowIso,
    });

    return ok({ ideas });
  },
};
