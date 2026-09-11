/**
 * The Worker: the same platform, on a host with no process.
 *
 * Two entry points, and neither owns any logic of its own.
 *
 * - `fetch` hands the request to `console/router.ts` - the same routes, the
 *   same authentication, the same page the daemon serves. A second copy of
 *   those would be a second place to fix a security bug in.
 * - `scheduled` calls `runTick`, the same turn of the loop the daemon runs on
 *   an interval. Which half runs depends on which cron fired: the heavy one
 *   (cycles, six model calls) is on the hourly schedule because a cron trigger
 *   at an hour or longer gets fifteen minutes of CPU, and the light one
 *   (publishing what is due) is every minute because a slot is to the minute.
 *
 * **Two things always work, whatever else is broken.** `/healthz` answers
 * before a database is needed, and `/go/<code>` redirects and records the click
 * even when the config has stopped validating or a secret has gone missing -
 * every link already inside a published post points here, and a click that is
 * not recorded cannot be counted later.
 */

import { describeError } from "../core/result.ts";
import { randomIds } from "../core/ids.ts";
import { systemClock } from "../core/clock.ts";
import type { ReleaseStamp } from "../core/release.ts";
import { handleRequest, handleRedirect } from "../console/router.ts";
import { REDIRECT_PATH } from "../affiliate/links.ts";
import { CYCLES_LOCK, DISPATCH_LOCK, createTickMemory, runTick } from "../scheduler/tick.ts";
import { createSqlRegistry } from "../storage/sql-store.ts";
import { createD1Driver } from "../storage/d1-driver.ts";
import { durableObjectLock, type DurableObjectNamespace } from "./lock-do.ts";
import { createWorkerRuntime, type WorkerEnv } from "./runtime.ts";
import { resolveOperators } from "../console/operators.ts";
import { renderSetup } from "./setup.ts";

/**
 * What the build put in the Worker. Passed in rather than imported here so a
 * test can exercise the configured path, which this repository's own build -
 * which has no licensee config - otherwise never reaches.
 */
export type Bundle = {
  readonly configSource: "licensee" | "example";
  readonly configText: string;
  readonly prompts: Readonly<Record<string, string>>;
  /**
   * Which release this Worker was built from. Undefined in a development
   * checkout, and then the update notice has nothing to compare and says
   * nothing - the Worker has no filesystem, so if the build did not carry this
   * in, nothing at runtime can recover it.
   */
  readonly release?: ReleaseStamp;
};

export type WorkerHandlers = {
  fetch(request: Request, env: WorkerEnv): Promise<Response>;
  scheduled(event: { readonly cron: string; readonly scheduledTime: number }, env: WorkerEnv): Promise<void>;
};

/** The cron that runs the day's cycles. Everything else is the minute tick. */
const CYCLE_CRON = "0 * * * *";

/**
 * A tick that has not finished in this long is assumed dead. Longer than the
 * fifteen minutes of CPU a cron trigger can use, so it never expires under a
 * tick that is still working.
 */
const TICK_LOCK_TTL_MS = 20 * 60_000;

