/**
 * `SqlDriver` on top of Node's built-in SQLite.
 *
 * Two jobs. It is how the SQL adapter is tested - the statements that will run
 * on D1 run here first, against real SQLite, with no network and no dependency
 * added. And it is a working single-file database for a licensee who has
 * outgrown one JSON file per collection but does not want a server.
 *
 * `node:sqlite` is built into Node and prints an experimental warning on first
 * use. It is not on any path a licensee walks by default.
 */

import { DatabaseSync } from "node:sqlite";

import type { SqlDriver, SqlParam, SqlStatement } from "./sql-driver.ts";

export type SqliteDriverOptions = {
  /** A file path, or `:memory:`. */
  readonly filename: string;
};

export function createSqliteDriver(options: SqliteDriverOptions): SqlDriver {
  const db = new DatabaseSync(options.filename);
  // Without this a reader and a writer in different processes fight; with it
  // they do not. Harmless in memory.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const bind = (params: readonly SqlParam[] | undefined): SqlParam[] => [...(params ?? [])];

  return {
    async all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]> {
      return db.prepare(sql).all(...bind(params)) as T[];
    },
    async run(sql: string, params?: readonly SqlParam[]): Promise<void> {
      db.prepare(sql).run(...bind(params));
    },
    async batch(statements: readonly SqlStatement[]): Promise<void> {
      // A half-applied batch is worse than a slow one: `putMany` is how a whole
      // slate of drafts is stored, and half a slate is a cycle nobody can read.
      db.exec("BEGIN");
      try {
        for (const statement of statements) db.prepare(statement.sql).run(...bind(statement.params));
        db.exec("COMMIT");
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}
