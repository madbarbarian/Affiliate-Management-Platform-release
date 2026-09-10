/**
 * The approval console.
 *
 * Two jobs, and it should be judged on both: let a person approve and order in
 * under a minute from a phone, and serve the tracking redirect so clicks are
 * actually counted.
 *
 * Auth is a bearer token. Bound to loopback with no token configured, one is
 * generated at startup and printed in the URL - secure by default without
 * making a local run a chore. Bound to anything else, a token is mandatory and
 * the server refuses to start without it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import type { Runtime } from "../runtime.ts";
import { handleRequest, MAX_BODY_BYTES } from "./router.ts";
import { operatorsWithoutTokens, resolveOperators, type Operator } from "./operators.ts";

export type ConsoleHandle = {
  readonly url: string;
  readonly token: string;
  readonly server: Server;
  close(): Promise<void>;
};

export async function startConsole(runtime: Runtime): Promise<Result<ConsoleHandle, PlatformError>> {
  const { config } = runtime;
  const loopback = config.console.host === "127.0.0.1" || config.console.host === "::1" || config.console.host === "localhost";
  // `|| undefined`, not `??`. The shipped `.env.local.sample` contains a bare
  // `AMP_CONSOLE_TOKEN=`, which `load.ts` turns into the empty string - and `??`
  // only falls back on null/undefined, so the server ran with "" as its secret.
  // `timingSafeEqual` on two zero-length buffers returns true, so the header
  // `Cookie: amp_console=` then authenticated every route, including the POST
  // that approves and publishes. A blank token now means no token, and no token
  // means one is generated.
  const configured = process.env[config.console.tokenEnv]?.trim() || undefined;

  if (!configured && !loopback) {
    return fail(
      "config",
      "console.no_token",
      `The console is bound to ${config.console.host}, which is reachable from outside this machine, ` +
        `so ${config.console.tokenEnv} must be set. Generate one with:\n` +
        `  node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"`,
    );
  }

  const token = configured ?? randomBytes(24).toString("hex");
  // The owner first, then anyone else `console.operators` names. The generated
  // token stands in for the owner's when none is set, so a local run is
  // unchanged - and still records the owner's name rather than "console".
  const operators: Operator[] = [
    { name: config.company.operator, token },
    ...resolveOperators(config, process.env).filter((entry) => entry.name !== config.company.operator),
  ];

  // A listed operator with no passphrase set cannot get in, and the only
  // symptom is that theirs "does not work". Named here, once, at startup.
  const missing = operatorsWithoutTokens(config, process.env);
  if (missing.length > 0) {
    runtime.services.logger.warn(
      `${missing.length} operator(s) in console.operators have no passphrase set, so they cannot open the console. ` +
        `Set ${missing.map((entry) => entry.tokenEnv).join(", ")} in .env.local.`,
      { operators: missing.map((entry) => entry.name) },
    );
  }

  // The documented deployment puts a public domain in front of a loopback bind
  // so `/go/<code>` resolves for readers (docs/2-setup/licensee-guide.md). That
  // makes "bound to loopback" a poor proxy for "not reachable", so say so when
  // the redirect is public and the token is one we invented: it changes on
  // every restart, and the operator needs to know the console went out with it.
  if (configured === undefined && isPubliclyRouted(config.tracking.baseUrl)) {
    runtime.services.logger.warn(
      `${config.console.tokenEnv} is not set, so a new console token was generated. ` +
        `tracking.baseUrl points at a public host, so anything in front of this daemon ` +
        `exposes the console too. Set ${config.console.tokenEnv} in .env.local to a value that ` +
        `survives a restart.`,
      { host: config.console.host, port: config.console.port },
    );
  }
  const server = createServer((request, response) => {
    serve(runtime, operators, request, response).catch((cause) => {
      runtime.services.logger.error("console request failed", {
        url: request.url,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "internal error" }));
      }
    });
  });

  const listening = await new Promise<Result<void, PlatformError>>((resolve) => {
    server.once("error", (cause: NodeJS.ErrnoException) => {
      resolve(
        cause.code === "EADDRINUSE"
          ? fail("config", "console.port_in_use", `Port ${config.console.port} is already in use.`, { cause })
          : fail("internal", "console.listen_failed", cause.message, { cause }),
      );
    });
    server.listen(config.console.port, config.console.host, () => resolve(ok(undefined)));
  });
  if (!listening.ok) return listening;

  const host = config.console.host === "::1" ? "[::1]" : config.console.host;
  return ok({
    url: `http://${host}:${config.console.port}/?token=${token}`,
    token,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

// ---------------------------------------------------------------------------
// node:http adapter
// ---------------------------------------------------------------------------

/**
 * Turns a Node request into a `Request`, asks the router, and writes the
 * `Response` back out. Everything the console decides lives in `router.ts`;
 * this file only knows how to speak to a socket.
 */
async function serve(runtime: Runtime, operators: readonly Operator[], incoming: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
  }

  const method = incoming.method ?? "GET";
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const read = await readBody(incoming);
    if (!read.ok) {
      response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: read.error.message }));
      return;
    }
    body = read.value;
  }

  const result = await handleRequest(runtime, operators, new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }));

  const out: Record<string, string | string[]> = {};
  for (const [name, value] of result.headers) {
    // Only `set-cookie` can legitimately repeat, and `Headers` joins repeats
    // with ", " - which a browser reads as one malformed cookie.
    out[name] = name === "set-cookie" ? result.headers.getSetCookie() : value;
  }
  response.writeHead(result.status, out);
  const text = await result.text();
  response.end(text === "" ? undefined : text);
}

/** The body cap is enforced here too: a Worker never sees an oversized stream. */
async function readBody(incoming: IncomingMessage): Promise<Result<string, PlatformError>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return fail("validation", "console.body_too_large", "Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  return ok(Buffer.concat(chunks).toString("utf8"));
}

/** True when a URL names a host a stranger could resolve. */
function isPubliclyRouted(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return !(
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".invalid") ||
      host.endsWith(".local") ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

