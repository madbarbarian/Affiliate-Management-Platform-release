/**
 * What a licensee charges the operations running on their instance.
 *
 * This exists because the question "subscription or revenue share?" should not
 * have to be answered before the platform is built. Both are computed from
 * numbers the platform already tracks - approved affiliate revenue per venture -
 * so switching between them, or running different deals per tenant, is a config
 * change rather than a rewrite.
 *
 * It produces a **statement**, not an invoice. No money moves here, nothing is
 * charged, and there is no tax handling: what a licensee owes their own
 * jurisdiction is not something this platform can know. The statement is the
 * arithmetic, in a form an accountant can check.
 *
 * Revenue is never converted between currencies. A tenant earning in JPY and
 * USD produces two lines, because inventing an exchange rate here would put a
 * wrong number on something someone is going to be billed for.
 */

import type { LicensingConfig } from "../config/schema.ts";
import type { RevenueRollup } from "../affiliate/attribution.ts";
import type { VentureId } from "../core/types.ts";

export type BillingModel = "none" | "subscription" | "revshare";

export type ResolvedTerms = {
  readonly model: BillingModel;
  /** Flat amount per period, in `subscriptionCurrency`. */
  readonly subscriptionAmount: number;
  readonly subscriptionCurrency: string;
  /** Fraction of approved revenue, 0..1. */
  readonly revshareRate: number;
};

/** The deal that applies to one venture, after any per-venture override. */
export function termsFor(licensing: LicensingConfig, ventureId: VentureId): ResolvedTerms {
  const override = licensing.overrides.find((entry) => entry.venture === ventureId);
  return {
    model: override?.model ?? licensing.model,
    subscriptionAmount: override?.subscriptionAmount ?? licensing.subscriptionAmount,
    subscriptionCurrency: override?.subscriptionCurrency ?? licensing.subscriptionCurrency,
    revshareRate: override?.revshareRate ?? licensing.revshareRate,
  };
}

export type StatementLine = {
  readonly currency: string;
  /** Approved affiliate revenue the venture earned in this currency. */
  readonly grossRevenue: number;
  /** What the platform operator charges against it. */
  readonly fee: number;
  /** Why that number: the arithmetic, in words. */
  readonly basis: string;
};

export type VentureStatement = {
  readonly ventureId: VentureId;
  readonly ventureName: string;
  readonly terms: ResolvedTerms;
  readonly lines: readonly StatementLine[];
  /** Revenue still pending network approval - not billed, but worth showing. */
  readonly pendingByCurrency: readonly { readonly currency: string; readonly amount: number }[];
};

export type StatementPeriod = {
  readonly fromIso: string;
  readonly toIso: string;
  readonly days: number;
};

export function buildStatement(input: {
  readonly licensing: LicensingConfig;
  readonly ventureId: VentureId;
  readonly ventureName: string;
  readonly totals: ReadonlyMap<string, RevenueRollup>;
  readonly period: StatementPeriod;
}): VentureStatement {
  const terms = termsFor(input.licensing, input.ventureId);
  const lines: StatementLine[] = [];

  for (const rollup of input.totals.values()) {
    if (rollup.approvedRevenue === 0) continue;
    if (terms.model === "revshare") {
      lines.push({
        currency: rollup.currency,
        grossRevenue: rollup.approvedRevenue,
        fee: round(rollup.approvedRevenue * terms.revshareRate, 2),
        basis: `${(terms.revshareRate * 100).toFixed(1)}% of ${format(rollup.approvedRevenue)} ${rollup.currency} approved`,
      });
    } else {
      lines.push({
        currency: rollup.currency,
        grossRevenue: rollup.approvedRevenue,
        fee: 0,
        basis:
          terms.model === "subscription"
            ? "revenue reported for reference; the fee is a flat subscription"
            : "no billing configured",
      });
    }
  }

  // A subscription is owed whether or not anything converted, so it is a line
  // of its own rather than something attached to a revenue currency.
  if (terms.model === "subscription") {
    const periods = input.period.days / 30;
    lines.push({
      currency: terms.subscriptionCurrency,
      grossRevenue: 0,
      fee: round(terms.subscriptionAmount * periods, 2),
      basis:
        `${format(terms.subscriptionAmount)} ${terms.subscriptionCurrency} per 30 days ` +
        `× ${periods.toFixed(2)} periods (${input.period.days} days)`,
    });
  }

  return {
    ventureId: input.ventureId,
    ventureName: input.ventureName,
    terms,
    lines,
    pendingByCurrency: [...input.totals.values()]
      .filter((rollup) => rollup.pendingRevenue !== 0)
      .map((rollup) => ({ currency: rollup.currency, amount: rollup.pendingRevenue })),
  };
}

/** A plain-text statement. Deliberately boring: it has to be checkable. */
export function renderStatement(statement: VentureStatement, period: StatementPeriod): string {
  const lines: string[] = [
    `${statement.ventureName} (${statement.ventureId})`,
    `  period      ${period.fromIso.slice(0, 10)} → ${period.toIso.slice(0, 10)} (${period.days} days)`,
    `  terms       ${describeTerms(statement.terms)}`,
  ];

  if (statement.lines.length === 0) {
    lines.push("  nothing to bill for this period");
  }
  for (const line of statement.lines) {
    lines.push(`  ${format(line.fee)} ${line.currency}`.padEnd(30) + `← ${line.basis}`);
  }
  for (const pending of statement.pendingByCurrency) {
    lines.push(`  (${format(pending.amount)} ${pending.currency} still pending network approval — not billed)`);
  }
  return lines.join("\n");
}

export function describeTerms(terms: ResolvedTerms): string {
  switch (terms.model) {
    case "revshare":
      return `revenue share, ${(terms.revshareRate * 100).toFixed(1)}% of approved revenue`;
    case "subscription":
      return `subscription, ${format(terms.subscriptionAmount)} ${terms.subscriptionCurrency} per 30 days`;
    case "none":
      return "no billing (running it for yourself)";
  }
}

function format(value: number): string {
  return Math.round(value * 100) / 100 === Math.round(value)
    ? Math.round(value).toLocaleString("en-US")
    : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
