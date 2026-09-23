import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SLOT_MINUTES, planSlots } from "../src/domain/scheduling.ts";
import {
  formatTimeOfDay,
  localDateTime,
  localMinutesOfDay,
  nextLocalTime,
  parseTimeOfDay,
  timezoneName,
} from "../src/core/clock.ts";

const TZ = "Asia/Tokyo";
const NOW = Date.parse("2026-04-01T00:00:00Z"); // 09:00 JST

test("never schedules into the past", () => {
  const plans = planSlots({
    count: 3,
    measured: [],
    fallbackMinutes: DEFAULT_SLOT_MINUTES,
    nowMs: NOW,
    timezone: TZ,
    minGapMinutes: 60,
    occupied: [],
  });
  assert.equal(plans.length, 3);
  for (const plan of plans) assert.ok(plan.at > NOW, `${new Date(plan.at).toISOString()} is not in the future`);
});

test("respects the minimum gap between posts", () => {
  const plans = planSlots({
    count: 3,
    measured: [],
    fallbackMinutes: DEFAULT_SLOT_MINUTES,
    nowMs: NOW,
    timezone: TZ,
    minGapMinutes: 240,
    occupied: [],
  });
  const times = plans.map((plan) => plan.at).sort((a, b) => a - b);
  for (let index = 1; index < times.length; index += 1) {
    const gapMinutes = ((times[index] as number) - (times[index - 1] as number)) / 60_000;
    assert.ok(gapMinutes >= 240, `gap was only ${gapMinutes} minutes`);
  }
});

test("does not collide with posts already scheduled", () => {
  const occupied = nextLocalTime(NOW, parseTimeOfDay("12:15"), TZ);
  const plans = planSlots({
    count: 1,
    measured: [],
    fallbackMinutes: [parseTimeOfDay("12:15"), parseTimeOfDay("21:00")],
    nowMs: NOW,
    timezone: TZ,
    minGapMinutes: 120,
    occupied: [occupied],
  });
  assert.equal(plans.length, 1);
  assert.equal(localMinutesOfDay(plans[0]!.at, TZ), parseTimeOfDay("21:00"));
});

test("prefers measured slots once there is enough evidence", () => {
  const plans = planSlots({
    count: 1,
    measured: [{ minutesOfDay: parseTimeOfDay("22:30"), samples: 4, averageLift: 1.8 }],
    fallbackMinutes: DEFAULT_SLOT_MINUTES,
    nowMs: NOW,
    timezone: TZ,
    minGapMinutes: 60,
    occupied: [],
  });
  assert.equal(localMinutesOfDay(plans[0]!.at, TZ), parseTimeOfDay("22:30"));
  assert.match(plans[0]!.reason, /measured best slot/);
});

test("ignores a 'best slot' backed by a single post", () => {
  const plans = planSlots({
    count: 1,
    measured: [{ minutesOfDay: parseTimeOfDay("03:00"), samples: 1, averageLift: 9 }],
    fallbackMinutes: [parseTimeOfDay("12:15")],
    nowMs: NOW,
    timezone: TZ,
    minGapMinutes: 60,
    occupied: [],
    minSamples: 2,
  });
  assert.equal(localMinutesOfDay(plans[0]!.at, TZ), parseTimeOfDay("12:15"));
  assert.match(plans[0]!.reason, /not enough published posts/);
});

test("rolls into the following day rather than bunching posts together", () => {
  const plans = planSlots({
    count: 4,
    measured: [],
    fallbackMinutes: [parseTimeOfDay("12:15"), parseTimeOfDay("21:00")],
    nowMs: NOW,
    timezone: TZ,
    minGapMinutes: 120,
    occupied: [],
  });
  assert.equal(plans.length, 4);
  const spanDays = (Math.max(...plans.map((p) => p.at)) - Math.min(...plans.map((p) => p.at))) / 86_400_000;
  assert.ok(spanDays >= 1, "four posts into two daily slots must span more than one day");
});

test("honours the lead time so nothing publishes the instant it is approved", () => {
  const plans = planSlots({
    count: 1,
    measured: [],
    // A slot one minute from now must be pushed to tomorrow, not fired at once.
    fallbackMinutes: [(localMinutesOfDay(NOW, TZ) + 1) % 1440],
    nowMs: NOW,
    timezone: TZ,
    minGapMinutes: 60,
    occupied: [],
    leadMinutes: 30,
  });
  assert.ok(plans[0]!.at - NOW >= 30 * 60_000);
});

test("time-of-day helpers round-trip", () => {
  assert.equal(formatTimeOfDay(parseTimeOfDay("07:30")), "07:30");
  assert.equal(formatTimeOfDay(parseTimeOfDay("00:00")), "00:00");
  assert.equal(formatTimeOfDay(parseTimeOfDay("23:59")), "23:59");
  assert.throws(() => parseTimeOfDay("24:00"), /Invalid time-of-day/);
  assert.throws(() => parseTimeOfDay("7:5"), /Invalid time-of-day/);
});

test("nextLocalTime lands on the right wall clock across a DST boundary", () => {
  // New York moves to DST on 2026-03-08 at 02:00 local.
  const before = Date.parse("2026-03-07T12:00:00Z");
  const at = nextLocalTime(before, parseTimeOfDay("09:00"), "America/New_York");
  assert.equal(localMinutesOfDay(at, "America/New_York"), parseTimeOfDay("09:00"));
  assert.ok(at > before);

  const afterSpring = nextLocalTime(Date.parse("2026-03-08T12:00:00Z"), parseTimeOfDay("09:00"), "America/New_York");
  assert.equal(localMinutesOfDay(afterSpring, "America/New_York"), parseTimeOfDay("09:00"));
});

test("an instant reads as the wall clock of whatever zone it is asked for, named", () => {
  // The slot the hand-over card was getting wrong: 22:30 UTC is the next
  // morning in Tokyo and the same evening in New York. The console printed the
  // UTC one to both.
  const slot = Date.parse("2026-09-21T22:30:00Z");
  assert.equal(localDateTime(slot, "Asia/Tokyo"), "2026-09-22 07:30");
  assert.equal(localDateTime(slot, "America/New_York"), "2026-09-21 18:30");
  assert.equal(localDateTime(slot, "UTC"), "2026-09-21 22:30");

  // And says which clock it is, in the language the console is set to.
  assert.equal(timezoneName(slot, "Asia/Tokyo", "ja"), "日本標準時");
  assert.equal(timezoneName(slot, "America/New_York", "en"), "Eastern Daylight Time");

  // Summer time is named as summer time rather than by the zone's winter name -
  // the same instant of the year is the difference between the two.
  const winter = Date.parse("2026-01-15T22:30:00Z");
  assert.equal(timezoneName(winter, "America/New_York", "en"), "Eastern Standard Time");
  assert.equal(localDateTime(winter, "America/New_York"), "2026-01-15 17:30");
});
