/**
 * Guardrails.
 *
 * The inspection role asks a second model to read the first model's work, but
 * a model checking a model is not a control - it can be talked out of its
 * opinion. So the things that must never ship are checked here, in code, with
 * no model in the loop: the affiliate disclosure, prohibited claims, channel
 * limits, and the venture's own banned phrases.
 *
 * The AI-smell heuristic is separate. It is not a hard gate - it is a cheap,
 * deterministic second opinion that runs even when the LLM inspection is
 * scored generously, so the two have to agree before a draft passes.
 */

import { shortUrl } from "../affiliate/links.ts";
import type { PolicyConfig, TrackingConfig } from "../config/schema.ts";
import type { CommentDraft, DraftContent, InspectionFinding, Offer, TrackedLink, VoiceProfile } from "../core/types.ts";
import type { ComplianceProfile } from "../domain/market.ts";

/**
 * The link a post was issued, for the check that readers are never sent
 * straight to the merchant.
 *
 * It carries the link record and the tracking config rather than a URL, for
 * the same reason `formatOffer` does: a caller that cannot hand over a URL
 * cannot hand over the wrong one. `issued` may be undefined; what that means
 * is decided here, against the offer, and never by the caller.
 */
export type LinkContext = {
  readonly issued: TrackedLink | undefined;
  readonly tracking: TrackingConfig;
};

export type ComplianceInput = {
  readonly content: DraftContent;
  readonly policy: PolicyConfig;
  readonly voice: VoiceProfile;
  /** The rules that apply to *this audience*, resolved from their market. */
  readonly profile: ComplianceProfile;
  readonly offer?: Offer;
  /**
   * Required, not optional, and the requirement is the point.
   *
   * It was optional for one review round, which keyed the whole URL check on
   * a caller remembering to pass it: a draft with an offer and no link id got
   * no check at all, body or comments. Today `writer.ts` issues a link for
   * every offer so that never happens - but nothing asserted it, and the
   * per-offer `direct` mode still awaiting a decision is precisely the change
   * that would stop issuing one. The guard would have switched itself off
   * with no test going red. Being unable to omit it is what stops that.
   */
  readonly link: LinkContext;
  readonly maxCharacters: number;
};

/**
 * The same guardrails, applied to the comments that sit under a post.
 *
 * Comments were exempt, which made them the way round every check in this
 * file: the link drop is where the affiliate URL actually lives, and a
 * prohibited claim reads exactly the same to a regulator whether it is in the
 * post or in the first reply beneath it.
 *
 * The disclosure is repaired rather than reported. A link drop is generated
 * text with one required element; appending it is unambiguous and always
 * correct, where refusing would cost the post its link for no benefit. A
 * direct link to the merchant is repaired for the same reason and by the same
 * argument. A prohibited claim is not repairable - that comment has to go.
 */
