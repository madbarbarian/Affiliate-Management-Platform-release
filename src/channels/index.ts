/**
 * The channel registry.
 *
 * Adding a channel to the platform means writing one factory and adding one
 * line here. A licensee who needs a channel the platform does not ship can add
 * theirs the same way without touching any other file.
 */

import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import type { ChannelConfig } from "../config/schema.ts";
import type { Channel, ChannelFactory } from "./channel.ts";
import { createManualChannel, MANUAL_ADAPTER } from "./manual.ts";
import { createMockChannel } from "./mock.ts";
import { createThreadsChannel } from "./threads.ts";
import { createWebhookChannel } from "./webhook.ts";

export const builtinChannelFactories: Record<string, ChannelFactory> = {
  [MANUAL_ADAPTER]: createManualChannel,
  mock: createMockChannel,
  threads: createThreadsChannel,
  webhook: createWebhookChannel,
};

export type ChannelRegistryOptions = {
  readonly channels: readonly ChannelConfig[];
  readonly env: NodeJS.ProcessEnv;
  readonly nowMs: () => number;
  /** Extra or overriding factories, keyed by adapter name. */
  readonly factories?: Record<string, ChannelFactory>;
};

export type ChannelRegistry = {
  get(id: string): Result<Channel, PlatformError>;
  enabled(): Channel[];
};

export function createChannelRegistry(options: ChannelRegistryOptions): Result<ChannelRegistry, PlatformError> {
  const factories = { ...builtinChannelFactories, ...options.factories };
  const channels = new Map<string, Channel>();

  for (const config of options.channels) {
    if (!config.enabled) continue;
    const factory = factories[config.adapter];
    if (!factory) {
      return fail(
        "config",
        "channel.unknown_adapter",
        `Channel "${config.id}" uses adapter "${config.adapter}", which is not registered. ` +
          `Available: ${Object.keys(factories).sort().join(", ")}.`,
      );
    }
    const credentials: Record<string, string> = {};
    for (const [key, envName] of Object.entries(config.credentialEnv)) {
      credentials[key] = options.env[envName] ?? "";
    }
    channels.set(
      config.id,
      factory({ id: config.id, credentials, options: config.options, nowMs: options.nowMs }),
    );
  }

  return ok({
    get(id) {
      const channel = channels.get(id);
      if (!channel) {
        return fail("config", "channel.not_found", `Channel "${id}" is not configured or is disabled.`, {
          details: { available: [...channels.keys()] },
        });
      }
      return ok(channel);
    },
    enabled() {
      return [...channels.values()];
    },
  });
}

export type { Channel, ChannelFactory } from "./channel.ts";
