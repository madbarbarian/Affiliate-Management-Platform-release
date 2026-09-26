/**
 * Joining money back to content.
 *
 * The chain is: post -> tracked link -> click -> conversion. Networks report
 * conversions against the sub-id we put on the link, so resolving them is a
 * lookup, not a guess. Anything that fails to resolve is reported as
 * unattributed rather than silently dropped - unattributed revenue is a
 * symptom worth seeing, usually a link issued outside the platform.
 */

import type {
  ClickEvent,
  ConversionEvent,
  Offer,
  PatternId,
  PostId,
  ScheduledPost,
  TrackedLink,
} from "../core/types.ts";
import type { NetworkConversion } from "../networks/network.ts";

export type ResolvedConversions = {
  readonly resolved: readonly ConversionEvent[];
  /** Conversions whose sub-id matched no link the platform issued. */
  readonly unattributed: readonly NetworkConversion[];
  /** Conversions already stored, skipped as duplicates. */
  readonly duplicates: number;
};

/**
 * `networkId` namespaces both the stored id and the duplicate check. Without
 * it, two ASPs that number their orders from 1 - which they all do - collided:
 * the second import silently overwrote the first one's revenue, or was dropped
 * as a duplicate of it.
 */
export function resolveConversions(
  incoming: readonly NetworkConversion[],
  links: readonly TrackedLink[],
  existing: readonly ConversionEvent[],
  networkId = "unknown",
): ResolvedConversions {
  const byCode = new Map(links.map((link) => [link.code, link]));
  const conversionId = (externalId: string): string => `cnv_${networkId}_${externalId}`;
  const seen = new Set(existing.map((conversion) => conversion.id));
  const resolved: ConversionEvent[] = [];
  const unattributed: NetworkConversion[] = [];
  let duplicates = 0;

  for (const conversion of incoming) {
    if (seen.has(conversionId(conversion.externalId))) {
      duplicates += 1;
      continue;
    }
    const link = byCode.get(conversion.subId);
    if (!link) {
      unattributed.push(conversion);
      continue;
    }
    seen.add(conversionId(conversion.externalId));
    resolved.push({
      id: conversionId(conversion.externalId),
      linkId: link.id,
      externalId: conversion.externalId,
      at: conversion.at,
      amount: conversion.amount,
      currency: conversion.currency,
      status: conversion.status,
    });
  }
  return { resolved, unattributed, duplicates };
}

/**
 * What one conversion is worth to the operator.
 * `cpa`/`cpc` pay a fixed amount; `revshare` pays a share of the sale, so the
 * network's reported amount is the sale, not the payout.
 */
export function payoutFor(offer: Offer, conversion: ConversionEvent): number {
  switch (offer.payoutModel) {
    case "revshare":
      return conversion.amount * offer.payoutValue;
    case "cpa":
    case "cpc":
      // Trust the network's figure when it gives one; fall back to the
      // configured rate for networks that only report the event.
      return conversion.amount > 0 ? conversion.amount : offer.payoutValue;
  }
}

export type RevenueRollup = {
  readonly clicks: number;
  readonly conversions: number;
  /** Payout from conversions the network has approved. */
  readonly approvedRevenue: number;
  /** Payout from conversions still pending approval. */
  readonly pendingRevenue: number;
  readonly currency: string;
};

export const emptyRollup = (currency: string): RevenueRollup => ({
  clicks: 0,
  conversions: 0,
  approvedRevenue: 0,
  pendingRevenue: 0,
  currency,
});

export type AttributionInput = {
  readonly links: readonly TrackedLink[];
  readonly clicks: readonly ClickEvent[];
  readonly conversions: readonly ConversionEvent[];
  readonly offers: readonly Offer[];
  readonly defaultCurrency: string;
};

