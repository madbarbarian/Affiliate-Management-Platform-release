/**
 * The shape of `platform.config.yaml` - the one file a licensee edits.
 *
 * The standard the platform commits to: a fork is configured, never patched.
 * Anything an operator needs to change to run their own account lives here or
 * in `.env.local`. If something can only be changed by editing `src/`, that is a gap
 * in this file, not a feature.
 */

import type { LogLevel } from "../core/logger.ts";
import type {
  Market,
  Offer,
  PayoutModel,
  RestrictedCategory,
  Venture,
  VoiceProfile,
} from "../core/types.ts";
import { createReader, formatIssues, get, type Issue } from "./validate.ts";
import { parseTimeOfDay } from "../core/clock.ts";
import { LOCALES, type Locale } from "../console/messages.ts";

/**
 * Bumped to 2 when `markets` became required. An older config now fails
 * validation with a message naming the version, rather than silently running
 * an operation with no jurisdiction attached to it.
 */
export const CONFIG_VERSION = 2;

/**
 * How much rope the machine gets.
 *  - manual:   every gate waits for a human, with no recommendation attached.
 *  - assisted: every gate waits for a human, pre-filled with the platform's
 *              recommendation so "OK" is one click. This is the default and
 *              the operating model the platform is designed around.
 *  - auto:     gates resolve themselves using that recommendation. A human can
 *              still stop everything with `amp pause` before a slot; there is
 *              no per-post cancel yet.
 */
export type Autonomy = "manual" | "assisted" | "auto";

/**
 * Reasoning depth, passed through as `output_config.effort`.
 * Current Claude models take effort rather than a sampling temperature -
 * `temperature` is rejected outright on the Opus 5 family.
 */
export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type LlmConfig = {
  readonly provider: "anthropic" | "mock";
  /** Model for judgement-heavy roles: research, planning, inspection. */
  readonly model: string;
  /** Cheaper model for mechanical roles. Falls back to `model` if unset. */
  readonly fastModel: string;
  readonly maxOutputTokens: number;
  /** Effort for judgement-heavy roles. */
  readonly effort: LlmEffort;
  /** Effort for mechanical roles run on `fastModel`. */
  readonly fastEffort: LlmEffort;
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  /** Retries per call for retryable failures (429/5xx/connection). */
  readonly maxRetries: number;
  readonly requestTimeoutMs: number;
};

/**
 * One person who may open the console, and the env var holding their
 * passphrase. The passphrase itself is never in this file.
 */
export type ConsoleOperator = {
  /** What the audit log records when this person approves something. */
  readonly name: string;
  readonly tokenEnv: string;
};

export type ConsoleConfig = {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  /** Env var holding the bearer token the console requires. */
  readonly tokenEnv: string;
  /**
   * The console's own language. **Not the disclosure's** - that follows each
   * venture's market, and an operator reading English while publishing to
   * Japanese readers still publishes a Japanese disclosure.
   */
  readonly locale: Locale;
  /**
   * Anyone beyond the first. `company.operator` plus `tokenEnv` is the first
   * entry and needs no listing here, so a single-operator config is unchanged.
   *
   * This exists so the audit log can name who approved something. An approval
   * cannot be attributed after the fact: a record written while there is one
   * shared passphrase says the owner's name forever, whoever pressed it.
   */
  readonly operators: readonly ConsoleOperator[];
};

export type PolicyConfig = {
  /** Refuse to publish a post carrying an offer without a disclosure line. */
  readonly requireDisclosure: boolean;
  readonly disclosureText: string;
  /** Inspection rejects a draft scoring above this on the AI-smell scale. */
  readonly maxAiSmellScore: number;
  readonly blockOnComplianceFindings: boolean;
  /** Phrases that mark text as machine-written, across all ventures. */
  readonly bannedPhrases: readonly string[];
  /** Claims no affiliate post may make. Checked by the inspection role. */
  readonly prohibitedClaims: readonly string[];
  readonly maxPostsPerDay: number;
  readonly minMinutesBetweenPosts: number;
  /** Hours after publishing that metrics keep being polled. */
  readonly metricsWindowHours: number;
  /**
   * How far back to ask each network for conversions, in days.
   *
   * Nothing like the metrics window, which is why it is a separate setting:
   * engagement is visible within hours, but an ASP approves a conversion on
   * its own schedule - often a monthly close, sometimes longer. Anything
   * reported after this window is never imported at all, so a value that is
   * too small silently drops revenue that was genuinely earned. Re-importing
   * is free (conversions deduplicate on the network's own id), so err long.
   */
  readonly conversionLookbackDays: number;
};

export type TrackingConfig = {
  /** Base of the redirect service that owns the short links. */
  readonly baseUrl: string;
  /** Query parameter carrying the tracking code on the destination URL. */
  readonly linkParam: string;
  /** Extra UTM-style parameters appended to every destination URL. */
  readonly extraParams: Readonly<Record<string, string>>;
};

