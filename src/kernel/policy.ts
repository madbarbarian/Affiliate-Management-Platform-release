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

import type { PolicyConfig } from "../config/schema.ts";
import type { CommentDraft, DraftContent, InspectionFinding, Offer, VoiceProfile } from "../core/types.ts";
import type { ComplianceProfile } from "../domain/market.ts";

export type ComplianceInput = {
  readonly content: DraftContent;
  readonly policy: PolicyConfig;
  readonly voice: VoiceProfile;
  /** The rules that apply to *this audience*, resolved from their market. */
  readonly profile: ComplianceProfile;
  readonly offer?: Offer;
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
 * prohibited claim is not repairable - that comment has to go.
 */
export function checkComments(input: {
  readonly comments: readonly CommentDraft[];
  readonly profile: ComplianceProfile;
  readonly policy: PolicyConfig;
  readonly hasOffer: boolean;
}): { readonly comments: readonly CommentDraft[]; readonly findings: readonly InspectionFinding[] } {
  const findings: InspectionFinding[] = [];
  const disclosure = input.profile.disclosureText.trim();
  const kept: CommentDraft[] = [];

  for (const comment of input.comments) {
    const claim = input.profile.prohibitedClaims.find(
      (phrase) => phrase.trim() !== "" && comment.text.includes(phrase),
    );
    if (claim) {
      findings.push({
        severity: "blocking",
        code: "compliance.comment_prohibited_claim",
        message:
          `A ${comment.purpose} comment makes the prohibited claim "${claim}" and was removed. ` +
          `${input.profile.regulator} does not care whether a claim is in the post or under it.`,
      });
      continue;
    }

    if (
      comment.purpose === "link_drop" &&
      input.hasOffer &&
      input.policy.requireDisclosure &&
      disclosure !== "" &&
      !comment.text.includes(disclosure)
    ) {
      kept.push({ ...comment, text: `${comment.text.trimEnd()}\n\n${disclosure}` });
      findings.push({
        severity: "note",
        code: "compliance.comment_disclosure_added",
        message: `The link drop carried no "${disclosure}", so it was appended.`,
      });
      continue;
    }

    kept.push(comment);
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
