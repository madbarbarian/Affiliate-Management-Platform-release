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
import type { ReleaseStamp } from "../core/release.ts";
import { buildConfig, type LoadedConfig } from "../config/load.ts";
import { ConfigError } from "../config/schema.ts";
import { createPromptLibraryFrom } from "../kernel/prompts.ts";
import { assembleRuntime, type Runtime } from "../kernel/assemble.ts";
import { createSqlRegistry, ensureSqlSchema, type MigrateOptions } from "../storage/sql-store.ts";
import { createSqlState } from "../storage/sql-state.ts";
import { createD1Driver, type D1Database } from "../storage/d1-driver.ts";
import type { SqlDriver } from "../storage/sql-driver.ts";
import type { StoreRegistry } from "../storage/store.ts";
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
  /** Which release this Worker was built from, when it was built from one. */
  readonly release?: ReleaseStamp;
};

/**
 * A path in the config is still a path, even where nothing can read it. They
 * are only used in messages here, so they name the source rather than a place.
 */
const CONFIG_PATH = "platform.config.yaml (bundled at build time)";

/**
 * The driver and the store registry, kept for as long as this isolate lives.
 *
 * `createWorkerRuntime` runs once per request, and rebuilds everything else -
 * on purpose: a fresh `Runtime` is the simplest guarantee that one request
 * never inherits another's half-read config. But `env.DB` names the same D1
 * database for the whole life of a deployment; there is no scenario where one
 * isolate answers `fetch` for two different licensees or two different
 * databases (docs/3-development/adding-people.md - a second customer is a
 * second Worker and a second D1, on purpose, not a second row in this one).
 * Rebuilding the driver anyway meant `ensureSchema`'s own memo - a `WeakMap`
 * keyed on the driver, "once per driver for as long as it lives, which on a
 * Worker is once per isolate" (sql-store.ts) - could never hit either: a
 * fresh driver every request is a fresh key every request, so the schema's
 * six `CREATE ... IF NOT EXISTS` statements and the `PRAGMA table_info` check
 * ran again on every single request, not once per isolate as that comment
 * already assumed. The same object is also what lets the console's portfolio
 * memo (`router.ts`) work at all on a Worker: it is keyed on
 * `runtime.services.stores`, which now has an isolate's worth of lifetime
 * instead of one request's.
 *
 * v0.12.1 (PR #83) keyed this on `env.DB` in a `WeakMap`, reasoning that if a
 * future host ever handed this Worker a fresh `env.DB` per call, that would
 * "degrade safely" to a fresh driver every time rather than serving one
 * request's database to a different one's. Measured on the deployed Worker,
 * that degradation is exactly what happens *today*: eight `/api/state` calls
 * seconds apart, well inside the portfolio memo's 30-second TTL, never once
 * came back faster than the first. The Workers runtime reuses an isolate
 * (and everything at module scope in it) across requests - that much is
 * documented behaviour - but nothing in Cloudflare's public documentation
 * states that a binding's own object identity is stable across those
 * requests, and the one thing it does say about caching a binding's value is
 * a warning that a *derived* client can go stale, not a promise that the
 * binding reference itself persists. A `WeakMap` keyed on that reference
 * cannot hit if the runtime hands back a structurally-new object standing in
 * for the same database on every call - and a fresh key every time is
 * indistinguishable, from inside a `WeakMap`, from a fresh database every
 * time. No rekeying fixes that; only not keying on the binding at all does.
 *
 * So this is a bare module variable instead: built once, kept for whatever
 * this variable's lifetime turns out to be, and never rebuilt because a later
 * call's `db` argument compares unequal to an earlier one. That is safe only
 * because of the single fact this file already leaned on above - one Worker,
 * one database, for as long as the isolate lives - and it stops being safe
 * the moment that fact stops being true (a second D1 binding added to the
 * same Worker to serve a second database from one isolate; multi-tenancy is
 * explicitly not this platform's shape, see adding-people.md §2). Tests are
 * the other place that fact is not true - one process runs every test in this
 * file, one after another, several of them opening their own throwaway D1
 * stand-in - so `forgetIsolateSqlCacheForTests` exists to draw the boundary a
 * real isolate draws for free.
 *
 * Deliberately not cached here: `state` (re-read from the database on every
 * request by `refresh()` regardless, so nothing is gained and the on/off
 * switches must never be trusted from an earlier request) and the `Runtime`
 * itself - only the D1 plumbing, which holds no per-request data of its own.
 */
let isolateSqlCache: { readonly driver: SqlDriver; readonly stores: StoreRegistry } | undefined;

function sqlPartsFor(db: D1Database, options: MigrateOptions): { readonly driver: SqlDriver; readonly stores: StoreRegistry } {
  if (isolateSqlCache) return isolateSqlCache;
  const driver = createD1Driver(db);
  const built = { driver, stores: createSqlRegistry(driver, options) };
  isolateSqlCache = built;
  return built;
}

/**
 * Test-only escape hatch: forgets whatever `sqlPartsFor` built so far.
 *
 * A real isolate never calls this - the cache is supposed to outlive every
 * request the isolate ever serves. `node --test` runs every test in one file
 * as one process, though, and several tests in `test/worker.test.ts` each
 * open their own in-memory D1 stand-in to prove something about a
 * *different* simulated isolate. Without a way to say "that was a different
 * isolate," the second test would silently inherit the first test's driver -
 * pointed at the first test's now-closed database - which is precisely the
 * cross-database leak the module-scope singleton must never cause for real.
 */
export function forgetIsolateSqlCacheForTests(): void {
  isolateSqlCache = undefined;
}

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

  // One account named means a database written before the split can be
  // upgraded; more than one and it refuses rather than guessing. See
  // docs/3-development/store-split.md.
  const only = loaded.config.ventures.length === 1 ? loaded.config.ventures[0]!.id : undefined;
  const { driver, stores } = sqlPartsFor(env.DB, only ? { assignExistingTo: only } : {});
  // Before the state store reads anything: the registry applies the schema
  // lazily, when an account is first opened, and the stop must never be read
  // from a database whose `state` table does not exist yet - an unreadable
  // stop means stopped. A WeakMap lookup rather than six statements after the
  // first call in this isolate: see `sqlPartsFor` above.
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
    ...(parts.release ? { release: parts.release } : {}),
    dryRun: false,
  });
}
