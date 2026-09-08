/**
 * The affiliate-network port.
 *
 * Networks differ wildly in what they expose, so the platform asks for the
 * least it can work with: what can I promote, and what did I earn. Everything
 * else - deep-link builders, creative libraries, payment schedules - is
 * deliberately out of scope, because none of it changes what the company does
 * each day.
 */

import type { PlatformError, Result } from "../core/result.ts";
import type { ConversionStatus, Offer } from "../core/types.ts";

/**
 * A conversion as the network reports it. `subId` is the tracking code the
 * platform put on the outbound link, which is what ties revenue back to a
 * specific post, pattern and idea.
 */
export type NetworkConversion = {
  readonly externalId: string;
  readonly subId: string;
  readonly at: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: ConversionStatus;
};

export type OfferNetwork = {
  readonly id: string;
  readonly adapter: string;
  /**
   * Offers the account may promote. Networks that have no catalogue API return
   * an empty list and the operator declares offers in config instead.
   */
  listOffers(): Promise<Result<Offer[], PlatformError>>;
  fetchConversions(sinceIso: string): Promise<Result<NetworkConversion[], PlatformError>>;
  /**
   * Turns a landing URL into the network's own tracked URL, carrying our
   * `subId`. Networks that use a plain query parameter can use the default.
   */
  buildTrackedUrl(input: { landingUrl: string; subId: string }): Result<string, PlatformError>;
  healthCheck(): Promise<Result<string, PlatformError>>;
};

export type NetworkFactory = (context: NetworkFactoryContext) => OfferNetwork;

export type NetworkFactoryContext = {
  readonly id: string;
  readonly credentials: Readonly<Record<string, string>>;
  readonly options: Readonly<Record<string, unknown>>;
  readonly nowMs: () => number;
};
