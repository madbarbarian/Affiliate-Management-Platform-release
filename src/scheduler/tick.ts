/**
 * One turn of the loop: start any account whose local start time has arrived,
 * publish anything whose slot has come up, and once a week ask the scout.
 *
 * It is a function rather than the body of the daemon's `setInterval` because
 * the same turn has to be callable by something that is not a long-running
 * process - a cron trigger on a host with no daemon. What differs there is only
 * *when* it is called, so nothing about scheduling belongs in here.
 *
 * Everything the turn remembers between calls is in `TickMemory`, held by the
 * caller. A daemon keeps one for its lifetime; a caller that starts fresh every
 * time passes a new one, and loses only noise: `startedToday` and `retryAfter`
 * are there to avoid repeated work and repeated log lines, not to prevent
 * double work. The orchestrator keys a cycle on `cyc_<venture>_<date>` and
 * resumes rather than duplicating, and `lastScoutAt` is read from the audit log
 * when the memory does not have it.
 */

import { localDate, localMinutesOfDay, parseTimeOfDay } from "../core/clock.ts";
import { COMPANY_SCOPE } from "../core/types.ts";
import { describeError } from "../core/result.ts";
import { isPaused, readPause } from "../kernel/pause.ts";
import { isVentureActive, readVentureState } from "../kernel/venture-state.ts";
import { lastScoutAt, runScout, scoutDue } from "../kernel/exploration.ts";
import type { Runtime } from "../runtime.ts";

/** How long to leave a venture alone after a retryable failure. */
export const RETRY_BACKOFF_MS = 10 * 60_000;

/**
 * The lock names the two halves take, where the host has a lock at all.
 *
 * Named here rather than at each caller because the console's "run today
 * again" button has to take *the same* one the cycles cron takes, and two
 * copies of a string that must match is how they come to differ.
 */
export const CYCLES_LOCK = "tick:cycles";
export const DISPATCH_LOCK = "tick:dispatch";

export type TickMemory = {
  /** Local dates already started, by venture, so a venture starts once per day. */
  readonly startedToday: Map<string, string>;
  /** Earliest epoch ms at which a deferred venture may be tried again. */
  readonly retryAfter: Map<string, number>;
  /** The stop already reported, so it is logged once rather than once a minute. */
  announcedStop?: string;
  /**
   * When the scout last completed. "Never" is a real value, so the wrapper
   * object is what distinguishes it from "not loaded yet".
   */
  lastScout?: { at: number | undefined };
  scoutRetryAfter?: number;
};

export function createTickMemory(): TickMemory {
  return { startedToday: new Map(), retryAfter: new Map() };
}

export type TickParts = {
  /** Start the accounts whose local start time has arrived. */
  readonly cycles?: boolean;
  /** Publish what is due, and record what a channel published on its own clock. */
  readonly dispatch?: boolean;
};

/**
 * `parts` exists for hosts that split the work across two schedules - a slow
 * one for cycles (which make model calls) and a fast one for dispatch (which
 * has to hit a slot to the minute). A daemon does both every minute.
 */
