import test from "node:test";
import assert from "node:assert/strict";
import { proRataCap, planClaim, type OwedStream } from "../src/claim-share.js";

/**
 * Rationing a pot that cannot pay everybody.
 *
 * The live failure: one address claimed 15,140 TSRA — the entire pot — while
 * 119,304 had been paid out all time and everyone else's balance stayed
 * accrued. The pot guard then paused the emission, correctly, because the pot
 * was empty again. Repeat until nobody but the first claimant is ever paid.
 */

const T = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const s = (key: string, n: number): OwedStream => ({ key, owed: T(n) });

// --- the cap ----------------------------------------------------------------

test("a pot that covers the debt rations nothing", () => {
  assert.equal(proRataCap(T(100), T(400), T(1000)), T(100));
});

test("a short pot pays the same fraction of the money as you are owed of the debt", () => {
  // 35,092 owed of 119,304 total, against a pot of 15,140 → 29.4% of the pot.
  const cap = proRataCap(T(35_092), T(119_304), T(15_140));
  const pct = Number(cap) / Number(T(15_140));
  assert.ok(pct > 0.29 && pct < 0.30, `expected ~29% of the pot, got ${(pct * 100).toFixed(2)}%`);
});

test("the cap never exceeds what you are owed", () => {
  assert.equal(proRataCap(T(5), T(10), T(1000)), T(5));
});

test("an empty pot caps everyone at nothing", () => {
  assert.equal(proRataCap(T(35_092), T(119_304), 0n), 0n);
});

// --- picking the streams ----------------------------------------------------

test("claims everything when the pot can cover it", () => {
  const plan = planClaim([s("a", 10), s("b", 5)], T(100));
  assert.equal(plan.amount, T(15));
  assert.equal(plan.take.length, 2);
});

test("takes the largest subset that fits inside the share", () => {
  // Cap of 12: the 10 fits, the 5 does not fit beside it, the 2 does.
  const plan = planClaim([s("a", 10), s("b", 5), s("c", 2)], T(12));
  assert.deepEqual(plan.take.map((x) => x.key), ["a", "c"]);
  assert.equal(plan.amount, T(12));
});

test("takes nothing rather than overshooting a share", () => {
  // One stream of 40 against a share of 12. Claiming it would empty the pot
  // out from under everyone else — which is the whole failure being fixed.
  const plan = planClaim([s("a", 40)], T(12));
  assert.deepEqual(plan.take, []);
  assert.match(plan.reason, /more than your share/);
});

test("an empty pot claims nothing and says why", () => {
  const plan = planClaim([s("a", 40)], 0n);
  assert.deepEqual(plan.take, []);
  assert.match(plan.reason, /pot is empty/);
});

test("nothing accrued is not a rationing problem", () => {
  const plan = planClaim([s("a", 0)], T(100));
  assert.equal(plan.amount, 0n);
  assert.match(plan.reason, /nothing has accrued/);
});

test("the plan never exceeds the cap", () => {
  // Property: whatever the mix, the selection fits. A plan that overshot would
  // be worse than no cap, because it would look fair while not being it.
  const streams = [s("a", 7.5), s("b", 3.25), s("c", 11), s("d", 0.5), s("e", 2)];
  for (const capWhole of [0.4, 1, 3, 7.6, 12, 24.25, 30]) {
    const cap = T(capWhole);
    const plan = planClaim(streams, cap);
    assert.ok(plan.amount <= cap, `took ${plan.amount} against a cap of ${cap}`);
  }
});
