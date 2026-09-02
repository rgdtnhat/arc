import test from "node:test";
import assert from "node:assert/strict";
import { planHarvest, harvestValueCents, type HarvestCandidate } from "../src/fees.js";

/**
 * Which of the protocol's own earnings are worth moving.
 *
 * The failure this guards against is a keeper that withdraws 0.0001 USDC every
 * few minutes and pays more in gas than the fee was worth — diligent-looking in
 * the log, and a slow leak in fact.
 */

const usdc = (n: number): HarvestCandidate =>
  ({ symbol: "USDC", address: "0x36", decimals: 6, accrued: BigInt(Math.round(n * 1e6)), priceE8: 100_000_000n });
const tsra = (n: number): HarvestCandidate =>
  ({ symbol: "TSRA", address: "0x8b", decimals: 18, accrued: BigInt(Math.round(n * 1e6)) * 10n ** 12n, priceE8: 12_500_000n });

test("values a balance in cents at the pool's own mark", () => {
  assert.equal(harvestValueCents(usdc(1)), 100n);
  assert.equal(harvestValueCents(tsra(8)), 100n); // 8 TSRA at $0.125
});

test("leaves dust where it is", () => {
  // 0.000112 USDC — what the treasury had actually accrued when this was found.
  assert.deepEqual(planHarvest([usdc(0.000112)], 5), []);
});

test("harvests once the balance is worth the transaction", () => {
  const plan = planHarvest([usdc(0.000112), usdc(2.5), tsra(40)], 5);
  assert.deepEqual(plan.map((c) => harvestValueCents(c)), [250n, 500n]);
});

test("skips an asset the pool cannot price", () => {
  // Not "worthless" and not "valuable" — unknown. Deciding either way on a
  // missing mark is how a keeper either strands revenue or burns gas for none.
  assert.deepEqual(planHarvest([{ ...usdc(100), priceE8: 0n }], 5), []);
});

test("a zero balance is never a transaction", () => {
  assert.deepEqual(planHarvest([usdc(0), tsra(0)], 0), []);
});
