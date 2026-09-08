/**
 * Analysis.
 *
 * This is the role that makes the operation compound. It pulls fresh numbers,
 * ties revenue back to the posts that earned it, and then does the thing that
 * matters most: attaches what actually happened to the patterns that claimed
 * it would, and re-scores them. A pattern that stops earning its keep is
 * retired here, and the planning role never sees it again.
 *
 * It runs first in the cycle, before research and planning, so today's plan is
 * made from yesterday's evidence rather than last week's.
 */

import { formatTimeOfDay } from "../core/clock.ts";
import { ok, type PlatformError, type Result } from "../core/result.ts";
import { hoursBetween } from "../domain/engagement.ts";
import { bestSlots, computePerformance } from "../domain/performance.ts";
import { rescorePatterns, withEvidence } from "../playbook/playbook.ts";
import { formatMoney, resolveConversions, totalCounts } from "../affiliate/attribution.ts";
import { ventureBrief, type Role, type RoleContext } from "../kernel/role.ts";
import { object, string } from "../llm/schema.ts";
import type { AnalysisReport, ConversionEvent, Pattern, PatternId, ScheduledPost } from "../core/types.ts";
import type { StoredMetric } from "../storage/store.ts";
import { metricId } from "../storage/store.ts";
import { formatPostPerformance, truncate } from "./format.ts";

export type AnalyzeInput = {
  /** How far back to look when re-scoring. Defaults to 21 days. */
  readonly lookbackDays?: number;
};

const ANALYSIS_SCHEMA = object({
  summary: string("Three sharp observations at most. Say where the evidence is thin."),
  stopDoing: string("The one thing the account should stop, or an empty string if nothing is clear yet."),
  tryNext: string("What the planning role should try tomorrow, and why."),
});

type AnalysisResponse = { summary: string; stopDoing: string; tryNext: string };

export const analyst: Role<AnalyzeInput, AnalysisReport> = {
  id: "analyst",
  title: "分析担当 / Analyst",
  description:
    "Refreshes metrics and revenue, then re-scores the playbook so tomorrow's plan is made from yesterday's evidence.",

  async run(context: RoleContext, input: AnalyzeInput): Promise<Result<AnalysisReport, PlatformError>> {
    const { venture, config, store, clock } = context;
    const lookbackDays = input.lookbackDays ?? 21;
    const nowMs = clock.now();
    const offers = config.offers.filter((offer) => venture.offers.includes(offer.id));
    const defaultCurrency = offers[0]?.currency ?? "JPY";

    await refreshMetrics(context);
    const revenueImport = await importConversions(context);

    const performance = await computePerformance(store, {
      ventureId: venture.id,
      nowMs,
      sinceMs: nowMs - lookbackDays * 86_400_000,
      offers,
      defaultCurrency,
    });

    // Attach what happened to the pattern that claimed it would.
    const patterns = await store.patterns.find((pattern) => pattern.ventureId === venture.id);
    const byId = new Map<PatternId, Pattern>(patterns.map((pattern) => [pattern.id, pattern]));
    for (const row of performance.rows) {
      if (!row.post.patternId || row.lift <= 0) continue;
      const pattern = byId.get(row.post.patternId);
      if (!pattern) continue;
      byId.set(
        pattern.id,
        withEvidence(
          pattern,
          {
            observedAt: row.post.publishedAt ?? clock.nowIso(),
            source: "own_post",
            refId: row.post.id,
            liftVsMedian: row.lift,
            note: `Own post, ${row.lift.toFixed(2)}x median${row.revenue ? `, ${row.revenue.conversions} conversions` : ""}.`,
          },
          nowMs,
        ),
      );
    }

    const rescored = rescorePatterns([...byId.values()], nowMs);
    if (rescored.patterns.length > 0) await store.patterns.putMany(rescored.patterns);

    const slots = bestSlots(performance.rows, venture.timezone, 4);
    const counts = totalCounts(performance.totals.values());

    const summary = await context.llm.completeJson<AnalysisResponse>({
      purpose: "analyze.summary",
      tier: "fast",
      system: `${ventureBrief(venture, config)}\n\n${context.prompts.render("analyst.system")}`,
      user: context.prompts.render("analyst.user", {
        date: new Date(nowMs).toISOString().slice(0, 10),
        postCount: performance.rows.length,
        medianScore: Math.round(performance.medianScore),
        postPerformance: formatPostPerformance(performance.rows),
        statusChanges: describeStatusChanges(rescored, byId),
        clicks: counts.clicks,
        conversions: counts.conversions,
        approvedRevenue: formatMoney(performance.totals, "approvedRevenue"),
        pendingRevenue: formatMoney(performance.totals, "pendingRevenue"),
        bestSlots:
          slots.length === 0
            ? "(not enough published posts to say)"
            : slots
                .map(
                  (slot) =>
                    `- ${formatTimeOfDay(slot.minutesOfDay)} — ${slot.averageLift.toFixed(2)}x over ${slot.samples} post(s)`,
                )
                .join("\n"),
      }),
      schema: ANALYSIS_SCHEMA,
    });
    if (!summary.ok) return summary;

    const narrative = [summary.value.summary, summary.value.stopDoing && `Stop: ${summary.value.stopDoing}`, summary.value.tryNext && `Next: ${summary.value.tryNext}`]
      .filter((line) => line && String(line).trim() !== "")
      .join("\n");

    const report: AnalysisReport = {
      examinedPosts: performance.rows.length,
      medianEngagement: Math.round(performance.medianScore),
      promoted: rescored.promoted,
      retired: rescored.retired,
      bestSlotsMinutesOfDay: slots.map((slot) => slot.minutesOfDay),
      summary: narrative,
      revenue: {
        clicks: counts.clicks,
        conversions: counts.conversions,
        approved: [...performance.totals.values()].map((rollup) => ({
          currency: rollup.currency,
          amount: rollup.approvedRevenue,
        })),
        unattributed: revenueImport.unattributed,
      },
    };

    await context.note("role.analyze.completed", truncate(narrative, 200), {
      examinedPosts: report.examinedPosts,
      promoted: report.promoted.length,
      retired: report.retired.length,
      conversionsImported: revenueImport.imported,
      unattributedConversions: revenueImport.unattributed,
    });

    return report.examinedPosts === 0 && rescored.patterns.length === 0
      ? ok({ ...report, summary: narrative || "Nothing published yet - no numbers to read." })
      : ok(report);
  },
};

