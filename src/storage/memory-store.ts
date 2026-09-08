/**
 * An in-memory Store. Used by tests, and by `amp cycle run --dry-run` where
 * the point is to see what the company would produce without keeping it.
 */

import type { AuditEvent, InspectionReport } from "../core/types.ts";
import type { AuditLog, Collection, Identified, InspectionStore, Store } from "./store.ts";

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

export function createMemoryStore(): Store & { events: AuditEvent[] } {
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
      events.push(event);
    },
    async recent(limit, filter) {
      // `slice(-0)` is `slice(0)`, which is the whole log. A limit of none has
      // to mean none, the way it does for the file-backed log.
      if (limit <= 0) return [];
      return events
        .filter((event) => !filter?.ventureId || event.ventureId === filter.ventureId)
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