export function checkComments(input: {
  readonly comments: readonly CommentDraft[];
  readonly profile: ComplianceProfile;
  readonly policy: PolicyConfig;
  readonly hasOffer: boolean;
  /** Required for the same reason as on `ComplianceInput`; see the note there. */
  readonly link: LinkContext;
}): { readonly comments: readonly CommentDraft[]; readonly findings: readonly InspectionFinding[] } {
  const findings: InspectionFinding[] = [];
  const disclosure = input.profile.disclosureText.trim();
  const kept: CommentDraft[] = [];
  const issued = input.link.issued;

  // Once, not once per comment: an offer with no readable link leaves nothing
  // to compare any of them against.
  if (!issued && input.hasOffer) findings.push(unresolvedLinkFinding("comment"));

  for (const comment of input.comments) {
    if (!issued && comment.purpose === "link_drop") {
      // A link drop with no verifiable link is the one comment that must not
      // ship: there is nothing in it a click could be credited to.
      continue;
    }

    let current = comment;

    if (issued) {
      const repair = repairDirectLinks(current.text, issued, input.link.tracking);
      if (!repair.clean) {
        // Fail closed. Unreachable in practice - see `repairDirectLinks`.
        findings.push(...directLinkFindings(current.text, issued, input.link.tracking, "comment"));
        continue;
      }
      if (repair.replaced.length > 0) {
        current = { ...current, text: repair.text };
        // `warn`, not `blocking`: nothing was blocked, the comment ships with
        // the tracked URL in it, and the publisher logs a blocking comment
        // finding as a refusal - which would send the operator hunting for a
        // comment that is fine. It is louder than the disclosure repair's
        // `note` because a direct link means something upstream put a URL in
        // front of a model that should never have seen one.
        findings.push({
          severity: "warn",
          code: "affiliate.comment_direct_link_repaired",
          message:
            `A ${current.purpose} comment linked straight to the merchant ` +
            `(${repair.replaced.join(", ")}); it was rewritten to ${shortUrl(input.link.tracking, issued)} ` +
            `so the click is counted. Check why a direct URL was available to write in the first place.`,
        });
      }
    }

    const claim = input.profile.prohibitedClaims.find(
      (phrase) => phrase.trim() !== "" && current.text.includes(phrase),
    );
    if (claim) {
      findings.push({
        severity: "blocking",
        code: "compliance.comment_prohibited_claim",
        message:
          `A ${current.purpose} comment makes the prohibited claim "${claim}" and was removed. ` +
          `${input.profile.regulator} does not care whether a claim is in the post or under it.`,
      });
      continue;
    }

    if (
      current.purpose === "link_drop" &&
      input.hasOffer &&
      input.policy.requireDisclosure &&
      disclosure !== "" &&
      !current.text.includes(disclosure)
    ) {
      kept.push({ ...current, text: `${current.text.trimEnd()}\n\n${disclosure}` });
      findings.push({
        severity: "note",
        code: "compliance.comment_disclosure_added",
        message: `The link drop carried no "${disclosure}", so it was appended.`,
      });
      continue;
    }

    kept.push(current);
  }

  return { comments: kept, findings };
}