/**
 * Pulls fresh engagement for anything published inside the metrics window.
 * Posts older than that stop being polled: their numbers have stopped moving,
 * and the channel API call is not free.
 */
async function refreshMetrics(context: RoleContext): Promise<void> {
  const { venture, config, store, clock } = context;
  const cutoff = clock.now() - config.policy.metricsWindowHours * 3_600_000;
  const live = await store.posts.find(
    (post) =>
      post.ventureId === venture.id &&
      post.status === "published" &&
      post.externalId !== undefined &&
      post.publishedAt !== undefined &&
      Date.parse(post.publishedAt) >= cutoff,
  );
  if (live.length === 0) return;

  const byChannel = new Map<string, ScheduledPost[]>();
  for (const post of live) {
    byChannel.set(post.channel, [...(byChannel.get(post.channel) ?? []), post]);
  }

  const captured: StoredMetric[] = [];
  for (const [channelId, posts] of byChannel) {
    const channel = context.channels.get(channelId);
    if (!channel.ok) continue;
    const result = await channel.value.metrics(posts.map((post) => post.externalId as string));
    if (!result.ok) {
      context.logger.warn("metric refresh failed", { channel: channelId, error: result.error.message });
      continue;
    }
    for (const post of posts) {
      const snapshot = result.value[post.externalId as string];
      if (!snapshot) continue;
      const capturedAt = clock.nowIso();
      captured.push({
        id: metricId(post.id, capturedAt),
        postId: post.id,
        ventureId: venture.id,
        capturedAt,
        ageHours: hoursBetween(post.publishedAt as string, clock.now()),
        snapshot,
      });
    }
  }
  if (captured.length > 0) await store.metrics.putMany(captured);
}

/** Imports conversions from every enabled network and ties them to links. */
async function importConversions(
  context: RoleContext,
): Promise<{ imported: number; unattributed: number }> {
  const { config, store, clock } = context;
  // Not `metricsWindowHours`. That window is about engagement, which is visible
  // within hours; a conversion is approved on the ASP's schedule, often at a
  // monthly close. Asking for 72 hours meant anything reported later than that
  // was never imported at all - revenue genuinely earned, silently absent from
  // every report, every statement and every pattern's evidence.
  const since = new Date(
    clock.now() - config.policy.conversionLookbackDays * 86_400_000,
  ).toISOString();
  const [links, stored] = await Promise.all([store.links.all(), store.conversions.all()]);
  // Grown as each network is imported. Reusing the opening snapshot meant a
  // second network could not see what the first had just written.
  const existing: ConversionEvent[] = [...stored];

  let imported = 0;
  let unattributed = 0;
  for (const network of context.networks.enabled()) {
    const result = await network.fetchConversions(since);
    if (!result.ok) {
      context.logger.warn("conversion import failed", { network: network.id, error: result.error.message });
      continue;
    }
    const resolved = resolveConversions(result.value, links, existing, network.id);
    if (resolved.resolved.length > 0) {
      await store.conversions.putMany(resolved.resolved);
      existing.push(...resolved.resolved);
      imported += resolved.resolved.length;
    }
    if (resolved.unattributed.length > 0) {
      unattributed += resolved.unattributed.length;
      // Audit log, not only the process log. Unattributed revenue is a symptom
      // - a sub-id the network mangled, a link issued by another instance - and
      // the promise is that it is shown, not swallowed.
      await context.note(
        "role.analyze.unattributed",
        `${resolved.unattributed.length} conversion(s) from "${network.id}" matched no tracked link.`,
        {
          network: network.id,
          count: resolved.unattributed.length,
          externalIds: resolved.unattributed.slice(0, 20).map((conversion) => conversion.externalId),
        },
      );
    }
  }
  return { imported, unattributed };
}

function describeStatusChanges(
  rescored: { promoted: readonly string[]; retired: readonly string[] },
  byId: Map<PatternId, Pattern>,
): string {
  const lines: string[] = [];
  for (const id of rescored.promoted) lines.push(`- promoted to active: ${byId.get(id)?.name ?? id} [${id}]`);
  for (const id of rescored.retired) lines.push(`- retired: ${byId.get(id)?.name ?? id} [${id}]`);
  return lines.length === 0 ? "(no pattern changed status today)" : lines.join("\n");
}
