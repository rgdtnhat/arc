import test from "node:test";
import assert from "node:assert/strict";

/**
 * The borrow limit, health factor and liquidation line, worked out from the
 * per-asset rows when the aggregate call cannot be read.
 *
 * These used to be four "n/a"s, on the reasoning that a fabricated number reads
 * as headroom that is not there. Fair — but "n/a" tells a borrower nothing about
 * whether they are near liquidation, which is exactly what they need while the
 * oracle is having a bad day, and it left the panel unable to explain why a
 * withdrawal was refused.
 *
 * So the pool's own arithmetic is reproduced from figures that survive the
 * failure. This pins it against `_liquidity` in TesseraPool.sol:
 *
 *     borrowLimit += supplied x price x cFactor / BPS
 *     liqLimit    += supplied x price x liqFactor / BPS
 *     liability   += borrowed x price x BPS / lFactor
 *     health       = liqLimit / liability
 *
 * It is an estimate and labelled one: the contract prices collateral at its
 * lowest usable source and debt at its highest, while this has a single mark for
 * both, so it reads slightly generous. That direction matters — the number the
 * contract enforces is never *more* permissive than the one shown.
 */

type Row = { supplied: number; borrowed: number; price: number; cF: number; liqF: number; lF: number };

const estimate = (rows: Row[]) => {
  const limit = rows.reduce((t, r) => t + (r.supplied * r.price * r.cF) / 10_000, 0);
  const liqAt = rows.reduce((t, r) => t + (r.supplied * r.price * r.liqF) / 10_000, 0);
  const liability = rows.reduce((t, r) => t + (r.lF > 0 ? (r.borrowed * r.price * 10_000) / r.lF : 0), 0);
  return { limit, liqAt, liability, health: liability > 0 ? liqAt / liability : null };
};

/** The live reserves, with the factors the pool is actually configured with. */
const LIVE: Row[] = [
  { supplied: 987.625182, borrowed: 545.864358, price: 1, cF: 9000, liqF: 9500, lF: 9000 },
  { supplied: 5.374864, borrowed: 1.000016, price: 1.17, cF: 8500, liqF: 9000, lF: 8500 },
  { supplied: 0.001, borrowed: 0.0001, price: 78296, cF: 7000, liqF: 8000, lF: 7000 },
  { supplied: 47650.803668, borrowed: 0.201242, price: 0.13, cF: 5000, liqF: 6500, lF: 6500 },
];

test("the borrow limit is each deposit weighted by its own collateral factor", () => {
  const { limit } = estimate(LIVE);
  // 987.63 x 0.90 + 6.29 x 0.85 + 78.30 x 0.70 + 6194.6 x 0.50
  assert.ok(Math.abs(limit - 4046.3) < 1, `got ${limit.toFixed(2)}`);
});

test("liquidation sits above the borrow limit, never below it", () => {
  /*
   * The distance between the two is the whole safety margin: `cFactor <
   * liqFactor` is enforced on chain so a borrower who draws to their limit still
   * has room before they can be seized. An estimate that inverted them would
   * describe a pool nobody would use.
   */
  const { limit, liqAt } = estimate(LIVE);
  assert.ok(liqAt > limit, `liquidation ${liqAt.toFixed(2)} is not above the limit ${limit.toFixed(2)}`);
});

test("health is distance to liquidation, not to the borrow cap", () => {
  // A fully-drawn position is not a liquidatable one, and measuring against the
  // borrow limit would make it read 1.00 the moment borrowing was allowed.
  const { health } = estimate(LIVE);
  assert.ok(health !== null && health > 8 && health < 9, `got ${health}`);

  const drawn = estimate([{ supplied: 100, borrowed: 90, price: 1, cF: 9000, liqF: 9500, lF: 10000 }]);
  assert.equal(drawn.limit, 90, "a position drawn to its exact limit");
  assert.ok(drawn.health! > 1, "and it must not read as liquidatable");
});

test("a debt in a riskier asset counts for more than its face value", () => {
  /*
   * `liability` divides by the liability factor rather than multiplying. Getting
   * that backwards would understate every debt and overstate every health
   * factor — the one direction an estimate must never be wrong in.
   */
  const safe = estimate([{ supplied: 0, borrowed: 100, price: 1, cF: 0, liqF: 0, lF: 10000 }]);
  const risky = estimate([{ supplied: 0, borrowed: 100, price: 1, cF: 0, liqF: 0, lF: 5000 }]);
  assert.equal(safe.liability, 100);
  assert.equal(risky.liability, 200, "a debt at a 50% liability factor should count double");
});

test("no debt is infinite health, not a division by zero", () => {
  const { health } = estimate([{ supplied: 500, borrowed: 0, price: 1, cF: 9000, liqF: 9500, lF: 9000 }]);
  assert.equal(health, null, "no debt should report no ratio rather than Infinity or NaN");
});

test("an asset that is not collateral adds nothing to the limit", () => {
  // A zero collateral factor is how an asset is taken off collateral duty
  // without delisting it; it must contribute exactly nothing.
  const { limit, liqAt } = estimate([{ supplied: 10_000, borrowed: 0, price: 5, cF: 0, liqF: 0, lF: 10000 }]);
  assert.equal(limit, 0);
  assert.equal(liqAt, 0);
});
