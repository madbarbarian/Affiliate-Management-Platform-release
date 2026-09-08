/**
 * Identifier generation. Injected like the clock so a cycle replayed in a test
 * produces byte-identical state files.
 */

import { randomUUID, createHash } from "node:crypto";

export type IdGenerator = {
  /** A new opaque id, prefixed for readability in logs and state files. */
  next(prefix: string): string;
};

export const randomIds: IdGenerator = {
  next: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
};

/** Deterministic ids: `${prefix}_000001`, `${prefix}_000002`, ... per prefix. */
export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${String(n).padStart(6, "0")}`;
    },
  };
}

/**
 * A short, stable, URL-safe code derived from arbitrary input. Used for
 * affiliate tracking slugs, where the same post must always map to the same
 * link even if the platform is restarted or re-hosted.
 */
export function stableCode(input: string, length = 10): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789"; // no l/1/0/o
  const digest = createHash("sha256").update(input).digest();
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(digest[i % digest.length] as number) % alphabet.length];
  }
  return out;
}

/** Normalises free text into a slug usable as a config key or filename. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
