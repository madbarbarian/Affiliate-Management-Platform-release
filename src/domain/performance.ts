/**
 * "How did we actually do?" - computed once, used by three roles.
 *
 * Planning needs it to justify proposals, analysis needs it to re-score the
 * playbook, and publishing needs it to pick slots. Computing it in one place
 * means those three never disagree about what a post was worth.
 */

import { engagementScore, hoursBetween, liftVsMedian, median, normaliseForAge } from "./engagement.ts";
import { revenueByPost, totalsByCurrency, type RevenueRollup } from "../affiliate/attribution.ts";
import type { PostId, ScheduledPost, VentureId } from "../core/types.ts";
import type { Store, StoredMetric } from "../storage/store.ts";
import type { Offer } from "../core/types.ts";

export type PerformanceRow = {
  readonly post: ScheduledPost;
  /** Age-normalised engagement score, so new and old posts compare fairly. */
  readonly score: number;
  readonly lift: number;
  readonly ageHours: number;
  readonly revenue?: RevenueRollup;
};

export type PerformanceWindow = {
  readonly rows: readonly PerformanceRow[];
  readonly medianScore: number;
  /** One entry per currency. Never summed across currencies - see attribution. */
  readonly totals: ReadonlyMap<string, RevenueRollup>;
};

export type PerformanceOptions = {
  readonly ventureId: VentureId;
  readonly nowMs: number;
  /** Only include posts published at or after this instant. */
  readonly sinceMs: number;
  readonly offers: readonly Offer[];
  readonly defaultCurrency: string;
};

export async function computePerformance(store: Store, options: PerformanceOptions): Promise<PerformanceWindow> {
  // Five independent reads, not two waves. `metrics` does not actually depend
  // on `posts` - `latestByPost` below only needs the *ids*, to decide which
  // metric rows to keep, and that filtering happens in memory after both have
  // already arrived. Awaiting `posts` and then `latestMetricByPost` in series
  // (as this used to) cost a whole extra round trip's latency on every venture,
  // every call - real time on a store backed by D1, paid for no reason.
  const [posts, metrics, links, clicks, conversions] = await Promise.all([
    store.posts.find(
      (post) =>
        post.ventureId === options.ventureId &&
        post.status === "published" &&
        post.publishedAt !== undefined &&
        Date.parse(post.publishedAt) >= options.sinceMs,
    ),
    store.metrics.all(),
    store.links.find((link) => link.ventureId === options.ventureId),
    store.clicks.all(),
    store.conversions.all(),
  ]);

  const latest = latestByPost(metrics, posts.map((post) => post.id));
  const revenue = revenueByPost({
    links,
    clicks,
    conversions,
    offers: options.offers,
    defaultCurrency: options.defaultCurrency,
  });

  const scored = posts.map((post) => {
    const metric = latest.get(post.id);
    const ageHours = post.publishedAt ? hoursBetween(post.publishedAt, options.nowMs) : 0;
    const raw = metric ? engagementScore(metric.snapshot) : 0;
    return {
      post,
      ageHours,
      // Normalise by age so a two-hour-old post is not judged against a
      // three-day-old one that had time to accumulate.
      rawScore: metric ? normaliseForAge(raw, metric.ageHours || ageHours) : 0,
      hasMetric: metric !== undefined,
    };
  });

  const measured = scored.filter((entry) => entry.hasMetric).map((entry) => entry.rawScore);
  const medianScore = median(measured);

  const rows: PerformanceRow[] = scored
    .map((entry) => {
      const rollup = revenue.get(entry.post.id);
      return {
        post: entry.post,
        score: entry.rawScore,
        lift: entry.hasMetric ? liftVsMedian(entry.rawScore, medianScore) : 0,
        ageHours: entry.ageHours,
        ...(rollup ? { revenue: rollup } : {}),
      };
    })
    .sort((a, b) => b.lift - a.lift);

  // Totalled from the rows, not from every rollup ever recorded. `posts` is
  // windowed by `sinceMs` but clicks and conversions are read whole (they have
  // to be, or a conversion would lose the click that attributes it), so summing
  // the map directly reported lifetime revenue under a seven-day heading - and
  // `amp statement` re-billed a revshare percentage against that lifetime figure
  // every single period.
  return {
    rows,
    medianScore,
    totals: totalsByCurrency(rows.map((row) => row.revenue).filter((rollup) => rollup !== undefined)),
  };
}

/** The freshest metric reading for each post. */
export async function latestMetricByPost(
  store: Store,
  postIds: readonly PostId[],
): Promise<Map<PostId, StoredMetric>> {
  const wanted = new Set(postIds);
  const metrics = await store.metrics.find((metric) => wanted.has(metric.postId));
  return latestByPost(metrics, postIds);
}

/**
 * The pure half of `latestMetricByPost`, split out so `computePerformance`
 * can run the read (`store.metrics.all()`) alongside its other four reads
 * instead of waiting on `posts` first only to turn around and ask the store
 * for something that never depended on it.
 */
function latestByPost(metrics: readonly StoredMetric[], postIds: readonly PostId[]): Map<PostId, StoredMetric> {
  const wanted = new Set(postIds);
  const latest = new Map<PostId, StoredMetric>();
  for (const metric of metrics) {
    if (!wanted.has(metric.postId)) continue;
    const current = latest.get(metric.postId);
    if (!current || metric.capturedAt > current.capturedAt) latest.set(metric.postId, metric);
  }
  return latest;
}

/**
 * The local minutes-of-day that have produced the best results so far.
 *
 * Slots are bucketed to the half hour, because minute-level precision on this
 * data is noise, and a venture posting twice a day takes weeks to say anything
 * about 09:07 versus 09:22.
 */
export function bestSlots(
  rows: readonly PerformanceRow[],
  timezone: string,
  count: number,
): { minutesOfDay: number; samples: number; averageLift: number }[] {
  const buckets = new Map<number, { total: number; samples: number }>();
  for (const row of rows) {
    if (!row.post.publishedAt || row.lift <= 0) continue;
    const minutes = localMinutesOfDay(Date.parse(row.post.publishedAt), timezone);
    const bucket = Math.floor(minutes / 30) * 30;
    const current = buckets.get(bucket) ?? { total: 0, samples: 0 };
    buckets.set(bucket, { total: current.total + row.lift, samples: current.samples + 1 });
  }
  return [...buckets.entries()]
    .map(([minutesOfDay, bucket]) => ({
      minutesOfDay,
      samples: bucket.samples,
      averageLift: bucket.total / bucket.samples,
    }))
    .sort((a, b) => b.averageLift - a.averageLift)
    .slice(0, count);
}

function localMinutesOfDay(epochMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = new Map(formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return Number(parts.get("hour")) * 60 + Number(parts.get("minute"));
}
