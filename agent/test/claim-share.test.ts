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

test("still claims when no whole stream fits inside the share", () => {
  /*
   * One stream of 40 against a share of 12.
   *
   * This used to take nothing, on the reasoning that claiming would overshoot
   * the share. In practice that locked out everybody whose rewards sit in one
   * large stream — permanently, because the share only shrinks as the debt
   * grows — while somebody owed the same amount across small streams claimed
   * freely. `claim` pays no more than the pot holds and leaves the remainder
   * accrued, so taking the one stream is bounded anyway.
   */
  const plan = planClaim([s("a", 40)], T(12));
  assert.equal(plan.take.length, 1);
  assert.equal(plan.amount, T(40));
});

test("when nothing fits, it takes the smallest stream, not the first", () => {
  // Least overshoot available. `take` must be the 9, not the 30 or the 50.
  const plan = planClaim([s("big", 50), s("small", 9), s("mid", 30)], T(8));
  assert.equal(plan.take.length, 1);
  assert.equal(plan.take[0].key, "small");
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

test("the plan never exceeds the cap by more than one stream", () => {
  /*
   * Property: drop the single stream that overshoots and the rest fits.
   *
   * The overshoot is the deliberate escape hatch — without it a share too
   * small for the one stream that would use it claims almost nothing — and
   * bounding it to *one* stream is what keeps it from becoming "ignore the
   * cap". Nothing beyond that one may exceed the share.
   */
  const streams = [s("a", 7.5), s("b", 3.25), s("c", 11), s("d", 0.5), s("e", 2)];
  for (const capWhole of [0.4, 1, 3, 7.6, 12, 24.25, 30]) {
    const cap = T(capWhole);
    const plan = planClaim(streams, cap);
    if (plan.amount <= cap) continue;
    // One stream, and only one, may be responsible for the overshoot.
    assert.ok(
      plan.take.some((x) => plan.amount - x.owed <= cap),
      `took ${plan.amount} over ${plan.take.length} streams against a cap of ${cap}`,
    );
  }
});

test("uses the share it has rather than only the streams that fit under it", () => {
  /*
   * The live shape that exposed this: one enormous stream and a few small
   * ones, with a share big enough for neither the big one nor much else. The
   * old plan took the small ones and left 97% of the share on the table.
   */
  const plan = planClaim([s("huge", 641_528), s("a", 900), s("b", 600), s("c", 35)], T(62_420));
  assert.ok(plan.take.some((x) => x.key === "huge"), "the stream worth claiming was left behind");
  assert.equal(plan.take.length, 4);
});

test("a pot that covers everything is not rationed at all", () => {
  const streams = [s("a", 7.5), s("b", 3.25)];
  const plan = planClaim(streams, proRataCap(T(10.75), T(10.75), T(1000)));
  assert.equal(plan.take.length, 2);
  assert.equal(plan.amount, T(10.75));
});
