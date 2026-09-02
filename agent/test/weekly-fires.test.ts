import test from "node:test";
import assert from "node:assert/strict";
import { parseSchedule, previousRun, isDue, nextRun, CATCH_UP_MS } from "../src/schedule.ts";

/**
 * Weekly, monthly and yearly schedules never fired. Not once, anywhere.
 *
 * `due()` asked `nextRun(schedule, now) <= now`. For an interval that works,
 * because `nextRun` returns `now` itself for a task that has never run. For
 * anything on a calendar it cannot: `nextRun` returns the first occurrence
 * *strictly after* the instant it is handed, so the test compared a future time
 * against the present and was false forever — while the row in the table showed
 * a next-run time, so the schedule looked configured and alive.
 *
 * Both stores carried their own copy of that test, so both were wrong in the
 * same way and could drift apart once fixed. They share `isDue` now.
 */

const MON_9AM = parseSchedule({ kind: "weekly", days: [1], hour: 9, minute: 0, offsetMinutes: 0 });
const at = (iso: string) => Date.parse(iso);

test("the old test could never be true for a calendar schedule", () => {
  /*
   * The defect itself, pinned. If this ever starts passing, `nextRun` has
   * changed meaning and `previousRun` has to change with it.
   */
  for (const iso of ["2026-08-31T09:00:00Z", "2026-08-31T09:00:30Z", "2026-08-31T15:00:00Z"]) {
    const now = at(iso);
    const next = nextRun(MON_9AM, now, null)!;
    assert.ok(next > now, "nextRun must stay strictly future — the fix depends on it");
  }
});

test("a weekly task fires at its time, and once", () => {
  const created = at("2026-08-24T00:00:00Z");
  // 09:00 on the Monday.
  assert.equal(isDue(MON_9AM, at("2026-08-31T09:00:00Z"), null, created), true);
  // Still due a few minutes later if the tick was late.
  assert.equal(isDue(MON_9AM, at("2026-08-31T09:04:00Z"), null, created), true);
  // Not before it.
  assert.equal(isDue(MON_9AM, at("2026-08-31T08:59:00Z"), null, created), false);
  // Having run, it is not due again the same day.
  const ran = at("2026-08-31T09:00:02Z");
  assert.equal(isDue(MON_9AM, at("2026-08-31T09:05:00Z"), ran, created), false);
  assert.equal(isDue(MON_9AM, at("2026-09-01T09:00:00Z"), ran, created), false);
  // …and is due again the following Monday.
  assert.equal(isDue(MON_9AM, at("2026-09-07T09:00:00Z"), ran, created), true);
});

test("it does not fire for an occurrence from before it existed", () => {
  // Created Tuesday; last Monday's 09:00 is not its to run.
  const created = at("2026-09-01T10:00:00Z");
  assert.equal(isDue(MON_9AM, at("2026-09-01T11:00:00Z"), null, created), false);
});

test("a run missed by hours is caught up; one missed by days is not", () => {
  /*
   * Both directions matter. A scheduler that never catches up silently skips
   * 09:00 because the container restarted at 08:59; one that always does wakes
   * from a week of downtime and fires a week of payments at once.
   */
  const created = at("2026-08-01T00:00:00Z");
  const oneHourLate = at("2026-08-31T10:00:00Z");
  assert.equal(isDue(MON_9AM, oneHourLate, null, created), true);

  const wellPast = at("2026-08-31T09:00:00Z") + CATCH_UP_MS + 60_000;
  assert.equal(isDue(MON_9AM, wellPast, null, created), false, "a stale occurrence fired");
  // And the next one still fires normally.
  assert.equal(isDue(MON_9AM, at("2026-09-07T09:00:00Z"), null, created), true);
});

test("the offset is honoured, so 09:00 GMT+7 is 02:00 UTC", () => {
  const s = parseSchedule({ kind: "weekly", days: [1], hour: 9, minute: 0, offsetMinutes: 420 });
  const created = at("2026-08-01T00:00:00Z");
  assert.equal(isDue(s, at("2026-08-31T02:00:00Z"), null, created), true);
  assert.equal(isDue(s, at("2026-08-31T09:00:00Z"), null, created), false, "fired at UTC 09:00 instead");
});

test("several weekdays each fire", () => {
  const s = parseSchedule({ kind: "weekly", days: [1, 4], hour: 9, minute: 0, offsetMinutes: 0 });
  const created = at("2026-08-01T00:00:00Z");
  const mon = at("2026-08-31T09:00:00Z");
  const thu = at("2026-09-03T09:00:00Z");
  assert.equal(isDue(s, mon, null, created), true);
  assert.equal(isDue(s, thu, mon + 1000, created), true);
  // Wednesday is not one of them.
  assert.equal(isDue(s, at("2026-09-02T09:00:00Z"), mon + 1000, created), false);
});

test("previousRun and nextRun agree about which instants a schedule means", () => {
  /*
   * They apply the same month-length rule — "the 31st" is the last day of a
   * shorter month — and if they disagreed, a monthly task would fire on one
   * date and display another.
   */
  const s = parseSchedule({ kind: "monthly", day: 31, hour: 12, minute: 0, offsetMinutes: 0 });
  // Walk a year of occurrences forward, then back, and require the same set.
  const forward: number[] = [];
  let cursor = at("2026-01-01T00:00:00Z");
  for (let i = 0; i < 12; i++) { cursor = nextRun(s, cursor, null)!; forward.push(cursor); }
  const backward: number[] = [];
  let back = forward[forward.length - 1];
  for (let i = 0; i < 12; i++) { backward.push(back); back = previousRun(s, back - 1)!; }
  assert.deepEqual(backward.reverse(), forward);
});

test("a monthly and a yearly schedule fire at all", () => {
  const created = at("2026-01-01T00:00:00Z");
  const m = parseSchedule({ kind: "monthly", day: 1, hour: 0, minute: 0, offsetMinutes: 0 });
  assert.equal(isDue(m, at("2026-09-01T00:00:00Z"), null, created), true);
  const y = parseSchedule({ kind: "yearly", month: 9, day: 1, hour: 0, minute: 0, offsetMinutes: 0 });
  assert.equal(isDue(y, at("2026-09-01T00:00:00Z"), null, created), true);
});

test("intervals keep working exactly as they did", () => {
  const e = parseSchedule({ kind: "every", seconds: 60 });
  const now = at("2026-08-31T09:00:00Z");
  assert.equal(isDue(e, now, null, 0), true, "a new interval task should run at once");
  assert.equal(isDue(e, now, now - 30_000, 0), false);
  assert.equal(isDue(e, now, now - 61_000, 0), true);
});

test("manual never fires on its own", () => {
  assert.equal(isDue(parseSchedule({ kind: "manual" }), Date.now(), null, 0), false);
  assert.equal(previousRun(parseSchedule({ kind: "manual" }), Date.now()), null);
});
