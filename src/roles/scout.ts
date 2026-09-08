/**
 * The scout - the seventh role, and the only one that works for the company
 * rather than for one venture.
 *
 * Inside a venture the platform already forms and tests hypotheses on its own.
 * The judgement it left entirely to the human was which ventures to have. The
 * scout does not take that judgement away; it prepares it. Once a week it reads
 * the aggregates of every account and proposes the next one, with the evidence
 * it leaned on, the honest way it fails, and the signal that would mean stop.
 * A person accepts or dismisses. Nothing is created by accepting except a
 * config block to paste.
 *
 * Two things the code enforces after the model has answered, because a model
 * asked "is this allowed here?" will say yes:
 *
 * - a proposal may only name a market the company is configured for, offers
 *   that exist and are permitted in that market, and a category that market
 *   does not prohibit;
 * - a proposal must not duplicate a niche the company already runs, and must
 *   carry a stopping rule. A hypothesis that cannot say what would disprove it
 *   is not one.
 */

import { ok, type PlatformError, type Result } from "../core/result.ts";
import type { Market, Offer, VentureProposal } from "../core/types.ts";
import { describePortfolioForScout, type Portfolio } from "../domain/portfolio.ts";
import { companyPrinciples, type CompanyContext, type Role } from "../kernel/role.ts";
import { array, enumOf, object, string } from "../llm/schema.ts";
import { formatOffers } from "./format.ts";

export type ScoutInput = {
  readonly count: number;
  readonly portfolio: Portfolio;
};

export type DroppedProposal = {
  readonly niche: string;
  readonly reason: string;
};

export type ScoutOutput = {
  readonly proposals: readonly VentureProposal[];
  /** What the model proposed that the code refused, and why. Audited. */
  readonly dropped: readonly DroppedProposal[];
};

/**
 * The category is a closed list, not free text. The prohibited-category check
 * compares this label against the market's list, and a label the model
 * invents ("entertainment" for a casino account) would slide past a string
 * comparison. Structured output enforces the enum, so the model has to pick
 * the market's own word for the thing - or "other", which the human sees.
 */
const proposalSchema = (categories: readonly string[]) => object({
  proposals: array(
    object({
      niche: string("What the account is about, in the operator's language."),
      audience: string("Who it is for. A sentence a real reader would recognise as themselves."),
      market: string("A market id from the list you were given."),
      language: string("BCP-47, e.g. ja."),
      category: enumOf(categories, "The main product category. Pick the closest; 'other' only if none fits."),
      ventureId: string("A short ASCII slug for ventures[].id, e.g. parenting-tools."),
      nameCandidates: array(string(), { minItems: 1, maxItems: 3 }),
      voice: object({
        persona: string(),
        firstPerson: string(),
        tone: array(string(), { maxItems: 4 }),
      }),
      offerIds: array(string("An offer id you were shown, permitted in this market. May be empty.")),
      hypothesis: string("Why this would work, citing the aggregates you were given."),
      evidence: string("The numbers you leaned on, by account."),
      risk: string("The honest way this fails."),
      firstHooks: array(string(), { minItems: 1, maxItems: 3 }),
      killSignal: string("What, measured over the first month, would mean stop. Concrete."),
    }),
  ),
});

type ProposalResponse = {
  proposals: {
    niche: string;
    audience: string;
    market: string;
    language: string;
    category: string;
    ventureId: string;
    nameCandidates: string[];
    voice: { persona: string; firstPerson: string; tone: string[] };
    offerIds: string[];
    hypothesis: string;
    evidence: string;
    risk: string;
    firstHooks: string[];
    killSignal: string;
  }[];
};

