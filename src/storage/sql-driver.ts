/**
 * The narrowest thing a SQL database has to do for this platform.
 *
 * Deliberately not an ORM and not a query builder: the SQL lives in
 * `sql-store.ts`, in one dialect (SQLite), and a driver only has to run it.
 * That is what makes the adapter testable - the same statements D1 will run in
 * production run against `node:sqlite` in the test suite, with no network and
 * no new dependency.
 */

export type SqlParam = string | number | null;

export type SqlStatement = {
  readonly sql: string;
  readonly params?: readonly SqlParam[];
};

export type SqlDriver = {
  /** Rows, as plain objects keyed by column name. */
  all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;
  run(sql: string, params?: readonly SqlParam[]): Promise<void>;
  /**
   * Runs several statements. Atomically where the driver can (a transaction, a
   * D1 batch); in order otherwise. Used for `putMany`, where a half-applied
   * batch is worse than a slow one.
   */
  batch(statements: readonly SqlStatement[]): Promise<void>;
  close?(): Promise<void>;
};
