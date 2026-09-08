/**
 * The lock, as a Durable Object.
 *
 * A cron trigger can fire while the previous one is still running, and can be
 * retried. Without a lock, two ticks publish the same due post twice. On a
 * machine the JSON store's directory lock covers this; here nothing does,
 * because there is no shared machine - only isolates that may or may not be the
 * same one.
 *
 * A Durable Object is the answer because there is exactly one of each name
 * across the whole account, and it handles one request at a time. That *is* the
 * lock; this class only remembers who holds it and until when.
 *
 * The TTL exists because a holder can vanish (an isolate killed mid-tick) and
 * nobody would ever release. It is deliberately longer than a tick's own budget
 * so it never expires under a tick that is still working.
 */

import type { Lock, LockHandle } from "../storage/lock.ts";

const DEFAULT_TTL_MS = 15 * 60_000;

type Held = { readonly holder: string; readonly until: number };

/** The Durable Object class. Named in wrangler.jsonc as `LOCK`. */
export class TickLock {
  #held: Held | undefined;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const holder = url.searchParams.get("holder") ?? "unknown";
    const now = Date.now();

    if (url.pathname === "/acquire") {
      const ttl = Number(url.searchParams.get("ttl") ?? DEFAULT_TTL_MS);
      if (this.#held && this.#held.until > now) {
        return Response.json({ acquired: false, holder: this.#held.holder });
      }
      this.#held = { holder, until: now + (Number.isFinite(ttl) ? ttl : DEFAULT_TTL_MS) };
      return Response.json({ acquired: true });
    }

    if (url.pathname === "/release") {
      // Only the holder may release. Otherwise a tick that overran its TTL,
      // finished late and released would free the lock of whoever had since
      // taken it - and two ticks would run after all.
      if (this.#held?.holder === holder) this.#held = undefined;
      return Response.json({ released: true });
    }

    return new Response("not found", { status: 404 });
  }
}

export type DurableObjectNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

/** The `Lock` port over that namespace. */
export function durableObjectLock(namespace: DurableObjectNamespace): Lock {
  return {
    async acquire(name, options): Promise<LockHandle | undefined> {
      const holder = options?.holder ?? crypto.randomUUID();
      const stub = namespace.get(namespace.idFromName(name));
      const ttl = options?.ttlMs ?? DEFAULT_TTL_MS;
      const response = await stub.fetch(
        new Request(`https://lock/acquire?holder=${encodeURIComponent(holder)}&ttl=${ttl}`),
      );
      const body = (await response.json()) as { acquired: boolean };
      if (!body.acquired) return undefined;

      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          await stub.fetch(new Request(`https://lock/release?holder=${encodeURIComponent(holder)}`));
        },
      };
    },
  };
}
