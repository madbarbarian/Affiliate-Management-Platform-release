/**
 * The environment `llm.provider: external-session` needs, read and checked in
 * one place.
 *
 * Pure: takes the config block and an env map, returns every problem at once.
 * Config validation elsewhere in this repo collects everything before failing
 * ("one run should fix the whole file"); a setup that needs four variables and
 * reports the first missing one sends the person round the loop four times.
 */

import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import type { ExternalSessionConfig } from "../config/schema.ts";

export type ExternalSessionEnv = {
  /** The console's public https base URL. Used to check reachability and to tell the operator what the routine must reach. */
  readonly baseUrl: string;
  /** Bearer token the job routes require. Held here only to prove the routes are open. */
  readonly jobToken: string;
  readonly fireUrl: string;
  readonly routineToken: string;
};

export const EXTERNAL_SESSION_ENV_ERROR_CODE = "llm.external_session_env";

/**
 * Hosts an Anthropic-cloud session cannot reach. A heuristic on the name, not
 * proof of reachability: it catches the example config's `127.0.0.1` and a
 * copied LAN address, which is the mistake people actually make.
 */
export function isPubliclyReachableHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host === "[::1]" || host === "[::]" || host.startsWith("[fe80:") || host.startsWith("[fc") || host.startsWith("[fd")) return false;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets) {
    const first = Number(octets[1]);
    const second = Number(octets[2]);
    if (first === 0 || first === 10 || first === 127) return false;
    if (first === 169 && second === 254) return false;
    if (first === 192 && second === 168) return false;
    if (first === 172 && second >= 16 && second <= 31) return false;
  }
  return true;
}

function urlProblem(name: string, value: string, what: string, requirePublic: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${name} is not a URL (${what}). Write the full address, starting with https://.`;
  }
  if (url.protocol !== "https:") {
    return `${name} must start with https:// (${what}); a token is sent to it.`;
  }
  if (requirePublic && !isPubliclyReachableHost(url.hostname)) {
    return (
      `${name} points at ${url.hostname}, which the routine cannot reach: it runs in Anthropic's cloud and fetches its job over HTTP. ` +
      "Use the address the internet reaches your console at."
    );
  }
  return undefined;
}

/**
 * Names every missing or unusable variable in one error. Cloudflare's fix is
 * given first, for the same reason `llm.no_api_key` does: a licensee there has
 * no `.env.local`.
 */
export function readExternalSessionEnv(
  config: ExternalSessionConfig,
  env: Readonly<Record<string, string | undefined>>,
): Result<ExternalSessionEnv, PlatformError> {
  const problems: string[] = [];
  const read = (name: string, what: string): string | undefined => {
    const value = env[name]?.trim();
    if (value === undefined || value === "") {
      problems.push(`${name} is not set (${what}).`);
      return undefined;
    }
    return value;
  };

  const baseUrl = read(config.baseUrlEnv, "the console's public https address, e.g. https://amp.example.workers.dev");
  const jobToken = read(config.tokenEnv, "the bearer token the routine sends to the job routes");
  const fireUrl = read(config.fireUrlEnv, "the routine's /fire URL, from its API trigger");
  const routineToken = read(config.routineTokenEnv, "the routine's own trigger token, shown once when the API trigger was added");

  if (baseUrl !== undefined) {
    const problem = urlProblem(config.baseUrlEnv, baseUrl, "the console's public address", true);
    if (problem) problems.push(problem);
  }
  if (fireUrl !== undefined) {
    const problem = urlProblem(config.fireUrlEnv, fireUrl, "the routine's /fire URL", false);
    if (problem) problems.push(problem);
  }

  if (problems.length > 0 || baseUrl === undefined || jobToken === undefined || fireUrl === undefined || routineToken === undefined) {
    return fail(
      "config",
      EXTERNAL_SESSION_ENV_ERROR_CODE,
      `llm.provider is "external-session" but its environment is not usable:\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        "\nOn Cloudflare: Workers & Pages -> this Worker -> Settings -> Variables and Secrets -> Add (type Secret for the two tokens). " +
        `On your own machine: put them in .env.local. Or set llm.provider to "anthropic" or "mock".`,
    );
  }
  return ok({ baseUrl, jobToken, fireUrl, routineToken });
}