export const scout: Role<ScoutInput, ScoutOutput, CompanyContext> = {
  id: "scout",
  title: "探索担当 / Scout",
  description:
    "Once a week, reads every account's numbers and proposes the next account to try - with evidence, a risk, and the signal that would mean stop.",

  async run(context: CompanyContext, input: ScoutInput): Promise<Result<ScoutOutput, PlatformError>> {
    const { config, clock, store } = context;
    const markets = config.markets;
    const offers = config.offers.filter((offer) => offer.active);
    // A proposal still waiting, or already accepted, occupies its niche as
    // much as a running venture does. Without this, week two re-proposes
    // week one's idea under the same suggested id.
    const openProposals = await store.proposals.find((proposal) => proposal.status !== "dismissed");
    const existingNiches = [
      ...config.ventures.map((venture) => venture.niche),
      ...openProposals.map((proposal) => `${proposal.niche} (already proposed, ${proposal.status})`),
    ];
    const categories = [
      ...new Set([
        ...offers.map((offer) => offer.category.toLowerCase()),
        ...markets.flatMap((market) => market.restrictedCategories.map((entry) => entry.category.toLowerCase())),
        "other",
      ]),
    ];

    const response = await context.llm.completeJson<ProposalResponse>({
      purpose: "scout.propose",
      tier: "primary",
      system: `${companyBrief(context)}\n\n${context.prompts.render("scout.system")}`,
      user: context.prompts.render("scout.user", {
        count: input.count,
        principles: bullets(config.company.principles, "(the company has not written its principles down yet)"),
        boundaries: bullets(config.company.boundaries, "(none declared - the policy's prohibited claims still apply)"),
        ventures: describePortfolioForScout(input.portfolio),
        existingNiches: bullets(existingNiches, "(none)"),
        markets: formatMarkets(markets),
        offers: formatOffersWithMarkets(offers),
        categories: categories.join(", "),
      }),
      schema: proposalSchema(categories),
    });
    if (!response.ok) return response;

    const takenNiches = new Set([
      ...config.ventures.map((venture) => normalise(venture.niche)),
      ...openProposals.map((proposal) => normalise(proposal.niche)),
    ]);
    const guarded = guardProposals(response.value.proposals, { markets, offers, takenNiches }, input.count);
    const nowIso = clock.nowIso();
    const takenIds = new Set([
      ...config.ventures.map((venture) => venture.id),
      ...openProposals.map((proposal) => proposal.suggestedVentureId),
    ]);

    const proposals: VentureProposal[] = guarded.kept.map((proposed, index) => ({
      id: context.ids.next("prp"),
      createdAt: nowIso,
      status: "proposed",
      niche: proposed.niche.trim(),
      audience: proposed.audience.trim(),
      market: proposed.market,
      language: proposed.language.trim() || marketLanguage(markets, proposed.market),
      category: proposed.category.trim().toLowerCase(),
      nameCandidates: proposed.nameCandidates.map((name) => name.trim()).filter((name) => name !== ""),
      voice: {
        persona: proposed.voice.persona.trim(),
        firstPerson: proposed.voice.firstPerson.trim() || "私",
        tone: proposed.voice.tone.map((tone) => tone.trim()).filter((tone) => tone !== ""),
      },
      offerIds: proposed.offerIds,
      hypothesis: proposed.hypothesis.trim(),
      evidence: proposed.evidence.trim(),
      risk: proposed.risk.trim(),
      firstHooks: proposed.firstHooks.map((hook) => hook.trim()).filter((hook) => hook !== ""),
      killSignal: proposed.killSignal.trim(),
      suggestedVentureId: uniqueSlug(proposed.ventureId, takenIds, index),
    }));

    for (const dropped of guarded.dropped) {
      await context.note("role.scout.dropped_proposal", `Dropped "${dropped.niche}": ${dropped.reason}`, {
        niche: dropped.niche,
        reason: dropped.reason,
      });
    }

    return ok({ proposals, dropped: guarded.dropped });
  },
};

// ---------------------------------------------------------------------------
// Guardrails - code, after the model
// ---------------------------------------------------------------------------

