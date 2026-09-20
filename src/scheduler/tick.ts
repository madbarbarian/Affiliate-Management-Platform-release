/**
 * One turn of the loop: start any account whose local start time has arrived,
 * publish anything whose slot has come up, and once a week ask the scout.
 *
 * It is a function rather than the body of the daemon's `setInterval` because
 * the same turn has to be callable by something that is not a long-running
 * process - a cron trigger on a host with no daemon. What differs there is only
 * *when* it is called, so nothing about scheduling belongs in here.
 *
 * **Nothing the turn decides comes out of `TickMemory`.** It used to: a map of
 * "already started today" and a map of "do not try again until". A cron fire is
 * a fresh isolate, so on Cloudflare both were always empty, and a day that had
 * failed deterministically was started again every single hour - four model
 * calls by the fourth tick, for an error that could not succeed. Whether to
 * start a day is now read from the cycle record, which is the only thing that
 * survives an isolate, and `judgeCycleStart` is where that reading happens.
 */

import { localDate, localMinutesOfDay, parseTimeOfDay } from "../core/clock.ts";
import { COMPANY_SCOPE, type Cycle } from "../core/types.ts";
import type { AuditEvent } from "../core/types.ts";
import { describeError } from "../core/result.ts";
import { isPaused, readPause } from "../kernel/pause.ts";
import { isVentureActive, readVentureState } from "../kernel/venture-state.ts";
import { cycleIdFor } from "../kernel/orchestrator.ts";
import { SCOUT_COMPLETED_EVENT, SCOUT_FAILED_EVENT, runScout, scoutDue } from "../kernel/exploration.ts";
import type { Runtime } from "../runtime.ts";

/**
 * How long to leave a day alone after a failure it might recover from.
 *
 * Not a config value, because the host cannot honour one. The Worker's cycles
 * cron is `0 * * * *` - once an hour, and nothing finer exists - so any value
 * under an hour is the same as zero there, and putting it in
 * `platform.config.yaml` would promise a precision the platform does not have.
 * On a daemon, which ticks every minute, it is what it says.
 */
export const CYCLE_RETRY_BACKOFF_MS = 10 * 60_000;

/** The same wait for the scout, whose cron is the minutely one. */
export const SCOUT_RETRY_BACKOFF_MS = 10 * 60_000;

/**
 * How many times a failing scout may be asked in one UTC day.
 *
 * A cap and not only a backoff, because the scout's own "have I run" marker is
 * read out of a bounded window of the company's audit log. Without a cap, a
 * scout failing every ten minutes writes enough failures to push the last
 * *successful* run out of that window in about a day - at which point the
 * platform decides it has never run and asks again immediately, forever. The
 * cap is what makes losing the marker harmless rather than self-feeding.
 */
export const SCOUT_MAX_ATTEMPTS_PER_DAY = 2;

/**
 * The lock names the two halves take, where the host has a lock at all.
 *
 * Named here rather than at each caller because the console's "run today
 * again" button has to take *the same* one the cycles cron takes, and two
 * copies of a string that must match is how they come to differ.
 */
export const CYCLES_LOCK = "tick:cycles";
export const DISPATCH_LOCK = "tick:dispatch";

/**
 * What one turn remembers, which is now only what it would otherwise say twice.
 *
 * Losing it costs a repeated log line and nothing else. Anything a decision
 * rests on is read from storage on every turn - see the file comment.
 */
export type TickMemory = {
  /** The stop already reported, so it is logged once rather than once a minute. */
  announcedStop?: string;
};

export function createTickMemory(): TickMemory {
  return {};
}

/**
 * Why a day was started, or was not. One word, because it is written to the
 * audit log and read back by a person.
 */
export type CycleStartReason =
  | "no_record"
  | "retry_due"
  | "other_day"
  | "already_settled"
  | "waiting_for_person"
  | "not_retryable"
  | "attempts_exhausted"
  | "backoff"
  | "unreadable_timestamp";

export type CycleStartJudgement = {
  readonly run: boolean;
  readonly reason: CycleStartReason;
};

export type CycleStartInput = {
  /** Today's cycle for this account, or undefined when there is none yet. */
  readonly cycle: Cycle | undefined;
  /**
   * The local date the caller is about to run, in the account's own timezone.
   * Passed in rather than derived: without it this cannot tell whether the
   * cycle it was handed is even the day being asked about.
   */
  readonly date: string;
  readonly nowMs: number;
  readonly backoffMs: number;
  readonly maxAttempts: number;
};

