/**
 * An in-memory Store. Used by tests, and by `amp cycle run --dry-run` where
 * the point is to see what the company would produce without keeping it.
 */

import type { AuditEvent, InspectionReport, TrackedLink } from "../core/types.ts";
import type { AuditLog, Collection, Identified, InspectionStore, Store, StoreRegistry } from "./store.ts";

function memoryCollection<T extends Identified>(): Collection<T> {
  const items = new Map<string, T>();
  return {
    async get(id) {
      return items.get(id);
    },
    async put(item) {
      items.set(item.id, item);
    },
    async putMany(batch) {
      for (const item of batch) items.set(item.id, item);
    },
    async all() {
      return [...items.values()];
    },
    async find(predicate) {
      return [...items.values()].filter(predicate);
    },
    async remove(id) {
      items.delete(id);
    },
  };
}

export function createMemoryStore(venture = "main"): Store & { events: AuditEvent[] } {
  const reports = new Map<string, InspectionReport>();
  const inspections: InspectionStore = {
    async get(draftId) {
      return reports.get(draftId);
    },
    async put(report) {
      reports.set(report.draftId, report);
    },
    async forCycle(draftIds) {
      return draftIds.map((id) => reports.get(id)).filter((report): report is InspectionReport => report !== undefined);
    },
  };

  const events: AuditEvent[] = [];
  const audit: AuditLog = {
    async append(event) {
      // Stamped with the scope, like the SQL log: this store is one account's,
      // so an event claiming another account's id is a crossing with no name.
      events.push({ ...event, ventureId: venture });
    },
    async recent(limit, filter) {
      // `slice(-0)` is `slice(0)`, which is the whole log. A limit of none has
      // to mean none, the way it does for the file-backed log.
      if (limit <= 0) return [];
      // Narrowing only. See the port.
      if (filter?.ventureId !== undefined && filter.ventureId !== venture) return [];
      return events
        .filter((event) => !filter?.cycleId || event.cycleId === filter.cycleId)
        .slice(-limit)
        .reverse();
    },
  };

  return {
    cycles: memoryCollection(),
    patterns: memoryCollection(),
    swipe: memoryCollection(),
    ideas: memoryCollection(),
    drafts: memoryCollection(),
    inspections,
    posts: memoryCollection(),
    metrics: memoryCollection(),
    decisions: memoryCollection(),
    links: memoryCollection(),
    clicks: memoryCollection(),
    conversions: memoryCollection(),
    proposals: memoryCollection(),
    audit,
    events,
    async flush() {},
    async close() {},
  };
}

/**
 * Every account in memory. Used by the tests, and by `--dry-run`, where the
 * whole point is that nothing survives the process.
 */
export type MemoryRegistry = StoreRegistry & {
  /**
   * The same store `for()` returns, without waiting.
   *
   * Only the in-memory implementation can offer this, and only the tests and
   * the dry run want it: everything else goes through the port so it works
   * over files and SQL too.
   */
  open(ventureId: string): Store & { events: AuditEvent[] };
};

export function createMemoryRegistry(): MemoryRegistry {
  const open = new Map<string, Store & { events: AuditEvent[] }>();
  const forVenture = (ventureId: string): Store & { events: AuditEvent[] } => {
    let store = open.get(ventureId);
    if (!store) {
      store = createMemoryStore(ventureId);
      open.set(ventureId, store);
    }
    return store;
  };

  return {
    open: forVenture,
    async for(ventureId) {
      return forVenture(ventureId);
    },
    async each() {
      return [...open.keys()].sort().map((ventureId) => ({ ventureId, store: forVenture(ventureId) }));
    },
    async findLinkByCode(code) {
      for (const [ventureId, store] of open) {
        const found = (await store.links.find((link: TrackedLink) => link.code === code))[0];
        // Where it lives decides whose it is. See the SQL registry.
        if (found) return { ...found, ventureId };
      }
      return undefined;
    },
    async close() {},
  };
}
