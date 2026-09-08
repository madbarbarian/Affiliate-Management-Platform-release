/**
 * Tracked links.
 *
 * Every post that carries an offer gets its own link, and the link's code is
 * derived deterministically from (venture, offer, post). That matters more
 * than it looks: it means the same post always maps to the same code, so a
 * restart, a re-host, or a rebuilt data directory does not orphan the revenue
 * that has already been earned against it.
 *
 * The short URL in the post points at the operator's own redirector, not the
 * network. That keeps the visible link stable, lets clicks be counted before
 * the hand-off, and means switching networks does not invalidate old posts.
 */

import { stableCode } from "../core/ids.ts";
import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import type { TrackingConfig } from "../config/schema.ts";
import type { Offer, PostId, TrackedLink, VentureId } from "../core/types.ts";
import type { OfferNetwork } from "../networks/network.ts";

export type IssueLinkInput = {
  readonly ventureId: VentureId;
  readonly offer: Offer;
  readonly postId?: PostId;
  /** Distinguishes links issued for the same offer within one venture. */
  readonly discriminator?: string;
  readonly network: OfferNetwork;
  readonly tracking: TrackingConfig;
  readonly nowMs: number;
};

export function issueLink(input: IssueLinkInput): Result<TrackedLink, PlatformError> {
  const seed = [input.ventureId, input.offer.id, input.postId ?? "", input.discriminator ?? ""].join("|");
  const code = stableCode(seed, 10);

  const tracked = input.network.buildTrackedUrl({ landingUrl: input.offer.landingUrl, subId: code });
  if (!tracked.ok) return tracked;

  let destinationUrl: string;
  try {
    const url = new URL(tracked.value);
    for (const [key, value] of Object.entries(input.tracking.extraParams)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set(input.tracking.linkParam, code);
    destinationUrl = url.toString();
  } catch (cause) {
    return fail("validation", "link.bad_url", `Could not build a tracked URL for offer "${input.offer.id}".`, { cause });
  }

  return ok({
    id: `lnk_${code}`,
    ventureId: input.ventureId,
    offerId: input.offer.id,
    ...(input.postId ? { postId: input.postId } : {}),
    code,
    destinationUrl,
    createdAt: new Date(input.nowMs).toISOString(),
  });
}

/** The URL that goes in the post: the operator's redirector, not the network. */
/**
 * The URL that goes in a post.
 *
 * The `/go/` segment is not decoration: it is the path the console's redirect
 * actually answers on. Without it, every link a licensee published resolved to
 * nothing - a 404 for the reader and no click recorded - while the documented
 * `baseUrl: "https://go.yourdomain.com"` looked exactly right. Building the
 * path here rather than asking licensees to include it in `baseUrl` keeps the
 * two ends of the redirect defined in one place.
 */
export function shortUrl(tracking: TrackingConfig, link: TrackedLink): string {
  const base = tracking.baseUrl.replace(/\/$/, "");
  return `${base}${REDIRECT_PATH}${link.code}`;
}

/** Where the console serves the redirect. Both ends read this. */
export const REDIRECT_PATH = "/go/";

/** Reverse lookup used when the redirector or a network reports a code. */
export function findByCode(links: readonly TrackedLink[], code: string): TrackedLink | undefined {
  return links.find((link) => link.code === code);
}
