/**
 * The storage port.
 *
 * Deliberately narrow: a keyed collection with predicate search, plus an
 * append-only audit log. Everything the platform needs fits in that, which
 * means swapping the shipped JSON store for Postgres, D1 or Supabase is one
 * file rather than a migration of the whole codebase.
 */

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
  PostMetric,
  ScheduledPost,
  SwipeItem,
  TrackedLink,
  VentureProposal,
} from "../core/types.ts";

export type Identified = { readonly id: string };

export type Collection<T extends Identified> = {
  get(id: string): Promise<T | undefined>;
  put(item: T): Promise<void>;
  putMany(items: readonly T[]): Promise<void>;
  all(): Promise<T[]>;
  find(predicate: (item: T) => boolean): Promise<T[]>;
  remove(id: string): Promise<void>;
};

/**
 * Inspection reports key on the draft they inspected rather than an id of
 * their own, so they get a thin wrapper instead of a Collection.
 */
export type InspectionStore = {
  get(draftId: string): Promise<InspectionReport | undefined>;
  put(report: InspectionReport): Promise<void>;
  forCycle(draftIds: readonly string[]): Promise<InspectionReport[]>;
};

export type AuditLog = {
  append(event: AuditEvent): Promise<void>;
  /**
   * Most recent first, and only this account's.
   *
   * `ventureId` narrows; it cannot widen. A log belongs to one account, so
   * asking it for another account's events is answered with none rather than
   * quietly ignored - the way to read across accounts is `StoreRegistry.each`.
   */
  recent(limit: number, filter?: { ventureId?: string; cycleId?: string }): Promise<AuditEvent[]>;
};

export type Store = {
  readonly cycles: Collection<Cycle>;
  readonly patterns: Collection<Pattern>;
  readonly swipe: Collection<SwipeItem>;
  readonly ideas: Collection<Idea>;
  readonly drafts: Collection<Draft>;
  readonly inspections: InspectionStore;
  readonly posts: Collection<ScheduledPost>;
  readonly metrics: Collection<PostMetric & Identified>;
  readonly decisions: Collection<Decision>;
  readonly links: Collection<TrackedLink>;
  readonly clicks: Collection<ClickEvent>;
  readonly conversions: Collection<ConversionEvent>;
  /** The scout's venture proposals and what the human decided about them. */
  readonly proposals: Collection<VentureProposal>;
  readonly audit: AuditLog;
  /** Persists anything buffered. Safe to call repeatedly. */
  flush(): Promise<void>;
  /** Releases any lock or handle. The process should not use the store after. */
  close(): Promise<void>;
};

/**
 * Every account's store, and the only way to get one.
 *
 * A `Store` is one account's world: what a role or the orchestrator is handed
 * holds that account's cycles and nothing else, so no caller has to remember a
 * `ventureId` filter and no caller can forget one. Accounts do not share a
 * store, which is what makes "this account learned this by itself" a fact
 * about where the data is rather than a claim about the code that reads it.
 *
 * **Crossing accounts is legitimate, and rare.** Five readers do it - the
 * accounts list, the scout, the dispatcher, the console's activity feed, and
 * the tracking redirect - and every one of them says so by calling `each` or
 * `findLinkByCode`. Anything that does not call these cannot cross.
 *
 * See `docs/3-development/store-split.md`.
 */
export type StoreRegistry = {
  /** One account's store. Repeated calls for the same account return the same one. */
  for(ventureId: string): Promise<Store>;
  /**
   * Every account that has data, whether or not the config still names it -
   * an account removed from the config still has a history to export.
   */
  each(): Promise<readonly { readonly ventureId: string; readonly store: Store }[]>;
  /**
   * The one lookup that has no account to start from: a reader arrives with a
   * code and nothing else. The link it finds names its account, so the click
   * it produces still lands in exactly one.
   */
  findLinkByCode(code: string): Promise<TrackedLink | undefined>;
  close(): Promise<void>;
};

/** Metrics carry a synthetic id so they fit the Collection shape. */
export type StoredMetric = PostMetric & Identified;

export function metricId(postId: string, capturedAt: string): string {
  return `${postId}@${capturedAt}`;
}
