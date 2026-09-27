/**
 * The one- or two-character monogram shown next to a channel's identity.
 *
 * `docs/3-development/visual-polish-proposal.md` §4.1-4.3: `ChannelConfig.id`
 * is a free string, so this file can only ever mechanically recognise the
 * handful of names the platform itself ships and documents
 * (`platform.config.example.yaml`, `docs/3-development/integrations.md` §3).
 * Anything else is a licensee's own webhook destination, and gets the same
 * honest "unknown" mark every time - never a guess dressed up as one of the
 * known letters.
 *
 * No brand logos, no emoji: §4.2 rejected both (trademark/accuracy risk for
 * the former, unverifiable cross-platform rendering for the latter). This is
 * text in a pill, the same mechanism `.chip` already is.
 */

/** Every channel id this product itself ships and documents a letter for. */
export const KNOWN_CHANNEL_MONOGRAMS: Readonly<Record<string, string>> = {
  threads: "T",
  x: "X",
  note: "n",
  youtube: "YT",
  // "手" (hand): this product's own voice is Japanese, and one kanji character
  // says "not automatic" at a glance better than a Roman initial would (§4.2).
  "by-hand": "手",
};

/** The mark for any channel id `KNOWN_CHANNEL_MONOGRAMS` does not name. */
export const UNKNOWN_CHANNEL_MONOGRAM = "?";

/** Whether `channelId` is one of the names this product itself recognises. */
export function isKnownChannel(channelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(KNOWN_CHANNEL_MONOGRAMS, channelId);
}

/** The badge's text for `channelId`: a known letter, or the honest fallback. */
export function channelMonogram(channelId: string): string {
  return isKnownChannel(channelId) ? KNOWN_CHANNEL_MONOGRAMS[channelId]! : UNKNOWN_CHANNEL_MONOGRAM;
}
