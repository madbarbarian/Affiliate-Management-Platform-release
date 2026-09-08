/**
 * Inspection - the second AI reading the first one's work.
 *
 * The order here is the whole design. Deterministic checks run first and their
 * findings are handed to the model as facts it must resolve. The model rewrites.
 * Then the deterministic checks run *again* on the rewrite, and those results -
 * not the model's self-assessment - decide whether the draft passes.
 *
 * A model asked "is this compliant?" will say yes. A regex asked "does the
 * disclosure string appear?" will not.
 */

import { ok, type PlatformError, type Result } from "../core/result.ts";
import { checkCompliance, detectAiSmell, passesPolicy } from "../kernel/policy.ts";
import { describeCompliance, findMarket, resolveCompliance, type ComplianceProfile } from "../domain/market.ts";
import { ventureBrief, type Role, type RoleContext } from "../kernel/role.ts";
import { array, enumOf, integer, object, string } from "../llm/schema.ts";
import type { Draft, DraftContent, FindingSeverity, InspectionFinding, InspectionReport } from "../core/types.ts";
import { formatDraftContent, formatFindings, formatOffer } from "./format.ts";

export type InspectInput = { readonly draft: Draft };

const SEVERITIES = ["blocking", "warn", "note"] as const;

const INSPECT_SCHEMA = object({
  aiSmellScore: integer("0-100 for the ORIGINAL draft. Most model first drafts land 40-70.", {
    minimum: 0,
    maximum: 100,
  }),
  revisedAiSmellScore: integer(
    "0-100 for YOUR REWRITE, judged as strictly as the original. This is the score the draft is held to.",
    { minimum: 0, maximum: 100 },
  ),
  findings: array(
    object({
      severity: enumOf(SEVERITIES),
      code: string("Dotted code, e.g. voice.hedged or compliance.missing_disclosure."),
      message: string("What is wrong, specifically."),
      excerpt: string("The offending text, or an empty string."),
      suggestion: string("How to fix it, or an empty string."),
    }),
  ),
  revised: object({
    hook: string(),
    body: string(),
    cta: string(),
    disclosure: string(),
    hashtags: array(string(), { maxItems: 3 }),
    threadParts: array(string(), { description: "Empty unless the post needs more than one part." }),
  }),
  unfixable: string(
    "If a blocking problem cannot be fixed without inventing facts, say which and why. Empty otherwise.",
  ),
});

type InspectResponse = {
  aiSmellScore: number;
  revisedAiSmellScore: number;
  findings: { severity: string; code: string; message: string; excerpt: string; suggestion: string }[];
  revised: {
    hook: string;
    body: string;
    cta: string;
    disclosure: string;
    hashtags: string[];
    threadParts: string[];
  };
  unfixable: string;
};