/** Revenue per post, for the analysis role and the console. */
export function revenueByPost(input: AttributionInput): Map<PostId, RevenueRollup> {
  const offerById = new Map(input.offers.map((offer) => [offer.id, offer]));
  const linkById = new Map(input.links.map((link) => [link.id, link]));
  const out = new Map<PostId, RevenueRollup>();

  const bump = (postId: PostId, change: Partial<RevenueRollup>): void => {
    const current = out.get(postId) ?? emptyRollup(input.defaultCurrency);
    out.set(postId, {
      clicks: current.clicks + (change.clicks ?? 0),
      conversions: current.conversions + (change.conversions ?? 0),
      approvedRevenue: current.approvedRevenue + (change.approvedRevenue ?? 0),
      pendingRevenue: current.pendingRevenue + (change.pendingRevenue ?? 0),
      currency: change.currency ?? current.currency,
    });
  };

  for (const click of input.clicks) {
    const postId = linkById.get(click.linkId)?.postId;
    if (postId) bump(postId, { clicks: 1 });
  }

  for (const conversion of input.conversions) {
    if (conversion.status === "rejected") continue;
    const link = linkById.get(conversion.linkId);
    if (!link?.postId) continue;
    const offer = offerById.get(link.offerId);
    if (!offer) continue;
    const payout = payoutFor(offer, conversion);
    bump(link.postId, {
      conversions: 1,
      currency: offer.currency,
      ...(conversion.status === "approved" ? { approvedRevenue: payout } : { pendingRevenue: payout }),
    });
  }

  return out;
}

/** Revenue per pattern - the number that decides what the company writes next. */
export function revenueByPattern(
  posts: readonly ScheduledPost[],
  byPost: Map<PostId, RevenueRollup>,
  defaultCurrency: string,
): Map<PatternId, RevenueRollup> {
  const out = new Map<PatternId, RevenueRollup>();
  for (const post of posts) {
    if (!post.patternId) continue;
    const rollup = byPost.get(post.id);
    if (!rollup) continue;
    const current = out.get(post.patternId) ?? emptyRollup(defaultCurrency);
    out.set(post.patternId, {
      clicks: current.clicks + rollup.clicks,
      conversions: current.conversions + rollup.conversions,
      approvedRevenue: current.approvedRevenue + rollup.approvedRevenue,
      pendingRevenue: current.pendingRevenue + rollup.pendingRevenue,
      currency: rollup.currency,
    });
  }
  return out;
}

/**
 * Totals, one per currency.
 *
 * Not one number: the moment a venture promotes a US offer alongside a
 * Japanese one, adding JPY to USD produces a figure that is wrong in a way
 * nobody notices until they try to reconcile it. There is no exchange rate in
 * this platform on purpose - inventing one would be worse than showing two
 * rows.
 */
export function totalsByCurrency(rollups: Iterable<RevenueRollup>): Map<string, RevenueRollup> {
  const out = new Map<string, RevenueRollup>();
  for (const rollup of rollups) {
    const current = out.get(rollup.currency) ?? emptyRollup(rollup.currency);
    out.set(rollup.currency, {
      clicks: current.clicks + rollup.clicks,
      conversions: current.conversions + rollup.conversions,
      approvedRevenue: current.approvedRevenue + rollup.approvedRevenue,
      pendingRevenue: current.pendingRevenue + rollup.pendingRevenue,
      currency: rollup.currency,
    });
  }
  return out;
}

/** Clicks and conversions summed across currencies - counts, not money. */
export function totalCounts(rollups: Iterable<RevenueRollup>): { clicks: number; conversions: number } {
  let clicks = 0;
  let conversions = 0;
  for (const rollup of rollups) {
    clicks += rollup.clicks;
    conversions += rollup.conversions;
  }
  return { clicks, conversions };
}

/**
 * One already-formatted line per currency: ["1,200 JPY", "34 USD"], or ["0"]
 * when there is nothing in any of them. The console sends this shape rather
 * than formatMoney's joined string so the browser never has to split a
 * sentence back into the parts it was built from.
 */
export function formatMoneyLines(
  totals: ReadonlyMap<string, RevenueRollup>,
  field: "approvedRevenue" | "pendingRevenue",
): string[] {
  const lines = [...totals.values()]
    .filter((rollup) => rollup[field] !== 0)
    .map((rollup) => `${Math.round(rollup[field]).toLocaleString("en-US")} ${rollup.currency}`);
  return lines.length > 0 ? lines : ["0"];
}

/** Renders per-currency totals as one line of text, "1,200 JPY / 34 USD". For terminals and reports. */
export function formatMoney(
  totals: ReadonlyMap<string, RevenueRollup>,
  field: "approvedRevenue" | "pendingRevenue",
): string {
  return formatMoneyLines(totals, field).join(" / ");
}
