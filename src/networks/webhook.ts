/**
 * A generic HTTP affiliate network.
 *
 * Same reasoning as the webhook channel: most networks either have no public
 * API or have one nobody wants to hand-roll, and operators usually already
 * export conversions somewhere. This adapter reads from whatever endpoint the
 * licensee points it at. The request/response contract is in
 * docs/3-development/extending.md.
 */

import { fail, ok, tryAsync, type PlatformError, type Result } from "../core/result.ts";
import type { ConversionStatus, Offer, PayoutModel } from "../core/types.ts";
import type { NetworkConversion, NetworkFactoryContext, OfferNetwork } from "./network.ts";

export function createWebhookNetwork(context: NetworkFactoryContext): OfferNetwork {
  const offersUrl = readString(context.options, "offersUrl");
  const conversionsUrl = readString(context.options, "conversionsUrl");
  const subIdParam = String(context.options["subIdParam"] ?? "subid");
  const timeoutMs = Number(context.options["timeoutMs"] ?? 30_000);
  const token = context.credentials["token"] ?? "";
  const defaultOriginMarket = String(context.options["originMarket"] ?? "");
  const defaultTargetMarkets = Array.isArray(context.options["targetMarkets"])
    ? (context.options["targetMarkets"] as unknown[]).filter((market): market is string => typeof market === "string")
    : [];
  const defaultCrossBorderNote = String(context.options["crossBorderNote"] ?? "");

  const call = async <T>(url: string | undefined, name: string, query: Record<string, string>): Promise<Result<T, PlatformError>> => {
    if (!url) return fail("config", "network.endpoint_missing", `Network "${context.id}" has no options.${name}Url configured.`);
    const attempt = await tryAsync("network", "network.request_failed", async () => {
      const target = new URL(url);
      for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
      const response = await fetch(target, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, text: await response.text() };
    }, { retryable: true });

    if (!attempt.ok) return attempt;
    const { status, text } = attempt.value;
    if (status < 200 || status >= 300) {
      return fail("network", "network.http_error", `${name} endpoint for "${context.id}" returned HTTP ${status}.`, {
        retryable: status >= 500 || status === 429,
        details: { body: text.slice(0, 300) },
      });
    }
    try {
      return ok(JSON.parse(text) as T);
    } catch (cause) {
      return fail("network", "network.invalid_json", `${name} endpoint for "${context.id}" did not return JSON.`, { cause });
    }
  };

  return {
    id: context.id,
    adapter: "webhook",

    async listOffers(): Promise<Result<Offer[], PlatformError>> {
      if (!offersUrl) return ok([]);
      const response = await call<{ offers?: unknown[] }>(offersUrl, "offers", {});
      if (!response.ok) return response;
      const offers: Offer[] = [];
      for (const raw of response.value.offers ?? []) {
        const item = (raw ?? {}) as Record<string, unknown>;
        if (typeof item["id"] !== "string" || typeof item["landingUrl"] !== "string") continue;
        offers.push({
          id: item["id"],
          network: context.id,
          name: typeof item["name"] === "string" ? item["name"] : item["id"],
          landingUrl: item["landingUrl"],
          payoutModel: isPayoutModel(item["payoutModel"]) ? item["payoutModel"] : "cpa",
          payoutValue: typeof item["payoutValue"] === "number" ? item["payoutValue"] : 0,
          currency: typeof item["currency"] === "string" ? item["currency"] : "JPY",
          category: typeof item["category"] === "string" ? item["category"] : "general",
          // A catalogue that does not say where an offer may run is assumed to
          // mean the network's own territory, which the operator declares.
          originMarket: typeof item["originMarket"] === "string" ? item["originMarket"] : defaultOriginMarket,
          targetMarkets: Array.isArray(item["targetMarkets"])
            ? item["targetMarkets"].filter((market): market is string => typeof market === "string")
            : defaultTargetMarkets,
          crossBorderNote: typeof item["crossBorderNote"] === "string" ? item["crossBorderNote"] : defaultCrossBorderNote,
          complianceNotes: Array.isArray(item["complianceNotes"])
            ? item["complianceNotes"].filter((note): note is string => typeof note === "string")
            : [],
          active: item["active"] !== false,
        });
      }
      return ok(offers);
    },

    async fetchConversions(sinceIso): Promise<Result<NetworkConversion[], PlatformError>> {
      const response = await call<{ conversions?: unknown[] }>(conversionsUrl, "conversions", { since: sinceIso });
      if (!response.ok) return response;
      const conversions: NetworkConversion[] = [];
      for (const raw of response.value.conversions ?? []) {
        const item = (raw ?? {}) as Record<string, unknown>;
        const subId = item["subId"] ?? item[subIdParam];
        if (typeof item["externalId"] !== "string" || typeof subId !== "string") continue;
        conversions.push({
          externalId: item["externalId"],
          subId,
          at: typeof item["at"] === "string" ? item["at"] : new Date(context.nowMs()).toISOString(),
          amount: typeof item["amount"] === "number" ? item["amount"] : 0,
          currency: typeof item["currency"] === "string" ? item["currency"] : "JPY",
          status: isConversionStatus(item["status"]) ? item["status"] : "pending",
        });
      }
      return ok(conversions);
    },

    buildTrackedUrl({ landingUrl, subId }) {
      try {
        const url = new URL(landingUrl);
        url.searchParams.set(subIdParam, subId);
        return ok(url.toString());
      } catch (cause) {
        return fail("validation", "network.bad_landing_url", `Offer landing URL is not a valid URL: ${landingUrl}`, { cause });
      }
    },

    async healthCheck(): Promise<Result<string, PlatformError>> {
      // A malformed configured URL used to throw out of `amp doctor` as a raw
      // stack trace. Doctor's whole job is reporting problems in a form the
      // operator can act on, so it reports this one too.
      if (!conversionsUrl) {
        return fail("config", "network.endpoint_missing", `Network "${context.id}" needs options.conversionsUrl.`);
      }
      try {
        return ok(`webhook network configured (${new URL(conversionsUrl).origin})`);
      } catch {
        return fail(
          "config",
          "network.bad_endpoint",
          `Network "${context.id}" has options.conversionsUrl = "${conversionsUrl}", which is not a URL. ` +
            `Use a full address, e.g. "https://api.example.com/conversions".`,
        );
      }
    },
  };
}

function readString(options: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isPayoutModel(value: unknown): value is PayoutModel {
  return value === "cpa" || value === "cpc" || value === "revshare";
}

function isConversionStatus(value: unknown): value is ConversionStatus {
  return value === "pending" || value === "approved" || value === "rejected";
}
