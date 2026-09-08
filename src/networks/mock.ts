/**
 * A simulated affiliate network.
 *
 * Conversions are derived from the tracking codes the platform has actually
 * issued, at a deterministic rate, so a dry run produces a revenue column that
 * moves when the content changes - which is the only way to tell whether the
 * analysis role's feedback loop is wired up correctly.
 */

import { createHash } from "node:crypto";

import { ok, type PlatformError, type Result } from "../core/result.ts";
import type { Offer } from "../core/types.ts";
import type { NetworkConversion, NetworkFactoryContext, OfferNetwork } from "./network.ts";

export type MockNetworkOptions = {
  /** Tracking codes the platform has issued. Injected by the runtime. */
  readonly knownSubIds?: () => readonly string[];
};

export function createMockNetwork(
  context: NetworkFactoryContext,
  options: MockNetworkOptions = {},
): OfferNetwork {
  const conversionRate = Number(context.options["conversionRate"] ?? 0.06);
  const payout = Number(context.options["payout"] ?? 2500);
  const currency = String(context.options["currency"] ?? "JPY");

  return {
    id: context.id,
    adapter: "mock",

    async listOffers(): Promise<Result<Offer[], PlatformError>> {
      // The mock network has no catalogue - offers come from config.
      return ok([]);
    },

    async fetchConversions(sinceIso): Promise<Result<NetworkConversion[], PlatformError>> {
      const since = Date.parse(sinceIso);
      const subIds = options.knownSubIds?.() ?? [];
      const conversions: NetworkConversion[] = [];
      for (const subId of subIds) {
        const roll = hashUnit(`${context.id}:${subId}`);
        if (roll > conversionRate) continue;
        const at = new Date(Math.max(since, context.nowMs() - 6 * 3_600_000)).toISOString();
        conversions.push({
          externalId: `mockconv_${hashHex(subId, 16)}`,
          subId,
          at,
          amount: payout,
          currency,
          // A quarter of conversions stay pending, as they would in reality.
          status: hashUnit(`${subId}:status`) < 0.25 ? "pending" : "approved",
        });
      }
      return ok(conversions);
    },

    buildTrackedUrl({ landingUrl, subId }) {
      const url = new URL(landingUrl);
      url.searchParams.set(String(context.options["subIdParam"] ?? "subid"), subId);
      return ok(url.toString());
    },

    async healthCheck(): Promise<Result<string, PlatformError>> {
      return ok(`mock network ready (simulated ${(conversionRate * 100).toFixed(1)}% conversion)`);
    },
  };
}

function hashHex(input: string, length: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

/** A stable pseudo-random number in [0, 1) derived from the input. */
function hashUnit(input: string): number {
  return createHash("sha256").update(input).digest().readUInt32BE(0) / 0xffff_ffff;
}
