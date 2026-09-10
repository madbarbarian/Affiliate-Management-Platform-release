/**
 * All the company's ventures on one page.
 *
 * Two readers, one table. The licensee running several accounts wants to know
 * which are earning, which are stuck at a gate, and which are measuring
 * nothing. The scout wants exactly the same numbers as evidence for what to
 * try next. Computing them once here means the two never disagree, and it
 * fixes the grain at which accounts are compared: aggregates per venture -
 * counts, a median, revenue by currency, the names of its best patterns.
 * Never individual posts or drafts. That grain is what keeps one account's
 * learning from leaking into another's, which is the promise a buyer of an
 * account relies on.
 *
 * Revenue is never summed across currencies, here or anywhere.
 */

import type { PlatformConfig } from "../config/schema.ts";
import type { CycleStatus, CycleStep, Venture, VentureId } from "../core/types.ts";
import { isPaused, readPause, type PauseState } from "../kernel/pause.ts";
import type { StateStore } from "../kernel/state.ts";
import {
  deactivatedBy,
  isVentureActive,
  readVentureState,
  type DeactivationRecord,
  type VentureState,
} from "../kernel/venture-state.ts";
import { totalsByCurrency, type RevenueRollup } from "../affiliate/attribution.ts";
import type { Store, StoreRegistry } from "../storage/store.ts";
import { describeMeasurementChain, type ChainStep } from "./measurement.ts";
import { computePerformance } from "./performance.ts";

export type PortfolioRow = {
  readonly ventureId: VentureId;
  readonly name: string;
  readonly niche: string;
  readonly audience: string;
  readonly market: string;
  /** Effective: config `active` and not deactivated by the operator. */
  readonly active: boolean;
  /** Set when the operator switched this account off from the console or CLI. */
  readonly deactivated?: DeactivationRecord;
  readonly stopped: boolean;
  readonly pendingDecisions: number;
  /**
   * Why this account deserves a look, computed from its numbers against the
   * `company.exploration.review` thresholds. Never acts by itself: it sits next
   * to the deactivate button so the operator decides with the reason in view.
   */
  readonly review?: string;
  readonly lastCycle?: {
    readonly date: string;
    readonly status: CycleStatus;
    readonly nextStep?: CycleStep;
    /**
     * Why it stopped, when it stopped badly. Carried here because this table is
     * the only place a Cloudflare operator sees a cycle at all: there is no
     * terminal for `cycle status`, and without it a red day says which step
     * broke and nothing about what to do next.
     */
    readonly failure?: string;
    /**
     * The failure's code, so a screen can choose its own words for it. The
     * message is the API's and can be a paragraph of English; the code is a
     * small closed set, which is what a one-line summary has to come from.
     */
    readonly failureCode?: string;
    readonly failureStep?: CycleStep;
  };
  /** Posts published inside the window. */
  readonly posts: number;
  readonly medianScore: number;
  readonly clicks: number;
  readonly conversions: number;
  /** One entry per currency. */
  readonly revenue: readonly RevenueRollup[];
  readonly playbook: {
    readonly active: number;
    readonly total: number;
    /** The best-supported patterns, by name - the shape of what works here. */
    readonly top: readonly { readonly name: string; readonly kind: string; readonly confidence: number }[];
  };
  readonly offerCategories: readonly string[];
  readonly measurementClosed: boolean;
  /**
   * The first thing standing between a post and a number, when the chain is
   * open. On a machine `doctor` says this; on a host there is no terminal to
   * say it in, so it travels with the row.
   */
  readonly measurementProblem?: string;
  /** Which link is open, so a UI can name it in its own language. */
  readonly measurementStep?: ChainStep;
};

export type Portfolio = {
  readonly days: number;
  readonly rows: readonly PortfolioRow[];
  readonly totals: {
    readonly posts: number;
    readonly clicks: number;
    readonly conversions: number;
    /** Per currency. There is no company-wide single number, on purpose. */
    readonly byCurrency: readonly RevenueRollup[];
  };
};

