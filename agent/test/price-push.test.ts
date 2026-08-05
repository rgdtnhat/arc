import test from "node:test";
import assert from "node:assert/strict";
import {
  proposePrice,
  toPoolPrice,
  actionable,
  roundsToTarget,
  PRICE_SCALE,
  MAX_MOVE_BPS,
} from "../src/price-push.ts";

const A = "0xf0c4a4ce82a5746abaad9425360ab04fbba432bf" as const;
const P = (usd: number) => BigInt(Math.round(usd * 1e8));

const at = (o: Partial<Parameters<typeof proposePrice>[0]> = {}) =>
  proposePrice({ asset: A, symbol: "cirBTC", current: P(95_000), marketUsd: 95_000, ...o });

test("does nothing when the mark already matches the market", () => {
  assert.equal(at({ marketUsd: 95_000 }).skip, "already within tolerance");
});

test("ignores a move too small to be worth a transaction", () => {
  assert.ok(at({ marketUsd: 95_100 }).skip); // ~0.1%
});

test("tracks an ordinary move exactly", () => {
  const p = at({ marketUsd: 99_000 });
  assert.equal(p.skip, undefined);
  assert.equal(p.next, P(99_000));
  assert.equal(p.clamped, false);
});

test("clamps a large move to one step rather than refusing it", () => {
  // A real 30% crash must still be tracked — three steps, not frozen.
  const p = at({ marketUsd: 66_500 }); // -30%
  assert.equal(p.clamped, true);
  assert.equal(p.next, P(95_000) - (P(95_000) * 1000n) / 10_000n); // -10%
  assert.ok(p.next > P(66_500), "one step, not the whole way");
});

test("clamps upward moves the same as downward ones", () => {
  const p = at({ marketUsd: 200_000 });
  assert.equal(p.clamped, true);
  assert.equal(p.next, P(95_000) + (P(95_000) * 1000n) / 10_000n);
});

test("refuses a feed that has clearly broken", () => {
  // Unclamped, a quote of $0.01 for bitcoin marks every position to nothing and
  // liquidates the lot in one transaction.
  const cheap = at({ marketUsd: 0.01 });
  assert.equal(cheap.clamped, true);
  assert.ok(cheap.next > P(85_000), "a broken quote still cannot move it more than a step");
});

test("refuses a quote outside the sanity band outright", () => {
  assert.ok(at({ marketUsd: 50_000_000 }).skip?.includes("sanity"));
});

test("refuses a stale quote — a feed that froze mid-crash is the dangerous case", () => {
  assert.ok(at({ marketUsd: 120_000, quoteAgeMs: 60 * 60_000 }).skip?.includes("old"));
});

test("refuses a missing quote rather than treating it as zero", () => {
  assert.ok(at({ marketUsd: null }).skip);
});

test("refuses to seed a first price silently", () => {
  // Nothing to measure a move against, so the clamp cannot protect anything.
  assert.ok(at({ current: 0n, marketUsd: 95_000 }).skip?.includes("by hand"));
});

test("never proposes a non-positive price", () => {
  for (const m of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const p = at({ marketUsd: m });
    assert.ok(p.skip || p.next > 0n, `bad quote ${m} produced ${p.next}`);
  }
});

test("rounds rather than truncating", () => {
  // Truncation biases every mark downward, which over many updates walks
  // collateral values quietly toward zero.
  assert.equal(toPoolPrice(1.999999995), 200000000n);
  assert.equal(toPoolPrice(0), null);
  assert.equal(toPoolPrice(-5), null);
});

test("reports the direction honestly", () => {
  assert.ok(at({ marketUsd: 99_000 }).moveBps > 0);
  assert.ok(at({ marketUsd: 90_000 }).moveBps < 0);
});

test("orders by the size of the move, so the most wrong price is fixed first", () => {
  const list = [
    at({ marketUsd: 96_000 }),
    proposePrice({ asset: A, symbol: "EURC", current: P(1.08), marketUsd: 1.2 }),
  ];
  const out = actionable(list);
  assert.equal(out[0]!.symbol, "EURC");
});

test("actionable drops everything skipped or already correct", () => {
  const list = [at({ marketUsd: 95_000 }), at({ marketUsd: null }), at({ marketUsd: 99_000 })];
  assert.equal(actionable(list).length, 1);
});

test("says how many rounds a clamped move needs", () => {
  // So a clamped update reads as "tracking, 3 rounds out" rather than "the price
  // is wrong and nothing is happening".
  const p = at({ marketUsd: 66_500 });
  const n = roundsToTarget(p, MAX_MOVE_BPS);
  assert.ok(n >= 3 && n <= 5, `expected a handful of rounds, got ${n}`);
  assert.equal(roundsToTarget(at({ marketUsd: 95_000 })), 0);
});

test("a single step is enough for a move inside the limit", () => {
  assert.equal(roundsToTarget(at({ marketUsd: 99_000 })), 1);
});

test("the scale matches the pool's", () => {
  assert.equal(PRICE_SCALE, 100_000_000n);
  assert.equal(toPoolPrice(1), PRICE_SCALE);
});
