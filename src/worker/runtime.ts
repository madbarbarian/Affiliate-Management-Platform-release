/**
 * Wiring, on Cloudflare.
 *
 * The mirror of `src/runtime.ts`: same company, different way of getting hold
 * of the parts. The config and the prompts come from the build (there is no
 * readable filesystem), storage and the switches come from D1, and secrets come
 * from the Worker's own environment rather than `.env.local`.
 *
 * Everything after that is `assembleRuntime`, shared with the machine.
 */

import { randomIds } from "../core/ids.ts";
import { createLogger, jsonConsoleSink } from "../core/logger.ts";
import { fail, type PlatformError, type Result } from "../core/result.ts";
import { systemClock } from "../core/clock.ts";
import { buildConfig, type LoadedConfig } from "../config/load.ts";
import { ConfigError } from "../config/schema.ts";
import { createPromptLibraryFrom } from "../kernel/prompts.ts";
import { assembleRuntime, type Runtime } from "../kernel/assemble.ts";
import { createSqlRegistry, ensureSqlSchema } from "../storage/sql-store.ts";
import { createSqlState } from "../storage/sql-state.ts";
import { createD1Driver, type D1Database } from "../storage/d1-driver.ts";
import type { Lock } from "../storage/lock.ts";

export type WorkerEnv = {
  /** The D1 binding declared in wrangler.jsonc. */
  readonly DB: D1Database;
  /** Secrets and vars arrive on the same object, as strings. */
  readonly [key: string]: unknown;
};

export type WorkerParts = {
  readonly env: WorkerEnv;
  readonly configText: string;
  readonly prompts: Readonly<Record<string, string>>;
  /** The Durable Object lock, where the deploy has one bound. */
  readonly lock?: Lock;
};

/**
 * A path in the config is still a path, even where nothing can read it. They
 * are only used in messages here, so they name the source rather than a place.
 */
const CONFIG_PATH = "platform.config.yaml (bundled at build time)";

export async function createWorkerRuntime(parts: WorkerParts): Promise<Result<Runtime, PlatformError>> {
  const { env } = parts;
  // Only the string entries: the D1 binding and any Durable Object namespace
  // are on the same object, and an adapter asking for a token must not get one.
  const stringEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") stringEnv[key] = value;
  }

  let loaded: LoadedConfig;
  try {
    loaded = buildConfig(parts.configText, CONFIG_PATH, stringEnv);
  } catch (cause) {
    if (cause instanceof ConfigError) {
      return fail("config", "config.invalid", cause.message, { cause });
    }
    return fail("config", "config.unreadable", cause instanceof Error ? cause.message : String(cause), { cause });
  }

  if (!env.DB) {
    return fail(
      "config",
      "worker.no_database",
      "There is no D1 binding called DB. It is declared in wrangler.jsonc and created for you on the first deploy; " +
        "if this is a Worker made by hand, add the binding and deploy again.",
    );
  }

  const driver = createD1Driver(env.DB);
  // One account named means a database written before the split can be
  // upgraded; more than one and it refuses rather than guessing. See
  // docs/3-development/store-split.md.
  const only = loaded.config.ventures.length === 1 ? loaded.config.ventures[0]!.id : undefined;
  const stores = createSqlRegistry(driver, only ? { assignExistingTo: only } : {});
  // Before the state store reads anything: the registry applies the schema
  // lazily, when an account is first opened, and the stop must never be read
  // from a database whose `state` table does not exist yet - an unreadable
  // stop means stopped.
  await ensureSqlSchema(driver, only ? { assignExistingTo: only } : {});
  const state = createSqlState(driver);
  // Before this, every read of the stop reports "unreadable", which means
  // stopped. Nothing runs on a state store that has not actually been read.
  await state.refresh?.();

  return assembleRuntime({
    loaded,
    stores,
    state,
    prompts: createPromptLibraryFrom(parts.prompts),
    clock: systemClock,
    ids: randomIds,
    logger: createLogger({
      level: loaded.config.runtime.logLevel,
      // Always JSON, and through `console` rather than `process.stdout`: these
      // lines go to `wrangler tail` and the dashboard, and there is no stdout
      // to write to - reaching for one throws from inside the logger, which
      // would take down the tick that was trying to report something.
      sink: jsonConsoleSink(),
    }),
    env: stringEnv,
    ...(parts.lock ? { lock: parts.lock } : {}),
    dryRun: false,
  });
}
