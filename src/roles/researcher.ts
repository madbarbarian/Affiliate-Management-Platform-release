/**
 * Research.
 *
 * Every morning: collect what travelled, keep only the shapes that look
 * reproducible, and fold them into the playbook. New shapes arrive as
 * `candidate` patterns with the swipe posts that justify them attached as
 * evidence - so when the analysis role later says a pattern is not working,
 * there is a specific claim to withdraw rather than a vibe to argue with.
 */

import { ok, type PlatformError, type Result } from "../core/result.ts";
import { engagementScore, liftVsMedian, median } from "../domain/engagement.ts";
import { withEvidence } from "../playbook/playbook.ts";
import { ventureBrief, type Role, type RoleContext } from "../kernel/role.ts";
import { array, enumOf, integer, object, string } from "../llm/schema.ts";
import type { Pattern, PatternKind, ScheduledPost, SwipeItem, SwipeReport } from "../core/types.ts";
import { formatPatterns, formatSwipeItems, truncate } from "./format.ts";

export type ResearchInput = {
  /** Only consider posts seen after this instant. */
  readonly sinceMs: number;
};

const PATTERN_KINDS = ["hook", "structure", "cta", "format", "topic"] as const;

const RESEARCH_SCHEMA = object({
  summary: string("Two or three sentences: what the field looked like today."),
  discardedCount: integer("How many collected posts you judged non-reproducible.", { minimum: 0 }),
  patterns: array(
    object({
      name: string("A short name a human would recognise, in the account's language.", { maxLength: 60 }),
      kind: enumOf(PATTERN_KINDS, "Which part of a post this pattern governs."),
      template: string("The shape, with {placeholders} naming what fills each slot."),
      whyItWorks: string("The mechanism, in terms of what the reader does. Not 'it is engaging'."),
      supportingItemIds: array(string(), {
        description: "Ids of the collected posts that evidence this pattern.",
        minItems: 1,
      }),
      mergesIntoExistingPattern: string(
        "Id of an existing playbook pattern this is a variation of, or an empty string.",
      ),
    }),
    { description: "Only patterns you believe are genuinely reproducible.", maxItems: 8 },
  ),
});

type ResearchOutput = {
  summary: string;
  discardedCount: number;
  patterns: {
    name: string;
    kind: string;
    template: string;
    whyItWorks: string;
    supportingItemIds: string[];
    mergesIntoExistingPattern: string;
  }[];
};