export const inspector: Role<InspectInput, InspectionReport> = {
  id: "inspector",
  title: "検品担当 / Inspector",
  description:
    "Reads the draft as a stranger would, rewrites the machine out of it, and blocks anything that must not ship.",

  async run(context: RoleContext, input: InspectInput): Promise<Result<InspectionReport, PlatformError>> {
    const { venture, config, store, clock } = context;
    const draft = input.draft;

    const channel = context.channels.get(draft.channel);
    if (!channel.ok) return channel;
    const maxCharacters = channel.value.capabilities.maxCharacters;
    const offer = draft.offerId ? config.offers.find((entry) => entry.id === draft.offerId) : undefined;

    const profile = resolveCompliance({
      policy: config.policy,
      market: findMarket(config.markets, venture.market),
      ...(offer ? { offer } : {}),
    });

    // Pass one: what can be known without a model.
    const mechanical = [
      ...checkCompliance({
        content: draft.content,
        policy: config.policy,
        voice: venture.voice,
        profile,
        ...(offer ? { offer } : {}),
        maxCharacters,
      }),
      ...detectAiSmell(draft.content, venture.voice).findings,
    ];
    const heuristicScore = detectAiSmell(draft.content, venture.voice).score;

    const link = draft.linkId ? await store.links.get(draft.linkId) : undefined;

    const response = await context.llm.completeJson<InspectResponse>({
      purpose: "inspect.review",
      tier: "primary",
      system: `${ventureBrief(venture, config)}\n\n${context.prompts.render("inspector.system")}`,
      user: context.prompts.render("inspector.user", {
        draft: formatDraftContent(draft.content),
        offer: formatOffer(offer, link?.destinationUrl),
        mechanicalFindings: formatFindings(mechanical),
        firstPerson: venture.voice.firstPerson,
        tone: venture.voice.tone.join(" / ") || "(unspecified)",
        signaturePhrases: venture.voice.signaturePhrases.join(" / ") || "(none)",
        bannedPhrases: [...venture.voice.bannedPhrases, ...config.policy.bannedPhrases].join(" / ") || "(none)",
        maxCharacters,
        disclosure: profile.disclosureText,
        compliance: describeCompliance(profile),
      }),
      schema: INSPECT_SCHEMA,
    });
    if (!response.ok) return response;

    const revised = normaliseRevision(response.value.revised, {
      original: draft.content,
      requireDisclosure: Boolean(offer) && config.policy.requireDisclosure,
      profile,
    });

    // Pass two: the same deterministic checks, on the rewrite. These decide.
    const afterCompliance = checkCompliance({
      content: revised,
      policy: config.policy,
      voice: venture.voice,
      profile,
      ...(offer ? { offer } : {}),
      maxCharacters,
    });
    const afterSmell = detectAiSmell(revised, venture.voice);

    const modelFindings: InspectionFinding[] = response.value.findings.map((finding) => ({
      severity: toSeverity(finding.severity),
      code: finding.code || "voice.unspecified",
      message: finding.message,
      ...(finding.excerpt ? { excerpt: finding.excerpt } : {}),
      ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
    }));

    const findings: InspectionFinding[] = [...afterCompliance, ...afterSmell.findings, ...modelFindings];

    if (response.value.unfixable.trim() !== "") {
      findings.push({
        severity: "blocking",
        code: "inspect.unfixable",
        message: response.value.unfixable.trim(),
      });
    }

    // Take the worse of the model's judgement and the heuristic - of the same
    // text. A model grading its sibling's work is not a disinterested party,
    // so the heuristic keeps a vote; but both votes must be about the rewrite.
    // This used to take the model's score of the ORIGINAL (which the prompt
    // asks to be 40-70) against a limit of 35 and call it "even after the
    // rewrite": an honest model blocked nearly every draft, and the mock's
    // fixed 22 hid it from every test.
    const originalAiSmellScore = response.value.aiSmellScore;
    const aiSmellScore = Math.max(response.value.revisedAiSmellScore, afterSmell.score);
    if (aiSmellScore > config.policy.maxAiSmellScore) {
      findings.push({
        severity: "blocking",
        code: "voice.too_synthetic",
        message:
          `Reads as machine-written (${aiSmellScore} against a limit of ${config.policy.maxAiSmellScore}) ` +
          `even after the rewrite.`,
      });
    }

    const passed = passesPolicy(findings, config.policy);
    const report: InspectionReport = {
      draftId: draft.id,
      inspectedAt: clock.nowIso(),
      aiSmellScore,
      findings,
      revised,
      passed,
    };

    await store.inspections.put(report);
    if (passed) {
      await store.drafts.put({ ...draft, content: revised, revision: draft.revision + 1 });
    }

    await context.note(
      passed ? "role.inspect.passed" : "role.inspect.blocked",
      passed
        ? `Draft ${draft.id} cleared inspection (smell ${aiSmellScore}).`
        : `Draft ${draft.id} was blocked: ${findings
            .filter((finding) => finding.severity === "blocking")
            .map((finding) => finding.code)
            .join(", ")}.`,
      { draftId: draft.id, aiSmellScore, originalAiSmellScore, heuristicScore, findings: findings.length },
    );

    return ok(report);
  },
};

/**
 * A rewrite that drops a field is a rewrite that lost content. Missing pieces
 * fall back to the original rather than publishing an empty CTA.
 */
function normaliseRevision(
  revised: InspectResponse["revised"],
  options: { original: DraftContent; requireDisclosure: boolean; profile: ComplianceProfile },
): DraftContent {
  const threadParts = (revised.threadParts ?? []).filter((part) => part.trim() !== "");
  const body = revised.body.trim() || options.original.body;

  const declared = revised.disclosure.trim() !== ""
    ? revised.disclosure.trim()
    : options.requireDisclosure
      ? options.original.disclosure.trim() || options.profile.disclosureText
      : options.original.disclosure.trim();

  // A rewrite that drops a cross-border caveat has removed something the
  // reader is legally owed, so it goes back in whatever the rewrite did.
  const lines = declared === "" ? [] : [declared];
  for (const notice of options.profile.crossBorderNotes) {
    const trimmed = notice.trim();
    if (trimmed === "") continue;
    const present = declared.includes(trimmed) || body.includes(trimmed) || threadParts.some((part) => part.includes(trimmed));
    if (!present) lines.push(trimmed);
  }
  const disclosure = lines.join("\n");

  return {
    hook: revised.hook.trim() || options.original.hook,
    body: revised.body.trim() || options.original.body,
    cta: revised.cta.trim() || options.original.cta,
    disclosure,
    hashtags: (revised.hashtags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== ""),
    ...(threadParts.length > 1 ? { threadParts } : {}),
  };
}

function toSeverity(value: string): FindingSeverity {
  return (SEVERITIES as readonly string[]).includes(value) ? (value as FindingSeverity) : "note";
}
