/**
 * Tests for the arithmetic behind Tessera's paid DeFi services.
 *
 * These answers are sold over HTTP 402 and an outside agent moves money on them,
 * so the ranking rules and the risk bands are the product, not a detail. Chain
 * reads are not covered here — the pure functions are, because they are what a
 * buyer would reproduce to check we told them the truth.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  rankYield,
  rankRoutes,
  healthFrom,
  reputationFrom,
  wadToPct,
  unitsToNum,
  type YieldVenue,
  type RouteLeg,
} from "@tessera/shared";

const WAD = 10n ** 18n;
const venue = (v: Partial<YieldVenue>): YieldVenue => ({
  venue: "lending",
  asset: "USDC",
  assetAddress: "0x0000000000000000000000000000000000000001",
  aprPct: 0,
  liquidity: 0,
  note: "",
  ...v,
});
const leg = (l: Partial<RouteLeg>): RouteLeg => ({
  venue: "amm", amountOut: "0", amountOutNum: 0, note: "", ...l,
});

// --- unit conversion ---------------------------------------------------------

test("wadToPct turns a WAD rate into a readable percentage", () => {
  assert.equal(wadToPct(WAD / 100n), 1); // 0.01 WAD -> 1%
  assert.equal(wadToPct((WAD * 525n) / 10_000n), 5.25);
  assert.equal(wadToPct(0n), 0);
});

test("unitsToNum respects the asset's decimals", () => {
  assert.equal(unitsToNum(1_000_000n, 6), 1);
  assert.equal(unitsToNum(100_000_000n, 8), 1);
});

// --- yield ranking -----------------------------------------------------------

test("bestYield picks the highest APR", () => {
  const best = rankYield([
    venue({ venue: "lending", aprPct: 3.2, liquidity: 100 }),
    venue({ venue: "vault", aprPct: 4.8, liquidity: 50 }),
  ]);
  assert.equal(best?.venue, "vault");
});

test("a venue with no liquidity is not an answer, however good its rate", () => {
  // Sending an agent somewhere it cannot withdraw from is worse than sending it
  // to the second-best rate.
  const best = rankYield([
    venue({ venue: "lending", aprPct: 99, liquidity: 0 }),
    venue({ venue: "vault", aprPct: 1.5, liquidity: 1000 }),
  ]);
  assert.equal(best?.venue, "vault");
  assert.equal(best?.aprPct, 1.5);
});

test("a zero rate is not an answer either", () => {
  assert.equal(rankYield([venue({ aprPct: 0, liquidity: 1000 })]), null);
});

test("no venues means no answer, not a fabricated one", () => {
  assert.equal(rankYield([]), null);
});

// --- routing -----------------------------------------------------------------

test("bestRoute picks the leg that returns most", () => {
  const best = rankRoutes([
    leg({ venue: "router", amountOutNum: 99.7, amountOut: "99.70" }),
    leg({ venue: "amm", amountOutNum: 101.2, amountOut: "101.20" }),
  ]);
  assert.equal(best?.venue, "amm");
});

test("a leg that returns nothing is skipped", () => {
  const best = rankRoutes([
    leg({ venue: "amm", amountOutNum: 0 }),
    leg({ venue: "router", amountOutNum: 5 }),
  ]);
  assert.equal(best?.venue, "router");
});

test("no usable leg means no route", () => {
  assert.equal(rankRoutes([leg({ amountOutNum: 0 })]), null);
  assert.equal(rankRoutes([]), null);
});

// --- health ------------------------------------------------------------------

const ACC = "0x000000000000000000000000000000000000dEaD" as const;
const usd = (n: number) => BigInt(Math.round(n * 1e8));

test("no debt reports no health factor rather than infinity", () => {
  // The contract returns type(uint256).max here; rendering that as a number
  // would put 1.16e59 on a dashboard.
  const h = healthFrom(ACC, usd(1000), 0n, usd(900), 2n ** 255n);
  assert.equal(h.band, "no-debt");
  assert.equal(h.healthFactor, null);
  assert.equal(h.bufferPct, null);
  assert.equal(h.suppliedUsd, 1000);
});

test("bands run safe -> watch -> at-risk -> liquidatable", () => {
  const at = (hf: number) => healthFrom(ACC, usd(1000), usd(500), usd(900), BigInt(Math.round(hf * 1e18))).band;
  assert.equal(at(2.0), "safe");
  assert.equal(at(1.5), "safe");
  assert.equal(at(1.49), "watch");
  assert.equal(at(1.1), "watch");
  assert.equal(at(1.09), "at-risk");
  assert.equal(at(1.0), "at-risk");
  assert.equal(at(0.99), "liquidatable");
});

test("bufferPct says how far collateral can fall before liquidation", () => {
  // At a health factor of 2, half the collateral value can evaporate.
  const h = healthFrom(ACC, usd(1000), usd(400), usd(800), 2n * WAD);
  assert.equal(h.bufferPct, 50);
  // At 1.25, a fifth.
  const h2 = healthFrom(ACC, usd(1000), usd(400), usd(800), (WAD * 125n) / 100n);
  assert.equal(h2.bufferPct, 20);
});

test("an already-liquidatable position reports a zero buffer, not a negative one", () => {
  const h = healthFrom(ACC, usd(1000), usd(900), usd(800), (WAD * 80n) / 100n);
  assert.equal(h.band, "liquidatable");
  assert.equal(h.bufferPct, 0);
});

// --- reputation --------------------------------------------------------------

const P = "0x000000000000000000000000000000000000bEEF" as const;

test("no history is 'unknown', not 'good'", () => {
  // Selling a clean-looking verdict on zero data would be the product being
  // actively wrong: a brand-new address is exactly what a scammer presents.
  const r = reputationFrom(P, 0, 0, "0.00");
  assert.equal(r.verdict, "unknown");
  assert.equal(r.successRate, null);
});

test("a tiny sample is 'unproven' however clean", () => {
  const r = reputationFrom(P, 4, 0, "0.00");
  assert.equal(r.successRate, 1);
  assert.equal(r.verdict, "unproven", "four out of four is not a track record");
});

test("verdicts follow the success rate once there is a sample", () => {
  assert.equal(reputationFrom(P, 20, 0, "0").verdict, "good");
  assert.equal(reputationFrom(P, 19, 1, "0").verdict, "good"); // 95%
  assert.equal(reputationFrom(P, 18, 2, "0").verdict, "mixed"); // 90%
  assert.equal(reputationFrom(P, 14, 6, "0").verdict, "mixed"); // 70%
  assert.equal(reputationFrom(P, 13, 7, "0").verdict, "poor"); // 65%
  assert.equal(reputationFrom(P, 0, 10, "0").verdict, "poor");
});

test("carries the raw counts and the stake, so a buyer can disagree with us", () => {
  const r = reputationFrom(P, 18, 2, "0.050000");
  assert.equal(r.settled, 18);
  assert.equal(r.failed, 2);
  assert.equal(r.total, 20);
  assert.equal(r.successRate, 0.9);
  assert.equal(r.stakeUsdc, "0.050000");
});
