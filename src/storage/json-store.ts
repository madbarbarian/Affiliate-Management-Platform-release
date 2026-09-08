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
import type { AuditLog, Collection, Identified, InspectionStore, Store, StoredMetric } from "./store.ts";

const AUDIT_FILE = "audit.jsonl";
const LOCK_DIR = ".lock";
/** A lock older than this is assumed to belong to a crashed process. */
const LOCK_STALE_MS = 15 * 60_000;

export type JsonStoreOptions = {
  readonly dataDir: string;
  /** Acquire the cross-process lock. Off for read-only commands and tests. */
  readonly lock?: boolean;
  /** Identifies the lock holder in error messages. */
  readonly owner?: string;
};

export async function createJsonStore(options: JsonStoreOptions): Promise<Store> {
  const { dataDir } = options;
  await mkdir(dataDir, { recursive: true });
  const release = options.lock ? await acquireLock(dataDir, options.owner ?? "amp") : undefined;

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

  const audit = createAuditLog(join(dataDir, AUDIT_FILE));

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

function createAuditLog(path: string): AuditLog {
  let chain: Promise<void> = Promise.resolve();
  return {
    async append(event: AuditEvent) {
      chain = chain.then(() => appendFile(path, `${JSON.stringify(event)}\n`, "utf8"));
      await chain;
    },
    async recent(limit, filter) {
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
        if (filter?.ventureId && event.ventureId !== filter.ventureId) continue;
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
