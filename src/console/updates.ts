/**
 * "Is there a fix I have not taken?", answered without a terminal.
 *
 * A licensee who does not know an update exists is worse off than one who knows
 * and has to click three times: they keep hitting a bug that is already fixed
 * and have no occasion to find out. That is why this is a requirement
 * (`requirements.md` 6) and not a mechanism question - it is satisfiable on
 * every delivery route, needing no git, no credential and no permission, so it
 * does not wait on how updates are *applied*. See
 * `docs/3-development/taking-updates.md`.
 *
 * Three properties this has to keep:
 *
 * - **It can never break the console.** A licensee is looking at this screen to
 *   approve today's posts. Every failure here resolves to "nothing to say".
 * - **It reads the release repository as untrusted text.** It is ours today; a
 *   fork's `upstream` could be anyone's tomorrow, and the answer is rendered on
 *   an authenticated page. Sizes are capped here, escaping is the caller's job.
 * - **It costs one request.** No token, no API - `raw.githubusercontent.com`,
 *   because asking a licensee to make a GitHub token to learn that a fix exists
 *   would put the notice behind exactly the step it exists to remove.
 */

import { changelogUrl, parseReleaseStamp, stampUrl, type ReleaseStamp } from "../core/release.ts";

export type UpdateStatus =
  /**
   * Nothing to say, and the reason, which the console shows to nobody. A
   * development checkout has no stamp; a licensee behind a proxy that blocks
   * GitHub gets `unreachable`. Neither is the licensee's problem to solve.
   */
  | { readonly kind: "unknown"; readonly why: "not-a-release" | "unreachable" }
  | { readonly kind: "current"; readonly version: string }
  | {
      readonly kind: "behind";
      /** What they are running. */
      readonly version: string;
      readonly upstreamVersion: string;
      /** When the newer release was built, ISO 8601. */
      readonly builtAt: string;
      /**
       * The top section of the upstream changelog, which is written for exactly
       * this moment. Plain text, capped; the page escapes it.
       */
      readonly notes: string;
    };

/** Enough for a long release note, far short of a body that could hurt us. */
const MAX_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Reads at most `MAX_BYTES`, and never throws.
 *
 * `AbortSignal.timeout` covers a server that accepts and then goes quiet, which
 * a plain `await fetch` does not: without it a stalled connection would hold
 * the console's request open until the platform gave up on it.
 */
async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/plain" },
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  } catch {
    return undefined;
  }
}

/**
 * The newest entry, as a person would read it.
 *
 * Keep a Changelog puts the newest release first under a `## [x.y.z]` heading,
 * so the first such section is what changed. `## [Unreleased]` is skipped: on
 * the release repository it holds work that is published but not yet numbered,
 * and leading with a heading that says "unreleased" to someone looking at a
 * release they can take would read as a warning it is not meant to be.
 */
export function latestNotes(changelog: string): string {
  const lines = changelog.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!line.startsWith("## ")) continue;
    if (/^##\s*\[?unreleased/i.test(line)) continue;
    start = i;
    break;
  }
  // No numbered section at all - a changelog that is all Unreleased, which is
  // true of this platform before its first tagged release. Better to show the
  // whole preamble than to claim there are no changes.
  if (start === -1) return changelog.trim().slice(0, 4_000);

  const body: string[] = [lines[start] as string];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.startsWith("## ")) break;
    body.push(line);
  }
  return body.join("\n").trim().slice(0, 4_000);
}

/**
 * Compares this copy against what the release repository publishes now.
 *
 * `fetchImpl` is injected for the same reason the clock is: a test that reaches
 * GitHub is a test that fails when GitHub does.
 */
export async function checkForUpdate(
  local: ReleaseStamp | undefined,
  fetchImpl: typeof fetch,
  options: { readonly timeoutMs?: number } = {},
): Promise<UpdateStatus> {
  if (!local) return { kind: "unknown", why: "not-a-release" };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const stampText = await fetchText(fetchImpl, stampUrl(local.upstream), timeoutMs);
  if (stampText === undefined) return { kind: "unknown", why: "unreachable" };

  const upstream = parseReleaseStamp(stampText);
  // Published but unparseable. "Unreachable" rather than "behind": we cannot
  // tell, and telling a licensee to take an update we cannot describe is worse
  // than saying nothing.
  if (!upstream) return { kind: "unknown", why: "unreachable" };

  if (upstream.commit === local.commit) return { kind: "current", version: local.version };

  // Second request only when there is something to describe, so the common case
  // stays one request.
  const changelog = await fetchText(fetchImpl, changelogUrl(local.upstream), timeoutMs);

  return {
    kind: "behind",
    version: local.version,
    upstreamVersion: upstream.version,
    builtAt: upstream.builtAt,
    notes: changelog === undefined ? "" : latestNotes(changelog),
  };
}
