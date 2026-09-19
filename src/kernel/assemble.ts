/**
 * Assembling the company from parts that are already in hand.
 *
 * `runtime.ts` finds those parts on a filesystem; a Worker gets them from its
 * bindings. Everything after that - which model, how the channels and networks
 * are registered, what the stop wraps, what a `Runtime` even is - is the same
 * on both, and lives here so it cannot come to differ.
 *
 * Nothing in this file touches the filesystem, the clock, or `process`.
 */

import { createEventBus, type EventBus } from "../core/events.ts";
import type { IdGenerator } from "../core/ids.ts";
import type { Logger } from "../core/logger.ts";
import { fail, ok, type Err, type PlatformError, type Result } from "../core/result.ts";
import type { VentureId } from "../core/types.ts";
import type { Clock } from "../core/clock.ts";
import type { ReleaseStamp } from "../core/release.ts";
import type { LoadedConfig } from "../config/load.ts";
import type { PlatformConfig } from "../config/schema.ts";
import { createAnthropicProvider } from "../llm/anthropic.ts";
import { createMockProvider } from "../llm/mock.ts";
import { createDemoHandlers } from "../llm/demo.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { StoreRegistry } from "../storage/store.ts";
import type { Decision } from "../core/types.ts";
import type { Lock } from "../storage/lock.ts";
import { createChannelRegistry } from "../channels/index.ts";
import { createNetworkRegistry } from "../networks/index.ts";
import type { PromptLibrary } from "./prompts.ts";
import { createOrchestrator, type Orchestrator } from "./orchestrator.ts";
import { describePause, pausedVentures, readPause, type PauseRecord } from "./pause.ts";
import { deactivatedBy, describeInactive, inactiveVentures, readVentureState } from "./venture-state.ts";
import type { StateStore } from "./state.ts";
import type { Services } from "./role.ts";

export type Runtime = {
  readonly loaded: LoadedConfig;
  readonly config: PlatformConfig;
  /** The stop and the deactivation switches. Files on a machine, rows on a host. */
  readonly state: StateStore;
  readonly services: Services;
  readonly orchestrator: Orchestrator;
  readonly bus: EventBus;
  /**
   * "Only one of these at a time", where the host needs telling. Undefined on a
   * machine, where the data directory's lock already answers that question.
   * Here so a request and a cron trigger can take the *same* lock: without it
   * the console's run button would race the hourly tick, and the two would
   * draft the same day twice.
   */
  readonly lock?: Lock;
  readonly dryRun: boolean;
  /**
   * Which copy of the platform this is, when it is a released one. Undefined in
   * a development checkout, and then the update notice has nothing to compare
   * and stays quiet. See `src/core/release.ts`.
   */
  readonly release?: ReleaseStamp;
  close(): Promise<void>;
};

export type AssembleParts = {
  readonly loaded: LoadedConfig;
  readonly stores: StoreRegistry;
  readonly state: StateStore;
  readonly prompts: PromptLibrary;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly lock?: Lock;
  readonly dryRun: boolean;
  readonly release?: ReleaseStamp;
};

export async function assembleRuntime(parts: AssembleParts): Promise<Result<Runtime, PlatformError>> {
  const { loaded, stores, state, prompts, clock, ids, logger, env, dryRun } = parts;
  const { config } = loaded;

  const llm = buildLlm(config, env, logger, dryRun);
  if (!llm.ok) {
    await stores.close();
    return llm;
  }

  // The mock network simulates conversions against links the platform has
  // actually issued, so it needs to be able to look them up. Nothing else does,
  // and reading every link ever issued is a real cost on a host that assembles
  // this per request - so it is only done when something simulated is wired up.
  let cachedCodes: string[] = [];
  const needsCodes = dryRun || config.networks.some((network) => network.adapter === "mock");
  const refreshCodes = async (): Promise<void> => {
    if (!needsCodes) return;
    // Every account's, because the simulator answers for the whole company.
    const codes: string[] = [];
    for (const scope of await stores.each()) {
      codes.push(...(await scope.store.links.all()).map((link) => link.code));
    }
    cachedCodes = codes;
  };
  await refreshCodes();

  const channels = createChannelRegistry({
    channels: dryRun ? config.channels.map((channel) => ({ ...channel, adapter: "mock" })) : config.channels,
    env,
    nowMs: () => clock.now(),
  });
  if (!channels.ok) {
    await stores.close();
    return channels;
  }

  const networks = createNetworkRegistry({
    networks: dryRun ? config.networks.map((network) => ({ ...network, adapter: "mock" })) : config.networks,
    env,
    nowMs: () => clock.now(),
    knownSubIds: () => cachedCodes,
  });
  if (!networks.ok) {
    await stores.close();
    return networks;
  }

  const bus = createEventBus(logger);
  bus.on("role.write.completed", () => {
    void refreshCodes();
  });

  const services: Services = {
    config,
    clock,
    ids,
    logger,
    llm: llm.value,
    stores,
    channels: channels.value,
    networks: networks.value,
    prompts,
    bus,
  };

  const orchestrator = createOrchestrator(services);

  return ok({
    loaded,
    config,
    state,
    services,
    // The stop is enforced here rather than inside the orchestrator, which has
    // no business reading operating state, and rather than in each entry point,
    // where the fourth one added would forget. Every surface - CLI, console,
    // daemon, Worker - goes through this wiring, so this is the one place that
    // covers all of them.
    orchestrator: dryRun ? orchestrator : guardWithStop(orchestrator, services, state),
    bus,
    ...(parts.lock ? { lock: parts.lock } : {}),
    ...(parts.release ? { release: parts.release } : {}),
    dryRun,
    async close() {
      await stores.close();
    },
  });
}

