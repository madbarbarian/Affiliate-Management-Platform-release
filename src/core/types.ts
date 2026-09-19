/**
 * The platform's shared vocabulary.
 *
 * Everything an "AI company" produces is a record in here, and every record is
 * persisted. That is deliberate: the human operator's only two jobs are to
 * approve proposals and to choose the running order, and neither is possible
 * unless the machine's reasoning is inspectable after the fact.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type VentureId = string;
export type CycleId = string;
export type PatternId = string;
export type IdeaId = string;
export type DraftId = string;
export type PostId = string;
export type OfferId = string;
export type LinkId = string;
export type DecisionId = string;
export type ChannelId = string;
export type MarketId = string;

// ---------------------------------------------------------------------------
// Markets - the jurisdiction a post is read in
// ---------------------------------------------------------------------------

/**
 * A category that carries rules beyond ordinary advertising law.
 * The note reaches the writing and inspection roles as a hard constraint.
 */
export type RestrictedCategory = {
  readonly category: string;
  readonly note: string;
  /** True when the platform should refuse the pairing outright. */
  readonly prohibited: boolean;
};

/**
 * Where an audience is, and what the law expects of an ad shown to them.
 *
 * The distinction that matters for cross-border promotion: compliance follows
 * the **audience**, not the merchant. A US product promoted to a Japanese
 * audience is governed by 景品表示法 and the stealth-marketing rules, not by
 * the FTC's guides - and the disclosure has to be in the language the reader
 * actually reads.
 */
export type Market = {
  readonly id: MarketId;
  readonly name: string;
  /** BCP-47 tag the audience reads in. */
  readonly language: string;
  /** ISO 4217. What revenue from this market is denominated in. */
  readonly currency: string;
  readonly timezone: string;
  /** The disclosure this market's regulator expects, in its language. */
  readonly disclosureText: string;
  /** Named for the audit trail: who would object, and under what rule. */
  readonly regulator: string;
  /** Claims prohibited here, on top of the platform-wide list. */
  readonly prohibitedClaims: readonly string[];
  readonly restrictedCategories: readonly RestrictedCategory[];
  /**
   * Extra obligations when the merchant is abroad - what a reader must be told
   * before they click. Empty when the market has no such rule.
   */
  readonly crossBorderNotice: string;
};

// ---------------------------------------------------------------------------
// Venture - one operating unit of the AI company
// ---------------------------------------------------------------------------

/**
 * The written personality the writing and inspection roles must hold to.
 * This is what stops six agents from producing six different voices.
 */
export type VoiceProfile = {
  /** Who the account reads as, in one or two sentences. */
  readonly persona: string;
  /** The first-person pronoun to use. Matters a lot in Japanese. */
  readonly firstPerson: string;
  /** Tone adjectives, e.g. ["率直", "自嘲気味"]. */
  readonly tone: readonly string[];
  /** Phrases that mark text as machine-written and must be rewritten. */
  readonly bannedPhrases: readonly string[];
  /** Turns of phrase that are recognisably this account's. */
  readonly signaturePhrases: readonly string[];
};

export type VentureCadence = {
  /** How many posts may go live per local day. */
  readonly postsPerDay: number;
  /** Minimum gap between two published posts, in minutes. */
  readonly minMinutesBetweenPosts: number;
  /** Local time the daily cycle kicks off, "HH:MM". */
  readonly cycleStartsAt: string;
  /** How many ideas the planning role proposes each cycle. */
  readonly ideasPerCycle: number;
};

export type Venture = {
  readonly id: VentureId;
  readonly name: string;
  /** The niche the account operates in, in the operator's own words. */
  readonly niche: string;
  /** Who the content is for. Feeds every prompt. */
  readonly audience: string;
  /**
   * Where this account's readers are. Decides which advertising rules apply,
   * which offers may be attached, and what the disclosure has to say.
   */
  readonly market: MarketId;
  /** IANA timezone. All scheduling is evaluated in this zone. */
  readonly timezone: string;
  /** BCP-47 language tag the content is written in, e.g. "ja". */
  readonly language: string;
  readonly channels: readonly ChannelId[];
  readonly offers: readonly OfferId[];
  readonly voice: VoiceProfile;
  readonly cadence: VentureCadence;
  readonly active: boolean;
};

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