export type PortfolioInput = {
  readonly config: PlatformConfig;
  /**
   * Every account's store. Comparing accounts is this file's entire job, so
   * this is the crossing that has a name - and each row is still built from
   * one account's store and nothing else.
   */
  readonly stores: StoreRegistry;
  readonly nowMs: number;
  readonly days: number;
  /**
   * The stop and deactivation switches. Required, and explicitly `undefined`
   * when there are none: an optional field here was silently dropped by a
   * caller that spread the wrong key in, and the columns came back wrong with
   * nothing to notice it.
   */
  readonly state: StateStore | undefined;
};

export async function buildPortfolio(input: PortfolioInput): Promise<Portfolio> {
  const { config, stores, nowMs, days } = input;
  const sinceMs = nowMs - days * 86_400_000;
  const pause: PauseState = input.state ? readPause(input.state) : { ventures: {} };
  const ventureState: VentureState = input.state ? readVentureState(input.state) : { inactive: {} };

  const unreviewed: PortfolioRow[] = [];
  for (const venture of config.ventures) {
    const store = await stores.for(venture.id);
    const [decisions, cycles, patterns] = await Promise.all([
      store.decisions.find((decision) => decision.status === "pending"),
      store.cycles.all(),
      store.patterns.all(),
    ]);
    unreviewed.push(
      await rowFor(venture, { config, store, nowMs, sinceMs, pause, ventureState, decisions, cycles, patterns }),
    );
  }
  const rows = unreviewed.map((row) => {
    const review = reviewReason(row, unreviewed, config.company.exploration.review);
    return review ? { ...row, review } : row;
  });

  return {
    days,
    rows,
    totals: {
      posts: rows.reduce((sum, row) => sum + row.posts, 0),
      clicks: rows.reduce((sum, row) => sum + row.clicks, 0),
      conversions: rows.reduce((sum, row) => sum + row.conversions, 0),
      byCurrency: [...totalsByCurrency(rows.flatMap((row) => row.revenue)).values()],
    },
  };
}

/**
 * Whether the chain is closed, and if not, the first thing in the way. On a
 * machine `doctor` says this; on a host there is no terminal to say it in.
 */
function measurementOf(config: PlatformConfig, ventureId: VentureId): {
  measurementClosed: boolean;
  measurementProblem?: string;
  measurementStep?: ChainStep;
} {
  const chain = describeMeasurementChain(config, ventureId);
  if (chain.closed) return { measurementClosed: true };
  const first = chain.links.find((link) => !link.ok);
  return {
    measurementClosed: false,
    ...(first ? { measurementProblem: first.problem, measurementStep: first.step } : {}),
  };
}