export async function runTick(
  runtime: Runtime,
  memory: TickMemory,
  nowMs: number,
  parts: TickParts = { cycles: true, dispatch: true },
): Promise<void> {
  const { logger } = runtime.services;

  // A cron fire is a fresh isolate: whatever the state store answered last time
  // belongs to an invocation that is over. No-op for the file adapter.
  await runtime.state.refresh?.();

  // The orchestrator refuses to run or publish while stopped, but a daemon that
  // discovers that by collecting an error every sixty seconds fills the log
  // with noise and buries whatever the operator actually needs to see.
  const stop = readPause(runtime.state);
  const stoppedEntirely = stop.all !== undefined;
  if (stoppedEntirely) {
    if (memory.announcedStop !== stop.all!.at) {
      memory.announcedStop = stop.all!.at;
      logger.warn("stopped - nothing will run or publish", {
        since: stop.all!.at,
        by: stop.all!.by,
        reason: stop.all!.reason,
        resumeWith: "amp resume",
      });
    }
    // Deliberately no early return. `dispatchDue` publishes nothing while
    // stopped - the orchestrator wrapper sees to that - but it is also what
    // records posts a native-scheduling channel put out on its own clock.
    // Returning here left the operator stopped and a live post unrecorded, the
    // exact case dispatchDue was written to handle.
  }
  if (!stoppedEntirely && memory.announcedStop !== undefined) {
    memory.announcedStop = undefined;
    logger.info("running again after a stop");
  }

  // Read once per tick, like the stop: an operator switching an account off
  // from the console takes effect on the next tick, no restart.
  const ventureState = readVentureState(runtime.state);
  if (parts.cycles !== false) {
    // Before the day's cycles, so a new day never opens beside a gate from the
    // old one. Not gated on the stop: a day passed whether or not the platform
    // was running, and a resume that hands back a week of gates is the pile-up
    // this prevents. See `requirements.md` 4.
    const lapsed = await runtime.orchestrator.expireStaleGates();
    if (!lapsed.ok) logger.error("could not close the gates that lapsed", { error: describeError(lapsed.error) });
    else if (lapsed.value.expired.length > 0) {
      logger.info("gates closed unanswered", { count: lapsed.value.expired.length });
    }

    for (const venture of runtime.config.ventures) {
      if (stoppedEntirely || isPaused(stop, venture.id)) continue;
      if (!isVentureActive(venture, ventureState)) continue;
      const today = localDate(nowMs, venture.timezone);
      if (memory.startedToday.get(venture.id) === today) continue;
      if ((memory.retryAfter.get(venture.id) ?? 0) > nowMs) continue;

      const startMinutes = parseTimeOfDay(venture.cadence.cycleStartsAt);
      if (localMinutesOfDay(nowMs, venture.timezone) < startMinutes) continue;

      // Marked started before the run, so a crash cannot loop the day. But a
      // *retryable* failure - an LLM 429, a channel 503 - is the orchestrator's
      // resume-the-failed-step design working, and burning the whole day on one
      // meant it never resumed. Those clear the mark and back off instead.
      memory.startedToday.set(venture.id, today);
      logger.info("starting daily cycle", { venture: venture.id, date: today });
      const result = await runtime.orchestrator.runCycle(venture.id, { date: today });
      if (!result.ok) {
        if (result.error.retryable) {
          memory.startedToday.delete(venture.id);
          memory.retryAfter.set(venture.id, nowMs + RETRY_BACKOFF_MS);
          logger.warn("cycle deferred, will retry", {
            venture: venture.id,
            inMinutes: Math.round(RETRY_BACKOFF_MS / 60_000),
            error: describeError(result.error),
          });
          continue;
        }
        logger.error("cycle failed", { venture: venture.id, error: describeError(result.error) });
        continue;
      }
      memory.retryAfter.delete(venture.id);
      logger.info("cycle paused or finished", {
        venture: venture.id,
        status: result.value.status,
        nextStep: result.value.nextStep ?? "—",
      });
    }
  }

  if (parts.dispatch === false) return;

  const dispatched = await runtime.orchestrator.dispatchDue(nowMs);
  if (!dispatched.ok) {
    logger.error("dispatch failed", { error: describeError(dispatched.error) });
    return;
  }

  // After dispatch, never before it: posts are scheduled to the minute and a
  // weekly model call must not be what makes one late. Only while nothing is
  // stopped - a stop means "do not spend or decide anything", and a call
  // proposing new accounts is both.
  if (!stoppedEntirely) await exploreIfDue(runtime, memory, nowMs);
  if (dispatched.value.published.length > 0 || dispatched.value.failed.length > 0) {
    logger.info("dispatch", {
      published: dispatched.value.published.length,
      failed: dispatched.value.failed.length,
      waiting: dispatched.value.stillWaiting,
    });
    for (const failure of dispatched.value.failed) {
      logger.error("post failed to publish", failure);
    }
  }
}

async function exploreIfDue(runtime: Runtime, memory: TickMemory, nowMs: number): Promise<void> {
  const exploration = runtime.config.company.exploration;
  const { logger } = runtime.services;
  if (!exploration.enabled || nowMs < (memory.scoutRetryAfter ?? 0)) return;
  memory.lastScout ??= { at: await lastScoutAt(await runtime.services.stores.for(COMPANY_SCOPE)) };
  if (!scoutDue(memory.lastScout.at, nowMs, exploration.everyDays)) return;

  // Not on day one. A scout shown nothing but empty aggregates would still
  // produce three confident proposals, and a fresh install would have paid for
  // a model call it did not ask for. `amp scout` by hand is unaffected.
  // Any account having finished a day is enough: the scout reads the whole
  // company, and on a fresh install there is nothing for it to read.
  let anyCompleted = false;
  for (const scope of await runtime.services.stores.each()) {
    if ((await scope.store.cycles.find((cycle) => cycle.status === "completed")).length > 0) {
      anyCompleted = true;
      break;
    }
  }
  if (!anyCompleted) return;

  logger.info("scout running", { everyDays: exploration.everyDays });
  const result = await runScout(runtime.services, { state: runtime.state });
  if (!result.ok) {
    // Same backoff as a deferred cycle. Not marked as run: a scout that could
    // not answer has not answered, and next week is too long to wait.
    memory.scoutRetryAfter = nowMs + RETRY_BACKOFF_MS;
    logger.warn("scout deferred, will retry", { error: describeError(result.error) });
    return;
  }
  memory.lastScout = { at: nowMs };
  logger.info("scout proposed", {
    proposals: result.value.proposals.length,
    dropped: result.value.dropped.length,
    // The daemon holds the data lock, so the CLI's accept/dismiss would be
    // refused while it runs; the console writes through this process.
    decideWith: "the console's 探索の提案 section (or stop the daemon and use amp scout accept <id>)",
  });
}