export type EngagementSnapshot = {
  readonly impressions?: number;
  readonly likes: number;
  readonly replies: number;
  readonly reposts: number;
  readonly saves?: number;
  readonly linkClicks?: number;
  readonly followsGained?: number;
};

export type PostMetric = {
  readonly postId: PostId;
  readonly ventureId: VentureId;
  readonly capturedAt: string;
  /** Hours since the post went live, so early and late reads are comparable. */
  readonly ageHours: number;
  readonly snapshot: EngagementSnapshot;
};

// ---------------------------------------------------------------------------
// Research - the swipe file and the patterns extracted from it
// ---------------------------------------------------------------------------

export type SwipeItem = {
  readonly id: string;
  readonly ventureId: VentureId;
  readonly channel: ChannelId;
  readonly capturedAt: string;
  readonly author?: string;
  readonly sourceUrl?: string;
  readonly text: string;
  readonly snapshot: EngagementSnapshot;
  /** Free-form labels assigned by the research role. */
  readonly tags: readonly string[];
};

export type PatternKind = "hook" | "structure" | "cta" | "format" | "topic";
export type PatternStatus = "candidate" | "active" | "retired";

export type PatternEvidence = {
  readonly observedAt: string;
  /** Where the evidence came from. */
  readonly source: "swipe" | "own_post";
  readonly refId: string;
  /**
   * Normalised performance of this observation, where 1.0 means "matched the
   * venture's recent median". Above 1 is over-performance.
   */
  readonly liftVsMedian: number;
  readonly note: string;
};

/**
 * A reusable "型" - the shape of a post that has been shown to travel, with
 * the variable parts left as placeholders.
 */