export type ChannelConfig = {
  readonly id: string;
  readonly adapter: string;
  readonly enabled: boolean;
  /** Env var names, resolved at construction time. Never literal secrets. */
  readonly credentialEnv: Readonly<Record<string, string>>;
  readonly research: {
    readonly queries: readonly string[];
    readonly minLikes: number;
    readonly maxItems: number;
    readonly lookbackHours: number;
  };
  readonly options: Readonly<Record<string, unknown>>;
};

export type NetworkConfig = {
  readonly id: string;
  readonly adapter: string;
  readonly enabled: boolean;
  readonly credentialEnv: Readonly<Record<string, string>>;
  readonly options: Readonly<Record<string, unknown>>;
};

/**
 * How the operator of this instance charges the ventures running on it.
 *
 * `none` is the normal case: you are running your own accounts. The other two
 * exist for a licensee who lets other people operate on their instance - the
 * third tier of the distribution model - so that "subscription or revenue
 * share?" stays a config switch rather than a decision that has to be made
 * before anything is built.
 *
 * This produces statements, never charges. Payment, invoicing and tax are
 * deliberately out of scope.
 */
export type LicensingTerms = {
  readonly model: "none" | "subscription" | "revshare";
  readonly subscriptionAmount: number;
  readonly subscriptionCurrency: string;
  /** Fraction of approved affiliate revenue, 0..1. */
  readonly revshareRate: number;
};

export type LicensingConfig = LicensingTerms & {
  /** Per-venture deals, for tenants who are not all on the same terms. */
  readonly overrides: readonly (Partial<LicensingTerms> & { readonly venture: string })[];
};

export type RuntimeConfig = {
  /** Where operating state is written. Relative paths resolve to the repo root. */
  readonly dataDir: string;
  /**
   * Where role prompts live. Editing a prompt is how an operator changes what
   * a role pays attention to, without forking the code that runs it.
   */
  readonly promptsDir: string;
  readonly logLevel: LogLevel;
  readonly logFormat: "pretty" | "json";
};

/**
 * The weekly question: should the company try another venture? Off by
 * default - a licensee should not discover a model call they did not ask for
 * in their bill, however cheap and however useful.
 */
export type ExplorationConfig = {
  readonly enabled: boolean;
  /** Days between scout runs when the daemon runs it. */
  readonly everyDays: number;
  /** How many proposals to ask for per run. */
  readonly proposals: number;
  /** Days of performance the scout is shown as evidence. */
  readonly lookbackDays: number;
  /**
   * When an account is flagged for review in the portfolio. Flagging is a
   * suggestion the operator sees next to a one-click deactivate; it never
   * switches anything off by itself.
   */
  readonly review: {
    /** Only accounts with at least this many posts in the window are judged. */
    readonly afterPosts: number;
    /** Flag when the account's median engagement is below this share of the company's median. */
    readonly belowShareOfMedian: number;
  };
};

/**
 * How hard a failed day tries again before it is left alone until tomorrow.
 *
 * There is a limit at all because the scheduler no longer decides from memory.
 * A cron fire is a fresh isolate, so "we already tried this" has to be a fact
 * on the cycle record - and a record that says "failed" with no count is a day
 * that retries every hour until midnight.
 */
export type RetryConfig = {
  /**
   * How many times a day's cycle may be started, counting the first.
   *
   * Raising this by one raises the worst-case cost of a failed day by roughly
   * one whole cycle. A retry re-runs the step that failed, and a step is not
   * one model call: `write` calls the writer once per approved idea, `inspect`
   * once per draft. The only step that fails the cycle with "try again" is
   * `write` when every draft failed, so one retry is N model calls, not one.
   *
   * On Cloudflare, changing this needs a redeploy: the config is compiled into
   * the Worker, so editing the file alone changes nothing that is running.
   */
  readonly maxCycleAttempts: number;
};

export type PlatformConfig = {
  readonly version: number;
  readonly company: {
    readonly name: string;
    readonly operator: string;
    readonly autonomy: Autonomy;
    /**
     * How the company thinks, in the operator's words. Read by every role in
     * every venture. Prose, not rules - the rules are `policy`.
     */
    readonly principles: readonly string[];
    /**
     * What the company never does, whatever a venture's numbers say. Also
     * prose: it shapes what gets proposed, it does not block what gets
     * published. Blocking is `policy.prohibitedClaims`.
     */
    readonly boundaries: readonly string[];
    readonly exploration: ExplorationConfig;
    readonly retry: RetryConfig;
  };
  readonly runtime: RuntimeConfig;
  readonly llm: LlmConfig;
  readonly console: ConsoleConfig;
  readonly policy: PolicyConfig;
  readonly tracking: TrackingConfig;
  readonly licensing: LicensingConfig;
  readonly markets: readonly Market[];
  readonly channels: readonly ChannelConfig[];
  readonly networks: readonly NetworkConfig[];
  readonly offers: readonly Offer[];
  readonly ventures: readonly Venture[];
};

