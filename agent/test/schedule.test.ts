import test from "node:test";
import assert from "node:assert/strict";
import { nextRun, parseSchedule, describeSchedule, SCHEDULE_LIMITS, type Schedule } from "../src/schedule.js";

/**
 * When an unattended task fires.
 *
 * This is the arithmetic behind something that will move money at 3am with
 * nobody watching, so it is checked against a table rather than against a week
 * of waiting. The cases that matter most are the ones where it must *not* fire:
 * a manual task, a schedule with no day chosen, and a server that has been down
 * for a day and must not wake up and run twenty-four times to catch up.
 */

const iso = (s: string) => Date.parse(s);
const at = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

// --- intervals --------------------------------------------------------------

test("a task that has never run is due immediately", () => {
  // "Every hour" starting an hour from now is not what anybody means when they
  // press Save.
  const now = iso("2026-08-12T10:00:00Z");
  assert.equal(nextRun({ kind: "every", seconds: 3600 }, now, null), now);
});

test("an interval measures from the last run", () => {
  const now = iso("2026-08-12T10:00:00Z");
  const last = iso("2026-08-12T09:30:00Z");
  assert.equal(at(nextRun({ kind: "every", seconds: 3600 }, now, last)), "2026-08-12T10:30:00.000Z");
});

test("a missed interval fires once, not once per interval slept through", () => {
  // Down for a day on an hourly task. Twenty-four catch-up transactions is a
  // far worse failure than one late one.
  const now = iso("2026-08-12T10:00:00Z");
  const last = iso("2026-08-11T10:00:00Z");
  assert.equal(nextRun({ kind: "every", seconds: 3600 }, now, last), now);
});

test("an interval below the floor is raised to it", () => {
  const s = parseSchedule({ kind: "every", seconds: 1 });
  assert.deepEqual(s, { kind: "every", seconds: SCHEDULE_LIMITS.minSeconds });
});

test("an interval the runner can keep is kept exactly", () => {
  /*
   * The floor used to sit at 15 — the runner's tick interval, standing in for
   * a guardrail. "Every 10 seconds" was silently rounded up and the row came
   * back reading "every 15 seconds" with nothing to say why. The runner now
   * ticks at the floor, so anything at or above it survives untouched.
   */
  for (const seconds of [5, 10, 30, 90]) {
    assert.deepEqual(parseSchedule({ kind: "every", seconds }), { kind: "every", seconds });
  }
});

test("the floor is one the runner can actually keep", () => {
  // If these ever disagree, a schedule is being promised at a cadence nothing
  // is awake often enough to deliver — which is the bug this pair replaced.
  assert.ok(SCHEDULE_LIMITS.minSeconds >= 1, "a floor below a second is a loop");
  assert.equal(describeSchedule({ kind: "every", seconds: 10 }), "every 10 seconds");
});

// --- weekly, in a stated offset ---------------------------------------------

test("fires at the wall time in the offset it was set in", () => {
  // 09:00 GMT+7 on Mondays is 02:00 UTC.
  const s: Schedule = { kind: "weekly", days: [1], hour: 9, minute: 0, offsetMinutes: 420 };
  assert.equal(at(nextRun(s, iso("2026-08-12T00:00:00Z"))), "2026-08-17T02:00:00.000Z");
});

test("later today counts as next", () => {
  // Wednesday 12 August 2026, 00:00 UTC = 07:00 GMT+7, before a 09:00 slot.
  const s: Schedule = { kind: "weekly", days: [3], hour: 9, minute: 0, offsetMinutes: 420 };
  assert.equal(at(nextRun(s, iso("2026-08-12T00:00:00Z"))), "2026-08-12T02:00:00.000Z");
});

test("a slot that has already passed today rolls to the next chosen day", () => {
  const s: Schedule = { kind: "weekly", days: [3, 5], hour: 9, minute: 0, offsetMinutes: 420 };
  // 03:00 UTC = 10:00 GMT+7 Wednesday: today's slot is gone, Friday is next.
  assert.equal(at(nextRun(s, iso("2026-08-12T03:00:00Z"))), "2026-08-14T02:00:00.000Z");
});

