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
import type {
  AuditLog,
  Collection,
  Identified,
  InspectionStore,
  Store,
  StoredMetric,
  StoreRegistry,
} from "./store.ts";
import type { SqlDriver, SqlStatement } from "./sql-driver.ts";

const SCHEMA: readonly string[] = [
  // `venture` is part of the key, not a filter bolted on: two accounts may hold
  // a record with the same id, and without it in the key the second write
  // would silently replace the first account's row.
  `CREATE TABLE IF NOT EXISTS records (
     venture    TEXT NOT NULL,
     collection TEXT NOT NULL,
     id         TEXT NOT NULL,
     seq        INTEGER NOT NULL,
     json       TEXT NOT NULL,
     PRIMARY KEY (venture, collection, id)
   )`,
  `CREATE INDEX IF NOT EXISTS records_order ON records (venture, collection, seq)`,
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

export type MigrateOptions = {
  /**
   * Which account the rows of a pre-split database belong to.
   *
   * A database written before accounts had their own space has no `venture`
   * column, and nothing in it says which account its rows are. The caller
   * knows: it holds the config. **One account named means every row is that
   * account's; anything else must not be guessed** - a wrong answer here mixes
   * two accounts' histories permanently, which is the exact thing this split
   * exists to make impossible.
   */
  readonly assignExistingTo?: string;
};

/**
 * Applies the schema, and upgrades a database written before the split.
 *
 * Safe to call on every start. The schema statements are all `IF NOT EXISTS`;
 * the upgrade runs only when `records` exists without a `venture` column, and
 * SQLite cannot add one to a primary key, so it is a rebuild.
 */
export async function migrate(driver: SqlDriver, options: MigrateOptions = {}): Promise<void> {
  const existing = await driver.all<{ name: string }>(`PRAGMA table_info(records)`);
  const preSplit = existing.length > 0 && !existing.some((column) => column.name === "venture");

  if (preSplit) {
    const rows = await driver.all<{ n: number }>(`SELECT COUNT(*) AS n FROM records`);
    const count = rows[0]?.n ?? 0;
    const venture = options.assignExistingTo;
    if (count > 0 && venture === undefined) {
      throw new Error(
        `This database was written before accounts had their own space, and holds ${count} rows ` +
          `that do not say which account they belong to. Nothing here can tell them apart, and ` +
          `guessing would mix two histories permanently. Run this with exactly one account in ` +
          `ventures:, so every row can be assigned to it, then add the others back.`,
      );
    }
    // One batch, not four statements. On Cloudflare the first request and the
    // minute cron can reach this in different isolates at the same moment, and
    // a rebuild half-applied - renamed but not copied - is the operator's
    // history gone. A D1 batch is atomic; where a driver has no batch it runs
    // them in order, which is what a single-process host has anyway.
    await driver.batch([
      { sql: `ALTER TABLE records RENAME TO records_pre_split` },
      ...SCHEMA.map((sql) => ({ sql })),
      ...(count > 0
        ? [
            {
              sql: `INSERT INTO records (venture, collection, id, seq, json)
                      SELECT ?, collection, id, seq, json FROM records_pre_split`,
              params: [venture as string],
            },
          ]
        : []),
      { sql: `DROP TABLE records_pre_split` },
    ]);
    return;
  }

  // One batch, not six statements - the same reason as the pre-split branch
  // above: a request and the minute cron can both reach an empty database's
  // first-ever schema check in different isolates at nearly the same moment,
  // and it is one round trip instead of six either way. `ensureSchema`'s own
  // memo (below) means a warm isolate never pays this again, but the very
  // first request into a brand new isolate still does, and six sequential
  // round trips was six times the network latency this needed to cost.
  await driver.batch(SCHEMA.map((sql) => ({ sql })));
}

/**
 * Which drivers have had the schema applied.
 *
 * `IF NOT EXISTS` makes re-running harmless but not free: it is a `PRAGMA
 * table_info` plus a batch of the schema statements, and on a host that
 * builds a store per request that lands on the redirect - the one path a
 * reader waits on. A `WeakMap` keyed on the driver means "once per driver for
 * as long as it lives", which on a Worker is once per isolate - as long as
 * something upstream actually keeps the driver for the isolate's life rather
 * than rebuilding it per request (`worker/runtime.ts`'s `sqlPartsFor`), since
 * a fresh driver is a fresh key here too.
 */
const migrated = new WeakMap<SqlDriver, Promise<void>>();

async function ensureSchema(driver: SqlDriver, options: MigrateOptions): Promise<void> {
  let applied = migrated.get(driver);
  if (!applied) {
    applied = migrate(driver, options);
    migrated.set(driver, applied);
    // A failed migration must not be remembered as done.
    applied.catch(() => migrated.delete(driver));
  }
  await applied;
}

export type SqlStoreOptions = MigrateOptions & {
  /** Whose store this is. Nothing outside this account is reachable through it. */
  readonly venture: string;
};

export { ensureSchema as ensureSqlSchema };

export async function createSqlStore(driver: SqlDriver, options: SqlStoreOptions): Promise<Store> {
  await ensureSchema(driver, options);
  const venture = options.venture;

  const collection = <T extends Identified>(name: string): Collection<T> =>
    new SqlCollection<T>(driver, venture, name);
  const inspectionRows = new SqlCollection<InspectionReport & Identified>(driver, venture, "inspections");

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
      // The scope wins over the event. An event carrying someone else's
      // ventureId written into this account's log would be a crossing with no
      // name, which is the thing the split is for.
      // The document is stamped too, not just the column: the column is how
      // the row is found, and the document is what a reader gets back. Two
      // answers to "whose event is this" is the bug, not a detail.
      const scoped: AuditEvent = { ...event, ventureId: venture };
      await driver.run(`INSERT INTO audit (at, venture_id, cycle_id, json) VALUES (?, ?, ?, ?)`, [
        scoped.at,
        venture,
        scoped.cycleId ?? null,
        JSON.stringify(scoped),
      ]);
    },
    async recent(limit, filter) {
      // The contract: a limit of none means none, and the limit counts events
      // that match the filter rather than events looked at.
      if (limit <= 0) return [];
      // Narrowing only: this log holds one account's events, so asking for
      // another account's is answered with none.
      if (filter?.ventureId !== undefined && filter.ventureId !== venture) return [];
      const cycleId = filter?.cycleId ?? null;
      const rows = await driver.all<{ json: string }>(
        `SELECT json FROM audit
          WHERE venture_id = ?
            AND (? IS NULL OR cycle_id = ?)
          ORDER BY seq DESC
          LIMIT ?`,
        [venture, cycleId, cycleId, limit],
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

/**
 * Keeps an item's original position when it is replaced.
 *
 * `seq` counts within the account, not the table: two accounts stored side by
 * side must each read back in the order they were written, and a counter over
 * the whole table interleaves them.
 */
const UPSERT = `INSERT INTO records (venture, collection, id, seq, json)
   VALUES (?, ?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM records WHERE venture = ?), ?)
   ON CONFLICT (venture, collection, id) DO UPDATE SET json = excluded.json`;

class SqlCollection<T extends Identified> implements Collection<T> {
  readonly #driver: SqlDriver;
  readonly #venture: string;
  readonly #name: string;

  constructor(driver: SqlDriver, venture: string, name: string) {
    this.#driver = driver;
    this.#venture = venture;
    this.#name = name;
  }

  async get(id: string): Promise<T | undefined> {
    const rows = await this.#driver.all<{ json: string }>(
      `SELECT json FROM records WHERE venture = ? AND collection = ? AND id = ?`,
      [this.#venture, this.#name, id],
    );
    const row = rows[0];
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  async put(item: T): Promise<void> {
    await this.#driver.run(UPSERT, [this.#venture, this.#name, item.id, this.#venture, JSON.stringify(item)]);
  }

  async putMany(items: readonly T[]): Promise<void> {
    if (items.length === 0) return;
    const statements: SqlStatement[] = items.map((item) => ({
      sql: UPSERT,
      params: [this.#venture, this.#name, item.id, this.#venture, JSON.stringify(item)],
    }));
    await this.#driver.batch(statements);
  }

  async all(): Promise<T[]> {
    const rows = await this.#driver.all<{ json: string }>(
      `SELECT json FROM records WHERE venture = ? AND collection = ? ORDER BY seq`,
      [this.#venture, this.#name],
    );
    return rows.map((row) => JSON.parse(row.json) as T);
  }

  async find(predicate: (item: T) => boolean): Promise<T[]> {
    return (await this.all()).filter(predicate);
  }

  async remove(id: string): Promise<void> {
    await this.#driver.run(`DELETE FROM records WHERE venture = ? AND collection = ? AND id = ?`, [
      this.#venture,
      this.#name,
      id,
    ]);
  }
}

/**
 * Every account in one database, and the ways across.
 *
 * The driver is shared - it is one D1 binding - but nothing that comes out of
 * `for()` can see past its own account. See `docs/3-development/store-split.md`.
 */
export function createSqlRegistry(driver: SqlDriver, options: MigrateOptions = {}): StoreRegistry {
  const open = new Map<string, Promise<Store>>();

  const forVenture = (ventureId: string): Promise<Store> => {
    let store = open.get(ventureId);
    if (!store) {
      store = createSqlStore(driver, { ...options, venture: ventureId });
      open.set(ventureId, store);
    }
    return store;
  };

  return {
    for: forVenture,

    async each() {
      await ensureSchema(driver, options);
      // From the data, not the config: an account dropped from `ventures:`
      // still has a history, and export is the reason it must stay reachable.
      const rows = await driver.all<{ venture: string }>(
        `SELECT venture FROM records
         UNION
         SELECT venture_id AS venture FROM audit WHERE venture_id IS NOT NULL
         ORDER BY venture`,
      );
      return Promise.all(
        rows.map(async (row) => ({ ventureId: row.venture, store: await forVenture(row.venture) })),
      );
    },

    async findLinkByCode(code) {
      await ensureSchema(driver, options);
      // One query, whatever the number of accounts. A reader is waiting on
      // this, and walking every account's store would make the wait grow with
      // the size of the operation.
      const rows = await driver.all<{ venture: string; json: string }>(
        `SELECT venture, json FROM records WHERE collection = 'links'`,
      );
      for (const row of rows) {
        const link = JSON.parse(row.json) as TrackedLink;
        // Where it lives decides whose it is, the way the audit log's scope
        // decides whose an event is. A document that disagrees with the space
        // it is in would send the click to an account that never issued it.
        if (link.code === code) return { ...link, ventureId: row.venture };
      }
      return undefined;
    },

    async close() {
      await driver.close?.();
    },
  };
}
