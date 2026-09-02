import test from "node:test";
import assert from "node:assert/strict";
import { decideEmissionsGuard, DEFAULT_GUARD, type PotSnapshot } from "../src/emissions-guard.js";

/**
 * Whether an emission is allowed to keep running.
 *
 * The case that matters most is the one where the guard does nothing: an
 * operator who pauses emissions during an incident must not find a keeper
 * turning them back on. Most of what follows checks that inaction, because a
 * guard that only gets the acting half right is a worse thing to own than no
 * guard at all.
 */

const TSRA = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

const snap = (over: Partial<PotSnapshot> = {}): PotSnapshot => ({
  held: TSRA(100_000),
  owed: TSRA(1_000),
  ratePerSecond: TSRA(0.5),
  paused: false,
  pausedByGuard: false,
  ...over,
});

// --- stopping ---------------------------------------------------------------

test("stops the emission when the pot is empty", () => {
  // The state that prompted this: 62,322 TSRA claimable against a pot of zero,
  // with the rate still running and adding to the first number.
  const d = decideEmissionsGuard(snap({ held: 0n, owed: TSRA(62_322) }));
  assert.equal(d.action, "pause");
  assert.match(d.reason, /pot is empty/);
  assert.equal(d.free, 0n);
});

test("stops when the balance is booked to somebody else", () => {
  // Held is large, but every token of it is already owed — the next second of
  // emission creates a claim nothing backs.
  const d = decideEmissionsGuard(snap({ held: TSRA(50_000), owed: TSRA(50_000) }));
  assert.equal(d.action, "pause");
  assert.equal(d.free, 0n);
});

test("stops a tick early rather than a tick late", () => {
  // 600s x 0.5/s = 300 of runway is the floor; 200 free is under it. Booking
  // rewards that cannot be paid is the failure this exists to prevent, and a
  // few seconds of foregone emission is the cheaper error.
  const d = decideEmissionsGuard(snap({ held: TSRA(200), owed: 0n }));
  assert.equal(d.action, "pause");
  assert.match(d.reason, /under 600s/);
});

test("leaves a funded emission running", () => {
  const d = decideEmissionsGuard(snap());
  assert.equal(d.action, "none");
  assert.match(d.reason, /backs the current rates/);
  assert.equal(d.runwaySeconds, 198_000); // 99,000 free at 0.5/s
});

test("does not pause an empty pot that is not emitting anything", () => {
  // Nothing is streaming, so there is no promise to break. Pausing here would
  // be a transaction over every stream that changes nothing.
  const d = decideEmissionsGuard(snap({ held: 0n, owed: 0n, ratePerSecond: 0n }));
  assert.equal(d.action, "none");
  assert.match(d.reason, /nothing to stop/);
  assert.equal(d.runwaySeconds, null);
});

// --- restarting -------------------------------------------------------------

test("never undoes a pause an operator set", () => {
  // The rule the guard cannot break. The pot is full, the rates are fine, and
  // it still does not touch the switch, because somebody else set it.
  const d = decideEmissionsGuard(snap({ paused: true, pausedByGuard: false }));
  assert.equal(d.action, "none");
  assert.match(d.reason, /operator/);
});

test("restarts its own pause once the pot is refilled", () => {
  const d = decideEmissionsGuard(snap({ paused: true, pausedByGuard: true }));
  assert.equal(d.action, "resume");
  assert.match(d.reason, /funded again/);
});

test("a dust refill does not restart the emission", () => {
  // Resuming on anything above zero would pause and resume forever, one
  // transaction over every stream each way.
  const d = decideEmissionsGuard(snap({ held: TSRA(10), owed: 0n, paused: true, pausedByGuard: true }));
  assert.equal(d.action, "none");
  assert.match(d.reason, /not been refilled enough/);
});

test("restarts a guard pause when nothing is streaming", () => {
  // With every rate at zero there is no runway to require, so a funded pot is
  // enough — otherwise the guard's own pause would outlive the reason for it
  // and silently swallow the next rate an operator sets.
  const d = decideEmissionsGuard(snap({ held: TSRA(5), owed: 0n, ratePerSecond: 0n, paused: true, pausedByGuard: true }));
  assert.equal(d.action, "resume");
});

test("stays paused while its own pause is still unfunded", () => {
  const d = decideEmissionsGuard(snap({ held: 0n, owed: TSRA(62_322), paused: true, pausedByGuard: true }));
  assert.equal(d.action, "none");
  assert.equal(d.free, 0n);
});

// --- the settings themselves ------------------------------------------------

test("the resume threshold sits well above the pause threshold", () => {
  // If these ever crossed, the guard would resume into a state it immediately
  // pauses again. The gap is the hysteresis.
  assert.ok(DEFAULT_GUARD.resumeRunwaySeconds > DEFAULT_GUARD.pauseBelowSeconds);
});
