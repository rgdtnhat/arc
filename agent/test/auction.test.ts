import test from "node:test";
import assert from "node:assert/strict";
import {
  auctionTerms,
  fillPreview,
  healthAfterFullFill,
  lotValueFor,
  AUCTION_HALF_LIFE,
  AUCTION_DURATION,
  MIN_BID_BPS,
  HF_TARGET_MIN,
  HF_TARGET_MAX,
} from "../src/auction.ts";

const U = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

test("the auction opens at terms nobody would take", () => {
  // Full debt demanded, no collateral offered. That is the point: a liquidator
  // who filled here would be donating, so the price has to be discovered.
  const t = auctionTerms(0);
  assert.equal(t.lotBps, 0);
  assert.equal(t.bidBps, 10_000);
});

test("the lot ramps up over the first half", () => {
  assert.equal(auctionTerms(AUCTION_HALF_LIFE / 2).lotBps, 5_000);
  assert.equal(auctionTerms(AUCTION_HALF_LIFE / 4).lotBps, 2_500);
  // The bid stays full for the whole first half.
  for (const t of [1, 100, AUCTION_HALF_LIFE - 1, AUCTION_HALF_LIFE]) {
    assert.equal(auctionTerms(t).bidBps, 10_000, `bid at ${t}s`);
  }
});

test("the midpoint is the fair exchange", () => {
  const t = auctionTerms(AUCTION_HALF_LIFE);
  assert.equal(t.lotBps, 10_000);
  assert.equal(t.bidBps, 10_000);
});

test("the bid decays over the second half but never reaches zero", () => {
  const mid = auctionTerms(AUCTION_HALF_LIFE + AUCTION_HALF_LIFE / 2);
  assert.equal(mid.lotBps, 10_000);
  assert.ok(mid.bidBps < 10_000 && mid.bidBps > MIN_BID_BPS, `got ${mid.bidBps}`);

  // A zero bid would let a late filler take the whole lot while removing no
  // debt at all — a griefing vector rather than price discovery.
  assert.equal(auctionTerms(AUCTION_DURATION).bidBps, MIN_BID_BPS);
  assert.equal(auctionTerms(AUCTION_DURATION * 10).bidBps, MIN_BID_BPS);
  assert.equal(auctionTerms(86_400).bidBps, MIN_BID_BPS);
});

test("terms are monotonic: waiting never makes the trade worse for a filler", () => {
  let lastLot = -1;
  let lastBid = 10_001;
  for (let t = 0; t <= AUCTION_DURATION + 60; t += 7) {
    const { lotBps, bidBps } = auctionTerms(t);
    assert.ok(lotBps >= lastLot, `lot fell at ${t}s`);
    assert.ok(bidBps <= lastBid, `bid rose at ${t}s`);
    lastLot = lotBps;
    lastBid = bidBps;
  }
});

test("a negative or fractional elapsed time is clamped, not extrapolated", () => {
  assert.equal(auctionTerms(-500).lotBps, 0);
  assert.equal(auctionTerms(-500).bidBps, 10_000);
  assert.deepEqual(auctionTerms(300.9), auctionTerms(300));
});

test("a fill preview is a share of what remains, not of the original", () => {
  const terms = auctionTerms(AUCTION_HALF_LIFE); // fair midpoint
  const debt = U("1000");
  const lot = U("1100");

  const whole = fillPreview(debt, lot, 0, 10_000, terms);
  assert.equal(whole.repay, debt);
  assert.equal(whole.seize, lot);

  // 60% is already gone. Asking for "100%" takes the last 40%, not the whole
  // auction again — quoting the latter would tell a liquidator they owe more
  // than twice what they actually will.
  const rest = fillPreview(debt, lot, 6_000, 10_000, terms);
  assert.equal(rest.repay, (debt * 4_000n) / 10_000n);
  assert.equal(rest.seize, (lot * 4_000n) / 10_000n);
});

