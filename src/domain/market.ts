/**
 * Resolving which rules apply to a given post.
 *
 * The principle the whole cross-border feature rests on: **compliance follows
 * the audience, not the merchant.** A US product promoted to a Japanese
 * audience is governed by 景品表示法 and the stealth-marketing rules, and the
 * disclosure has to be in Japanese - the FTC's guides are not what protects
 * that reader. The merchant's own market only decides what extra caveats the
 * reader is owed: currency, shipping, language support, who they are actually
 * contracting with.
 *
 * Both halves are computed here so the policy checks, the writing role and the
 * inspection role cannot disagree about them.
 */

import type { PolicyConfig } from "../config/schema.ts";
import type { Market, MarketId, Offer } from "../core/types.ts";

export type ComplianceProfile = {
  readonly market: Market | undefined;
  /** The disclosure that must appear, in the audience's language. */
  readonly disclosureText: string;
  /** Platform-wide claims plus this market's own. */
  readonly prohibitedClaims: readonly string[];
  /** Category rules that apply to this offer in this market. */
  readonly categoryNotes: readonly string[];
  /** True when the merchant sits outside the audience's market. */
  readonly crossBorder: boolean;
  /**
   * What the reader must be told because the merchant is abroad. Empty when
   * the promotion is domestic.
   */
  readonly crossBorderNotes: readonly string[];
  readonly regulator: string;
  readonly currency: string;
};

export function findMarket(markets: readonly Market[], id: MarketId | undefined): Market | undefined {
  return id === undefined ? undefined : markets.find((market) => market.id === id);
}

export function resolveCompliance(input: {
  readonly policy: PolicyConfig;
  readonly market: Market | undefined;
  readonly offer?: Offer;
}): ComplianceProfile {
  const { policy, market, offer } = input;

  const crossBorder = offer !== undefined && market !== undefined && offer.originMarket !== market.id;

  const crossBorderNotes: string[] = [];
  if (crossBorder && offer) {
    if (offer.crossBorderNote.trim() !== "") crossBorderNotes.push(offer.crossBorderNote.trim());
    if (market?.crossBorderNotice.trim()) crossBorderNotes.push(market.crossBorderNotice.trim());
  }

  const categoryNotes = (market?.restrictedCategories ?? [])
    .filter((entry) => offer !== undefined && entry.category === offer.category)
    .map((entry) => entry.note);

  return {
    market,
    // A market's own wording wins: a Japanese reader needs a Japanese
    // disclosure, whatever the platform-wide default happens to say.
    disclosureText: market?.disclosureText.trim() || policy.disclosureText,
    prohibitedClaims: [...policy.prohibitedClaims, ...(market?.prohibitedClaims ?? [])],
    categoryNotes,
    crossBorder,
    crossBorderNotes,
    regulator: market?.regulator ?? "(no market declared)",
    currency: market?.currency ?? offer?.currency ?? "JPY",
  };
}

/** A block describing the rules, for embedding in a prompt. */
export function describeCompliance(profile: ComplianceProfile): string {
  const lines: string[] = [];
  if (profile.market) {
    lines.push(`- Audience market: ${profile.market.name} (${profile.market.id}), reading in ${profile.market.language}`);
    lines.push(`- Governed by: ${profile.regulator}`);
  }
  lines.push(`- Required disclosure, verbatim: ${profile.disclosureText}`);
  if (profile.prohibitedClaims.length > 0) {
    lines.push(`- Never claim: ${profile.prohibitedClaims.join(" / ")}`);
  }
  for (const note of profile.categoryNotes) {
    lines.push(`- Category rule you must honour: ${note}`);
  }
  if (profile.crossBorder) {
    lines.push(
      `- This is a CROSS-BORDER promotion. The reader is in a different country from the merchant, ` +
        `so they must be told the following before they click, in the body of the post - not in a footnote:`,
    );
    for (const note of profile.crossBorderNotes) lines.push(`  - ${note}`);
  }
  return lines.join("\n");
}
