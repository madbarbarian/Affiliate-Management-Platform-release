/**
 * Choosing when a post goes out.
 *
 * Kept as a pure function because this is the part of the day most likely to
 * be wrong in a way nobody notices: a post scheduled into the past publishes
 * instantly, two posts three minutes apart read as a bot, and a "best time"
 * derived from two data points is superstition. All three are testable, so
 * they are tested rather than trusted.
 */

import { formatTimeOfDay, localMinutesOfDay, nextLocalTime } from "../core/clock.ts";

export type SlotCandidate = {
  readonly minutesOfDay: number;
  readonly samples: number;
  readonly averageLift: number;
};

export type SlotPlan = {
  readonly at: number;
  readonly minutesOfDay: number;
  /** One line the operator can sanity-check. */
  readonly reason: string;
};

export type PlanSlotsOptions = {
  readonly count: number;
  /** Measured slots, best first. May be empty for a new account. */
  readonly measured: readonly SlotCandidate[];
  /** Used when there is not enough measured data. */
  readonly fallbackMinutes: readonly number[];
  readonly nowMs: number;
  readonly timezone: string;
  readonly minGapMinutes: number;
  /** Epoch ms of posts already scheduled, so slots do not collide. */
  readonly occupied: readonly number[];
  /**
   * A slot needs at least this many observations before it is treated as
   * measured rather than noise.
   */
  readonly minSamples?: number;
  /** Never schedule sooner than this many minutes from now. */
  readonly leadMinutes?: number;
};

const MINUTE_MS = 60_000;

export function planSlots(options: PlanSlotsOptions): SlotPlan[] {
  const minSamples = options.minSamples ?? 2;
  const leadMs = (options.leadMinutes ?? 20) * MINUTE_MS;
  const earliest = options.nowMs + leadMs;

  const trusted = options.measured.filter((slot) => slot.samples >= minSamples);
  const ranked: { minutesOfDay: number; reason: string }[] = [
    ...trusted.map((slot) => ({
      minutesOfDay: slot.minutesOfDay,
      reason: `measured best slot: ${slot.averageLift.toFixed(2)}x median over ${slot.samples} posts`,
    })),
    ...options.fallbackMinutes.map((minutes) => ({
      minutesOfDay: minutes,
      reason:
        trusted.length === 0
          ? "default slot - not enough published posts to measure a best time yet"
          : "default slot - measured slots exhausted",
    })),
  ];

  // Deduplicate while keeping the best-ranked reason for each time of day.
  const seen = new Set<number>();
  const candidates = ranked.filter((entry) => {
    if (seen.has(entry.minutesOfDay)) return false;
    seen.add(entry.minutesOfDay);
    return true;
  });

  const taken = [...options.occupied].sort((a, b) => a - b);
  const plans: SlotPlan[] = [];
  let candidateIndex = 0;
  let dayOffset = 0;

  // With no measured slots and no fallbacks configured there is nothing to
  // schedule against. The loop below would have spun and then dereferenced
  // `undefined` through a cast that hid it from the typechecker; returning
  // early says the same thing honestly.
  if (candidates.length === 0) return [];

  while (plans.length < options.count) {
    if (candidateIndex >= candidates.length) {
      // Out of slots for today - roll to tomorrow rather than bunching posts.
      candidateIndex = 0;
      dayOffset += 1;
      if (dayOffset > 7) break; // Refuse to schedule more than a week out.
    }
    const candidate = candidates[candidateIndex];
    candidateIndex += 1;
    if (!candidate) continue;

    const base = earliest + dayOffset * 86_400_000;
    let at = nextLocalTime(base - 1, candidate.minutesOfDay, options.timezone);
    if (at < earliest) at = nextLocalTime(earliest, candidate.minutesOfDay, options.timezone);

    if (conflicts(at, taken, options.minGapMinutes)) continue;

    plans.push({
      at,
      minutesOfDay: localMinutesOfDay(at, options.timezone),
      reason: `${formatTimeOfDay(candidate.minutesOfDay)} ${options.timezone} - ${candidate.reason}`,
    });
    taken.push(at);
    taken.sort((a, b) => a - b);
  }

  return plans;
}

function conflicts(at: number, taken: readonly number[], minGapMinutes: number): boolean {
  const gap = minGapMinutes * MINUTE_MS;
  return taken.some((other) => Math.abs(other - at) < gap);
}

/**
 * Slots to use before an account has published enough to measure anything.
 * Morning commute, lunch, and the evening scroll - the three windows most
 * consumer feeds peak in, in most timezones.
 */
export const DEFAULT_SLOT_MINUTES: readonly number[] = [
  7 * 60 + 30,
  12 * 60 + 15,
  21 * 60,
  18 * 60 + 30,
  22 * 60 + 30,
];
