/**
 * The daemon - the thing that makes it a company rather than a script someone
 * remembers to run.
 *
 * Once a minute it calls `runTick`, which starts any venture whose local start
 * time has arrived and publishes anything whose slot has come up. That is the
 * entire loop. Cron would do the first half, but not the second - posts are
 * scheduled to the minute across timezones, and a channel without native
 * scheduling needs something awake to press send.
 *
 * The turn itself lives in `tick.ts`, so a host with no daemon can call it from
 * a scheduled trigger. What is left here is the process: the interval, the
 * console, and stopping cleanly.
 */

import { describeError } from "../core/result.ts";
import type { Runtime } from "../runtime.ts";
import { startConsole, type ConsoleHandle } from "../console/server.ts";
import { createTickMemory, runTick } from "./tick.ts";

export type DaemonOptions = {
  /** How often to check. Sixty seconds is the resolution of a scheduled slot. */
  readonly tickMs?: number;
  /** Start the approval console in the same process. */
  readonly withConsole?: boolean;
};

export type Daemon = {
  stop(): Promise<void>;
  /** Resolves when the daemon stops. */
  readonly done: Promise<void>;
};

export async function startDaemon(runtime: Runtime, options: DaemonOptions = {}): Promise<Daemon> {
  const tickMs = options.tickMs ?? 60_000;
  const { logger, clock } = runtime.services;

  let consoleHandle: ConsoleHandle | undefined;
  if (options.withConsole && runtime.config.console.enabled) {
    const started = await startConsole(runtime);
    if (started.ok) {
      consoleHandle = started.value;
      logger.info("console listening", { url: started.value.url });
    } else {
      // A console that will not start is worth shouting about, but it is not a
      // reason to stop publishing.
      logger.error("console failed to start", { error: describeError(started.error) });
    }
  }

  let stopping = false;
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // Held across ticks so a venture starts once a day and a deferred one backs
  // off. Losing it costs log noise and repeated no-op work, never duplication.
  const memory = createTickMemory();
  const tick = (): Promise<void> => runTick(runtime, memory, clock.now());

  const loop = async (): Promise<void> => {
    while (!stopping) {
      try {
        await tick();
      } catch (cause) {
        // The daemon is the one thing that must not die.
        logger.error("tick threw", { error: cause instanceof Error ? cause.message : String(cause) });
      }
      await sleepUntilStopped(tickMs, () => stopping);
    }
    await consoleHandle?.close();
    resolveDone();
  };

  void loop();
  logger.info("daemon running", { tickSeconds: Math.round(tickMs / 1000) });

  return {
    async stop() {
      stopping = true;
      await done;
    },
    done,
  };
}

/** A sleep that wakes early when the daemon is asked to stop. */
async function sleepUntilStopped(ms: number, stopped: () => boolean): Promise<void> {
  const step = 250;
  let waited = 0;
  while (waited < ms && !stopped()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
    waited += step;
  }
}