test("a negative offset is honoured as typed", () => {
  // 17:00 GMT-05:00 on Fridays is 22:00 UTC.
  const s: Schedule = { kind: "weekly", days: [5], hour: 17, minute: 0, offsetMinutes: -300 };
  assert.equal(at(nextRun(s, iso("2026-08-12T00:00:00Z"))), "2026-08-14T22:00:00.000Z");
});

test("no weekday chosen is an unfinished form, not every day", () => {
  const s = parseSchedule({ kind: "weekly", days: [], hour: 9 });
  assert.deepEqual(s, { kind: "manual" });
  assert.equal(nextRun(s, Date.now()), null);
});

// --- monthly and yearly -----------------------------------------------------

test("the 31st fires on the last day of a shorter month", () => {
  // A monthly task must fire twelve times a year, not seven.
  const s: Schedule = { kind: "monthly", day: 31, hour: 12, minute: 0, offsetMinutes: 0 };
  assert.equal(at(nextRun(s, iso("2026-09-15T00:00:00Z"))), "2026-09-30T12:00:00.000Z");
});

test("monthly rolls into the next month once the day has passed", () => {
  const s: Schedule = { kind: "monthly", day: 1, hour: 0, minute: 30, offsetMinutes: 0 };
  assert.equal(at(nextRun(s, iso("2026-08-12T00:00:00Z"))), "2026-09-01T00:30:00.000Z");
});

test("yearly rolls into next year", () => {
  const s: Schedule = { kind: "yearly", month: 3, day: 1, hour: 8, minute: 0, offsetMinutes: 0 };
  assert.equal(at(nextRun(s, iso("2026-08-12T00:00:00Z"))), "2027-03-01T08:00:00.000Z");
});

test("29 February lands on the 28th in a common year", () => {
  const s: Schedule = { kind: "yearly", month: 2, day: 29, hour: 0, minute: 0, offsetMinutes: 0 };
  assert.equal(at(nextRun(s, iso("2026-08-12T00:00:00Z"))), "2027-02-28T00:00:00.000Z");
});

// --- refusing to guess ------------------------------------------------------

test("an unrecognisable schedule is manual, never a fast loop", () => {
  for (const bad of [undefined, null, {}, { kind: "hourly" }, { kind: 42 }, "every second"]) {
    assert.deepEqual(parseSchedule(bad), { kind: "manual" }, `for ${JSON.stringify(bad)}`);
  }
});

test("an out-of-range offset is clamped rather than believed", () => {
  const s = parseSchedule({ kind: "weekly", days: [1], hour: 9, offsetMinutes: 99_999 });
  assert.equal((s as { offsetMinutes: number }).offsetMinutes, SCHEDULE_LIMITS.maxOffsetMinutes);
});

test("a manual schedule never produces a time", () => {
  assert.equal(nextRun({ kind: "manual" }, Date.now(), Date.now() - 1e9), null);
});

// --- what the operator reads ------------------------------------------------

test("describes itself in the words it was set in", () => {
  assert.equal(describeSchedule({ kind: "every", seconds: 3600 }), "every hour");
  assert.equal(describeSchedule({ kind: "every", seconds: 7200 }), "every 2 hours");
  assert.equal(describeSchedule({ kind: "every", seconds: 45 }), "every 45 seconds");
  assert.equal(
    describeSchedule({ kind: "weekly", days: [1, 4], hour: 9, minute: 5, offsetMinutes: 420 }),
    "Monday, Thursday at 09:05 GMT+07:00",
  );
  assert.equal(
    describeSchedule({ kind: "monthly", day: 1, hour: 0, minute: 0, offsetMinutes: -300 }),
    "day 1 of each month at 00:00 GMT-05:00",
  );
  assert.equal(describeSchedule({ kind: "manual" }), "only when you run it");
});