export const researcher: Role<ResearchInput, SwipeReport> = {
  id: "researcher",
  title: "リサーチ担当 / Research lead",
  description:
    "Collects what performed in the niche each morning and extracts only the reproducible shapes into the playbook.",

  async run(context: RoleContext, input: ResearchInput): Promise<Result<SwipeReport, PlatformError>> {
    const { venture, config, store, clock } = context;

    // 1. Collect. A channel that cannot search is not an error - most cannot.
    const collected: SwipeItem[] = [];
    const failures: PlatformError[] = [];
    for (const channelId of venture.channels) {
      const channel = context.channels.get(channelId);
      if (!channel.ok) {
        failures.push(channel.error);
        continue;
      }
      if (!channel.value.capabilities.discovery) continue;
      const channelConfig = config.channels.find((entry) => entry.id === channelId);
      const result = await channel.value.discover({
        ventureId: venture.id,
        queries: channelConfig?.research.queries ?? [venture.niche],
        minLikes: channelConfig?.research.minLikes ?? 100,
        maxItems: channelConfig?.research.maxItems ?? 40,
        since: input.sinceMs,
      });
      if (!result.ok) {
        // One channel going dark should cost that channel's input, not the day.
        context.logger.warn("discovery failed", { channel: channelId, error: result.error.message });
        failures.push(result.error);
        continue;
      }
      collected.push(...result.value);
    }

    if (collected.length === 0) {
      await context.note("role.research.empty", "No posts cleared the engagement filter.", {
        channels: venture.channels,
        failures: failures.map((failure) => failure.code),
      });
      return ok({
        capturedItems: [],
        candidatePatterns: [],
        discardedCount: 0,
        summary:
          failures.length > 0
            ? `No swipe material: every discovery-capable channel failed (${failures.map((f) => f.code).join(", ")}).`
            : "No swipe material: nothing cleared the engagement filter.",
      });
    }

    await store.swipe.putMany(collected);

    // 2. Rank, so the model reads the strongest material first.
    const ranked = [...collected].sort((a, b) => engagementScore(b.snapshot) - engagementScore(a.snapshot));
    const scores = ranked.map((item) => engagementScore(item.snapshot));
    const medianScore = median(scores);

    const existingPatterns = await store.patterns.find((pattern) => pattern.ventureId === venture.id);
    const recentPosts = await recentOwnPosts(context, 5);

    // 3. Extract.
    const response = await context.llm.completeJson<ResearchOutput>({
      purpose: "research.extract_patterns",
      tier: "primary",
      system: `${ventureBrief(venture, config)}\n\n${context.prompts.render("researcher.system")}`,
      user: context.prompts.render("researcher.user", {
        lookbackHours: Math.round((clock.now() - input.sinceMs) / 3_600_000),
        channelSummary: venture.channels.join(", "),
        itemCount: ranked.length,
        swipeItems: formatSwipeItems(ranked),
        existingPatterns: formatPatterns(existingPatterns),
        recentOwnPosts:
          recentPosts.length === 0
            ? "(this account has not published yet)"
            : recentPosts.map((post) => `- ${truncate(post.content.hook, 100)}`).join("\n"),
      }),
      schema: RESEARCH_SCHEMA,
    });
    if (!response.ok) return response;

    // 4. Fold into the playbook.
    const byId = new Map(existingPatterns.map((pattern) => [pattern.id, pattern]));
    const itemsById = new Map(ranked.map((item) => [item.id, item]));
    const nowIso = clock.nowIso();
    const created: Pattern[] = [];
    const touched = new Map<string, Pattern>();

    for (const proposed of response.value.patterns) {
      const supporting = proposed.supportingItemIds
        .map((id) => itemsById.get(id))
        .filter((item): item is SwipeItem => item !== undefined);
      // A pattern whose cited evidence does not exist is a hallucinated claim.
      if (supporting.length === 0) {
        await context.note(
          "role.research.dropped_pattern",
          `Dropped "${proposed.name}": it cited swipe items that do not exist.`,
          { name: proposed.name, cited: proposed.supportingItemIds },
        );
        continue;
      }

      const target = proposed.mergesIntoExistingPattern
        ? (touched.get(proposed.mergesIntoExistingPattern) ?? byId.get(proposed.mergesIntoExistingPattern))
        : undefined;

      let pattern: Pattern =
        target ??
        {
          id: context.ids.next("pat"),
          ventureId: venture.id,
          name: proposed.name,
          kind: toPatternKind(proposed.kind),
          template: proposed.template,
          whyItWorks: proposed.whyItWorks,
          evidence: [],
          confidence: 0.5,
          status: "candidate",
          createdAt: nowIso,
          updatedAt: nowIso,
        };

      for (const item of supporting) {
        pattern = withEvidence(
          pattern,
          {
            observedAt: item.capturedAt,
            source: "swipe",
            refId: item.id,
            liftVsMedian: liftVsMedian(engagementScore(item.snapshot), medianScore),
            note: `Observed in the swipe file${item.author ? ` from ${item.author}` : ""}.`,
          },
          clock.now(),
        );
      }

      if (target) touched.set(pattern.id, pattern);
      else created.push(pattern);
    }

    const allTouched = [...created, ...touched.values()];
    if (allTouched.length > 0) await store.patterns.putMany(allTouched);

    await context.note("role.research.completed", response.value.summary, {
      collected: collected.length,
      newPatterns: created.length,
      mergedPatterns: touched.size,
      discarded: response.value.discardedCount,
    });

    return ok({
      capturedItems: collected,
      candidatePatterns: created,
      discardedCount: response.value.discardedCount,
      summary: response.value.summary,
    });
  },
};

function toPatternKind(value: string): PatternKind {
  return (PATTERN_KINDS as readonly string[]).includes(value) ? (value as PatternKind) : "hook";
}

async function recentOwnPosts(context: RoleContext, limit: number): Promise<ScheduledPost[]> {
  const posts = await context.store.posts.find(
    (post) => post.ventureId === context.venture.id && post.status === "published",
  );
  return posts.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")).slice(0, limit);
}