/** Everything that can be decided without asking a model. */
export function checkCompliance(input: ComplianceInput): InspectionFinding[] {
  const findings: InspectionFinding[] = [];
  const { content, policy, voice, offer, profile } = input;
  const fullText = renderPlainText(content);

  if (offer && policy.requireDisclosure) {
    const disclosure = profile.disclosureText.trim();
    const declared = content.disclosure.trim();
    // The check is that the market's required wording is in the text a reader
    // will see - not that the model put *something* in the disclosure field.
    //
    // This used to short-circuit on `declared !== ""`, which made the whole
    // guardrail decorative: a model writing "ad" for a Japanese audience
    // satisfied it, and both the writer and the inspector keep the model's
    // wording verbatim, so the required text could be absent end to end. A
    // guardrail that accepts any non-empty string is a guardrail in name only.
    //
    // `fullText` is rendered from the whole draft including `content.disclosure`,
    // so this covers a disclosure written into the body as well as one declared
    // in its own field.
    const present = disclosure === "" ? declared !== "" : fullText.includes(disclosure);
    if (!present) {
      findings.push({
        severity: "blocking",
        code: "compliance.missing_disclosure",
        message:
          `This post promotes "${offer.name}" but carries no affiliate disclosure. ` +
          `${profile.market ? `Readers in ${profile.market.name} ` : "Readers "}must see "${disclosure}" ` +
          `before the link (${profile.regulator}).`,
      });
    }
  }

  // Keyed on the offer, not on the link: a post that has something to sell and
  // no readable link cannot be cleared. A body that leaked is blocked and never
  // repaired - the inspector has a rewrite loop behind it, so a lost draft is
  // recoverable in a way a silently mis-attributed published post is not.
  if (input.link.issued) {
    findings.push(...directLinkFindings(fullText, input.link.issued, input.link.tracking, "post"));
  } else if (offer) {
    findings.push(unresolvedLinkFinding("post"));
  }

  // Cross-border facts are checked by presence, not by asking a model whether
  // it mentioned them. If the writer weaves them in, this passes; if not, the
  // platform appends them, and this is what proves it happened.
  if (offer && profile.crossBorder) {
    for (const notice of profile.crossBorderNotes) {
      const trimmed = notice.trim();
      if (trimmed !== "" && !fullText.includes(trimmed)) {
        findings.push({
          severity: "blocking",
          code: "compliance.missing_cross_border_notice",
          message:
            `This promotes "${offer.name}" from ${offer.originMarket} to readers in ` +
            `${profile.market?.id ?? "another market"}, so they must be told: "${trimmed}"`,
          suggestion: "Say it in the body, in the reader's language, before the link.",
        });
      }
    }
  }

  for (const claim of profile.prohibitedClaims) {
    if (claim.trim() !== "" && fullText.includes(claim)) {
      findings.push({
        severity: "blocking",
        code: "compliance.prohibited_claim",
        message: `Contains a claim prohibited in this market: "${claim}" (${profile.regulator}).`,
        excerpt: excerptAround(fullText, claim),
        suggestion: "State what actually happened for you, with the conditions attached.",
      });
    }
  }

  for (const note of profile.categoryNotes) {
    findings.push({
      severity: "note",
      code: "compliance.category_rule",
      message: `Category rule in this market: ${note}`,
    });
  }

  for (const note of offer?.complianceNotes ?? []) {
    findings.push({
      severity: "note",
      code: "compliance.offer_rule",
      message: `Offer rule to honour: ${note}`,
    });
  }

  const bannedPhrases = [...policy.bannedPhrases, ...voice.bannedPhrases];
  for (const phrase of bannedPhrases) {
    if (phrase.trim() !== "" && fullText.includes(phrase)) {
      findings.push({
        severity: "warn",
        code: "voice.banned_phrase",
        message: `Uses a banned phrase: "${phrase}".`,
        excerpt: excerptAround(fullText, phrase),
      });
    }
  }

  const rendered = renderForChannel(content);
  if (rendered.length > input.maxCharacters && (content.threadParts ?? []).length === 0) {
    findings.push({
      severity: "warn",
      code: "channel.too_long",
      message:
        `The post is ${rendered.length} characters against a ${input.maxCharacters} limit, ` +
        `and has no thread split. It will be published as a thread instead of one post.`,
    });
  }

  if (content.hook.trim() === "") {
    findings.push({ severity: "blocking", code: "content.no_hook", message: "The post has no first line." });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// The tracked link
// ---------------------------------------------------------------------------

/**
 * The reader is never handed the network's own destination URL.
 *
 * Every click this platform counts happens because the reader went through
 * `/go/<code>` first: the redirect records the click, then hands over. A
 * direct URL still reaches the merchant and can still pay out, so nothing
 * looks broken - the click simply never happened as far as this platform is
 * concerned, and a post that earned it cannot be told apart from one that
 * earned nothing. That is how it survived from the first commit: the
 * inspector rewrote every body around the destination URL it had been handed,
 * and no check in this file looked at a URL at all.
 *
 * Deliberately not a `compliance.*` code. `blockOnComplianceFindings: false`
 * relaxes what a market's regulator demands of the copy; it must not also
 * switch off the platform's own accounting.
 */
function directLinkFindings(
  text: string,
  issued: TrackedLink,
  tracking: TrackingConfig,
  where: "post" | "comment",
): InspectionFinding[] {
  const hit = findDirectLink(text, directLinkCandidates(issued.destinationUrl));
  if (!hit) return [];

  const expected = shortUrl(tracking, issued);
  return [
    {
      severity: "blocking",
      code: "affiliate.direct_link",
      message:
        `This ${where} sends readers straight to the merchant ("${hit.text}") instead of through the ` +
        `tracked link. Put ${expected} there instead: the redirect is what records the click, so a ` +
        `direct URL means the click is never counted and no revenue can be attributed to this post.`,
      excerpt: excerptAround(text, hit.text),
      suggestion: `Use ${expected} wherever the offer is linked.`,
    },
  ];
}

/**
 * Rewrites a comment's direct links into the tracked one, in place.
 *
 * Removing the comment was the first answer and it was wrong. The publisher
 * appends the tracked URL to the link drop immediately before this runs, so
 * dropping the comment threw that away too and left a post carrying an offer,
 * a link id and no URL anywhere - indistinguishable from a normal post, and
 * earning nothing. Losing a draft is recoverable, because the inspector has a
 * rewrite loop behind it; losing the link on a post that still ships is not.
 *
 * Replacing is deterministic and unambiguous, which is the argument this file
 * already makes for appending a missing disclosure rather than refusing.
 * The post body is a different case and is still blocked, never repaired.
 */
function repairDirectLinks(
  text: string,
  issued: TrackedLink,
  tracking: TrackingConfig,
): { readonly text: string; readonly replaced: readonly string[]; readonly clean: boolean } {
  const expected = shortUrl(tracking, issued);
  const candidates = directLinkCandidates(issued.destinationUrl);
  const replaced: string[] = [];
  let out = text;

  while (replaced.length < MAX_DIRECT_LINK_REPAIRS) {
    const hit = findDirectLink(out, candidates);
    if (!hit) return { text: out, replaced, clean: true };
    replaced.push(hit.text);
    out = `${out.slice(0, hit.index)}${expected}${out.slice(hit.index + hit.length)}`;
  }

  // Only reachable if the replacement itself matches a candidate, which would
  // mean `tracking.baseUrl` sits under the merchant's own domain. Fail closed
  // rather than loop: the caller drops the comment.
  return { text: out, replaced, clean: findDirectLink(out, candidates) === undefined };
}

/** More direct links than any real comment holds; past this, stop and fail closed. */
const MAX_DIRECT_LINK_REPAIRS = 8;

/**
 * Fail closed: the post carries an offer, and either no tracked link was
 * issued for it or the record cannot be read. Either way there is no
 * destination URL to look for, so nothing here can clear the text. Staying
 * quiet would be a green light with nothing behind it.
 */
function unresolvedLinkFinding(where: "post" | "comment"): InspectionFinding {
  return {
    severity: "blocking",
    code: "affiliate.link_unresolved",
    message:
      `This ${where} carries an offer with no readable tracked link, so there is no way to tell whether ` +
      `it sends readers through the redirect or straight to the merchant. This draft cannot be fixed by ` +
      `re-running the cycle - that writes a new draft and leaves this one blocked. Check the data ` +
      `directory still holds the link records (runtime.dataDir, "links"); restore them from backup if ` +
      `it does not, and if they are gone for good, take the offer off this account until links issue again.`,
  };
}

/**
 * The spellings of the destination URL that still bypass the redirect.
 *
 * Two shapes - the destination verbatim, and the destination with its query
 * string dropped, because a model copying a long URL out of a prompt loses the
 * tail far more often than it mistypes the host - each in the interchangeable
 * forms a browser treats identically: `http` or `https`, with or without a
 * leading `www.`. Host case is handled by comparing ASCII-lowercased copies of
 * both sides.
 *
 * The line is drawn there deliberately. Percent-encoded characters, a URL
 * split across a newline, and third-party shorteners are all left alone: no
 * model emits the first two, and a shortener is undetectable by anything that
 * only reads the text - catching one needs a network call, which a guardrail
 * does not get to make.
 *
 * Every candidate is built from this link's own destination, so none of them
 * can match a URL the post mentions for an unrelated reason.
 */
function directLinkCandidates(destinationUrl: string): string[] {
  const shapes = [destinationUrl];
  try {
    const parsed = new URL(destinationUrl);
    const path = parsed.pathname.replace(/\/+$/, "");
    // Skipped when the path is just "/": that would amount to matching the
    // bare domain, and a post may legitimately name the merchant's site.
    if (path !== "") shapes.push(`${parsed.origin}${path}`);
  } catch {
    // An unparseable destination is matched verbatim; inventing variants of a
    // string that is not a URL would only invent false hits.
    return [asciiLower(destinationUrl)];
  }

  const candidates = new Set<string>();
  for (const shape of shapes) {
    const bare = asciiLower(shape).replace(/^https?:\/\//, "").replace(/^www\./, "");
    for (const scheme of ["https://", "http://"]) {
      candidates.add(`${scheme}${bare}`);
      candidates.add(`${scheme}www.${bare}`);
    }
  }
  return [...candidates];
}

/** Where a text links straight to the merchant, and exactly what it wrote there. */
type DirectLinkHit = { readonly index: number; readonly length: number; readonly text: string };

/**
 * The earliest and longest direct link in the text, if there is one.
 *
 * Longest at the same position matters: the full destination and the same URL
 * without its query string both start where the URL starts, and repairing
 * only the shorter of the two would leave `?subid=...` dangling after the
 * replacement.
 */
function findDirectLink(text: string, candidates: readonly string[]): DirectLinkHit | undefined {
  const haystack = asciiLower(text);
  let best: DirectLinkHit | undefined;

  for (const candidate of candidates) {
    let from = 0;
    while (from <= haystack.length) {
      const index = haystack.indexOf(candidate, from);
      if (index === -1) break;
      if (!continuesPath(haystack, index + candidate.length)) {
        const better = !best || index < best.index || (index === best.index && candidate.length > best.length);
        if (better) {
          best = { index, length: candidate.length, text: text.slice(index, index + candidate.length) };
        }
        break;
      }
      from = index + 1;
    }
  }

  return best;
}

/**
 * Lowercases ASCII letters and nothing else.
 *
 * `toLowerCase()` is not length-preserving for every input - a few non-ASCII
 * letters fold into two characters - and this copy is used to map a match back
 * onto the original text by index, which a shifted length would corrupt.
 * Schemes and hosts are ASCII by definition, so folding those is all the
 * comparison needs.
 */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Characters that would make the text's URL a longer path than the one matched. */
const PATH_CHARACTER = /[A-Za-z0-9\-._~%]/;

/**
 * True when the text carries on into a longer path than the one matched.
 *
 * ".../lp" must not be read as a hit on ".../lp-other" or ".../lp/deeper":
 * those are different pages, and a guard that blocks honest posts is worse
 * than no guard. A bare trailing slash, a query, a fragment, punctuation or
 * the end of the line are all the same page, so those count.
 */
function continuesPath(text: string, at: number): boolean {
  const next = text.charAt(at);
  if (next === "/") return PATH_CHARACTER.test(text.charAt(at + 1));
  return PATH_CHARACTER.test(next);
}

/** True when nothing found is severe enough to stop publication. */
/**
 * `blockOnComplianceFindings: false` relaxes exactly what its name says -
 * findings from the compliance checks. It used to keep only `content.*`
 * blockers, which quietly also switched off `voice.too_synthetic` (the
 * `maxAiSmellScore` gate) and `inspect.unfixable`; nothing in the field's name
 * or its documentation suggests that turning off compliance blocking should
 * publish drafts the inspector said it could not fix.
 */
export function passesPolicy(findings: readonly InspectionFinding[], policy: PolicyConfig): boolean {
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  if (policy.blockOnComplianceFindings) return blocking.length === 0;
  return !blocking.some((finding) => !finding.code.startsWith("compliance."));
}

// ---------------------------------------------------------------------------
// AI-smell heuristic
// ---------------------------------------------------------------------------

export type SmellResult = {
  /** 0-100. Higher reads more like a machine wrote it. */
  readonly score: number;
  readonly findings: readonly InspectionFinding[];
};

/**
 * Signals that survive translation between languages, which matters because a
 * licensee may operate in any of them:
 *  - the writing never speaks in the first person
 *  - every sentence is the same length (humans vary wildly)
 *  - hedged, tidy constructions stacked one after another
 *  - a list where a person would have written a sentence
 *  - superlatives with nothing concrete behind them
 */
export function detectAiSmell(content: DraftContent, voice: VoiceProfile): SmellResult {
  const text = renderPlainText(content);
  const findings: InspectionFinding[] = [];
  let score = 0;

  if (voice.firstPerson.trim() !== "" && !text.includes(voice.firstPerson)) {
    score += 22;
    findings.push({
      severity: "warn",
      code: "voice.no_first_person",
      message: `Never uses the venture's first person ("${voice.firstPerson}"), so it reads as a description rather than an account.`,
      suggestion: `Rewrite at least the hook and one body line from ${voice.firstPerson}'s point of view.`,
    });
  }

  const sentences = splitSentences(text);
  if (sentences.length >= 4) {
    const lengths = sentences.map((sentence) => sentence.length);
    const mean = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
    const variance = lengths.reduce((sum, length) => sum + (length - mean) ** 2, 0) / lengths.length;
    const coefficient = mean === 0 ? 0 : Math.sqrt(variance) / mean;
    if (coefficient < 0.28) {
      score += 18;
      findings.push({
        severity: "warn",
        code: "voice.uniform_rhythm",
        message: `Every sentence is about the same length (${Math.round(mean)} characters). Human writing lurches.`,
        suggestion: "Cut one sentence to three or four words and let another run long.",
      });
    }
  }

  const hedges = HEDGE_PATTERNS.filter((pattern) => pattern.test(text));
  if (hedges.length >= 2) {
    score += Math.min(20, hedges.length * 7);
    findings.push({
      severity: "warn",
      code: "voice.hedged",
      message: `Stacks ${hedges.length} hedging constructions. It reads like it is avoiding a commitment.`,
      suggestion: "Say the thing plainly once, and own it.",
    });
  }

  const bulletLines = text.split("\n").filter((line) => /^\s*(?:[-・*•]|\d+[.)、])\s/.test(line));
  if (bulletLines.length >= 4) {
    score += 12;
    findings.push({
      severity: "note",
      code: "voice.listicle",
      message: `${bulletLines.length} list items in a short post. Lists are how a model organises; people tell it as one story.`,
    });
  }

  const superlatives = SUPERLATIVE_PATTERNS.filter((pattern) => pattern.test(text));
  if (superlatives.length > 0) {
    score += Math.min(15, superlatives.length * 6);
    findings.push({
      severity: "warn",
      code: "voice.empty_superlative",
      message: "Uses superlatives with nothing concrete attached.",
      suggestion: "Replace each with the number, the date, or the thing that actually happened.",
    });
  }

  if (!/[0-9０-９]/.test(content.hook)) {
    score += 6;
    findings.push({
      severity: "note",
      code: "voice.abstract_hook",
      message: "The hook has no concrete number in it, which is the cheapest way to make a first line specific.",
    });
  }

  const usesSignature = voice.signaturePhrases.some((phrase) => phrase.trim() !== "" && text.includes(phrase));
  if (voice.signaturePhrases.length > 0 && !usesSignature) {
    score += 8;
    findings.push({
      severity: "note",
      code: "voice.no_signature",
      message: "None of the account's recognisable turns of phrase appear.",
    });
  }

  return { score: Math.min(100, score), findings };
}

const HEDGE_PATTERNS = [
  /することができ(?:ます|る)/,
  /と言え(?:るでしょう|ます)/,
  /かもしれ(?:ません|ない)/,
  /のではないでしょうか/,
  /重要(?:です|である)/,
  /\bit(?:'s| is) important to\b/i,
  /\bcan help you\b/i,
  /\bmay(?: well)? be\b/i,
];

const SUPERLATIVE_PATTERNS = [
  /圧倒的/,
  /革命的/,
  /最強の/,
  /究極の/,
  /\bgame[- ]changing\b/i,
  /\brevolutionary\b/i,
  /\bunlock the power\b/i,
];

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Everything in a draft that could reach a reader, for the checks to scan.
 *
 * `body` and `threadParts` are both included, never one instead of the other.
 * Substituting them meant a threaded draft's `body` was scanned by nothing -
 * a prohibited claim sitting there produced zero findings - while channels
 * that publish the whole content object still sent it. This function decides
 * what the guardrails can see, so a field missing from it is a field with no
 * guardrail on it at all; err towards scanning text that never ships rather
 * than shipping text that was never scanned.
 */
export function renderPlainText(content: DraftContent): string {
  return [
    content.hook,
    content.body,
    ...(content.threadParts ?? []),
    content.cta,
    content.disclosure,
    content.hashtags.join(" "),
  ]
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/** What a single-post channel would actually publish. */
export function renderForChannel(content: DraftContent): string {
  return [content.hook, content.body, content.cta, content.disclosure, content.hashtags.join(" ")]
    .filter((line) => line.trim() !== "")
    .join("\n\n");
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。．！？!?])\s*|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 1);
}

function excerptAround(text: string, needle: string, radius = 24): string {
  const index = text.indexOf(needle);
  if (index === -1) return needle;
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + needle.length + radius));
}
