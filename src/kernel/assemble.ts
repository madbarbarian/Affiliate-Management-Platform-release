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
import type { LoadedConfig } from "../config/load.ts";
import type { PlatformConfig } from "../config/schema.ts";
import { createAnthropicProvider } from "../llm/anthropic.ts";
import { createMockProvider } from "../llm/mock.ts";
import { createDemoHandlers } from "../llm/demo.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { Store } from "../storage/store.ts";
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
  readonly dryRun: boolean;
  close(): Promise<void>;
};

export type AssembleParts = {
  readonly loaded: LoadedConfig;
  readonly store: Store;
  readonly state: StateStore;
  readonly prompts: PromptLibrary;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dryRun: boolean;
};

export async function assembleRuntime(parts: AssembleParts): Promise<Result<Runtime, PlatformError>> {
  const { loaded, store, state, prompts, clock, ids, logger, env, dryRun } = parts;
  const { config } = loaded;

  const llm = buildLlm(config, env, logger, dryRun);
  if (!llm.ok) {
    await store.close();
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
    cachedCodes = (await store.links.all()).map((link) => link.code);
  };
  await refreshCodes();

  const channels = createChannelRegistry({
    channels: dryRun ? config.channels.map((channel) => ({ ...channel, adapter: "mock" })) : config.channels,
    env,
    nowMs: () => clock.now(),
  });
  if (!channels.ok) {
    await store.close();
    return channels;
  }

  const networks = createNetworkRegistry({
    networks: dryRun ? config.networks.map((network) => ({ ...network, adapter: "mock" })) : config.networks,
    env,
    nowMs: () => clock.now(),
    knownSubIds: () => cachedCodes,
  });
  if (!networks.ok) {
    await store.close();
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
    store,
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
    dryRun,
    async close() {
      await store.close();
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
      const decision = await services.store.decisions.get(decisionId);
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

    pendingDecisions(ventureId) {
      return inner.pendingDecisions(ventureId);
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
      // Half the people who see this are on Cloudflare, where there is no
      // .env.local and no terminal to put one in - naming only that fix sends
      // them looking for a file that cannot exist.
      `llm.provider is "anthropic" but ${config.llm.apiKeyEnv} is not set. ` +
        `Put it in .env.local, or - on Cloudflare - add it as a secret ` +
        `(wrangler secret put ${config.llm.apiKeyEnv}, or the Workers dashboard). ` +
        `Or set llm.provider to "mock" to run without a model.`,
    );
  }
  return ok(createAnthropicProvider({ config: config.llm, apiKey, logger }));
}
