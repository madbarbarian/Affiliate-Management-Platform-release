/**
 * A minimal in-process event bus.
 *
 * The orchestrator emits an event for every meaningful thing the company does.
 * Subscribers turn those into the audit trail, console notifications, and
 * whatever a licensee bolts on (Slack, LINE, email) without the orchestrator
 * knowing they exist.
 */

import type { AuditEvent } from "./types.ts";
import type { Logger } from "./logger.ts";

export type EventHandler = (event: AuditEvent) => void | Promise<void>;

export type EventBus = {
  /** Subscribe to a single event type, or "*" for all of them. */
  on(type: string, handler: EventHandler): () => void;
  emit(event: AuditEvent): Promise<void>;
};

export function createEventBus(logger?: Logger): EventBus {
  const handlers = new Map<string, Set<EventHandler>>();

  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<EventHandler>();
      set.add(handler);
      handlers.set(type, set);
      return () => {
        set.delete(handler);
      };
    },

    async emit(event) {
      const targets = [...(handlers.get(event.type) ?? []), ...(handlers.get("*") ?? [])];
      for (const handler of targets) {
        try {
          await handler(event);
        } catch (cause) {
          // A broken subscriber must never take down a cycle.
          logger?.warn("event handler failed", {
            type: event.type,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    },
  };
}
