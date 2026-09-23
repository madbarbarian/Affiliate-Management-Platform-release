/**
 * Every timestamp the console prints, said in the clock the account keeps - and
 * named, so the reader knows which clock that is.
 *
 * The console printed UTC. Not labelled UTC: sliced out of `toISOString()` and
 * shown as if it were the time. A slot chosen for 07:30 in Tokyo read
 * `2026-09-21 22:30` on the screen of the person who was supposed to post it,
 * and a licensee in New York was handed the same string - so the one screen
 * that tells somebody *when* was wrong for every reader at once.
 *
 * Two rules, and both matter:
 *
 * - **The account's timezone, not the reader's and not the server's.** A slot
 *   is chosen for the hour the readers are awake, so the account's clock is the
 *   one the number means something in. The browser's clock belongs to whoever
 *   opened the page, which is a different question.
 * - **Never without its name.** A bare wall clock is indistinguishable from the
 *   bug this file exists to end. The name comes from Intl, so summer time is
 *   named as summer time and no zone is missing from a table of ours.
 */

import { localDateTime, timezoneName } from "../core/clock.ts";
import { fill, type Locale, type Messages } from "./messages.ts";

export type When = {
  /** An instant as the account reads it: `2026-09-22 07:30（日本標準時）`. */
  at(epochMs: number, timezone: string): string;
  /** The same, from a stored ISO timestamp. Anything unparseable passes through. */
  atIso(iso: string, timezone: string): string;
  /** The zone's name alone, for a screen that says it once above a column. */
  zone(epochMs: number, timezone: string): string;
};

export function createWhen(T: Messages, locale: Locale): When {
  const zone = (epochMs: number, timezone: string): string => timezoneName(epochMs, timezone, locale);
  const at = (epochMs: number, timezone: string): string =>
    localDateTime(epochMs, timezone) + fill(T, "punct.paren", { text: zone(epochMs, timezone) });
  return {
    at,
    // Passed through rather than rejected: `kernel/pause.ts` records `"unknown"`
    // for a stop whose file lost its timestamp, and a screen that printed
    // `NaN-NaN-NaN` there would be less honest than the word it was given.
    atIso: (iso, timezone) => {
      const epochMs = Date.parse(iso);
      return Number.isNaN(epochMs) ? iso : at(epochMs, timezone);
    },
    zone,
  };
}

/**
 * The clock for what belongs to the company rather than to one account: the
 * activity log's company-wide entries, a proposal, a stop of everything.
 *
 * There is no `company.timezone` in the config and this does not invent one.
 * When every account keeps the same clock - which is every licensee with one
 * account, and most with several - that clock is unambiguously the company's.
 * When they disagree there is no honest single answer, so it falls back to UTC,
 * which is at least labelled UTC on the screen rather than passed off as local
 * time. Adding `company.timezone` would settle it; that is a schema change and
 * a licensee-facing decision, not something to slip in here.
 */
export function companyTimezone(ventures: readonly { readonly timezone: string }[]): string {
  const zones = new Set(ventures.map((venture) => venture.timezone));
  return zones.size === 1 ? ([...zones][0] as string) : "UTC";
}
