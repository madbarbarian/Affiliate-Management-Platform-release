/**
 * `SqlDriver` on top of Cloudflare D1.
 *
 * D1 is SQLite, so the statements are the ones `sql-store.ts` already runs
 * against `node:sqlite` in the test suite. This file is only the shape of the
 * binding.
 *
 * The binding is typed here rather than pulled from `@cloudflare/workers-types`
 * on purpose: this is the whole surface used, it is stable, and a platform that
 * ships with one runtime dependency should not need a package to describe four
 * methods. If that stops being true, install the types - do not widen this.
 */

import type { SqlDriver, SqlParam, SqlStatement } from "./sql-driver.ts";

export type D1PreparedStatement = {
  bind(...values: readonly SqlParam[]): D1PreparedStatement;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};

export type D1Database = {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: readonly D1PreparedStatement[]): Promise<unknown>;
};

export function createD1Driver(db: D1Database): SqlDriver {
  const prepared = (statement: SqlStatement): D1PreparedStatement => {
    const base = db.prepare(statement.sql);
    // `bind()` with no arguments is not the same as not binding: D1 rejects it
    // for a statement that has no placeholders.
    return statement.params && statement.params.length > 0 ? base.bind(...statement.params) : base;
  };

  return {
    async all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]> {
      const { results } = await prepared({ sql, ...(params ? { params } : {}) }).all<T>();
      return results;
    },
    async run(sql: string, params?: readonly SqlParam[]): Promise<void> {
      await prepared({ sql, ...(params ? { params } : {}) }).run();
    },
    async batch(statements: readonly SqlStatement[]): Promise<void> {
      if (statements.length === 0) return;
      // D1 runs a batch in one transaction, which is what `putMany` needs: half
      // a slate of drafts is a cycle nobody can read.
      await db.batch(statements.map(prepared));
    },
  };
}
