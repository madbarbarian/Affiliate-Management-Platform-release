/**
 * The shipped storage adapter: one JSON file per collection under the data
 * directory, plus a JSONL audit log.
 *
 * Sized for what it actually is - a single operator running a handful of
 * accounts. Collections are read once and cached in memory; writes are atomic
 * (temp file + rename) so a crash mid-write cannot leave a half-parsed cycle
 * behind. A process-level lock stops a `amp cycle run` from racing the daemon.
 *
 * When a licensee outgrows this (tens of thousands of posts, or more than one
 * machine), the fix is a new adapter behind `Store`, not changes here.
 */

import { mkdir, readFile, rename, rm, stat, writeFile, appendFile, readdir } from "node:fs/promises";
import { writeFileAtomic } from "./atomic.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  AuditEvent,
  ClickEvent,
  ConversionEvent,
  Cycle,
  Decision,
  Draft,
  Idea,
  InspectionReport,
  Pattern,
  ScheduledPost,
  SwipeItem,
  TrackedLink,
  VentureProposal,
} from "../core/types.ts";
import type {
  AuditLog,
  Collection,
  Identified,
  InspectionStore,
  Store,
  StoredMetric,
  StoreRegistry,
} from "./store.ts";

const AUDIT_FILE = "audit.jsonl";
const LOCK_DIR = ".lock";
/** A lock older than this is assumed to belong to a crashed process. */
const LOCK_STALE_MS = 15 * 60_000;

export type JsonStoreOptions = {
  readonly dataDir: string;
  /**
   * Whose store this is. Its files live in `<dataDir>/ventures/<venture>/`,
   * so an account is a directory: what is not open cannot be read, and handing
   * one over is handing over a folder.
   */
  readonly venture: string;
  /** Acquire the cross-process lock. Off for read-only commands and tests. */
  readonly lock?: boolean;
  /** Identifies the lock holder in error messages. */
  readonly owner?: string;
};

/** Where one account's files live. Exported because the registry lists them. */
export function ventureDir(dataDir: string, venture: string): string {
  return join(dataDir, "ventures", venture);
}

/** The files a pre-split data directory keeps at its top level. */
const COLLECTION_FILES: readonly string[] = [
  "cycles.json",
  "patterns.json",
  "swipe.json",
  "ideas.json",
  "drafts.json",
  "inspections.json",
  "posts.json",
  "metrics.json",
  "decisions.json",
  "links.json",
  "clicks.json",
  "conversions.json",
  "proposals.json",
  AUDIT_FILE,
];

/**
 * Moves a pre-split data directory into its account's folder.
 *
 * Before accounts had their own space these files sat at the top level, and
 * nothing in them says which account they are. Left alone, the new layout
 * simply would not find them: **the operator's history would appear to be
 * gone**, with no error, which is the worst way for a migration to fail.
 *
 * The same rule as the SQL one, for the same reason: one account named means
 * every file is that account's, and more than one must not be guessed at.
 * Returns what it moved, so a caller can say so.
 */
export async function migrateDataDir(
  dataDir: string,
  options: { readonly assignExistingTo?: string } = {},
): Promise<readonly string[]> {
  if (!existsSync(dataDir)) return [];
  const present = COLLECTION_FILES.filter((file) => existsSync(join(dataDir, file)));
  if (present.length === 0) return [];

  const venture = options.assignExistingTo;
  if (venture === undefined) {
    throw new Error(
      `${dataDir} holds ${present.length} file(s) written before accounts had their own space, ` +
        `and nothing in them says which account they belong to. Guessing would mix two histories ` +
        `permanently. Start once with exactly one account in ventures:, so every file can be ` +
        `assigned to it, then add the others back.`,
    );
  }

  const target = ventureDir(dataDir, venture);
  await mkdir(target, { recursive: true });
  for (const file of present) {
    // Never over an account's existing file: a half-done move re-run must not
    // replace what the new layout has already written.
    if (existsSync(join(target, file))) continue;
    await rename(join(dataDir, file), join(target, file));
  }
  return present;
}