/**
 * Wraps the orchestrator so nothing runs or publishes while the operator has
 * stopped the platform.
 *
 * A dry run deliberately skips this: it publishes nothing, and investigating
 * what went wrong is the main thing anyone does while stopped.
 */
export function guardWithStop(inner: Orchestrator, services: Services, state: StateStore): Orchestrator {
  const stopped = (record: PauseRecord, ventureId?: VentureId): Err<PlatformError> =>
    fail("conflict", "platform.stopped", describePause(record, ventureId), {
      // Never retried automatically. A stop is a decision, not a transient
      // failure, and quietly retrying past one is the whole thing this prevents.
      retryable: false,
      details: { stoppedAt: record.at, stoppedBy: record.by },
    });

  return {
    async runCycle(ventureId, options) {
      const stop = readPause(state);
      if (stop.all) return stopped(stop.all);
      const record = stop.ventures[ventureId];
      if (record) return stopped(record, ventureId);
      // Switched off by the operator: not an emergency, not an error in the
      // config, just an account that is not running this season. Same place
      // as the stop so no entry point can forget it.
      const venture = services.config.ventures.find((entry) => entry.id === ventureId);
      const ventureState = readVentureState(state);
      if (venture && deactivatedBy(ventureState, venture.id)) {
        return fail("conflict", "venture.deactivated", describeInactive(venture, ventureState), { retryable: false });
      }
      return inner.runCycle(ventureId, options);
    },

    async resolveGate(decisionId, request) {
      const stop = readPause(state);
      if (stop.all) return stopped(stop.all);
      // Per-venture stops need the decision to know which venture is being
      // approved. An unknown decision falls through to the orchestrator, which
      // reports it as not found - that is its message to give, not ours.
      // Crossing on purpose, and for the same reason resolveGate does: an
      // approval arrives as an id with no account attached.
      let decision: Decision | undefined;
      for (const scope of await services.stores.each()) {
        decision = await scope.store.decisions.get(decisionId);
        if (decision) break;
      }
      const record = decision ? stop.ventures[decision.ventureId] : undefined;
      if (record && decision) return stopped(record, decision.ventureId);
      return inner.resolveGate(decisionId, request);
    },

    async dispatchDue(nowMs, options) {
      const stop = readPause(state);
      const held = stop.all ? services.config.ventures.map((venture) => venture.id) : pausedVentures(stop);
      // A deactivated account's approved posts wait too. Deactivation is
      // indefinite, so they may wait a long time; the operator sees them in
      // the console's upcoming list and decides on reactivation.
      const off = inactiveVentures(readVentureState(state));
      return inner.dispatchDue(nowMs, {
        skipVentures: [...(options?.skipVentures ?? []), ...held, ...off],
      });
    },

    // Not gated on the stop, for the same reason `dispatchDue` records posts a
    // channel put out on its own clock: this does not publish anything, it
    // records that a person already did. A stop that arrived after the post was
    // handed over cannot un-post it, and refusing here would leave the operator
    // with a live post the platform denies exists - and no link between it and
    // the clicks it is about to earn.
    recordPostedByHand(postId, request) {
      return inner.recordPostedByHand(postId, request);
    },

    pendingDecisions(ventureId) {
      return inner.pendingDecisions(ventureId);
    },

    // Not gated on the stop. Expiring a gate publishes nothing and runs no
    // role; it records that a day went by unanswered, which is as true while
    // stopped as it is while running. Suppressing it would hand the operator a
    // pile of gates on resume and no way to see when each one lapsed.
    expireStaleGates() {
      return inner.expireStaleGates();
    },
  };
}

export function buildLlm(
  config: PlatformConfig,
  env: Readonly<Record<string, string | undefined>>,
  logger: Logger,
  dryRun: boolean,
): Result<LlmProvider, PlatformError> {
  if (dryRun || config.llm.provider === "mock") {
    if (!dryRun) {
      logger.warn("llm.provider is \"mock\" - no real model will be called");
    }
    return ok(createMockProvider({ responses: createDemoHandlers() }));
  }

  const apiKey = env[config.llm.apiKeyEnv];
  if (!apiKey) {
    return fail(
      "config",
      "llm.no_api_key",
      // Most of the people who see this are on Cloudflare, where there is no
      // .env.local, no terminal and therefore no `wrangler secret put` - which
      // is what this used to name first. A licensee met it the day they
      // switched to the real model, and the fix it offered was one they could
      // not carry out. The dashboard path is the one that exists for them, so
      // it goes first and in full; the file is for whoever has a machine.
      `llm.provider is "anthropic" but ${config.llm.apiKeyEnv} is not set. ` +
        `On Cloudflare: Workers & Pages -> this Worker -> Settings -> ` +
        `Variables and Secrets -> Add, name ${config.llm.apiKeyEnv}, type Secret. ` +
        `On your own machine: put it in .env.local (or wrangler secret put ` +
        `${config.llm.apiKeyEnv}). Or set llm.provider to "mock" to run without a model.`,
    );
  }
  return ok(createAnthropicProvider({ config: config.llm, apiKey, logger }));
}