export function createWorker(bundle: Bundle): WorkerHandlers {
  const { configSource, configText, prompts, release } = bundle;

  const setupResponse = (
    request: Request,
    env: WorkerEnv,
    url: URL,
    token: string | undefined,
    problem: string | undefined,
  ): Response => {
    if (token && !authorised(request, url, token)) {
      return html(401, "<p>合言葉が要ります。Cloudflare で設定した AMP_CONSOLE_TOKEN を <code>?token=…</code> に付けて開いてください。</p>");
    }
    return html(
      200,
      renderSetup({
        configured: configSource === "licensee",
        ...(problem ? { problem } : {}),
        hasDatabase: Boolean(env.DB),
        hasModelKey: hasModelKey(env),
        hasConsoleToken: Boolean(token),
        address: url.origin,
      }),
    );
  };

  return {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    // Answers before anything else is known to work, so an uptime check does
    // not need a database or a config.
    if (url.pathname === "/healthz") {
      return json(200, { ok: true, configured: configSource === "licensee" });
    }

    const token = readToken(env);

    if (configSource !== "licensee") {
      // No links can exist yet, so there is nothing for the redirect to serve.
      return setupResponse(request, env, url, token, undefined);
    }

    // The same lock the cycles cron takes. The console can start a day too, and
    // a request that ran a cycle beside the hourly tick would draft it twice.
    const lock = env.LOCK ? durableObjectLock(env.LOCK as DurableObjectNamespace) : undefined;
    const runtime = await createWorkerRuntime({ env, configText, prompts, ...(lock ? { lock } : {}), ...(release ? { release } : {}) });

    // Built from the config, not from one binding: the owner's passphrase is
    // whatever `console.tokenEnv` names, and a second operator is a
    // `console.operators` entry naming their own. Asking `env.AMP_CONSOLE_TOKEN`
    // here instead put this gate and the router's on different questions - a
    // licensee who renamed the variable configured their console correctly and
    // then met the setup screen forever, because the two never agreed.
    const operators = runtime.ok ? resolveOperators(runtime.value.config, stringsIn(env)) : [];

    if (!runtime.ok || operators.length === 0) {
      // Whatever is wrong, the links in the posts are not. Serve them from the
      // database directly, with nothing else assembled.
      if (url.pathname.startsWith(REDIRECT_PATH) && env.DB) {
        if (runtime.ok) await runtime.value.close();
        const stores = createSqlRegistry(createD1Driver(env.DB));
        return handleRedirect({ stores, ids: randomIds, clock: systemClock }, url, request);
      }
      if (!runtime.ok) {
        // A config that was written but does not validate is the same situation
        // for the person reading it: they are not running yet, and they need to
        // know which line to fix.
        return setupResponse(request, env, url, token, describeError(runtime.error));
      }
      // The router refuses an empty token on every route, which would leave a
      // licensee staring at 401 with nothing to act on. Name the variable their
      // own config asked for, not the one the example ships with.
      const wanted = runtime.value.config.console.tokenEnv;
      await runtime.value.close();
      return html(
        503,
        renderSetup({
          configured: true,
          problem:
            `承認画面の合言葉が設定されていません。Cloudflare のダッシュボードで ${wanted} を設定してください。` +
            "合言葉が無いと、このアドレスを知っている人が承認画面を開けてしまいます。",
          hasDatabase: Boolean(env.DB),
          hasModelKey: hasModelKey(env),
          hasConsoleToken: false,
          address: url.origin,
        }),
      );
    }

    try {
      return await handleRequest(runtime.value, operators, request);
    } finally {
      await runtime.value.close();
    }
  },

  async scheduled(event: { readonly cron: string; readonly scheduledTime: number }, env: WorkerEnv): Promise<void> {
    if (configSource !== "licensee") return;

    const cycles = event.cron === CYCLE_CRON;
    const name = cycles ? CYCLES_LOCK : DISPATCH_LOCK;

    // A cron can fire while the last one is still running, and can be retried.
    // Two ticks publishing the same due post is the failure this prevents; the
    // two halves take different locks so a long cycle never delays a slot.
    const lock = env.LOCK ? durableObjectLock(env.LOCK as DurableObjectNamespace) : undefined;
    const held = await lock?.acquire(name, { holder: String(event.scheduledTime), ttlMs: TICK_LOCK_TTL_MS });
    if (lock && !held) {
      console.log(JSON.stringify({ level: "info", msg: "tick skipped - the previous one is still running", tick: name }));
      return;
    }

    const runtime = await createWorkerRuntime({ env, configText, prompts, ...(release ? { release } : {}) });
    if (!runtime.ok) {
      console.error(JSON.stringify({ level: "error", msg: "config", error: describeError(runtime.error) }));
      await held?.release();
      return;
    }

    try {
      // A fresh memory every time: an isolate is not a process. What that
      // costs is repeated log lines, not repeated work - the orchestrator keys
      // a cycle on its date and resumes rather than opening a second one.
      await runTick(runtime.value, createTickMemory(), event.scheduledTime, {
        cycles,
        dispatch: !cycles,
      });
    } finally {
      await runtime.value.close();
      await held?.release();
    }
  },
  };
}

/**
 * The query parameter or the cookie the console sets from it - somebody who
 * reached the console once and came back to a broken deploy still has the
 * cookie and not the URL. Only here: the console's own routes do the full
 * thing (header, cookie, constant-time compare), and this page exists before
 * there is a runtime to hand them.
 */
function authorised(request: Request, url: URL, token: string): boolean {
  const supplied = url.searchParams.get("token");
  if (supplied !== null && constantTimeEqual(supplied, token)) return true;
  const cookie = readCookie(request.headers.get("cookie"), "amp_console");
  return cookie !== undefined && constantTimeEqual(cookie, token);
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Only the string entries. The D1 binding and the Durable Object namespace sit
 * on the same object, and a passphrase lookup must never resolve to one.
 */
function stringsIn(env: WorkerEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * The shipped binding name, for the setup screen only.
 *
 * That screen exists before there is a config to read `console.tokenEnv` out
 * of - or when the config does not parse - so the name the deploy button asks
 * for is the only one it can know. Once a config validates, the gate is
 * `resolveOperators`, which asks the config. These must not be swapped.
 */
function readToken(env: WorkerEnv): string | undefined {
  const value = env["AMP_CONSOLE_TOKEN"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function hasModelKey(env: WorkerEnv): boolean {
  const value = env["ANTHROPIC_API_KEY"];
  return typeof value === "string" && value.trim() !== "";
}

function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