export async function createJsonStore(options: JsonStoreOptions): Promise<Store> {
  // The lock is on the whole data directory, not on one account: it exists to
  // stop two *processes* sharing it, and a second process would collide over
  // any account.
  await mkdir(options.dataDir, { recursive: true });
  const release = options.lock ? await acquireLock(options.dataDir, options.owner ?? "amp") : undefined;
  const dataDir = ventureDir(options.dataDir, options.venture);
  await mkdir(dataDir, { recursive: true });

  const collections: JsonCollection<Identified>[] = [];
  const make = <T extends Identified>(name: string): Collection<T> => {
    const collection = new JsonCollection<T>(join(dataDir, `${name}.json`));
    collections.push(collection as unknown as JsonCollection<Identified>);
    return collection;
  };

  const drafts = make<Draft>("drafts");
  const inspectionFile = new JsonCollection<InspectionReport & Identified>(join(dataDir, "inspections.json"));
  collections.push(inspectionFile as unknown as JsonCollection<Identified>);

  const inspections: InspectionStore = {
    async get(draftId) {
      return inspectionFile.get(draftId);
    },
    async put(report) {
      await inspectionFile.put({ ...report, id: report.draftId });
    },
    async forCycle(draftIds) {
      // In the order asked for, not the order they happen to sit in the file.
      // The memory store already worked this way, and a caller lining reports
      // up against its own list of drafts needs them to agree.
      const found: InspectionReport[] = [];
      for (const id of draftIds) {
        const report = await inspectionFile.get(id);
        if (report) found.push(report);
      }
      return found;
    },
  };

  const audit = createAuditLog(join(dataDir, AUDIT_FILE), options.venture);

  return {
    cycles: make<Cycle>("cycles"),
    patterns: make<Pattern>("patterns"),
    swipe: make<SwipeItem>("swipe"),
    ideas: make<Idea>("ideas"),
    drafts,
    inspections,
    posts: make<ScheduledPost>("posts"),
    metrics: make<StoredMetric>("metrics"),
    decisions: make<Decision>("decisions"),
    links: make<TrackedLink>("links"),
    clicks: make<ClickEvent>("clicks"),
    conversions: make<ConversionEvent>("conversions"),
    proposals: make<VentureProposal>("proposals"),
    audit,

    async flush() {
      for (const collection of collections) await collection.flush();
    },

    async close() {
      for (const collection of collections) await collection.flush();
      await release?.();
    },
  };
}

export type JsonRegistryOptions = Omit<JsonStoreOptions, "venture"> & {
  /** Which account a pre-split data directory belongs to. See `migrateDataDir`. */
  readonly assignExistingTo?: string;
};

/**
 * Every account under one data directory, one folder each.
 *
 * The lock is taken once, by the first store opened, and released when that
 * store closes - it guards the directory against a second *process*, which is
 * not a per-account question.
 */