export type Pattern = {
  readonly id: PatternId;
  readonly ventureId: VentureId;
  readonly name: string;
  readonly kind: PatternKind;
  /** e.g. "{期間}で{成果}。やったのは{意外な一つ}だけ" */
  readonly template: string;
  /** Why the first line stops the scroll, stated as a mechanism not a vibe. */
  readonly whyItWorks: string;
  readonly evidence: readonly PatternEvidence[];
  /** 0..1. Recomputed from evidence by the analysis role each cycle. */
  readonly confidence: number;
  readonly status: PatternStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type SwipeReport = {
  readonly capturedItems: readonly SwipeItem[];
  /** Patterns the research role believes are reproducible, not one-offs. */
  readonly candidatePatterns: readonly Pattern[];
  readonly discardedCount: number;
  readonly summary: string;
};

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type Idea = {
  readonly id: IdeaId;
  readonly cycleId: CycleId;
  readonly ventureId: VentureId;
  readonly title: string;
  /** The specific take, not the topic. */
  readonly angle: string;
  readonly patternId?: PatternId;
  readonly offerId?: OfferId;
  /** The reader problem this post speaks to. */
  readonly targetPain: string;
  readonly promisedOutcome: string;
  /** The planner's own estimate, used to sort and later to score the planner. */
  readonly expectedEngagement: number;
  /** Which past data point justifies the estimate. */
  readonly rationale: string;
  readonly risk: string;
  /** 1-based rank as proposed. The human may reorder. */
  readonly rank: number;
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type DraftContent = {
  /** Line one. Its whole job is to stop the scroll. */
  readonly hook: string;
  readonly body: string;
  readonly cta: string;
  /** Affiliate relationship disclosure. Never optional when an offer is attached. */
  readonly disclosure: string;
  readonly hashtags: readonly string[];
  /** For channels that support threads, the body split into posts. */
  readonly threadParts?: readonly string[];
};

export type Draft = {
  readonly id: DraftId;
  readonly ideaId: IdeaId;
  readonly cycleId: CycleId;
  readonly ventureId: VentureId;
  readonly channel: ChannelId;
  readonly content: DraftContent;
  readonly offerId?: OfferId;
  readonly linkId?: LinkId;
  readonly patternId?: PatternId;
  readonly createdAt: string;
  readonly revision: number;
};

// ---------------------------------------------------------------------------
// Inspection - the second AI that reads the first AI's work
// ---------------------------------------------------------------------------

export type FindingSeverity = "blocking" | "warn" | "note";

export type InspectionFinding = {
  readonly severity: FindingSeverity;
  /** e.g. "voice.ai_smell", "compliance.missing_disclosure" */
  readonly code: string;
  readonly message: string;
  /** The offending excerpt, when the finding points at specific text. */
  readonly excerpt?: string;
  readonly suggestion?: string;
};

export type InspectionReport = {
  readonly draftId: DraftId;
  readonly inspectedAt: string;
  /** 0-100. Higher means it reads more like a machine wrote it. */
  readonly aiSmellScore: number;
  readonly findings: readonly InspectionFinding[];
  /** The rewritten draft. Empty findings still produce a revision. */
  readonly revised: DraftContent;
  /** False when a blocking finding survived the rewrite. */
  readonly passed: boolean;
};

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export type CommentPurpose = "self_reply" | "faq" | "objection" | "link_drop";

export type CommentDraft = {
  readonly id: string;
  readonly purpose: CommentPurpose;
  readonly text: string;
};

export type PostStatus =
  | "queued"
  | "approved"
  | "scheduled"
  /**
   * The slot arrived on a channel that cannot publish by itself, so the text
   * was composed and handed to a person. It is not live and must never be
   * counted as if it were: only someone saying they posted it moves it on.
   */
  | "handed_over"
  | "published"
  | "failed"
  | "cancelled";

export type ScheduledPost = {
  readonly id: PostId;
  readonly cycleId: CycleId;
  readonly ventureId: VentureId;
  readonly draftId: DraftId;
  readonly channel: ChannelId;
  readonly content: DraftContent;
  /** Epoch milliseconds. Chosen by the publishing role from metric history. */
  readonly scheduledFor: number;
  /** Why this slot, in one line, so the human can sanity-check it. */
  readonly slotReason: string;
  /** 1-based publishing order within the cycle. The human's final say. */
  readonly order: number;
  readonly status: PostStatus;
  readonly commentDrafts: readonly CommentDraft[];
  readonly offerId?: OfferId;
  readonly linkId?: LinkId;
  readonly patternId?: PatternId;
  readonly externalId?: string;
  readonly externalUrl?: string;
  readonly publishedAt?: string;
  readonly failureReason?: string;
  /**
   * The post as text, in the order it goes out, composed by the channel at the
   * moment it was handed over.
   *
   * Stored rather than recomposed on demand, because it is what a person was
   * actually shown and pasted. Recomposing it later would answer a different
   * question - what the channel would compose *now* - and the audit promise is
   * about what happened.
   */
  readonly handOverParts?: readonly string[];
  /** When the platform gave up publishing this itself and asked a person to. */
  readonly handedOverAt?: string;
  /** Who said they posted it, when a person did. */
  readonly postedBy?: string;
};

// ---------------------------------------------------------------------------
// Affiliate
// ---------------------------------------------------------------------------

export type PayoutModel = "cpa" | "cpc" | "revshare";

export type Offer = {
  readonly id: OfferId;
  readonly network: string;
  readonly name: string;
  readonly landingUrl: string;
  readonly payoutModel: PayoutModel;
  /** Fixed amount for cpa/cpc; fractional rate (0..1) for revshare. */
  readonly payoutValue: number;
  readonly currency: string;
  readonly category: string;
  /** Where the merchant is. Drives the cross-border caveats a reader is owed. */
  readonly originMarket: MarketId;
  /**
   * Markets this offer may be promoted in. Usually the network's own
   * territory restriction, and enforced as one: a venture cannot carry an
   * offer that does not list its market.
   */
  readonly targetMarkets: readonly MarketId[];
  /**
   * What a reader outside `originMarket` must be told before they click -
   * shipping, currency, language support, who they would be contracting with.
   * Required whenever the offer is promoted across a border.
   */
  readonly crossBorderNote: string;
  /** Network- or regulator-imposed rules the inspection role must enforce. */
  readonly complianceNotes: readonly string[];
  readonly active: boolean;
};

export type TrackedLink = {
  readonly id: LinkId;
  readonly ventureId: VentureId;
  readonly offerId: OfferId;
  readonly postId?: PostId;
  /** Short, stable slug. Same inputs always yield the same code. */
  readonly code: string;
  readonly destinationUrl: string;
  readonly createdAt: string;
};

export type ClickEvent = {
  readonly id: string;
  readonly linkId: LinkId;
  readonly at: string;
  readonly referrer?: string;
  readonly country?: string;
};

export type ConversionStatus = "pending" | "approved" | "rejected";

export type ConversionEvent = {
  readonly id: string;
  readonly linkId: LinkId;
  /** The network's own identifier, used to deduplicate re-imports. */
  readonly externalId: string;
  readonly at: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: ConversionStatus;
};

// ---------------------------------------------------------------------------
// Human-in-the-loop decisions
// ---------------------------------------------------------------------------

/**
 * The two gates. They exist because the operating model promises the human
 * exactly two jobs: say OK to the proposals, and decide what goes out first.
 */
export type DecisionGate = "proposal_approval" | "publish_approval";

export type DecisionItem = {
  readonly id: string;
  /** The domain record this item stands for (an Idea, or a ScheduledPost). */
  readonly refId: string;
  readonly title: string;
  readonly summary: string;
  /**
   * The platform's own recommendation. In `assisted` autonomy the console
   * pre-selects these so approving is one click; in `auto` they are what gets
   * selected; in `manual` they are shown but nothing is pre-selected.
   */
  readonly recommended: boolean;
  /** Everything the human might want to read before deciding. */
  readonly detail: Readonly<Record<string, unknown>>;
};

export type DecisionStatus = "pending" | "approved" | "rejected" | "expired";

export type DecisionResolution = {
  readonly decidedBy: string;
  readonly decidedAt: string;
  /** Item ids the human said OK to. */
  readonly selectedIds: readonly string[];
  /** Item ids in the order the human wants them to go out. */
  readonly ordering: readonly string[];
  readonly note?: string;
};

export type Decision = {
  readonly id: DecisionId;
  readonly cycleId: CycleId;
  readonly ventureId: VentureId;
  readonly gate: DecisionGate;
  readonly createdAt: string;
  readonly items: readonly DecisionItem[];
  /** How many items the human must pick, as a hint for the console. */
  readonly selectionHint: { readonly min: number; readonly max: number };
  readonly status: DecisionStatus;
  readonly resolution?: DecisionResolution;
  /** Auto-resolved when the venture runs in "auto" autonomy. */
  readonly autoResolved: boolean;
};

// ---------------------------------------------------------------------------
// The cycle - one day of the company's work
// ---------------------------------------------------------------------------

export type CycleStep =
  | "analyze"
  | "research"
  | "plan"
  | "proposal_approval"
  | "write"
  | "inspect"
  | "schedule"
  | "publish_approval"
  | "dispatch";

export const CYCLE_STEPS: readonly CycleStep[] = [
  "analyze",
  "research",
  "plan",
  "proposal_approval",
  "write",
  "inspect",
  "schedule",
  "publish_approval",
  "dispatch",
];

export type CycleStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type AnalysisReport = {
  readonly examinedPosts: number;
  readonly medianEngagement: number;
  readonly promoted: readonly PatternId[];
  readonly retired: readonly PatternId[];
  readonly bestSlotsMinutesOfDay: readonly number[];
  readonly summary: string;
  readonly revenue: {
    readonly clicks: number;
    readonly conversions: number;
    /** One entry per currency. Cross-border ventures earn in more than one. */
    readonly approved: readonly { readonly currency: string; readonly amount: number }[];
    /**
     * Conversions the networks reported this run that matched no tracked link.
     * Not money - unknown currency, unknown post - but a count that going up
     * means the measurement chain is leaking somewhere.
     */
    readonly unattributed: number;
  };
};

/** Typed accessor for what each step leaves behind on the cycle. */
export type CycleArtifacts = {
  analyze?: AnalysisReport;
  research?: SwipeReport;
  plan?: { ideas: readonly Idea[] };
  proposal_approval?: { decisionId: DecisionId; approvedIdeaIds: readonly IdeaId[] };
  write?: { draftIds: readonly DraftId[] };
  inspect?: { reports: readonly InspectionReport[]; rejectedDraftIds: readonly DraftId[] };
  schedule?: { postIds: readonly PostId[] };
  publish_approval?: { decisionId: DecisionId; approvedPostIds: readonly PostId[] };
  dispatch?: { dispatchedPostIds: readonly PostId[]; failedPostIds: readonly PostId[] };
};

export type CycleStepRecord = {
  readonly step: CycleStep;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly note: string;
};

export type Cycle = {
  readonly id: CycleId;
  readonly ventureId: VentureId;
  /** Local calendar date in the venture's timezone. One cycle per date. */
  readonly date: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: CycleStatus;
  /** The step to run next. `undefined` once the cycle is finished. */
  readonly nextStep?: CycleStep;
  readonly completed: readonly CycleStepRecord[];
  readonly artifacts: CycleArtifacts;
  readonly pendingDecisionId?: DecisionId;
  readonly failure?: { readonly step: CycleStep; readonly message: string; readonly code: string };
};

// ---------------------------------------------------------------------------
// Exploration - proposing the next venture
// ---------------------------------------------------------------------------

/**
 * The `ventureId` used for records that belong to the company rather than to
 * one venture: the scout's audit events, and anything else that looks across
 * accounts. A constant rather than `undefined` so every store query that
 * filters by venture keeps working.
 */
export const COMPANY_SCOPE: VentureId = "company";

export type ProposalStatus = "proposed" | "accepted" | "dismissed";

/**
 * A venture the scout thinks the company should try next. It is a hypothesis
 * with a stopping rule, not a plan: the human decides whether to run it, and
 * accepting one produces a config block to paste, never a config edit.
 */
export type VentureProposal = {
  readonly id: string;
  readonly createdAt: string;
  readonly status: ProposalStatus;
  readonly niche: string;
  readonly audience: string;
  readonly market: MarketId;
  readonly language: string;
  /** The proposal's main category, checked against the market's prohibited list. */
  readonly category: string;
  readonly nameCandidates: readonly string[];
  readonly voice: Pick<VoiceProfile, "persona" | "firstPerson" | "tone">;
  /** Offers from config that this market permits. Empty is a valid answer. */
  readonly offerIds: readonly OfferId[];
  /** Why this would work, citing the aggregates the scout was shown. */
  readonly hypothesis: string;
  readonly evidence: string;
  readonly risk: string;
  /** The first three hooks, so the human can picture the account. */
  readonly firstHooks: readonly string[];
  /** What, measured over the first month, would mean "stop". Required. */
  readonly killSignal: string;
  /** Suggested `ventures[].id`, a slug derived from the niche. */
  readonly suggestedVentureId: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly resolutionNote?: string;
  /**
   * Set once the accepted block was actually appended to the config. Absent
   * on an accepted proposal means the person has to paste it - the console
   * and the CLI both read this rather than assuming.
   */
  readonly appended?: { readonly at: string; readonly configPath: string; readonly backupPath: string };
};

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export type AuditEvent = {
  readonly id: string;
  readonly at: string;
  readonly ventureId: VentureId;
  readonly cycleId?: CycleId;
  /** e.g. "role.completed", "decision.resolved", "post.published" */
  readonly type: string;
  readonly actor: string;
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
};