test("an early fill pays the full debt for part of the lot", () => {
  const terms = auctionTerms(AUCTION_HALF_LIFE / 2); // lot 50%, bid 100%
  const { repay, seize } = fillPreview(U("1000"), U("1100"), 0, 10_000, terms);
  assert.equal(repay, U("1000"));
  assert.equal(seize, U("550"));
});

test("a late fill takes the whole lot for a fraction of the debt", () => {
  const terms = auctionTerms(AUCTION_DURATION);
  const { repay, seize } = fillPreview(U("1000"), U("1100"), 0, 10_000, terms);
  assert.equal(seize, U("1100"));
  assert.equal(repay, (U("1000") * BigInt(MIN_BID_BPS)) / 10_000n);
  // Still removes debt, which is what the floor is for.
  assert.ok(repay > 0n);
});

test("a zero or exhausted fill previews nothing", () => {
  const terms = auctionTerms(AUCTION_HALF_LIFE);
  assert.deepEqual(fillPreview(U("1000"), U("1100"), 0, 0, terms), { repay: 0n, seize: 0n });
  assert.deepEqual(fillPreview(U("1000"), U("1100"), 10_000, 5_000, terms), { repay: 0n, seize: 0n });
});

/**
 * The band check, on the same position the contract tests use: 1 cirBTC marked
 * down to $22,000 backing an 18,000 USDC debt, liqFactor 80%, lFactor 95%.
 */
const POSITION = {
  liquidationLimit: 17_600n * 10n ** 8n,
  liability: (18_000n * 10n ** 8n * 10_000n) / 9_500n,
  collateralLiqFactorBps: 8_000n,
  debtLFactorBps: 9_500n,
};

function bandAt(fractionBps: bigint) {
  const debtValue = (18_000n * 10n ** 8n * fractionBps) / 10_000n;
  return healthAfterFullFill({ ...POSITION, debtValue, lotValue: lotValueFor(debtValue) });
}

test("too small a liquidation leaves the borrower still liquidatable", () => {
  // Clearing 1% of an underwater position barely moves it: the borrower gets
  // seized again on the next tick of interest for one episode of distress.
  const r = bandAt(100n);
  assert.equal(r.inBand, false);
  assert.ok(r.healthFactor !== null && r.healthFactor < HF_TARGET_MIN);
});

test("too large a liquidation overshoots the ceiling", () => {
  // 75% lands the borrower well above 1.15 — more collateral sold than the
  // problem required.
  const r = bandAt(7_500n);
  assert.equal(r.inBand, false);
  assert.ok(r.healthFactor !== null && r.healthFactor > HF_TARGET_MAX);
});

test("a percentage inside the band is accepted", () => {
  const r = bandAt(7_000n);
  assert.equal(r.inBand, true);
  assert.ok(r.healthFactor !== null);
  assert.ok(r.healthFactor >= HF_TARGET_MIN && r.healthFactor <= HF_TARGET_MAX);
});

test("clearing the whole debt is always in band", () => {
  // There is no residual position for the ceiling to protect, so a full clear
  // is the best available outcome rather than an over-liquidation.
  const r = bandAt(10_000n);
  assert.equal(r.inBand, true);
  assert.equal(r.healthFactor, null);
});

test("the band has a workable percentage somewhere in it", () => {
  // The rule is only usable if a liquidator can actually satisfy it. Sweep the
  // range the UI offers and assert at least one percentage lands inside.
  const ok: number[] = [];
  for (let pct = 100; pct <= 10_000; pct += 100) {
    if (bandAt(BigInt(pct)).inBand) ok.push(pct);
  }
  assert.ok(ok.length > 0, "no percentage satisfied the band");
  // And that the acceptable range is contiguous, so "raise it a bit" is sound
  // advice rather than a guess.
  const withoutFullClear = ok.filter((p) => p < 10_000);
  for (let i = 1; i < withoutFullClear.length; i++) {
    assert.equal(withoutFullClear[i]! - withoutFullClear[i - 1]!, 100, "the band is not contiguous");
  }
});

test("a lot is the debt plus the liquidation bonus", () => {
  assert.equal(lotValueFor(10_000n), 11_000n);
  assert.equal(lotValueFor(0n), 0n);
});
