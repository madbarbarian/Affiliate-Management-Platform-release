/**
 * Rendering domain records into prompt blocks.
 *
 * Kept in one place because consistency here is what lets a prompt reference
 * "the id in brackets" and have that be true in every role.
 */

import { engagementScore } from "../domain/engagement.ts";
import { shortUrl } from "../affiliate/links.ts";
import type { TrackingConfig } from "../config/schema.ts";
import type {
  Draft,
  DraftContent,
  Idea,
  InspectionFinding,
  Offer,
  Pattern,
  ScheduledPost,
  SwipeItem,
  TrackedLink,
} from "../core/types.ts";
import type { RevenueRollup } from "../affiliate/attribution.ts";

export function formatSwipeItems(items: readonly SwipeItem[], limit = 30): string {
  if (items.length === 0) return "(nothing cleared the engagement filter today)";
  return items
    .slice(0, limit)
    .map((item) => {
      const score = engagementScore(item.snapshot);
      return [
        `### [${item.id}] ${item.author ?? "unknown"} — score ${score}`,
        `likes ${item.snapshot.likes} / replies ${item.snapshot.replies} / reposts ${item.snapshot.reposts}`,
        "```",
        item.text.slice(0, 700),
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

export function formatPatterns(patterns: readonly Pattern[]): string {
  if (patterns.length === 0) return "(the playbook is empty - everything is untested)";
  return patterns
    .map((pattern) =>
      [
        `### [${pattern.id}] ${pattern.name}`,
        `- kind: ${pattern.kind}`,
        `- status: ${pattern.status} (confidence ${pattern.confidence.toFixed(2)}, ${pattern.evidence.length} observations)`,
        `- template: ${pattern.template}`,
        `- why it works: ${pattern.whyItWorks}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function formatOffers(offers: readonly Offer[]): string {
  if (offers.length === 0) return "(no offers in scope - write posts with no product attached)";
  return offers
    .map((offer) =>
      [
        `### [${offer.id}] ${offer.name}`,
        `- category: ${offer.category}`,
        `- payout: ${offer.payoutModel} ${offer.payoutValue}${offer.payoutModel === "revshare" ? " (share of sale)" : ` ${offer.currency}`}`,
        offer.complianceNotes.length > 0 ? `- rules: ${offer.complianceNotes.join("; ")}` : "- rules: (none stated)",
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * The offer block every role that writes text puts in front of the model.
 *
 * It takes the link *record*, never a URL, and derives the reader-facing one
 * itself. Three callers used to each choose which URL to hand over, and the
 * inspector chose the network's own landing page instead of the redirect. The
 * inspector rewrites the whole body, so every post that carried an offer
 * shipped that direct URL in place of `/go/<code>`, and a click from a post
 * body was never counted. A caller that cannot pass a URL cannot pass the
 * wrong one, so the choice lives here or nowhere.
 *
 * A per-offer `direct` mode (Amazon forbids redirecting its links) would be
 * decided in this function, not back at the call sites.
 */
export function formatOffer(
  offer: Offer | undefined,
  link: TrackedLink | undefined,
  tracking: TrackingConfig,
): string {
  if (!offer) return "(no offer on this post - write it with nothing to sell)";
  return [
    `- name: ${offer.name}`,
    `- what it is: ${offer.category}`,
    `- link to use: ${link ? shortUrl(tracking, link) : "(no link issued)"}`,
    offer.complianceNotes.length > 0 ? `- rules you must honour: ${offer.complianceNotes.join("; ")}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export type PostPerformanceRow = {
  readonly post: ScheduledPost;
  readonly score: number;
  readonly lift: number;
  readonly revenue?: RevenueRollup;
};

export function formatPostPerformance(rows: readonly PostPerformanceRow[], limit = 20): string {
  if (rows.length === 0) return "(no posts have published yet)";
  return rows
    .slice(0, limit)
    .map((row) => {
      const revenue = row.revenue
        ? ` / ${row.revenue.clicks} clicks, ${row.revenue.conversions} conv, ${row.revenue.approvedRevenue} ${row.revenue.currency}`
        : "";
      return [
        `- [${row.post.id}] lift ${row.lift.toFixed(2)}x (score ${Math.round(row.score)})${revenue}`,
        `  pattern: ${row.post.patternId ?? "none"} / offer: ${row.post.offerId ?? "none"}`,
        `  hook: ${row.post.content.hook.slice(0, 120)}`,
      ].join("\n");
    })
    .join("\n");
}

export function formatIdea(idea: Idea): string {
  return [
    `[${idea.id}] #${idea.rank} ${idea.title}`,
    `  angle: ${idea.angle}`,
    `  pain: ${idea.targetPain}`,
    `  outcome: ${idea.promisedOutcome}`,
    `  why: ${idea.rationale}`,
    `  risk: ${idea.risk}`,
    `  pattern: ${idea.patternId ?? "none"} / offer: ${idea.offerId ?? "none"}`,
  ].join("\n");
}

export function formatDraftContent(content: DraftContent): string {
  const parts = content.threadParts && content.threadParts.length > 0
    ? content.threadParts.map((part, index) => `--- part ${index + 1} ---\n${part}`).join("\n")
    : content.body;
  return [
    `HOOK: ${content.hook}`,
    "",
    parts,
    "",
    `CTA: ${content.cta}`,
    `DISCLOSURE: ${content.disclosure || "(none)"}`,
    `HASHTAGS: ${content.hashtags.join(" ") || "(none)"}`,
  ].join("\n");
}

export function formatDraft(draft: Draft): string {
  return formatDraftContent(draft.content);
}

export function formatFindings(findings: readonly InspectionFinding[]): string {
  if (findings.length === 0) return "(the automated checks found nothing - look harder yourself)";
  return findings
    .map((finding) => {
      const excerpt = finding.excerpt ? `\n  excerpt: "${finding.excerpt}"` : "";
      const suggestion = finding.suggestion ? `\n  suggested fix: ${finding.suggestion}` : "";
      return `- [${finding.severity}] ${finding.code}: ${finding.message}${excerpt}${suggestion}`;
    })
    .join("\n");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
