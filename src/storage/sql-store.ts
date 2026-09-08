/**
 * A `Store` on top of SQL - three tables, and one JSON document per row.
 *
 * The shape is chosen to change as little as possible, not to be idiomatic:
 *
 * - **`find` takes a JavaScript predicate.** There is no translating that into
 *   SQL, and the shipped JSON store already reads a collection and filters it
 *   in memory. Doing the same here means a licensee who moves from files to a
 *   database sees identical results, which is the only promise worth making.
 * - **One column of JSON rather than a column per field.** A column per field
 *   means a migration every time a type gains one (requirements, open item 14).
 *   A document per row inherits the JSON store's property that new fields cost
 *   nothing and old rows still parse.
 * - **`seq` exists only for ordering.** `all()` returns items in the order they
 *   were first stored, which the store contract requires and a bare
 *   `SELECT ... WHERE collection = ?` does not guarantee. An upsert keeps the
 *   original `seq`, so replacing an item does not move it to the end.
 *
 * Sizing: one account posting three times a day for a year is tens of thousands
 * of rows, and a cycle reads a few thousand. That is inside D1's free daily
 * allowance, let alone the paid one. When it stops being, the fix is indexes
 * and narrower queries here - not a different `Store`.
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
  ScheduledPost,
  SwipeItem,
  TrackedLink,
  VentureProposal,
} from "../core/types.ts";
import type { AuditLog, Collection, Identified, InspectionStore, Store, StoredMetric } from "./store.ts";
import type { SqlDriver, SqlStatement } from "./sql-driver.ts";

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS records (
     collection TEXT NOT NULL,
     id         TEXT NOT NULL,
     seq        INTEGER NOT NULL,
     json       TEXT NOT NULL,
     PRIMARY KEY (collection, id)
   )`,
  `CREATE INDEX IF NOT EXISTS records_order ON records (collection, seq)`,
  `CREATE TABLE IF NOT EXISTS audit (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     at         TEXT NOT NULL,
     venture_id TEXT,
     cycle_id   TEXT,
     json       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS audit_venture ON audit (venture_id, seq DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_cycle ON audit (cycle_id, seq DESC)`,
  `CREATE TABLE IF NOT EXISTS state (
     key  TEXT PRIMARY KEY,
     json TEXT NOT NULL
   )`,
];

/** Applies the schema. Safe to call on every start; every statement is `IF NOT EXISTS`. */
export async function migrate(driver: SqlDriver): Promise<void> {
  for (const statement of SCHEMA) await driver.run(statement);
}

/**
 * Which drivers have had the schema applied.
 *
 * `IF NOT EXISTS` makes re-running harmless but not free: it is six round
 * trips to the database, and on a host that builds a store per request that
 * lands on the redirect - the one path a reader waits on. A `WeakMap` keyed on
 * the driver means "once per driver for as long as it lives", which on a
 * Worker is once per isolate.
 */
const migrated = new WeakMap<SqlDriver, Promise<void>>();

export async function createSqlStore(driver: SqlDriver): Promise<Store> {
  let applied = migrated.get(driver);
  if (!applied) {
    applied = migrate(driver);
    migrated.set(driver, applied);
    // A failed migration must not be remembered as done.
    applied.catch(() => migrated.delete(driver));
  }
  await applied;

  const collection = <T extends Identified>(name: string): Collection<T> => new SqlCollection<T>(driver, name);
  const inspectionRows = new SqlCollection<InspectionReport & Identified>(driver, "inspections");

  const inspections: InspectionStore = {
    async get(draftId) {
      return inspectionRows.get(draftId);
    },
    async put(report) {
      await inspectionRows.put({ ...report, id: report.draftId });
    },
    async forCycle(draftIds) {
      const found: InspectionReport[] = [];
      for (const id of draftIds) {
        const report = await inspectionRows.get(id);
        if (report) found.push(report);
      }
      return found;
    },
  };

  const audit: AuditLog = {
    async append(event) {
      await driver.run(`INSERT INTO audit (at, venture_id, cycle_id, json) VALUES (?, ?, ?, ?)`, [
        event.at,
        event.ventureId ?? null,
        event.cycleId ?? null,
        JSON.stringify(event),
      ]);
    },
    async recent(limit, filter) {
      // The contract: a limit of none means none, and the limit counts events
      // that match the filter rather than events looked at.
      if (limit <= 0) return [];
      const ventureId = filter?.ventureId ?? null;
      const cycleId = filter?.cycleId ?? null;
      const rows = await driver.all<{ json: string }>(
        `SELECT json FROM audit
          WHERE (? IS NULL OR venture_id = ?)
            AND (? IS NULL OR cycle_id = ?)
          ORDER BY seq DESC
          LIMIT ?`,
        [ventureId, ventureId, cycleId, cycleId, limit],
      );
      return rows.map((row) => JSON.parse(row.json) as AuditEvent);
    },
  };

  return {
    cycles: collection<Cycle>("cycles"),
    patterns: collection<Pattern>("patterns"),
    swipe: collection<SwipeItem>("swipe"),
    ideas: collection<Idea>("ideas"),
    drafts: collection<Draft>("drafts"),
    inspections,
    posts: collection<ScheduledPost>("posts"),
    metrics: collection<StoredMetric>("metrics"),
    decisions: collection<Decision>("decisions"),
    links: collection<TrackedLink>("links"),
    clicks: collection<ClickEvent>("clicks"),
    conversions: collection<ConversionEvent>("conversions"),
    proposals: collection<VentureProposal>("proposals"),
    audit,

    // Every write has already reached the database by the time it returns;
    // there is nothing buffered to push and no handle of ours to release.
    async flush() {},
    async close() {
      await driver.close?.();
    },
  };
}

/** Keeps an item's original position when it is replaced. */
const UPSERT = `INSERT INTO records (collection, id, seq, json)
   VALUES (?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM records), ?)
   ON CONFLICT (collection, id) DO UPDATE SET json = excluded.json`;

class SqlCollection<T extends Identified> implements Collection<T> {
  readonly #driver: SqlDriver;
  readonly #name: string;

  constructor(driver: SqlDriver, name: string) {
    this.#driver = driver;
    this.#name = name;
  }

  async get(id: string): Promise<T | undefined> {
    const rows = await this.#driver.all<{ json: string }>(
      `SELECT json FROM records WHERE collection = ? AND id = ?`,
      [this.#name, id],
    );
    const row = rows[0];
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  async put(item: T): Promise<void> {
    await this.#driver.run(UPSERT, [this.#name, item.id, JSON.stringify(item)]);
  }

  async putMany(items: readonly T[]): Promise<void> {
    if (items.length === 0) return;
    const statements: SqlStatement[] = items.map((item) => ({
      sql: UPSERT,
      params: [this.#name, item.id, JSON.stringify(item)],
    }));
    await this.#driver.batch(statements);
  }

  async all(): Promise<T[]> {
    const rows = await this.#driver.all<{ json: string }>(
      `SELECT json FROM records WHERE collection = ? ORDER BY seq`,
      [this.#name],
    );
    return rows.map((row) => JSON.parse(row.json) as T);
  }

  async find(predicate: (item: T) => boolean): Promise<T[]> {
    return (await this.all()).filter(predicate);
  }

  async remove(id: string): Promise<void> {
    await this.#driver.run(`DELETE FROM records WHERE collection = ? AND id = ?`, [this.#name, id]);
  }
}
