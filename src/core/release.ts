/**
 * What copy of the platform is this, and where did it come from.
 *
 * A licensee cannot answer "is there a fix I have not taken?" without two
 * things: what they are running, and where to look for what is current. Neither
 * is knowable from the code itself. The copy the Deploy button makes shares no
 * git history with the platform, so its commits say nothing about the upstream
 * it came from, and `package.json`'s version moves once a release, not once a
 * fix.
 *
 * So the release build stamps it. `scripts/make-release.ts` already writes
 * `RELEASE.json` - the manifest of what a licensee received - and the identity
 * belongs in the same file rather than a second one beside it. Nothing writes
 * it in this repository, and its absence is the honest answer for a development
 * checkout: this copy was not released, so there is nothing to compare it
 * against.
 *
 * Reading is deliberately forgiving. This is a file in the licensee's own
 * repository, and they may edit, truncate or delete it. A broken stamp must
 * cost them the update notice and nothing else - never a console that will not
 * open.
 */

export type ReleaseStamp = {
  /** The platform version this copy was cut from. */
  readonly version: string;
  /** Short commit of the platform at the moment the release was built. */
  readonly commit: string;
  /** When the release was built, ISO 8601. */
  readonly builtAt: string;
  /** `owner/repo` of the public release repository this copy came from. */
  readonly upstream: string;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Reads the identity out of `RELEASE.json`, ignoring the file manifest beside
 * it. Returns undefined for anything it cannot fully trust.
 *
 * All four fields are required together: a stamp missing `upstream` cannot be
 * compared against anything, and one missing `commit` would report every fetch
 * as a difference. Half a stamp is worse than none, because none is silent and
 * half is wrong.
 */
export function parseReleaseStamp(source: string): ReleaseStamp | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = parsed as Record<string, unknown>;

  const version = text(raw["version"]);
  const commit = text(raw["commit"]);
  const builtAt = text(raw["builtAt"]);
  const upstream = text(raw["upstream"]);
  if (!version || !commit || !builtAt || !upstream) return undefined;

  // A release built without git writes this rather than a commit. Treating it
  // as an identity would make every comparison a difference, so a copy that
  // cannot say what it is says nothing - the notice stays quiet instead of
  // telling a licensee they are out of date forever.
  if (commit === "unknown") return undefined;

  // `owner/repo`, and nothing else. This value is interpolated into the URL the
  // Worker fetches, so a stamp someone edited must not be able to point that
  // fetch at another host or walk out of the repository path.
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(upstream)) return undefined;

  return { version, commit, builtAt, upstream };
}

/** Where the current release's own stamp is published. Raw, so no API token. */
export function stampUrl(upstream: string): string {
  return `https://raw.githubusercontent.com/${upstream}/main/RELEASE.json`;
}

/** Where the changelog is published, for "what actually changed". */
export function changelogUrl(upstream: string): string {
  return `https://raw.githubusercontent.com/${upstream}/main/CHANGELOG.md`;
}