type Proposed = ProposalResponse["proposals"][number];

function guardProposals(
  proposed: readonly Proposed[],
  scope: { markets: readonly Market[]; offers: readonly Offer[]; takenNiches: ReadonlySet<string> },
  limit: number,
): { kept: Proposed[]; dropped: DroppedProposal[] } {
  const marketById = new Map(scope.markets.map((market) => [market.id, market]));
  const offerById = new Map(scope.offers.map((offer) => [offer.id, offer]));
  const { takenNiches } = scope;
  const kept: Proposed[] = [];
  const dropped: DroppedProposal[] = [];
  const seen = new Set<string>();

  for (const candidate of proposed) {
    const niche = candidate.niche.trim();
    const market = marketById.get(candidate.market);
    if (!market) {
      dropped.push({ niche, reason: `market "${candidate.market}" is not one this company is configured for` });
      continue;
    }
    const category = candidate.category.trim().toLowerCase();
    const restriction = market.restrictedCategories.find((entry) => entry.category.toLowerCase() === category);
    if (restriction?.prohibited) {
      dropped.push({ niche, reason: `market "${market.id}" prohibits the "${category}" category: ${restriction.note}` });
      continue;
    }
    if (takenNiches.has(normalise(niche)) || seen.has(normalise(niche))) {
      dropped.push({ niche, reason: "an account or an open proposal with this niche already exists" });
      continue;
    }
    if (candidate.killSignal.trim() === "") {
      dropped.push({ niche, reason: "no stopping rule - a proposal that cannot say what would disprove it is not a hypothesis" });
      continue;
    }

    // Offer references are trimmed, not fatal: "no permitted offer" is a true
    // and useful answer about this market, not a flaw in the idea.
    const offerIds = candidate.offerIds.filter((offerId) => {
      const offer = offerById.get(offerId);
      return offer !== undefined && offer.targetMarkets.includes(market.id);
    });

    seen.add(normalise(niche));
    kept.push({ ...candidate, niche, offerIds });
    if (kept.length >= limit) break;
  }
  return { kept, dropped };
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function uniqueSlug(suggested: string, taken: Set<string>, index: number): string {
  const base =
    suggested
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || `venture-${index + 1}`;
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  taken.add(slug);
  return slug;
}

function marketLanguage(markets: readonly Market[], marketId: string): string {
  return markets.find((market) => market.id === marketId)?.language ?? "ja";
}

// ---------------------------------------------------------------------------
// Prompt material
// ---------------------------------------------------------------------------

/** The company half of the brief: no venture, because there is none yet. */
function companyBrief(context: CompanyContext): string {
  return [`# 会社 / Company brief`, ``, `- Company: ${context.config.company.name}`, ``, ...companyPrinciples(context.config)].join(
    "\n",
  );
}

function bullets(lines: readonly string[], empty: string): string {
  return lines.length === 0 ? empty : lines.map((line) => `- ${line}`).join("\n");
}

function formatMarkets(markets: readonly Market[]): string {
  return markets
    .map((market) =>
      [
        `### [market:${market.id}] ${market.name}`,
        `- language: ${market.language}, currency: ${market.currency}, timezone: ${market.timezone}`,
        `- regulator: ${market.regulator}`,
        market.restrictedCategories.length > 0
          ? `- restricted categories: ${market.restrictedCategories
              .map((entry) => `${entry.category}${entry.prohibited ? " (PROHIBITED)" : ""}`)
              .join(", ")}`
          : "- restricted categories: (none)",
      ].join("\n"),
    )
    .join("\n\n");
}

function formatOffersWithMarkets(offers: readonly Offer[]): string {
  if (offers.length === 0) return "(no offers - every proposal will have an empty offerIds)";
  return offers
    .map((offer) => `${formatOffers([offer])}\n- targetMarkets: ${offer.targetMarkets.join(", ")}`)
    .join("\n\n");
}
