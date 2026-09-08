/**
 * The affiliate-network registry. Mirrors the channel registry: one factory
 * per adapter, resolved by name from config.
 */

import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import type { NetworkConfig } from "../config/schema.ts";
import { createCsvNetwork } from "./csv.ts";
import { createMockNetwork } from "./mock.ts";
import { createWebhookNetwork } from "./webhook.ts";
import type { NetworkFactory, OfferNetwork } from "./network.ts";

export type NetworkRegistryOptions = {
  readonly networks: readonly NetworkConfig[];
  readonly env: NodeJS.ProcessEnv;
  readonly nowMs: () => number;
  /** Tracking codes issued so far, for adapters that simulate conversions. */
  readonly knownSubIds?: () => readonly string[];
  readonly factories?: Record<string, NetworkFactory>;
};

export type NetworkRegistry = {
  get(id: string): Result<OfferNetwork, PlatformError>;
  enabled(): OfferNetwork[];
};

export function createNetworkRegistry(options: NetworkRegistryOptions): Result<NetworkRegistry, PlatformError> {
  const factories: Record<string, NetworkFactory> = {
    mock: (context) => createMockNetwork(context, { ...(options.knownSubIds ? { knownSubIds: options.knownSubIds } : {}) }),
    csv: createCsvNetwork,
    webhook: createWebhookNetwork,
    ...options.factories,
  };

  const networks = new Map<string, OfferNetwork>();
  for (const config of options.networks) {
    if (!config.enabled) continue;
    const factory = factories[config.adapter];
    if (!factory) {
      return fail(
        "config",
        "network.unknown_adapter",
        `Network "${config.id}" uses adapter "${config.adapter}", which is not registered. ` +
          `Available: ${Object.keys(factories).sort().join(", ")}.`,
      );
    }
    const credentials: Record<string, string> = {};
    for (const [key, envName] of Object.entries(config.credentialEnv)) {
      credentials[key] = options.env[envName] ?? "";
    }
    networks.set(config.id, factory({ id: config.id, credentials, options: config.options, nowMs: options.nowMs }));
  }

  return ok({
    get(id) {
      const network = networks.get(id);
      if (!network) {
        return fail("config", "network.not_found", `Network "${id}" is not configured or is disabled.`, {
          details: { available: [...networks.keys()] },
        });
      }
      return ok(network);
    },
    enabled() {
      return [...networks.values()];
    },
  });
}

export type { NetworkConversion, NetworkFactory, OfferNetwork } from "./network.ts";
