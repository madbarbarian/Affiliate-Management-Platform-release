/**
 * Time is injected everywhere so cycles are reproducible in tests and so a
 * licensee's schedule can be evaluated in their own timezone rather than the
 * server's.
 */

export type Clock = {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Current instant as an ISO-8601 string in UTC. */
  nowIso(): string;
  sleep(ms: number): Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A clock that only moves when the test tells it to. */
export function fixedClock(startIso: string): Clock & { advance(ms: number): void; set(iso: string): void } {
  let current = Date.parse(startIso);
  if (Number.isNaN(current)) throw new Error(`fixedClock: invalid ISO timestamp "${startIso}"`);
  return {
    now: () => current,
    nowIso: () => new Date(current).toISOString(),
    sleep: async () => {},
    advance: (ms: number) => {
      current += ms;
    },
    set: (iso: string) => {
      const parsed = Date.parse(iso);
      if (Number.isNaN(parsed)) throw new Error(`fixedClock.set: invalid ISO timestamp "${iso}"`);
      current = parsed;
    },
  };
}

const MINUTES_PER_HOUR = 60;

/**
 * Formats an instant as wall-clock parts in an IANA timezone.
 * Uses Intl so we do not ship a timezone database of our own.
 */
export function zonedParts(
  epochMs: number,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = new Map(formatter.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    hour: Number(parts.get("hour")),
    minute: Number(parts.get("minute")),
    weekday: Math.max(0, weekdayNames.indexOf(parts.get("weekday") ?? "Sun")),
  };
}

/** The local calendar date in `timezone`, as YYYY-MM-DD. */
export function localDate(epochMs: number, timezone: string): string {
  const { year, month, day } = zonedParts(epochMs, timezone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Minutes since local midnight in `timezone`. */
export function localMinutesOfDay(epochMs: number, timezone: string): number {
  const { hour, minute } = zonedParts(epochMs, timezone);
  return hour * MINUTES_PER_HOUR + minute;
}

/** Parses "HH:MM" into minutes since midnight. Throws on malformed input. */
export function parseTimeOfDay(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid time-of-day "${value}", expected HH:MM (24h)`);
  return Number(match[1]) * MINUTES_PER_HOUR + Number(match[2]);
}

export function formatTimeOfDay(minutesOfDay: number): string {
  const normalized = ((minutesOfDay % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / MINUTES_PER_HOUR);
  const minute = normalized % MINUTES_PER_HOUR;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Resolves "the next instant at `minutesOfDay` local time in `timezone`,
 * strictly after `afterMs`". Handles DST by probing candidate instants and
 * checking what the wall clock actually reads.
 */
export function nextLocalTime(afterMs: number, minutesOfDay: number, timezone: string): number {
  const DAY_MS = 86_400_000;
  const MINUTE_MS = 60_000;
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const probe = afterMs + dayOffset * DAY_MS;
    const parts = zonedParts(probe, timezone);
    const probeMinutes = parts.hour * MINUTES_PER_HOUR + parts.minute;
    // Move the probe to the target wall-clock minute on the probe's local day.
    let candidate = probe + (minutesOfDay - probeMinutes) * MINUTE_MS;
    // Correct for offset shifts introduced by the move itself (DST edges).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const actual = localMinutesOfDay(candidate, timezone);
      const drift = minutesOfDay - actual;
      if (drift === 0) break;
      candidate += drift * MINUTE_MS;
    }
    if (candidate > afterMs) return candidate;
  }
  return afterMs + DAY_MS;
}

/**
 * An instant as the wall clock reads it in `timezone`: `YYYY-MM-DD HH:MM`.
 *
 * The console used to slice this out of `toISOString()`, which is the wall
 * clock in UTC and therefore nobody's: a Tokyo account's 07:30 slot was shown
 * to every reader as the previous day's 22:30, and an operator in New York was
 * told the same wrong thing as an operator in Tokyo. Built from `zonedParts`
 * rather than by adding an offset, because an offset is a guess that is wrong
 * twice a year.
 */
export function localDateTime(epochMs: number, timezone: string): string {
  return `${localDate(epochMs, timezone)} ${formatTimeOfDay(localMinutesOfDay(epochMs, timezone))}`;
}

/**
 * What `timezone` is called at `epochMs`, in `locale`: 日本標準時,
 * アメリカ東部夏時間, Eastern Daylight Time.
 *
 * From Intl rather than a table of our own, so every IANA zone has a name and a
 * zone on summer time says so. A time printed without one is a time the reader
 * has to guess at, and the guess is wrong for everyone who is not standing
 * where the account is.
 */
export function timezoneName(epochMs: number, timezone: string, locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: "long" }).formatToParts(
    new Date(epochMs),
  );
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timezone;
}
