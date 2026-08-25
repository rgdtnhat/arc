import test from "node:test";
import assert from "node:assert/strict";
import { gradeUndelivered, gradeLastPoke } from "../src/health-grade.ts";

/**
 * The two ways `/api/health/protocol` was lying, pinned as a table.
 *
 * Both were live at once on this deployment, and between them they are why a
 * pool frozen for supply and borrow ran for days without the health panel
 * saying anything useful: one check screamed at a healthy fifteen-minute cycle,
 * so the page's overall status was `fail` and `fail` stopped meaning anything;
 * the other slept through a keeper that had been cold for seventeen days.
 */

const ROUND = 15 * 60; // the keeper's default interval, in seconds

test("a healthy cycle between two rounds is not a failure", () => {
  /*
   * The measured numbers. The emitter released and the keeper distributed at
   * 14:31 and again at 14:46 — fifteen minutes apart, exactly as configured —
   * and in between the pending total reached 1,359 TSRA. The old rule
   * (`tokens > 500 → fail`) called that a failure, twice an hour, forever.
   */
  const g = gradeUndelivered({ tokens: 1359.83, sinceDistribute: 8 * 60, roundSeconds: ROUND, canDistribute: true });
  assert.equal(g.status, "ok", g.detail);
});

test("a handle nobody is turning still fails, however small the pile", () => {
  const g = gradeUndelivered({ tokens: 12, sinceDistribute: ROUND * 5, roundSeconds: ROUND, canDistribute: true });
  assert.equal(g.status, "fail");
  assert.match(g.detail, /nobody is turning the handle/);
});

test("one missed round warns rather than failing", () => {
  const g = gradeUndelivered({ tokens: 800, sinceDistribute: ROUND * 3, roundSeconds: ROUND, canDistribute: true });
  assert.equal(g.status, "warn", g.detail);
});

test("nothing waiting is never late", () => {
  const g = gradeUndelivered({ tokens: 0, sinceDistribute: ROUND * 99, roundSeconds: ROUND, canDistribute: true });
  assert.equal(g.status, "ok");
});

test("a server with no key to distribute with says so instead of claiming health", () => {
  // `distribute` is permissionless, so this is not broken — but nothing here
  // will turn it, and "ok" would promise a handle that is not being turned.
  const g = gradeUndelivered({ tokens: 900, sinceDistribute: null, roundSeconds: ROUND, canDistribute: false });
  assert.equal(g.status, "warn");
  assert.match(g.detail, /no key to distribute with/);
});

test("a fresh start gets one interval of grace, not an alarm", () => {
  const g = gradeUndelivered({ tokens: 900, sinceDistribute: null, roundSeconds: ROUND, canDistribute: true });
  assert.equal(g.status, "ok");
  assert.match(g.detail, /no round has run yet/);
});

test("a keeper poked once at genesis is not healthy seventeen days later", () => {
  /*
   * The live reading, exactly: "1 round(s), last 25210 min ago", graded `ok`
   * because the rule only ever looked at `rounds === 0`.
   */
  const now = 1_787_670_000;
  const g = gradeLastPoke({ rounds: 1, lastPokeSec: now - 25_210 * 60, nowSec: now });
  assert.notEqual(g.status, "ok", "a seventeen-day-old poke was filed as healthy");
  assert.equal(g.status, "warn");
  assert.match(g.detail, /17\.5 day/);
});

test("a keeper poked this morning is healthy", () => {
  const now = 1_787_670_000;
  const g = gradeLastPoke({ rounds: 40, lastPokeSec: now - 3600, nowSec: now });
  assert.equal(g.status, "ok");
  assert.match(g.detail, /60 min ago/);
});

test("never poked is a warning about the permissionless path, and says which", () => {
  const now = 1_787_670_000;
  const g = gradeLastPoke({ rounds: 0, lastPokeSec: 0, nowSec: now });
  assert.equal(g.status, "warn");
  assert.match(g.detail, /never poked/);
});

test("a stale poke never escalates to fail — the app's own keeper covers it", () => {
  // `gradeUndelivered` is the check that escalates when tokens are actually
  // stranded. Two checks failing for one cause is how a panel gets ignored.
  const now = 1_787_670_000;
  for (const days of [2, 30, 400]) {
    const g = gradeLastPoke({ rounds: 3, lastPokeSec: now - days * 86_400, nowSec: now });
    assert.equal(g.status, "warn", `${days} days`);
  }
});
