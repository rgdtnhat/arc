import test from "node:test";
import assert from "node:assert/strict";
import {
  rankOpportunities,
  actionable,
  badDebt,
  LIQUIDATION_THRESHOLD_WAD,
  type LiquidatablePosition,
} from "../src/liquidatable.ts";
import { AUCTION_DURATION, AUCTION_HALF_LIFE } from "../src/auction.ts";

const USD = (n: number) => BigInt(Math.round(n * 1e8));

const pos = (o: Partial<LiquidatablePosition> = {}): LiquidatablePosition => ({
  user: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  healthWad: 900_000_000_000_000_000n, // 0.9
  debtUsd: USD(1_000),
  collateralUsd: USD(1_050),
  auctionElapsed: null,
  ...o,
});

test("excludes healthy positions entirely", () => {
  assert.deepEqual(rankOpportunities([pos({ healthWad: LIQUIDATION_THRESHOLD_WAD })]), []);
  assert.deepEqual(rankOpportunities([pos({ healthWad: 2_000_000_000_000_000_000n })]), []);
});

test("excludes an account with no debt", () => {
  assert.deepEqual(rankOpportunities([pos({ healthWad: 0n })]), []);
});

test("says plainly that opening an auction pays nothing by itself", () => {
  // A keeper expecting a reward for the opening call would otherwise be
  // surprised, and surprised keepers stop showing up.
  const [o] = rankOpportunities([pos({ auctionElapsed: null })]);
  assert.equal(o!.auctionOpen, false);
  assert.equal(o!.profitUsd, 0n);
  assert.match(o!.note, /pays nothing by itself/);
});

test("an early fill costs more than the collateral is worth", () => {
  // First half: the lot climbs from zero at a full bid, so an early filler
  // overpays. That is the design, and the feed should show it.
  const [o] = rankOpportunities([pos({ auctionElapsed: 60 })]);
  assert.ok(o!.profitUsd < 0n, `expected a loss, got ${o!.profitUsd}`);
  assert.match(o!.note, /Not yet profitable/);
});

test("becomes profitable as the bid decays", () => {
  const early = rankOpportunities([pos({ auctionElapsed: AUCTION_HALF_LIFE })])[0]!;
  const late = rankOpportunities([pos({ auctionElapsed: AUCTION_DURATION })])[0]!;
  assert.ok(late.profitUsd > early.profitUsd);
  assert.ok(late.profitUsd > 0n);
});

test("reports the seconds left before the discount stops widening", () => {
  const mid = rankOpportunities([pos({ auctionElapsed: 900 })])[0]!;
  assert.equal(mid.secondsToFloor, AUCTION_DURATION - 900);
  const floor = rankOpportunities([pos({ auctionElapsed: AUCTION_DURATION + 500 })])[0]!;
  assert.equal(floor.secondsToFloor, 0);
});

test("quotes against what remains, not what the auction originally offered", () => {
  // Getting this backwards would quote a keeper more than twice what it pays.
  const whole = rankOpportunities([pos({ auctionElapsed: AUCTION_DURATION })])[0]!;
  const half = rankOpportunities([pos({ auctionElapsed: AUCTION_DURATION, filledBps: 5_000 })])[0]!;
  assert.equal(half.repayUsd, whole.repayUsd / 2n);
  assert.equal(half.seizeUsd, whole.seizeUsd / 2n);
});

test("ranks by the size of the edge, not by the depth of the distress", () => {
  const small = pos({
    user: "0x1111111111111111111111111111111111111111",
    healthWad: 500_000_000_000_000_000n, // much sicker
    debtUsd: USD(10),
    collateralUsd: USD(11),
    auctionElapsed: AUCTION_DURATION,
  });
  const large = pos({
    user: "0x2222222222222222222222222222222222222222",
    healthWad: 990_000_000_000_000_000n,
    debtUsd: USD(10_000),
    collateralUsd: USD(11_000),
    auctionElapsed: AUCTION_DURATION,
  });
  const ranked = rankOpportunities([small, large]);
  assert.equal(ranked[0]!.user, large.user, "a keeper spending one transaction wants the bigger edge");
});

test("reports profit as a rate too, so sizes can be compared", () => {
  const [o] = rankOpportunities([pos({ auctionElapsed: AUCTION_DURATION })]);
  assert.ok(o!.profitBps > 0);
});

test("actionable applies the keeper's own margin rather than a guessed one", () => {
  const opps = rankOpportunities([
    pos({ auctionElapsed: AUCTION_DURATION, debtUsd: USD(1_000), collateralUsd: USD(1_050) }),
  ]);
  assert.equal(actionable(opps).length, 1);
  // A keeper whose gas and slippage come to more than the edge sees nothing.
  assert.equal(actionable(opps, USD(10_000)).length, 0);
});

test("actionable never returns a position with no auction to fill", () => {
  const opps = rankOpportunities([pos({ auctionElapsed: null })]);
  assert.equal(actionable(opps).length, 0);
});

test("identifies bad debt: at the floor and still nobody would take it", () => {
  const opps = rankOpportunities([
    pos({ auctionElapsed: AUCTION_DURATION, debtUsd: USD(1_000), collateralUsd: USD(50) }),
  ]);
  assert.equal(badDebt(opps).length, 1);
  assert.match(opps[0]!.note, /bad-debt case/);
});

test("a still-running auction is not bad debt, however underwater it looks", () => {
  const opps = rankOpportunities([
    pos({ auctionElapsed: 100, debtUsd: USD(1_000), collateralUsd: USD(50) }),
  ]);
  assert.equal(badDebt(opps).length, 0);
});

test("handles an empty pool without special-casing at the call site", () => {
  assert.deepEqual(rankOpportunities([]), []);
  assert.deepEqual(actionable([]), []);
  assert.deepEqual(badDebt([]), []);
});