export class ConfigError extends Error {
  readonly issues: readonly Issue[];
  constructor(issues: readonly Issue[], source: string) {
    super(`Invalid configuration in ${source}:\n${formatIssues(issues)}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const DEFAULT_BANNED_PHRASES = [
  "いかがでしたか",
  "まとめると",
  "ぜひ参考にしてみてください",
  "この記事では",
  "重要なポイントは以下の通りです",
  "革命的な",
  "圧倒的な",
  "delve",
  "In today's fast-paced world",
];

const DEFAULT_PROHIBITED_CLAIMS = [
  "必ず稼げる",
  "誰でも100%",
  "リスクゼロ",
  "医師も推奨",
  "元本保証",
];

/**
 * Turns a parsed YAML/JSON document into a validated config.
 * Collects every problem before throwing so one run fixes the whole file.
 */
export function parseConfig(raw: unknown, source = "platform.config.yaml"): PlatformConfig {
  const reader = createReader();
  const { at } = reader;

  const version = at("version", get(raw, "version")).number({ integer: true, fallback: CONFIG_VERSION });
  if (version !== CONFIG_VERSION) {
    at("version", version).reject(`unsupported config version ${version}, this build expects ${CONFIG_VERSION}`);
  }

  const companyRaw = at("company", get(raw, "company")).object();
  const explorationRaw = at("company.exploration", companyRaw["exploration"]).object();
  const reviewRaw = at("company.exploration.review", explorationRaw["review"]).object();
  const retryRaw = at("company.retry", companyRaw["retry"]).object();
  const company = {
    name: at("company.name", companyRaw["name"]).string("My AI Company"),
    operator: at("company.operator", companyRaw["operator"]).string("operator"),
    autonomy: at("company.autonomy", companyRaw["autonomy"]).oneOf<Autonomy>(
      ["manual", "assisted", "auto"],
      "assisted",
    ),
    principles: at("company.principles", companyRaw["principles"]).stringArray([]),
    boundaries: at("company.boundaries", companyRaw["boundaries"]).stringArray([]),
    exploration: {
      enabled: at("company.exploration.enabled", explorationRaw["enabled"]).boolean(false),
      everyDays: at("company.exploration.everyDays", explorationRaw["everyDays"]).number({
        min: 1,
        max: 90,
        integer: true,
        fallback: 7,
      }),
      proposals: at("company.exploration.proposals", explorationRaw["proposals"]).number({
        min: 1,
        max: 10,
        integer: true,
        fallback: 3,
      }),
      lookbackDays: at("company.exploration.lookbackDays", explorationRaw["lookbackDays"]).number({
        min: 7,
        max: 365,
        integer: true,
        fallback: 30,
      }),
      review: {
        afterPosts: at("company.exploration.review.afterPosts", reviewRaw["afterPosts"]).number({
          min: 1,
          max: 1000,
          integer: true,
          fallback: 20,
        }),
        belowShareOfMedian: at(
          "company.exploration.review.belowShareOfMedian",
          reviewRaw["belowShareOfMedian"],
        ).number({ min: 0, max: 1, fallback: 0.5 }),
      },
    },
    retry: {
      maxCycleAttempts: readMaxCycleAttempts(at("company.retry.maxCycleAttempts", retryRaw["maxCycleAttempts"])),
    },
  };

  const runtimeRaw = at("runtime", get(raw, "runtime")).object();
  const runtime: RuntimeConfig = {
    dataDir: at("runtime.dataDir", runtimeRaw["dataDir"]).string(".amp"),
    promptsDir: at("runtime.promptsDir", runtimeRaw["promptsDir"]).string("prompts"),
    logLevel: at("runtime.logLevel", runtimeRaw["logLevel"]).oneOf<LogLevel>(
      ["debug", "info", "warn", "error"],
      "info",
    ),
    logFormat: at("runtime.logFormat", runtimeRaw["logFormat"]).oneOf(["pretty", "json"] as const, "pretty"),
  };

  const llmRaw = at("llm", get(raw, "llm")).object();
  const model = at("llm.model", llmRaw["model"]).string("claude-opus-5");
  const llm: LlmConfig = {
    provider: at("llm.provider", llmRaw["provider"]).oneOf(["anthropic", "mock"] as const, "anthropic"),
    model,
    fastModel: at("llm.fastModel", llmRaw["fastModel"]).string(model),
    maxOutputTokens: at("llm.maxOutputTokens", llmRaw["maxOutputTokens"]).number({
      min: 256,
      max: 64_000,
      integer: true,
      fallback: 4096,
    }),
    effort: at("llm.effort", llmRaw["effort"]).oneOf<LlmEffort>(
      ["low", "medium", "high", "xhigh", "max"],
      "high",
    ),
    fastEffort: at("llm.fastEffort", llmRaw["fastEffort"]).oneOf<LlmEffort>(
      ["low", "medium", "high", "xhigh", "max"],
      "medium",
    ),
    apiKeyEnv: at("llm.apiKeyEnv", llmRaw["apiKeyEnv"]).string("ANTHROPIC_API_KEY"),
    baseUrl: at("llm.baseUrl", llmRaw["baseUrl"]).string("https://api.anthropic.com"),
    // 3, not 45: the fallback used to sit outside its own bounds, so omitting
    // the key gave 45 SDK retries per role call while writing 45 explicitly
    // was rejected as "must be at most 8".
    maxRetries: at("llm.maxRetries", llmRaw["maxRetries"]).number({ min: 0, max: 8, integer: true, fallback: 3 }),
    requestTimeoutMs: at("llm.requestTimeoutMs", llmRaw["requestTimeoutMs"]).number({
      min: 1000,
      max: 600_000,
      integer: true,
      fallback: 120_000,
    }),
  };

  const consoleRaw = at("console", get(raw, "console")).object();
  const consoleConfig: ConsoleConfig = {
    enabled: at("console.enabled", consoleRaw["enabled"]).boolean(true),
    host: at("console.host", consoleRaw["host"]).string("127.0.0.1"),
    port: at("console.port", consoleRaw["port"]).number({ min: 1, max: 65_535, integer: true, fallback: 4321 }),
    tokenEnv: at("console.tokenEnv", consoleRaw["tokenEnv"]).string("AMP_CONSOLE_TOKEN"),
    locale: at("console.locale", consoleRaw["locale"]).oneOf<Locale>([...LOCALES], "ja"),
    operators: at("console.operators", consoleRaw["operators"]).objectArray().map(({ path, value }) => {
      // Roles and per-account assignment are deliberately not implemented yet
      // (docs/3-development/adding-people.md). Reading only `name` and
      // `tokenEnv` and ignoring the rest is the dangerous way to defer a
      // feature: someone writes `role: manager`, doctor says nothing, and they
      // believe they have limited a person who in fact holds every power the
      // owner does. A deferred feature has to refuse, not shrug.
      for (const key of Object.keys(value)) {
        if (key === "name" || key === "tokenEnv") continue;
        at(`${path}.${key}`, value[key]).reject(
          key === "role" || key === "ventures"
            ? "is not implemented yet, and leaving it here would be worse than not writing it: " +
              "anyone holding a passphrase can do everything you can, on every account. " +
              "Delete the line. If there is something this person must not see or touch, " +
              "do not give them a passphrase yet."
            : "is not a field of console.operators. Only name and tokenEnv are read.",
        );
      }
      return {
        name: at(`${path}.name`, value["name"]).string(),
        tokenEnv: at(`${path}.tokenEnv`, value["tokenEnv"]).string(),
      };
    }),
  };

  const policyRaw = at("policy", get(raw, "policy")).object();
  const policy: PolicyConfig = {
    requireDisclosure: at("policy.requireDisclosure", policyRaw["requireDisclosure"]).boolean(true),
    disclosureText: at("policy.disclosureText", policyRaw["disclosureText"]).string("#PR"),
    maxAiSmellScore: at("policy.maxAiSmellScore", policyRaw["maxAiSmellScore"]).number({
      min: 0,
      max: 100,
      fallback: 35,
    }),
    blockOnComplianceFindings: at(
      "policy.blockOnComplianceFindings",
      policyRaw["blockOnComplianceFindings"],
    ).boolean(true),
    bannedPhrases: at("policy.bannedPhrases", policyRaw["bannedPhrases"]).stringArray(DEFAULT_BANNED_PHRASES),
    prohibitedClaims: at("policy.prohibitedClaims", policyRaw["prohibitedClaims"]).stringArray(
      DEFAULT_PROHIBITED_CLAIMS,
    ),
    maxPostsPerDay: at("policy.maxPostsPerDay", policyRaw["maxPostsPerDay"]).number({
      min: 1,
      max: 50,
      integer: true,
      fallback: 3,
    }),
    minMinutesBetweenPosts: at("policy.minMinutesBetweenPosts", policyRaw["minMinutesBetweenPosts"]).number({
      min: 0,
      max: 1440,
      integer: true,
      fallback: 120,
    }),
    metricsWindowHours: at("policy.metricsWindowHours", policyRaw["metricsWindowHours"]).number({
      min: 1,
      max: 720,
      integer: true,
      fallback: 72,
    }),
    // 45 days clears a monthly close plus the lag before it. Optional with a
    // default, so a config written before this existed keeps working.
    conversionLookbackDays: at(
      "policy.conversionLookbackDays",
      policyRaw["conversionLookbackDays"],
    ).number({ min: 1, max: 400, integer: true, fallback: 45 }),
  };

  const trackingRaw = at("tracking", get(raw, "tracking")).object();
  const tracking: TrackingConfig = {
    // An invalid base URL is a broken link in every post that carries an offer,
    // so it is checked here rather than discovered in production.
    baseUrl: readUrl(
      at("tracking.baseUrl", trackingRaw["baseUrl"]),
      reader,
      "tracking.baseUrl",
      // The bare host. `shortUrl` appends `/go/<code>` itself; a fallback that
      // already ended in `/go` produced `…/go/go/<code>` in every post.
      "https://example.invalid",
    ),
    linkParam: at("tracking.linkParam", trackingRaw["linkParam"]).string("amp"),
    extraParams: readStringMap(at("tracking.extraParams", trackingRaw["extraParams"]).object(), reader, "tracking.extraParams"),
  };

  const licensingRaw = at("licensing", get(raw, "licensing")).object();
  const readTerms = (source: Record<string, unknown>, path: string, defaults: LicensingTerms): LicensingTerms => ({
    model: at(`${path}.model`, source["model"]).oneOf(["none", "subscription", "revshare"] as const, defaults.model),
    subscriptionAmount: at(`${path}.subscriptionAmount`, source["subscriptionAmount"]).number({
      min: 0,
      fallback: defaults.subscriptionAmount,
    }),
    subscriptionCurrency: at(`${path}.subscriptionCurrency`, source["subscriptionCurrency"]).string(
      defaults.subscriptionCurrency,
    ),
    revshareRate: at(`${path}.revshareRate`, source["revshareRate"]).number({
      min: 0,
      max: 1,
      fallback: defaults.revshareRate,
    }),
  });
  const licensingDefaults: LicensingTerms = {
    model: "none",
    subscriptionAmount: 0,
    subscriptionCurrency: "JPY",
    revshareRate: 0,
  };
  const baseTerms = readTerms(licensingRaw, "licensing", licensingDefaults);
  const licensing: LicensingConfig = {
    ...baseTerms,
    overrides: at("licensing.overrides", licensingRaw["overrides"]).objectArray().map(({ path, value }) => ({
      venture: at(`${path}.venture`, value["venture"]).string(),
      ...readTerms(value, path, baseTerms),
    })),
  };

  const markets = at("markets", get(raw, "markets")).objectArray().map(({ path, value }) => {
    const timezone = at(`${path}.timezone`, value["timezone"]).string("UTC");
    if (!isValidTimezone(timezone)) {
      at(`${path}.timezone`, timezone).reject("is not a recognised IANA timezone");
    }
    const market: Market = {
      id: at(`${path}.id`, value["id"]).string(),
      name: at(`${path}.name`, value["name"]).string(),
      language: at(`${path}.language`, value["language"]).string(),
      currency: at(`${path}.currency`, value["currency"]).string(),
      timezone,
      disclosureText: at(`${path}.disclosureText`, value["disclosureText"]).string(),
      regulator: at(`${path}.regulator`, value["regulator"]).string("(unspecified)"),
      prohibitedClaims: at(`${path}.prohibitedClaims`, value["prohibitedClaims"]).stringArray([]),
      restrictedCategories: at(`${path}.restrictedCategories`, value["restrictedCategories"])
        .objectArray()
        .map(({ path: categoryPath, value: categoryValue }) => {
          const restricted: RestrictedCategory = {
            category: at(`${categoryPath}.category`, categoryValue["category"]).string(),
            note: at(`${categoryPath}.note`, categoryValue["note"]).string(),
            prohibited: at(`${categoryPath}.prohibited`, categoryValue["prohibited"]).boolean(false),
          };
          return restricted;
        }),
      crossBorderNotice: at(`${path}.crossBorderNotice`, value["crossBorderNotice"]).string(""),
    };
    return market;
  });

  const channels = at("channels", get(raw, "channels")).objectArray().map(({ path, value }) => {
    const research = at(`${path}.research`, value["research"]).object();
    const channel: ChannelConfig = {
      id: at(`${path}.id`, value["id"]).string(),
      adapter: at(`${path}.adapter`, value["adapter"]).string("mock"),
      enabled: at(`${path}.enabled`, value["enabled"]).boolean(true),
      credentialEnv: readStringMap(at(`${path}.credentialEnv`, value["credentialEnv"]).object(), reader, `${path}.credentialEnv`),
      research: {
        queries: at(`${path}.research.queries`, research["queries"]).stringArray([]),
        minLikes: at(`${path}.research.minLikes`, research["minLikes"]).number({ min: 0, integer: true, fallback: 100 }),
        maxItems: at(`${path}.research.maxItems`, research["maxItems"]).number({ min: 1, max: 500, integer: true, fallback: 40 }),
        lookbackHours: at(`${path}.research.lookbackHours`, research["lookbackHours"]).number({
          min: 1,
          max: 720,
          integer: true,
          fallback: 24,
        }),
      },
      options: at(`${path}.options`, value["options"]).object(),
    };
    return channel;
  });

  const networks = at("networks", get(raw, "networks")).objectArray().map(({ path, value }) => {
    const network: NetworkConfig = {
      id: at(`${path}.id`, value["id"]).string(),
      adapter: at(`${path}.adapter`, value["adapter"]).string("mock"),
      enabled: at(`${path}.enabled`, value["enabled"]).boolean(true),
      credentialEnv: readStringMap(at(`${path}.credentialEnv`, value["credentialEnv"]).object(), reader, `${path}.credentialEnv`),
      options: at(`${path}.options`, value["options"]).object(),
    };
    return network;
  });

  const offers = at("offers", get(raw, "offers")).objectArray().map(({ path, value }) => {
    const offer: Offer = {
      id: at(`${path}.id`, value["id"]).string(),
      network: at(`${path}.network`, value["network"]).string(),
      name: at(`${path}.name`, value["name"]).string(),
      landingUrl: readUrl(at(`${path}.landingUrl`, value["landingUrl"]), reader, `${path}.landingUrl`),
      payoutModel: at(`${path}.payoutModel`, value["payoutModel"]).oneOf<PayoutModel>(
        ["cpa", "cpc", "revshare"],
        "cpa",
      ),
      payoutValue: at(`${path}.payoutValue`, value["payoutValue"]).number({ min: 0, fallback: 0 }),
      currency: at(`${path}.currency`, value["currency"]).string("JPY"),
      category: at(`${path}.category`, value["category"]).string("general"),
      originMarket: at(`${path}.originMarket`, value["originMarket"]).string(),
      targetMarkets: at(`${path}.targetMarkets`, value["targetMarkets"]).stringArray([]),
      crossBorderNote: at(`${path}.crossBorderNote`, value["crossBorderNote"]).string(""),
      complianceNotes: at(`${path}.complianceNotes`, value["complianceNotes"]).stringArray([]),
      active: at(`${path}.active`, value["active"]).boolean(true),
    };
    return offer;
  });

  const ventures = at("ventures", get(raw, "ventures")).objectArray().map(({ path, value }) => {
    const voiceRaw = at(`${path}.voice`, value["voice"]).object();
    const cadenceRaw = at(`${path}.cadence`, value["cadence"]).object();
    const voice: VoiceProfile = {
      persona: at(`${path}.voice.persona`, voiceRaw["persona"]).string(),
      firstPerson: at(`${path}.voice.firstPerson`, voiceRaw["firstPerson"]).string("私"),
      tone: at(`${path}.voice.tone`, voiceRaw["tone"]).stringArray([]),
      bannedPhrases: at(`${path}.voice.bannedPhrases`, voiceRaw["bannedPhrases"]).stringArray([]),
      signaturePhrases: at(`${path}.voice.signaturePhrases`, voiceRaw["signaturePhrases"]).stringArray([]),
    };
    const cycleStartsAt = at(`${path}.cadence.cycleStartsAt`, cadenceRaw["cycleStartsAt"]).string("06:30");
    try {
      parseTimeOfDay(cycleStartsAt);
    } catch {
      at(`${path}.cadence.cycleStartsAt`, cycleStartsAt).reject('must be "HH:MM" in 24-hour form');
    }
    const timezone = at(`${path}.timezone`, value["timezone"]).string("Asia/Tokyo");
    if (!isValidTimezone(timezone)) {
      at(`${path}.timezone`, timezone).reject("is not a recognised IANA timezone");
    }

    const venture: Venture = {
      id: at(`${path}.id`, value["id"]).string(),
      name: at(`${path}.name`, value["name"]).string(),
      niche: at(`${path}.niche`, value["niche"]).string(),
      audience: at(`${path}.audience`, value["audience"]).string(),
      market: at(`${path}.market`, value["market"]).string(),
      timezone,
      language: at(`${path}.language`, value["language"]).string("ja"),
      channels: at(`${path}.channels`, value["channels"]).stringArray([]),
      offers: at(`${path}.offers`, value["offers"]).stringArray([]),
      voice,
      cadence: {
        postsPerDay: at(`${path}.cadence.postsPerDay`, cadenceRaw["postsPerDay"]).number({
          min: 1,
          max: 50,
          integer: true,
          fallback: 2,
        }),
        minMinutesBetweenPosts: at(
          `${path}.cadence.minMinutesBetweenPosts`,
          cadenceRaw["minMinutesBetweenPosts"],
        ).number({ min: 0, max: 1440, integer: true, fallback: policy.minMinutesBetweenPosts }),
        cycleStartsAt,
        ideasPerCycle: at(`${path}.cadence.ideasPerCycle`, cadenceRaw["ideasPerCycle"]).number({
          min: 1,
          max: 50,
          integer: true,
          fallback: 10,
        }),
      },
      active: at(`${path}.active`, value["active"]).boolean(true),
    };
    return venture;
  });

  const config: PlatformConfig = {
    version,
    company,
    runtime,
    llm,
    console: consoleConfig,
    policy,
    tracking,
    licensing,
    markets,
    channels,
    networks,
    offers,
    ventures,
  };

  checkReferentialIntegrity(config, reader);

  if (reader.issues.length > 0) throw new ConfigError(reader.issues, source);
  return config;
}

/** One start plus one retry. Enough for a blip, not enough to pay for a bad day twice over. */
export const DEFAULT_MAX_CYCLE_ATTEMPTS = 2;
export const MAX_CYCLE_ATTEMPTS_RANGE = { min: 1, max: 5 } as const;

/**
 * Range-checked here rather than by `.number({ min, max })` so the message can
 * name the fix. The built-in one says "must be at most 5, got 20", which tells
 * a licensee what is wrong and nothing about what to write instead - and this
 * is a number whose only effect is on their bill.
 */
function readMaxCycleAttempts(field: ReturnType<ReturnType<typeof createReader>["at"]>): number {
  const { min, max } = MAX_CYCLE_ATTEMPTS_RANGE;
  const value = field.number({ integer: true, fallback: DEFAULT_MAX_CYCLE_ATTEMPTS });
  if (value < min || value > max) {
    field.reject(
      `must be between ${min} and ${max} - write ${DEFAULT_MAX_CYCLE_ATTEMPTS}, which is the default, ` +
        `or ${min} to stop retrying a failed day at all. Each extra attempt costs about one more cycle ` +
        `on a day that keeps failing.`,
    );
    return DEFAULT_MAX_CYCLE_ATTEMPTS;
  }
  return value;
}

/** Cross-references that a per-field validator cannot see. */
function checkReferentialIntegrity(config: PlatformConfig, reader: ReturnType<typeof createReader>): void {
  const { at } = reader;
  assertUnique(config.markets.map((m) => m.id), "markets", reader);
  assertUnique(config.channels.map((c) => c.id), "channels", reader);
  assertUnique(config.networks.map((n) => n.id), "networks", reader);
  assertUnique(config.offers.map((o) => o.id), "offers", reader);
  assertUnique(config.ventures.map((v) => v.id), "ventures", reader);

  // The whole point of naming operators is that the audit log can tell them
  // apart. Two people sharing a name, or a second entry reusing the owner's
  // passphrase, gives a record that looks attributed and is not.
  const operatorNames = new Set([config.company.operator]);
  const operatorEnvs = new Set([config.console.tokenEnv]);
  config.console.operators.forEach((operator, index) => {
    const path = `console.operators[${index}]`;
    if (operatorNames.has(operator.name)) {
      reader.at(`${path}.name`, operator.name).reject(
        `is already the name of another operator - the audit log could not tell them apart`,
      );
    }
    operatorNames.add(operator.name);
    if (operatorEnvs.has(operator.tokenEnv)) {
      reader.at(`${path}.tokenEnv`, operator.tokenEnv).reject(
        `is already another operator's passphrase - two people holding one secret are one person to the audit log`,
      );
    }
    operatorEnvs.add(operator.tokenEnv);
  });

  const channelIds = new Set(config.channels.map((c) => c.id));
  const networkIds = new Set(config.networks.map((n) => n.id));
  const offerIds = new Set(config.offers.map((o) => o.id));
  const marketById = new Map(config.markets.map((market) => [market.id, market]));

  if (config.markets.length === 0) {
    at("markets", config.markets).reject(
      "at least one market is required - it decides which advertising rules apply to what you publish",
    );
  }

  config.offers.forEach((offer, index) => {
    if (offer.network !== "" && !networkIds.has(offer.network)) {
      at(`offers[${index}].network`, offer.network).reject(
        `references unknown network "${offer.network}" (declared: ${[...networkIds].join(", ") || "none"})`,
      );
    }
    if (offer.originMarket !== "" && !marketById.has(offer.originMarket)) {
      at(`offers[${index}].originMarket`, offer.originMarket).reject(
        `references unknown market "${offer.originMarket}"`,
      );
    }
    if (offer.targetMarkets.length === 0) {
      at(`offers[${index}].targetMarkets`, offer.targetMarkets).reject(
        "must list at least one market this offer may be promoted in",
      );
    }
    for (const target of offer.targetMarkets) {
      if (!marketById.has(target)) {
        at(`offers[${index}].targetMarkets`, target).reject(`references unknown market "${target}"`);
      }
    }

    // Promoting a foreign merchant means the reader is owed things a domestic
    // one implies: currency, shipping, who they are actually contracting with.
    const foreignTargets = offer.targetMarkets.filter((target) => target !== offer.originMarket);
    if (foreignTargets.length > 0 && offer.crossBorderNote.trim() === "") {
      at(`offers[${index}].crossBorderNote`, offer.crossBorderNote).reject(
        `is required: this offer originates in "${offer.originMarket}" but is promoted in ` +
          `${foreignTargets.map((market) => `"${market}"`).join(", ")}. ` +
          `State what a reader there must know before clicking - currency, shipping, language support, ` +
          `and who they would be buying from.`,
      );
    }

    // A category a market bans outright cannot be promoted there at all.
    for (const target of offer.targetMarkets) {
      const restriction = marketById
        .get(target)
        ?.restrictedCategories.find((entry) => entry.category === offer.category);
      if (restriction?.prohibited) {
        at(`offers[${index}].targetMarkets`, target).reject(
          `market "${target}" prohibits the "${offer.category}" category: ${restriction.note}`,
        );
      }
    }
  });

  if (config.ventures.length === 0) {
    at("ventures", config.ventures).reject("at least one venture is required");
  }

  const ventureIds = new Set(config.ventures.map((venture) => venture.id));
  config.licensing.overrides.forEach((override, index) => {
    if (override.venture !== "" && !ventureIds.has(override.venture)) {
      at(`licensing.overrides[${index}].venture`, override.venture).reject(
        `references unknown venture "${override.venture}" - a billing override for a venture that does not exist ` +
          `would silently never apply`,
      );
    }
  });

  const offerById = new Map(config.offers.map((offer) => [offer.id, offer]));

  config.ventures.forEach((venture, index) => {
    if (venture.channels.length === 0) {
      at(`ventures[${index}].channels`, venture.channels).reject("at least one channel is required");
    }
    for (const channelId of venture.channels) {
      if (!channelIds.has(channelId)) {
        at(`ventures[${index}].channels`, channelId).reject(`references unknown channel "${channelId}"`);
      }
    }
    if (venture.market !== "" && !marketById.has(venture.market)) {
      at(`ventures[${index}].market`, venture.market).reject(
        `references unknown market "${venture.market}" (declared: ${[...marketById.keys()].join(", ") || "none"})`,
      );
    }
    for (const offerId of venture.offers) {
      if (!offerIds.has(offerId)) {
        at(`ventures[${index}].offers`, offerId).reject(`references unknown offer "${offerId}"`);
        continue;
      }
      // The rule that makes cross-border safe: an offer may only be carried by
      // a venture whose audience it is licensed to be shown to.
      const offer = offerById.get(offerId) as Offer;
      if (venture.market !== "" && !offer.targetMarkets.includes(venture.market)) {
        at(`ventures[${index}].offers`, offerId).reject(
          `offer "${offerId}" may not be promoted in market "${venture.market}". ` +
            `Its targetMarkets are ${offer.targetMarkets.map((market) => `"${market}"`).join(", ") || "(none)"}. ` +
            `Add "${venture.market}" there only if the network's terms actually permit it.`,
        );
      }
    }
    if (venture.cadence.postsPerDay > config.policy.maxPostsPerDay) {
      at(`ventures[${index}].cadence.postsPerDay`, venture.cadence.postsPerDay).reject(
        `exceeds policy.maxPostsPerDay (${config.policy.maxPostsPerDay})`,
      );
    }
  });
}

function assertUnique(ids: readonly string[], path: string, reader: ReturnType<typeof createReader>): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (id === "") return;
    if (seen.has(id)) reader.at(`${path}[${index}].id`, id).reject(`duplicate id "${id}"`);
    seen.add(id);
  });
}

function readStringMap(
  source: Record<string, unknown>,
  reader: ReturnType<typeof createReader>,
  path: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = reader.at(`${path}.${key}`, value).string("");
  }
  return out;
}

function readUrl(
  field: ReturnType<ReturnType<typeof createReader>["at"]>,
  reader: ReturnType<typeof createReader>,
  path: string,
  fallback?: string,
): string {
  // Passing "" as the default suppressed the reader's own "is required" check,
  // so a missing `offers[].landingUrl` sailed through `parseConfig` and
  // `doctor` and only surfaced as a failed draft at write time. No fallback
  // means required; an explicit "" fallback still means optional.
  const value = field.string(fallback);
  if (value === "") return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      reader.at(path, value).reject("must be an http(s) URL");
    }
  } catch {
    reader.at(path, value).reject(`is not a valid URL: "${value}"`);
  }
  return value;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
