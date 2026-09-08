/**
 * The playbook - the company's accumulated knowledge about what travels.
 *
 * This is the piece that makes the operation compound rather than just repeat.
 * The research role proposes patterns, the planning and writing roles spend
 * them, and the analysis role re-scores them every day against what actually
 * happened. A pattern that keeps working gets promoted and used more; one that
 * stops working is retired, and stops polluting tomorrow's plan.
 *
 * Scoring is deliberately conservative. Three good posts is not proof, so
 * confidence is shrunk toward "unknown" until there is enough evidence, and
 * old evidence decays - a hook that worked last quarter is not a hook that
 * works now.
 */

import type { Pattern, PatternEvidence, PatternStatus } from "../core/types.ts";

export type ScoringOptions = {
  /** Days after which one piece of evidence counts half as much. */
  readonly halfLifeDays: number;
  /** Effective sample size at which confidence stops being shrunk. */
  readonly shrinkage: number;
  /** Lift at or below which a pattern scores 0. */
  readonly floorLift: number;
  /** Lift at or above which a pattern scores 1. */
  readonly ceilingLift: number;
  readonly promoteAt: number;
  readonly retireAt: number;
  /** Minimum evidence weight before a status may change. */
  readonly minSupportToPromote: number;
  readonly minSupportToRetire: number;
};

export const DEFAULT_SCORING: ScoringOptions = {
  halfLifeDays: 21,
  shrinkage: 3,
  floorLift: 0.8,
  ceilingLift: 2.0,
  promoteAt: 0.65,
  retireAt: 0.35,
  minSupportToPromote: 2,
  minSupportToRetire: 3,
};

export type PatternScore = {
  readonly confidence: number;
  /** Effective sample size after recency decay. */
  readonly support: number;
  /** Recency-weighted average lift over the venture's median. */
  readonly weightedLift: number;
};

/**
 * Scores one pattern from its evidence.
 *
 * With no evidence the answer is 0.5 - "we have no idea" - not 0. A brand new
 * candidate should be tried, not buried.
 */
export function scorePattern(
  pattern: Pattern,
  nowMs: number,
  options: ScoringOptions = DEFAULT_SCORING,
): PatternScore {
  if (pattern.evidence.length === 0) return { confidence: 0.5, support: 0, weightedLift: 1 };

  let weightSum = 0;
  let liftSum = 0;
  for (const item of pattern.evidence) {
    const weight = recencyWeight(item, nowMs, options.halfLifeDays);
    weightSum += weight;
    liftSum += item.liftVsMedian * weight;
  }
  if (weightSum === 0) return { confidence: 0.5, support: 0, weightedLift: 1 };

  const weightedLift = liftSum / weightSum;
  const span = options.ceilingLift - options.floorLift;
  const raw = clamp((weightedLift - options.floorLift) / (span === 0 ? 1 : span), 0, 1);
  // Shrink toward 0.5 until there is enough evidence to justify a strong claim.
  const trust = weightSum / (weightSum + options.shrinkage);
  return {
    confidence: clamp(0.5 + (raw - 0.5) * trust, 0, 1),
    support: weightSum,
    weightedLift,
  };
}

function recencyWeight(evidence: PatternEvidence, nowMs: number, halfLifeDays: number): number {
  const observed = Date.parse(evidence.observedAt);
  if (Number.isNaN(observed)) return 0;
  const ageDays = Math.max(0, (nowMs - observed) / 86_400_000);
  return 0.5 ** (ageDays / Math.max(0.5, halfLifeDays));
}

/**
 * The status a pattern should hold given its score.
 *
 * Retirement requires more evidence than promotion: wrongly promoting costs
 * one mediocre post, wrongly retiring throws away something that works.
 */
export function nextStatus(
  current: PatternStatus,
  score: PatternScore,
  options: ScoringOptions = DEFAULT_SCORING,
): PatternStatus {
  if (current === "retired") {
    // A retired pattern can come back, but only on strong fresh evidence.
    return score.confidence >= options.promoteAt && score.support >= options.minSupportToPromote + 1
      ? "active"
      : "retired";
  }
  if (score.confidence <= options.retireAt && score.support >= options.minSupportToRetire) return "retired";
  if (score.confidence >= options.promoteAt && score.support >= options.minSupportToPromote) return "active";
  return current === "active" ? "active" : "candidate";
}

