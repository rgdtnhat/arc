/**
 * Price impact, and the guard that stops a swap returning almost nothing.
 *
 * The reported symptom was "I swap and receive nothing, only the pool
 * quantities change". That is constant-product working correctly against
 * reserves far smaller than the order — so the fix is not in the curve, it is
 * refusing to execute silently. These pin the measurement and the threshold,
 * because a guard that mis-measures either blocks ordinary trades or waves
 * through the one that empties someone's wallet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { priceImpact, maxInputWithin, IMPACT_MAX_PCT } from "../src/impact.js";

/** Constant product without fees — enough to exercise the measurement. */
const cp = (rIn: bigint, rOut: bigint) => (x: bigint) => (x * rOut) / (rIn + x);

const M = (n: number, d = 6) => BigInt(Math.round(n * 10 ** d));

test("a tiny trade against a deep pool has almost no impact", () => {
  const rIn = M(1_000_000), rOut = M(1_000_000);
  const aIn = M(10);
  const i = priceImpact(rIn, rOut, aIn, cp(rIn, rOut)(aIn), 6, 6);
  assert.ok(i.impactPct < 0.01, `expected negligible impact, got ${i.impactPct}`);
  assert.equal(i.severity, "fine");
  assert.equal(i.reason, "");
});

test("the reported case: a big order against a shallow pool is severe", () => {
  // The live pool: ~11 USDC / ~9 EURC, and a 400-unit order.
  const rIn = M(9.093886), rOut = M(10.999001);
  const aIn = M(400);
  const i = priceImpact(rIn, rOut, aIn, cp(rIn, rOut)(aIn), 6, 6);
  assert.equal(i.severity, "severe");
  assert.ok(i.impactPct > 90, `expected a near-total loss of rate, got ${i.impactPct}%`);
  assert.ok(i.reserveUsedPct > 95, "it drains nearly the whole output reserve");
  assert.match(i.reason, /too shallow/);
});

test("severity thresholds sit where the constants say", () => {
  const rIn = M(1000), rOut = M(1000);
  // Impact for constant product is about aIn/(rIn+aIn); pick sizes around 1%.
  const small = priceImpact(rIn, rOut, M(2), cp(rIn, rOut)(M(2)), 6, 6);
  assert.equal(small.severity, "fine", `0.2% impact should be fine, got ${small.impactPct}`);
  const mid = priceImpact(rIn, rOut, M(50), cp(rIn, rOut)(M(50)), 6, 6);
  assert.equal(mid.severity, "warn", `~4.8% impact should warn, got ${mid.impactPct}`);
  const big = priceImpact(rIn, rOut, M(300), cp(rIn, rOut)(M(300)), 6, 6);
  assert.equal(big.severity, "severe", `~23% impact should be severe, got ${big.impactPct}`);
  assert.ok(big.impactPct >= IMPACT_MAX_PCT);
});

test("impact is measured across differing decimals", () => {
  // cirBTC is 8dp against USDC's 6. Getting this wrong makes every BTC quote
  // look like a 100% impact, which would block every trade in the pair.
  const rIn = BigInt(50_000 * 1e6);        // 50,000 USDC, 6dp
  const rOut = BigInt(Math.round(1 * 1e8)); // 1 cirBTC, 8dp
  const aIn = BigInt(100 * 1e6);            // 100 USDC
  const out = (aIn * rOut) / (rIn + aIn);
  const i = priceImpact(rIn, rOut, aIn, out, 6, 8);
  assert.ok(i.impactPct < 1, `decimals mishandled — got ${i.impactPct}%`);
  assert.ok(i.spotPrice > 0 && i.execPrice > 0);
});

test("an empty or one-sided pool reports nothing rather than dividing by zero", () => {
  assert.equal(priceImpact(0n, M(10), M(1), 0n, 6, 6).impactPct, 0);
  assert.equal(priceImpact(M(10), 0n, M(1), 0n, 6, 6).impactPct, 0);
  assert.equal(priceImpact(M(10), M(10), 0n, 0n, 6, 6).severity, "fine");
});

test("a quote that returns zero registers as total impact, not as fine", () => {
  const rIn = M(10), rOut = M(10);
  const i = priceImpact(rIn, rOut, M(1000), 0n, 6, 6);
  assert.equal(i.severity, "severe");
  assert.equal(i.impactPct, 100);
});

// --- the suggested size -----------------------------------------------------

test("maxInputWithin finds a size that clears the threshold", () => {
  const rIn = M(9.093886), rOut = M(10.999001);
  const q = cp(rIn, rOut);
  const safe = maxInputWithin(q, rIn, rOut, M(400), 6, 6);
  assert.ok(safe > 0n, "there is some tradeable size");
  assert.ok(safe < M(400), "it is smaller than what was asked for");
  const i = priceImpact(rIn, rOut, safe, q(safe), 6, 6);
  assert.ok(i.impactPct <= IMPACT_MAX_PCT + 0.01, `suggestion still over the line at ${i.impactPct}%`);
});

test("maxInputWithin returns the original size when it was already fine", () => {
  const rIn = M(1_000_000), rOut = M(1_000_000);
  const aIn = M(10);
  assert.equal(maxInputWithin(cp(rIn, rOut), rIn, rOut, aIn, 6, 6), aIn);
});

test("the suggestion is the largest size that fits, not an arbitrary fraction", () => {
  const rIn = M(1000), rOut = M(1000);
  const q = cp(rIn, rOut);
  const safe = maxInputWithin(q, rIn, rOut, M(900), 6, 6);
  // One unit more must breach the threshold, or the bisection stopped early.
  const over = priceImpact(rIn, rOut, safe + M(1), q(safe + M(1)), 6, 6);
  assert.ok(over.impactPct > IMPACT_MAX_PCT, "a larger size should exceed the cap");
});