async function rowFor(
  venture: Venture,
  scope: {
    config: PlatformConfig;
    store: Store;
    nowMs: number;
    sinceMs: number;
    pause: PauseState;
    ventureState: VentureState;
    decisions: readonly { ventureId: string }[];
    cycles: readonly {
      ventureId: string;
      date: string;
      status: CycleStatus;
      nextStep?: CycleStep;
      failure?: { message: string; code: string; step: CycleStep };
    }[];
    patterns: readonly { ventureId: string; name: string; kind: string; confidence: number; status: string }[];
  },
): Promise<PortfolioRow> {
  const offers = scope.config.offers.filter((offer) => venture.offers.includes(offer.id));
  const performance = await computePerformance(scope.store, {
    ventureId: venture.id,
    nowMs: scope.nowMs,
    sinceMs: scope.sinceMs,
    offers,
    defaultCurrency: offers[0]?.currency ?? "JPY",
  });
  const revenue = [...performance.totals.values()];
  const deactivated: DeactivationRecord | undefined = deactivatedBy(scope.ventureState, venture.id);
  const own = scope.patterns.filter((pattern) => pattern.ventureId === venture.id);
  const lastCycle = scope.cycles
    .filter((cycle) => cycle.ventureId === venture.id)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];

  return {
    ventureId: venture.id,
    name: venture.name,
    niche: venture.niche,
    audience: venture.audience,
    market: venture.market,
    active: isVentureActive(venture, scope.ventureState),
    ...(deactivated ? { deactivated } : {}),
    stopped: isPaused(scope.pause, venture.id),
    pendingDecisions: scope.decisions.filter((decision) => decision.ventureId === venture.id).length,
    ...(lastCycle
      ? {
          lastCycle: {
            date: lastCycle.date,
            status: lastCycle.status,
            ...(lastCycle.nextStep ? { nextStep: lastCycle.nextStep } : {}),
            // Only when the day actually ended there. Every screen keys the
            // failure off this being present rather than off the status, so a
            // cycle that carried a stale failure forward showed
            // 実行できませんでした while it was waiting at an approval gate.
            // The orchestrator clears the failure now; this is the second lock
            // on the same door, and the one every reader passes through.
            ...(lastCycle.failure && lastCycle.status === "failed"
              ? {
                  failure: lastCycle.failure.message,
                  failureCode: lastCycle.failure.code,
                  failureStep: lastCycle.failure.step,
                }
              : {}),
          },
        }
      : {}),
    posts: performance.rows.length,
    medianScore: Math.round(performance.medianScore),
    clicks: revenue.reduce((sum, rollup) => sum + rollup.clicks, 0),
    conversions: revenue.reduce((sum, rollup) => sum + rollup.conversions, 0),
    revenue,
    playbook: {
      active: own.filter((pattern) => pattern.status === "active").length,
      total: own.length,
      top: own
        .filter((pattern) => pattern.status === "active")
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3)
        .map((pattern) => ({ name: pattern.name, kind: pattern.kind, confidence: pattern.confidence })),
    },
    offerCategories: [...new Set(offers.map((offer) => offer.category))],
    ...measurementOf(scope.config, venture.id),
  };
}

/**
 * Why an account deserves a second look. Two rules, both about the window:
 * enough posts to judge and nothing reaching a link, or enough posts and an
 * engagement median far below the company's. Deterministic on purpose - a
 * reason the operator can check against the same numbers on the same row.
 * Accounts already off are not re-flagged.
 */
export function reviewReason(
  row: PortfolioRow,
  all: readonly PortfolioRow[],
  thresholds: { afterPosts: number; belowShareOfMedian: number },
): string | undefined {
  if (!row.active || row.posts < thresholds.afterPosts) return undefined;
  // Zero clicks is only a verdict when a click could have been recorded:
  // the measurement chain closed and at least one offer to link to. An
  // account on mock adapters, or one with no contracted offer, would
  // otherwise be flagged for a number the platform cannot measure.
  if (row.clicks === 0 && row.conversions === 0 && row.measurementClosed && row.offerCategories.length > 0) {
    return `${row.posts} posts in the window and not one click on a tracked link`;
  }
  const peers = all.filter((entry) => entry.active && entry.posts >= thresholds.afterPosts);
  if (peers.length < 2) return undefined;
  const medians = peers.map((entry) => entry.medianScore).sort((a, b) => a - b);
  const middle = Math.floor(medians.length / 2);
  const companyMedian = medians.length % 2 === 0 ? ((medians[middle - 1] ?? 0) + (medians[middle] ?? 0)) / 2 : (medians[middle] ?? 0);
  if (companyMedian > 0 && row.medianScore < companyMedian * thresholds.belowShareOfMedian) {
    return `median engagement ${row.medianScore} is under ${Math.round(thresholds.belowShareOfMedian * 100)}% of the company's ${Math.round(companyMedian)}`;
  }
  return undefined;
}