/**
 * Whether to start (or resume) an account's day, from the stored record alone.
 *
 * The rule that matters, and the one the first version of this got backwards:
 * **only an explicit `retryable: false` stops a retry.** A missing value is a
 * record written before the field existed, and treating "unknown" as a dead
 * end would have turned every pre-existing failure into a day that never runs.
 * Worse, `cycle.step_threw` - a D1 blip, a `fetch` TypeError, a prompt that did
 * not load - is built by `fail()` whose default is `retryable: false`, and
 * those are the failures that most often clear by themselves on a host. What
 * bounds the cost is the attempt limit, not a refusal to try.
 *
 * A cycle left `running` is the same case: the isolate died mid-step. Hourly
 * resumption is what recovers it, and skipping would leave the account dead
 * with the screen still saying 動作中.
 */
export function judgeCycleStart(input: CycleStartInput): CycleStartJudgement {
  const { cycle, date, nowMs, backoffMs, maxAttempts } = input;
  if (!cycle) return { run: true, reason: "no_record" };
  if (cycle.date !== date) return { run: false, reason: "other_day" };
  if (cycle.status === "completed" || cycle.status === "cancelled") {
    return { run: false, reason: "already_settled" };
  }
  if (cycle.status === "awaiting_approval") return { run: false, reason: "waiting_for_person" };
  if (cycle.status === "failed" && cycle.failure?.retryable === false) {
    return { run: false, reason: "not_retryable" };
  }
  // Absent means "it has run at least once", which is true of anything that
  // exists. Reading it as zero would hand every pre-existing record a free try.
  const attempts = cycle.attempts ?? 1;
  if (attempts >= maxAttempts) return { run: false, reason: "attempts_exhausted" };
  const lastTouched = Date.parse(cycle.updatedAt);
  // Fail closed on a timestamp nobody can read: without one there is no way to
  // hold the backoff, and a day that cannot be rate-limited is a day that runs
  // on every tick.
  if (Number.isNaN(lastTouched)) return { run: false, reason: "unreadable_timestamp" };
  if (lastTouched + backoffMs > nowMs) return { run: false, reason: "backoff" };
  return { run: true, reason: "retry_due" };
}

/** The reasons that mean "this day is over unless a person starts it". */
const DEAD_FOR_TODAY: ReadonlySet<CycleStartReason> = new Set<CycleStartReason>([
  "not_retryable",
  "attempts_exhausted",
  "unreadable_timestamp",
]);

/** The event a day gives up under. Read by the console's activity feed. */
export const CYCLE_ABANDONED_EVENT = "cycle.retry_abandoned";

/** Why the scout was asked, or was not. */
export type ScoutStartReason = "never_run" | "due" | "not_due" | "attempts_exhausted" | "backoff";

export type ScoutStartJudgement = { readonly run: boolean; readonly reason: ScoutStartReason };

export type ScoutStartInput = {
  /** The company's recent audit events, most recent first. */
  readonly events: readonly AuditEvent[];
  readonly nowMs: number;
  readonly everyDays: number;
  readonly backoffMs: number;
  readonly maxAttemptsPerDay: number;
};

/**
 * Whether to ask the scout, from the company's audit log alone.
 *
 * The same problem as the cycle, one layer up: the minutely cron reaches this,
 * and the "do not retry yet" mark used to live in `TickMemory` - so a scout
 * whose model call kept failing was asked again sixty seconds later, forever.
 * The mark is the failure event itself now, which survives an isolate.
 */
