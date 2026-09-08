/**
 * Turning raw engagement into one comparable number.
 *
 * The analysis role has to answer "did this do better than usual?", and it
 * cannot do that from five separate counters. The weights below encode how
 * much effort each action costs a reader: a like is cheap, a save means they
 * intend to come back, a follow means they bought the account itself.
 *
 * These are the platform's defaults, and they are the kind of thing an
 * operator with real data should tune. Today that means editing this constant;
 * moving it into `platform.config.yaml` is an open item in the requirements.
 */

import type { EngagementSnapshot } from "../core/types.ts";

export const ENGAGEMENT_WEIGHTS = {
  likes: 1,
  replies: 3,
  reposts: 5,
  saves: 2,
  linkClicks: 4,
  followsGained: 10,
} as const;

/** A single comparable number for one post. */
export function engagementScore(snapshot: EngagementSnapshot): number {
  return (
    snapshot.likes * ENGAGEMENT_WEIGHTS.likes +
    snapshot.replies * ENGAGEMENT_WEIGHTS.replies +
    snapshot.reposts * ENGAGEMENT_WEIGHTS.reposts +
    (snapshot.saves ?? 0) * ENGAGEMENT_WEIGHTS.saves +
    (snapshot.linkClicks ?? 0) * ENGAGEMENT_WEIGHTS.linkClicks +
    (snapshot.followsGained ?? 0) * ENGAGEMENT_WEIGHTS.followsGained
  );
}

/**
 * Engagement per thousand impressions. Comparable across accounts of
 * different sizes, and the honest measure of whether the *writing* worked
 * rather than the distribution. Returns undefined when impressions are unknown.
 */
export function engagementRate(snapshot: EngagementSnapshot): number | undefined {
  if (!snapshot.impressions || snapshot.impressions <= 0) return undefined;
  return (engagementScore(snapshot) / snapshot.impressions) * 1000;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * How a score compares to the venture's recent median. 1.0 means typical.
 * Guards the zero-median case so a brand new account does not report infinite
 * lift on its first post.
 */
export function liftVsMedian(score: number, medianScore: number): number {
  if (medianScore <= 0) return score > 0 ? 1 : 0;
  return score / medianScore;
}

/**
 * Posts stop accumulating engagement after a day or so. Comparing a 2-hour-old
 * post to a 3-day-old one without adjusting makes every new post look like a
 * failure, so scores are scaled up to their projected mature value.
 *
 * The curve is `1 - e^(-h/8)`, matching how engagement actually lands: most of
 * it in the first working day, a long thin tail after.
 */
export function maturityFactor(ageHours: number): number {
  if (ageHours <= 0) return 0.05;
  return Math.max(0.05, 1 - Math.exp(-ageHours / 8));
}

export function normaliseForAge(score: number, ageHours: number): number {
  return score / maturityFactor(ageHours);
}

export function hoursBetween(fromIso: string, toMs: number): number {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return 0;
  return Math.max(0, (toMs - from) / 3_600_000);
}
