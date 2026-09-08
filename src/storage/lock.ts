/**
 * "Only one of these at a time."
 *
 * On a machine this is the data directory's `mkdir` lock, held by the JSON
 * store: it stops `amp cycle run` from racing the daemon. On a host with no
 * process there is no such thing, and there is a new way to collide - **a cron
 * trigger can fire while the last one is still running**, or be retried. Two
 * ticks running a cycle for the same account would publish the same post twice.
 *
 * So the guard becomes a port. The shipped implementation is a no-op, because
 * the JSON store already holds a real lock and adding a second one there would
 * be two answers to the same question. A Worker binds this to a Durable
 * Object, which is single-threaded by construction and therefore *is* the lock.
 */

export type LockHandle = {
  /** Release. Safe to call twice. */
  release(): Promise<void>;
};

export type Lock = {
  /**
   * Takes the named lock, or returns undefined if someone else holds it.
   * Never waits: a tick that cannot get the lock has nothing useful to do
   * with the time, and the next one is a minute away.
   */
  acquire(name: string, options?: { holder?: string; ttlMs?: number }): Promise<LockHandle | undefined>;
};

/**
 * There is one implementation, `src/worker/lock-do.ts`, because there is one
 * host that needs it. A process on a machine is already covered by the JSON
 * store's directory lock, and adding a second lock there would be two answers
 * to the same question.
 */