export type RescoreResult = {
  readonly patterns: readonly Pattern[];
  readonly promoted: readonly string[];
  readonly retired: readonly string[];
};

/** Re-scores every pattern and reports which ones changed status. */
export function rescorePatterns(
  patterns: readonly Pattern[],
  nowMs: number,
  options: ScoringOptions = DEFAULT_SCORING,
): RescoreResult {
  const promoted: string[] = [];
  const retired: string[] = [];
  const updated = patterns.map((pattern) => {
    const score = scorePattern(pattern, nowMs, options);
    const status = nextStatus(pattern.status, score, options);
    if (status !== pattern.status) {
      if (status === "active") promoted.push(pattern.id);
      if (status === "retired") retired.push(pattern.id);
    }
    if (status === pattern.status && score.confidence === pattern.confidence) return pattern;
    return {
      ...pattern,
      confidence: round(score.confidence, 4),
      status,
      updatedAt: new Date(nowMs).toISOString(),
    };
  });
  return { patterns: updated, promoted, retired };
}

/**
 * The patterns worth giving the planning role today: active first, then
 * candidates that have not been tried enough to judge. Retired patterns are
 * excluded entirely - that is the point of retiring them.
 */
export function selectForPlanning(
  patterns: readonly Pattern[],
  limit: number,
  nowMs: number,
  options: ScoringOptions = DEFAULT_SCORING,
  /**
   * How many posts a day the venture actually publishes. The shortlist is
   * sized by how many ideas are proposed (six or more), but whether untested
   * patterns belong on it is a question about the publishing volume: with one
   * or two posts a day there is no spare slot to spend on an experiment, and
   * an idea built on an untested pattern is a gamble, not exploration.
   * Omitted, the shortlist size decides - the pre-1.0 behaviour.
   */
  postsPerDay?: number,
): Pattern[] {
  const scored = patterns
    .filter((pattern) => pattern.status !== "retired")
    .map((pattern) => ({ pattern, score: scorePattern(pattern, nowMs, options) }));

  // Reserve about a quarter of the slots for untested candidates. Without
  // that, the playbook converges on whatever worked first and never learns
  // anything new.
  //
  // At very low volume the floor of one inverts the intent - with a single
  // slot it reserved all of it - so exploration is switched off there.
  // Exploration is what you do with a spare slot, never with the only one.
  const volume = postsPerDay ?? limit;
  const explorationSlots = volume <= 2 ? 0 : Math.max(1, Math.round(limit * 0.25));
  const proven = scored
    .filter((entry) => entry.pattern.status === "active")
    .sort((a, b) => b.score.confidence - a.score.confidence)
    .map((entry) => entry.pattern);
  const untested = scored
    .filter((entry) => entry.pattern.status === "candidate")
    .sort((a, b) => a.score.support - b.score.support)
    .map((entry) => entry.pattern);

  const out = [...proven.slice(0, Math.max(0, limit - explorationSlots)), ...untested.slice(0, explorationSlots)];
  // Too few proven patterns to fill the list: top up with candidates whatever
  // the volume. A playbook that has proved nothing yet has nothing else to
  // offer, and showing the planner an empty list would freeze it forever.
  if (out.length < limit) {
    for (const pattern of [...proven, ...untested]) {
      if (out.length >= limit) break;
      if (!out.includes(pattern)) out.push(pattern);
    }
  }
  return out.slice(0, limit);
}

/** Appends evidence, keeping the most recent observations bounded. */
export function withEvidence(
  pattern: Pattern,
  evidence: PatternEvidence,
  nowMs: number,
  maxEvidence = 40,
): Pattern {
  const seen = pattern.evidence.some(
    (item) => item.source === evidence.source && item.refId === evidence.refId,
  );
  if (seen) return pattern;
  const merged = [...pattern.evidence, evidence]
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .slice(0, maxEvidence);
  return { ...pattern, evidence: merged, updatedAt: new Date(nowMs).toISOString() };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