export function judgeScoutStart(input: ScoutStartInput): ScoutStartJudgement {
  const { events, nowMs, everyDays, backoffMs, maxAttemptsPerDay } = input;
  const completed = events.find((event) => event.type === SCOUT_COMPLETED_EVENT);
  const lastCompletedMs = completed ? Date.parse(completed.at) : undefined;
  if (!scoutDue(Number.isNaN(lastCompletedMs ?? NaN) ? undefined : lastCompletedMs, nowMs, everyDays)) {
    return { run: false, reason: "not_due" };
  }

  // UTC, not an account's timezone: the scout works for the company, and the
  // company has no one timezone to have a day in.
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const failures = events.filter((event) => event.type === SCOUT_FAILED_EVENT);
  if (failures.filter((event) => event.at.slice(0, 10) === today).length >= maxAttemptsPerDay) {
    return { run: false, reason: "attempts_exhausted" };
  }
  const lastFailureMs = failures[0] ? Date.parse(failures[0].at) : undefined;
  if (lastFailureMs !== undefined && !Number.isNaN(lastFailureMs) && lastFailureMs + backoffMs > nowMs) {
    return { run: false, reason: "backoff" };
  }
  return { run: true, reason: lastCompletedMs === undefined ? "never_run" : "due" };
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
      // One date, used twice on purpose. The judgement below and the run it
      // authorises have to be about the same day, or a tick that crosses local
      // midnight judges yesterday and starts today.
      const today = localDate(nowMs, venture.timezone);

      const startMinutes = parseTimeOfDay(venture.cadence.cycleStartsAt);
      if (localMinutesOfDay(nowMs, venture.timezone) < startMinutes) continue;

      const store = await runtime.services.stores.for(venture.id);
      const cycle = await store.cycles.get(cycleIdFor(venture.id, today));
      const judgement = judgeCycleStart({
        cycle,
        date: today,
        nowMs,
        backoffMs: CYCLE_RETRY_BACKOFF_MS,
        maxAttempts: runtime.config.company.retry.maxCycleAttempts,
      });
      if (!judgement.run) {
        await noteAbandoned(runtime, venture.id, today, judgement, cycle);
        continue;
      }
      // Counted before the day is started, and only where there is already a
      // record: a day with none is about to be created with `attempts: 1`.
      if (cycle) await countAttempt(runtime, cycle);

      logger.info("starting daily cycle", { venture: venture.id, date: today, why: judgement.reason });
      const result = await runtime.orchestrator.runCycle(venture.id, { date: today });
      if (!result.ok) {
        // No mark to clear and no backoff to set: the orchestrator has already
        // written the failure and its `retryable` onto the cycle, which is what
        // the next tick will read.
        const level = result.error.retryable ? "warn" : "error";
        logger[level]("cycle stopped", { venture: venture.id, error: describeError(result.error) });
        continue;
      }
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
  if (!stoppedEntirely) await exploreIfDue(runtime, nowMs);
  if (
    dispatched.value.published.length > 0 ||
    dispatched.value.handedOver.length > 0 ||
    dispatched.value.failed.length > 0
  ) {
    logger.info("dispatch", {
      published: dispatched.value.published.length,
      // Counted apart from `published` on purpose: these are composed and
      // waiting for the operator to post them, and a log line that added the
      // two together would report work as done that nobody has done.
      handedOver: dispatched.value.handedOver.length,
      failed: dispatched.value.failed.length,
      waiting: dispatched.value.stillWaiting,
    });
    for (const failure of dispatched.value.failed) {
      logger.error("post failed to publish", failure);
    }
  }
}

/**
 * Marks a day as tried again, before it is.
 *
 * Here and nowhere else, because spending money on a day is a decision this
 * file makes. Two other things restart a cycle and neither of them is a new
 * try: `resolveGate` resumes the day a person has just answered - twice, once
 * per gate, which with the start would exhaust the limit on a morning where
 * nothing went wrong - and the console's 今日のサイクルを動かす is a person
 * saying they know something the scheduler does not. Both go straight to the
 * orchestrator and never through here, which is what makes this the one place.
 *
 * Written *before* `runCycle`, so the crash it is bounding cannot be what stops
 * it being recorded. `updatedAt` moves with it for the same reason: it is what
 * holds the backoff, and a day that cannot be backed off runs on every tick.
 */
async function countAttempt(runtime: Runtime, cycle: Cycle): Promise<void> {
  const store = await runtime.services.stores.for(cycle.ventureId);
  await store.cycles.put({
    ...cycle,
    attempts: (cycle.attempts ?? 1) + 1,
    updatedAt: runtime.services.clock.nowIso(),
  });
}