/** Plain-text table for the terminal. */
export function renderPortfolio(portfolio: Portfolio): string {
  const lines: string[] = [];
  lines.push(`=== All accounts — last ${portfolio.days} days ===`, "");
  for (const row of portfolio.rows) {
    const state = row.stopped
      ? "STOPPED"
      : row.deactivated
        ? `deactivated by ${row.deactivated.by}${row.deactivated.reason ? `: ${row.deactivated.reason}` : ""}`
        : row.active
          ? "active"
          : "inactive (config)";
    const cycle = row.lastCycle
      ? `${row.lastCycle.date} ${row.lastCycle.status}${row.lastCycle.nextStep ? ` → ${row.lastCycle.nextStep}` : ""}`
      : "never run";
    lines.push(`${row.ventureId}  ${row.name}  [${state}]`);
    lines.push(`  niche        ${row.niche}`);
    lines.push(`  market       ${row.market}   measurement ${row.measurementClosed ? "closed" : "INCOMPLETE"}`);
    lines.push(`  last cycle   ${cycle}${row.pendingDecisions > 0 ? `   (${row.pendingDecisions} decision(s) waiting)` : ""}`);
    if (row.lastCycle?.failure) lines.push(`  FAILED       ${row.lastCycle.failure}`);
    if (row.review) lines.push(`  REVIEW       ${row.review} — amp venture deactivate ${row.ventureId} --reason "…" switches it off, keeping its data`);
    lines.push(`  posts ${row.posts}   median ${row.medianScore}   clicks ${row.clicks}   conversions ${row.conversions}`);
    lines.push(`  approved     ${formatRollups(row.revenue, "approvedRevenue")}   pending ${formatRollups(row.revenue, "pendingRevenue")}`);
    lines.push(
      `  playbook     ${row.playbook.active} active / ${row.playbook.total}` +
        (row.playbook.top.length > 0
          ? `   top: ${row.playbook.top.map((pattern) => `${pattern.name} (${pattern.confidence.toFixed(2)})`).join(", ")}`
          : ""),
    );
    lines.push("");
  }
  lines.push(
    `total        posts ${portfolio.totals.posts}   clicks ${portfolio.totals.clicks}   conversions ${portfolio.totals.conversions}`,
  );
  lines.push(`approved     ${formatRollups(portfolio.totals.byCurrency, "approvedRevenue")}   (per currency, never summed across)`);
  return lines.join("\n");
}

/**
 * The portfolio as the scout reads it: aggregates only. This is the one place
 * that decides what one account is allowed to know about another.
 */
export function describePortfolioForScout(portfolio: Portfolio): string {
  if (portfolio.rows.length === 0) return "(no ventures yet)";
  return portfolio.rows
    .map((row) =>
      [
        `### [${row.ventureId}] ${row.name}${row.active ? "" : " (inactive)"}${row.review ? ` — flagged for review: ${row.review}` : ""}`,
        `- niche: ${row.niche}`,
        `- audience: ${row.audience}`,
        `- market: ${row.market}`,
        `- last ${portfolio.days} days: ${row.posts} posts, median engagement ${row.medianScore}, ` +
          `${row.clicks} clicks, ${row.conversions} conversions, approved ${formatRollups(row.revenue, "approvedRevenue")}`,
        `- offer categories: ${row.offerCategories.join(", ") || "(none)"}`,
        `- playbook: ${row.playbook.active} proven / ${row.playbook.total} total` +
          (row.playbook.top.length > 0
            ? `; strongest: ${row.playbook.top.map((pattern) => `${pattern.name} [${pattern.kind}] ${pattern.confidence.toFixed(2)}`).join("; ")}`
            : ""),
        `- measurement: ${row.measurementClosed ? "closed" : "incomplete - treat its numbers as unreliable"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function formatRollups(rollups: readonly RevenueRollup[], field: "approvedRevenue" | "pendingRevenue"): string {
  const parts = rollups
    .filter((rollup) => rollup[field] !== 0)
    .map((rollup) => `${Math.round(rollup[field]).toLocaleString("en-US")} ${rollup.currency}`);
  return parts.join(" / ") || "0";
}
