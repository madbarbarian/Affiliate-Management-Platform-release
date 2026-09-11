/**
 * Wiring, on a machine.
 *
 * Finds the config on disk, opens the JSON store in the data directory, reads
 * the prompts out of `prompts/`, and hands all of it to `assembleRuntime` -
 * the part a Worker shares (`src/kernel/assemble.ts`). Every entry point that
 * runs as a process - the CLI, the console, the daemon - comes through here, so
 * there is exactly one description of how the parts fit together on this side.
 *
 * `dryRun` swaps storage, the model and every adapter for their simulated
 * versions in one place. That is the difference between "you can try it" and
 * "you can try it if you first get an API key, a Threads token, and a network
 * account".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { randomIds, type IdGenerator } from "./core/ids.ts";
import { consoleSink, createLogger, type Logger } from "./core/logger.ts";
import { fail, type PlatformError, type Result } from "./core/result.ts";
import { systemClock, type Clock } from "./core/clock.ts";
import { parseReleaseStamp, type ReleaseStamp } from "./core/release.ts";
import { loadConfig, loadDotEnv, repoRoot, type LoadedConfig } from "./config/load.ts";
import { ConfigError } from "./config/schema.ts";
import { createJsonRegistry } from "./storage/json-store.ts";
import { createMemoryRegistry } from "./storage/memory-store.ts";
import type { StoreRegistry } from "./storage/store.ts";
import { createPromptLibrary } from "./kernel/prompts.ts";
import { fileState } from "./kernel/state.ts";
import { assembleRuntime, type Runtime } from "./kernel/assemble.ts";

export type { Runtime } from "./kernel/assemble.ts";

export type RuntimeOptions = {
  readonly configPath?: string;
  readonly cwd?: string;
  /**
   * Run against simulated storage, model and adapters. Nothing is written to
   * disk and nothing is published.
   */
  readonly dryRun?: boolean;
  /** Take the data-directory lock. Off for read-only commands. */
  readonly lock?: boolean;
  /** Identifies the lock holder in error messages. */
  readonly owner?: string;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: Logger;
  readonly env?: NodeJS.ProcessEnv;
};

export async function createRuntime(options: RuntimeOptions = {}): Promise<Result<Runtime, PlatformError>> {
  const env = options.env ?? process.env;
  loadDotEnv(options.cwd ?? repoRoot());

  let loaded: LoadedConfig;
  try {
    loaded = await loadConfig({
      ...(options.configPath ? { explicit: options.configPath } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env,
    });
  } catch (cause) {
    if (cause instanceof ConfigError) {
      return fail("config", "config.invalid", cause.message, { cause });
    }
    return fail("config", "config.unreadable", cause instanceof Error ? cause.message : String(cause), { cause });
  }

  const dryRun = options.dryRun ?? false;

  // One account named means a data directory written before the split can be
  // moved into its folder; more than one and it refuses rather than guessing.
  // See docs/3-development/store-split.md.
  const only = loaded.config.ventures.length === 1 ? loaded.config.ventures[0]!.id : undefined;
  const stores: StoreRegistry = dryRun
    ? createMemoryRegistry()
    : createJsonRegistry({
        dataDir: loaded.dataDir,
        lock: options.lock ?? false,
        ...(options.owner ? { owner: options.owner } : {}),
        ...(only ? { assignExistingTo: only } : {}),
      });

  // The real switches, dry run or not. `--dry-run` swaps storage, the model and
  // the adapters so nothing is published; the stop and the deactivations are
  // the operator's answer to "what is running", and a dry run that reports
  // something different from the live one is worse than useless - it is what
  // someone checks *because* they are unsure.
  const state = fileState(loaded.dataDir);
  // A no-op for the file adapter; a database-backed one loads its snapshot here
  // so no entry point can read the stop before it has been read.
  await state.refresh?.();

  const release = readReleaseStamp();

  return assembleRuntime({
    loaded,
    stores,
    state,
    ...(release ? { release } : {}),
    prompts: createPromptLibrary(loaded.promptsDir),
    clock: options.clock ?? systemClock,
    ids: options.ids ?? randomIds,
    logger:
      options.logger ??
      createLogger({
        level: loaded.config.runtime.logLevel,
        sink: consoleSink(loaded.config.runtime.logFormat),
        base: dryRun ? { mode: "dry-run" } : {},
      }),
    env,
    dryRun,
  });
}

/**
 * Which release this copy is, for the update notice.
 *
 * Absent in this repository - `RELEASE.json` is written into the distribution
 * by `scripts/make-release.ts`, not committed here - and absent is the right
 * answer: a development checkout was never released, so it cannot be behind
 * anything. Reading is best-effort for the same reason the parser is
 * forgiving: this file sits in the licensee's own repository, and a broken one
 * must cost them the notice and never the console.
 */
function readReleaseStamp(): ReleaseStamp | undefined {
  try {
    return parseReleaseStamp(readFileSync(join(repoRoot(), "RELEASE.json"), "utf8"));
  } catch {
    return undefined;
  }
}