/**
 * Records, once, that a day has stopped trying.
 *
 * Not every skip: "waiting for a person" and "already finished" are what a
 * healthy afternoon looks like, and an hourly line about each of them would
 * bury the account's feed under its own scheduler. What is recorded is the day
 * giving up, because that is the one a person has to know about - `decision.
 * expired` was added for exactly this, after days died on a host whose only
 * record of it was a log line nobody could read.
 *
 * Once, because the tick fires every hour and the account's feed shows twelve
 * entries. The guard is the log itself: if the last thing recorded about this
 * cycle is already that it gave up, there is nothing new to say.
 */
async function noteAbandoned(
  runtime: Runtime,
  ventureId: string,
  date: string,
  judgement: CycleStartJudgement,
  cycle: Cycle | undefined,
): Promise<void> {
  const { logger } = runtime.services;
  logger.debug("cycle not started", { venture: ventureId, date, why: judgement.reason });
  if (!DEAD_FOR_TODAY.has(judgement.reason) || !cycle) return;

  const store = await runtime.services.stores.for(ventureId);
  const [latest] = await store.audit.recent(1, { cycleId: cycle.id });
  if (latest?.type === CYCLE_ABANDONED_EVENT) return;

  const event: AuditEvent = {
    id: runtime.services.ids.next("evt"),
    at: runtime.services.clock.nowIso(),
    ventureId,
    cycleId: cycle.id,
    type: CYCLE_ABANDONED_EVENT,
    actor: "scheduler",
    // English, like every other stored summary: the record is durable and the
    // screen's language is a setting.
    summary: `Stopped trying ${date} (${judgement.reason}).`,
    data: {
      day: date,
      reason: judgement.reason,
      attempts: cycle.attempts ?? 1,
      ...(cycle.failure ? { step: cycle.failure.step, code: cycle.failure.code } : {}),
    },
  };
  await store.audit.append(event);
  await runtime.services.bus.emit(event);
  logger.warn("no more retries for this day", { venture: ventureId, date, why: judgement.reason });
}

async function exploreIfDue(runtime: Runtime, nowMs: number): Promise<void> {
  const exploration = runtime.config.company.exploration;
  const { logger } = runtime.services;
  if (!exploration.enabled) return;
  const companyStore = await runtime.services.stores.for(COMPANY_SCOPE);
  const judgement = judgeScoutStart({
    events: await companyStore.audit.recent(SCOUT_EVENT_WINDOW, { ventureId: COMPANY_SCOPE }),
    nowMs,
    everyDays: exploration.everyDays,
    backoffMs: SCOUT_RETRY_BACKOFF_MS,
    maxAttemptsPerDay: SCOUT_MAX_ATTEMPTS_PER_DAY,
  });
  if (!judgement.run) return;

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

  logger.info("scout running", { everyDays: exploration.everyDays, why: judgement.reason });
  const result = await runScout(runtime.services, { state: runtime.state });
  if (!result.ok) {
    // Recorded, not remembered. The mark that holds the next ten minutes has
    // to outlive the isolate, and on a host the isolate is gone the moment
    // this returns - which is how a scout that could not answer came to be
    // asked again sixty seconds later, and every minute after that.
    await recordScoutFailure(runtime, result.error.message);
    logger.warn("scout deferred, will retry", { error: describeError(result.error) });
    return;
  }
  logger.info("scout proposed", {
    proposals: result.value.proposals.length,
    dropped: result.value.dropped.length,
    // The daemon holds the data lock, so the CLI's accept/dismiss would be
    // refused while it runs; the console writes through this process.
    decideWith: "the console's 探索の提案 section (or stop the daemon and use amp scout accept <id>)",
  });
}

/**
 * How far back the scout's own history is read. The same window `lastScoutAt`
 * uses, and named here because `judgeScoutStart`'s per-day cap is what keeps
 * the window from filling with failures - the two numbers only make sense
 * together.
 */
const SCOUT_EVENT_WINDOW = 200;

async function recordScoutFailure(runtime: Runtime, message: string): Promise<void> {
  const store = await runtime.services.stores.for(COMPANY_SCOPE);
  const event: AuditEvent = {
    id: runtime.services.ids.next("evt"),
    at: runtime.services.clock.nowIso(),
    ventureId: COMPANY_SCOPE,
    type: SCOUT_FAILED_EVENT,
    actor: "scheduler",
    summary: `The scout could not answer: ${message.slice(0, 200)}`,
    data: {},
  };
  await store.audit.append(event);
  await runtime.services.bus.emit(event);
}