export function createJsonRegistry(options: JsonRegistryOptions): StoreRegistry {
  const open = new Map<string, Promise<Store>>();
  let locker: string | undefined;

  // Once per registry, before any account is opened. A store opened over a
  // directory whose files have not been moved yet would create empty ones
  // beside them and report an operation with no history.
  let moved: Promise<unknown> | undefined;
  const migrated = (): Promise<unknown> => {
    moved ??= migrateDataDir(options.dataDir, options.assignExistingTo ? { assignExistingTo: options.assignExistingTo } : {});
    return moved;
  };

  const forVenture = async (ventureId: string): Promise<Store> => {
    await migrated();
    let store = open.get(ventureId);
    if (!store) {
      const takesLock = options.lock === true && locker === undefined;
      if (takesLock) locker = ventureId;
      store = createJsonStore({ ...options, venture: ventureId, lock: takesLock });
      open.set(ventureId, store);
    }
    return store;
  };

  const known = async (): Promise<string[]> => {
    await migrated();
    // From the directories, not the config: an account dropped from
    // `ventures:` still has a history, and export is why it must stay
    // reachable.
    const root = join(options.dataDir, "ventures");
    if (!existsSync(root)) return [...open.keys()].sort();
    const entries = await readdir(root, { withFileTypes: true });
    const found = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    for (const id of open.keys()) found.add(id);
    return [...found].sort();
  };

  return {
    for: forVenture,

    async each() {
      const ids = await known();
      return Promise.all(ids.map(async (ventureId) => ({ ventureId, store: await forVenture(ventureId) })));
    },

    async findLinkByCode(code) {
      for (const ventureId of await known()) {
        const store = await forVenture(ventureId);
        const found = (await store.links.find((link) => link.code === code))[0];
        // Where it lives decides whose it is. See the SQL registry.
        if (found) return { ...found, ventureId };
      }
      return undefined;
    },

    async close() {
      for (const store of open.values()) await (await store).close();
      open.clear();
      locker = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

class JsonCollection<T extends Identified> implements Collection<T> {
  readonly #path: string;
  #items: Map<string, T> | undefined;
  /** Serialises writes so two awaits cannot interleave rename calls. */
  #writeChain: Promise<void> = Promise.resolve();
  #dirty = false;

  constructor(path: string) {
    this.#path = path;
  }

  async #load(): Promise<Map<string, T>> {
    if (this.#items) return this.#items;
    const map = new Map<string, T>();
    if (existsSync(this.#path)) {
      const text = await readFile(this.#path, "utf8");
      if (text.trim() !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (cause) {
          throw new Error(`Corrupt store file ${this.#path}. Move it aside to continue.`, { cause });
        }
        if (!Array.isArray(parsed)) {
          throw new Error(`Store file ${this.#path} should contain a JSON array.`);
        }
        for (const item of parsed as T[]) map.set(item.id, item);
      }
    }
    this.#items = map;
    return map;
  }

  async get(id: string): Promise<T | undefined> {
    return (await this.#load()).get(id);
  }

  async put(item: T): Promise<void> {
    (await this.#load()).set(item.id, item);
    this.#dirty = true;
    await this.flush();
  }

  async putMany(items: readonly T[]): Promise<void> {
    const map = await this.#load();
    for (const item of items) map.set(item.id, item);
    this.#dirty = true;
    await this.flush();
  }

  async all(): Promise<T[]> {
    return [...(await this.#load()).values()];
  }

  async find(predicate: (item: T) => boolean): Promise<T[]> {
    return (await this.all()).filter(predicate);
  }

  async remove(id: string): Promise<void> {
    if ((await this.#load()).delete(id)) {
      this.#dirty = true;
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.#dirty || !this.#items) return;
    this.#dirty = false;
    const snapshot = [...this.#items.values()];
    // The chain is reset on failure and the collection marked dirty again.
    // Previously a single failed write left `#writeChain` permanently rejected
    // while `#dirty` was already false, so every later write on that collection
    // rethrew the original error and nothing reached disk again - a full day of
    // cycle state lost to one transient ENOSPC.
    this.#writeChain = this.#writeChain
      .catch(() => undefined)
      .then(() => writeAtomic(this.#path, `${JSON.stringify(snapshot, null, 2)}\n`));
    try {
      await this.#writeChain;
    } catch (cause) {
      this.#dirty = true;
      this.#writeChain = Promise.resolve();
      throw cause;
    }
  }
}

/** Creation time of the lock directory, for a holder we cannot read. */
async function lockCreatedAt(lockPath: string): Promise<number> {
  try {
    return (await stat(lockPath)).birthtimeMs || (await stat(lockPath)).mtimeMs;
  } catch {
    return Number.NaN;
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await writeFileAtomic(path, contents);
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

function createAuditLog(path: string, venture: string): AuditLog {
  let chain: Promise<void> = Promise.resolve();
  return {
    async append(event: AuditEvent) {
      // Stamped with the scope. This file is one account's history.
      const scoped: AuditEvent = { ...event, ventureId: venture };
      chain = chain.then(() => appendFile(path, `${JSON.stringify(scoped)}\n`, "utf8"));
      await chain;
    },
    async recent(limit, filter) {
      // Narrowing only. See the port.
      if (filter?.ventureId !== undefined && filter.ventureId !== venture) return [];
      if (!existsSync(path)) return [];
      const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "");
      const out: AuditEvent[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
        let event: AuditEvent;
        try {
          event = JSON.parse(lines[i] as string) as AuditEvent;
        } catch {
          continue; // A torn final line is not worth failing a status command over.
        }
        if (filter?.cycleId && event.cycleId !== filter.cycleId) continue;
        out.push(event);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

/**
 * `mkdir` is atomic on every platform we target, which makes it a usable lock
 * primitive without a dependency. The lock records who holds it so the error
 * message can say "the daemon has it" instead of "resource busy".
 */
async function acquireLock(dataDir: string, owner: string): Promise<() => Promise<void>> {
  const lockPath = join(dataDir, LOCK_DIR);
  const infoPath = join(lockPath, "owner.json");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath);
      await writeFile(infoPath, JSON.stringify({ owner, pid: process.pid, at: new Date().toISOString() }), "utf8");
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const holder = await readLockOwner(infoPath);
      // A lock directory whose owner.json has not landed yet is a process
      // mid-acquire, not an orphan. Treating it as orphaned deleted a live
      // lock and let two processes write the same data directory at once, so
      // an unreadable holder is judged by the directory's own age instead.
      const stampMs = holder ? Date.parse(holder.at) : await lockCreatedAt(lockPath);
      const ageMs = Number.isFinite(stampMs) ? Date.now() - stampMs : Number.POSITIVE_INFINITY;
      if (Number.isFinite(ageMs) && ageMs < LOCK_STALE_MS && (!holder || isAlive(holder.pid))) {
        throw new Error(
          holder
            ? `Another process is using ${dataDir} (${holder.owner}, pid ${holder.pid}, since ${holder.at}). ` +
                `Stop it first, or run read-only commands like \`amp cycle status\`.`
            : `Another process is acquiring the lock on ${dataDir}. Try again in a moment.`,
        );
      }
      // Stale or orphaned: clear it and try once more.
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  throw new Error(`Could not acquire the lock on ${dataDir}.`);
}

async function readLockOwner(path: string): Promise<{ owner: string; pid: number; at: string } | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as { owner: string; pid: number; at: string };
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to another user.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Lists the collection files present, for `amp doctor`. */
export async function describeDataDir(dataDir: string): Promise<{ file: string; bytes: number }[]> {
  if (!existsSync(dataDir)) return [];
  const entries = await readdir(dataDir, { withFileTypes: true });
  const out: { file: string; bytes: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stat = await import("node:fs/promises").then((fs) => fs.stat(join(dataDir, entry.name)));
    out.push({ file: entry.name, bytes: stat.size });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
