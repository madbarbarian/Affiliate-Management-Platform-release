/**
 * What a role is.
 *
 * A role is one job in the company: research, planning, writing, inspection,
 * analysis, publishing. Each one takes a typed input, does its job, and
 * returns a typed output or a failure. It does not decide what runs next, does
 * not talk to another role, and does not know a human exists. The orchestrator
 * owns all of that.
 *
 * Keeping roles that dumb is what makes the company extensible: a licensee who
 * wants a seventh role - a legal reviewer, a translator, a thumbnail designer -
 * writes one of these and adds it to the pipeline.
 */

import type { Clock } from "../core/clock.ts";
import type { EventBus } from "../core/events.ts";
import type { IdGenerator } from "../core/ids.ts";
import type { Logger } from "../core/logger.ts";
import type { PlatformError, Result } from "../core/result.ts";
import { COMPANY_SCOPE, type AuditEvent, type CycleId, type Venture } from "../core/types.ts";
import type { PlatformConfig } from "../config/schema.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { Store, StoreRegistry } from "../storage/store.ts";
import type { ChannelRegistry } from "../channels/index.ts";
import { findMarket, resolveCompliance } from "../domain/market.ts";
import type { NetworkRegistry } from "../networks/index.ts";
import type { PromptLibrary } from "./prompts.ts";

/** Services shared by every role and by the orchestrator. */
export type Services = {
  readonly config: PlatformConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly llm: LlmProvider;
  /**
   * Every account's store, and the only way to reach one.
   *
   * There is no `store` here on purpose: a service bag shared by six roles and
   * the orchestrator cannot hold "the" store without one of them reaching into
   * an account that is not theirs. A `RoleContext` has a `store`, because a
   * role always knows whose work it is doing.
   */
  readonly stores: StoreRegistry;
  readonly channels: ChannelRegistry;
  readonly networks: NetworkRegistry;
  readonly prompts: PromptLibrary;
  readonly bus: EventBus;
};

export type RoleContext = Services & {
  readonly venture: Venture;
  readonly cycleId: CycleId;
  /** This account's store. Nothing outside it is reachable. */
  readonly store: Store;
  /** Records something worth auditing. Never throws. */
  note(type: string, summary: string, data?: Record<string, unknown>): Promise<void>;
};

/**
 * The context for a role that works for the company rather than for one
 * venture - today only the scout, which proposes the *next* venture and so
 * cannot belong to any existing one. Same services, same audit contract; the
 * events carry `COMPANY_SCOPE` where a venture id would go.
 */
export type CompanyContext = Services & {
  /** The company's own store, under COMPANY_SCOPE - no account's. */
  readonly store: Store;
  note(type: string, summary: string, data?: Record<string, unknown>): Promise<void>;
};

export type Role<Input, Output, Context = RoleContext> = {
  readonly id: string;
  /** How this role would be introduced on an org chart. */
  readonly title: string;
  /** One sentence: what this role is responsible for. */
  readonly description: string;
  run(context: Context, input: Input): Promise<Result<Output, PlatformError>>;
};

export async function createCompanyContext(services: Services, actor: string): Promise<CompanyContext> {
  const store = await services.stores.for(COMPANY_SCOPE);
  return {
    ...services,
    store,
    logger: services.logger.child({ venture: COMPANY_SCOPE, role: actor }),
    async note(type, summary, data = {}) {
      const event: AuditEvent = {
        id: services.ids.next("evt"),
        at: services.clock.nowIso(),
        ventureId: COMPANY_SCOPE,
        type,
        actor,
        summary,
        data,
      };
      await store.audit.append(event);
      await services.bus.emit(event);
    },
  };
}

export async function createRoleContext(
  services: Services,
  venture: Venture,
  cycleId: CycleId,
  actor: string,
): Promise<RoleContext> {
  const store = await services.stores.for(venture.id);
  return {
    ...services,
    venture,
    cycleId,
    store,
    logger: services.logger.child({ venture: venture.id, cycle: cycleId, role: actor }),
    async note(type, summary, data = {}) {
      const event: AuditEvent = {
        id: services.ids.next("evt"),
        at: services.clock.nowIso(),
        ventureId: venture.id,
        cycleId,
        type,
        actor,
        summary,
        data,
      };
      await store.audit.append(event);
      await services.bus.emit(event);
    },
  };
}

/**
 * The stable half of every prompt: who this account is and who it is for.
 *
 * Byte-identical across all six roles within a cycle, which is the point - it
 * is the cached prefix, so the sixth role's call pays for the brief once
 * rather than six times.
 */
export function ventureBrief(venture: Venture, config: PlatformConfig): string {
  const profile = resolveCompliance({
    policy: config.policy,
    market: findMarket(config.markets, venture.market),
  });
  return [
    `# アカウント / Account brief`,
    ``,
    `- Company: ${config.company.name}`,
    `- Venture: ${venture.name} (${venture.id})`,
    `- Niche: ${venture.niche}`,
    `- Audience: ${venture.audience}`,
    `- Language: write in ${venture.language}`,
    `- Timezone: ${venture.timezone}`,
    ``,
    ...companyPrinciples(config),
    `## Voice`,
    `- Persona: ${venture.voice.persona}`,
    `- First person: ${venture.voice.firstPerson}`,
    `- Tone: ${venture.voice.tone.join(" / ") || "(unspecified)"}`,
    `- Signature phrases: ${venture.voice.signaturePhrases.join(" / ") || "(none)"}`,
    `- Never write: ${[...venture.voice.bannedPhrases, ...config.policy.bannedPhrases].join(" / ") || "(none)"}`,
    ``,
    `## Non-negotiable rules`,
    // Resolved from the venture's market, not read off the platform-wide
    // policy. Compliance follows the audience: telling a role to write "#ad"
    // for Japanese readers is how a market's own wording never appears.
    `- Any post carrying an affiliate offer must disclose it: "${profile.disclosureText}"`,
    `- Never make these claims: ${profile.prohibitedClaims.join(" / ") || "(none)"}`,
    `- Write as one person recounting what they did, not as a brand describing a product.`,
  ].join("\n");
}

/**
 * The company's thinking, identical in every venture's brief. This is how a
 * second, third and twentieth account still sound like the same company: not
 * the same voice - each venture has its own - but the same judgement about
 * what is worth saying and what is never done.
 *
 * Empty sections are omitted rather than rendered as "(none)": a company that
 * has not written its principles down should not have a heading implying it
 * has.
 */
export function companyPrinciples(config: PlatformConfig): string[] {
  const lines: string[] = [];
  if (config.company.principles.length > 0) {
    lines.push(`## How this company thinks`, ...config.company.principles.map((line) => `- ${line}`), ``);
  }
  if (config.company.boundaries.length > 0) {
    lines.push(
      `## What this company never does, in any venture`,
      ...config.company.boundaries.map((line) => `- ${line}`),
      ``,
    );
  }
  return lines;
}
