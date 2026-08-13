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

// --- cross-checking independent sources -------------------------------------

import { crossCheck, proposeFromSources, MAX_SOURCE_SPREAD_BPS } from "../src/price-push.ts";

test("agrees when independent sources agree", () => {
  const r = crossCheck([
    { source: "coingecko", usd: 95_000 },
    { source: "amm-twap", usd: 95_400 },
  ]);
  assert.equal(r.usd, 95_200);
  assert.deepEqual(r.used, ["coingecko", "amm-twap"]);
});

test("refuses rather than picking a winner when they contradict each other", () => {
  // A clamp bounds how fast a wrong price moves; it does not stop it moving.
  // There is no rule for choosing between two contradicting sources that is not
  // really a guess, and a guess should not be setting a borrow limit.
  const r = crossCheck([
    { source: "coingecko", usd: 95_000 },
    { source: "amm-twap", usd: 130_000 },
  ]);
  assert.equal(r.usd, null);
  assert.match(r.reason!, /disagree/);
  assert.ok(r.spreadBps > MAX_SOURCE_SPREAD_BPS);
});

test("takes the median, so one wrong source cannot drag the answer", () => {
  const r = crossCheck(
    [
      { source: "a", usd: 95_000 },
      { source: "b", usd: 95_100 },
      { source: "c", usd: 95_050 },
    ],
    500,
  );
  assert.equal(r.usd, 95_050, "the middle, not the mean");
});

test("still prices from one source, and says it is uncorroborated", () => {
  // Refusing the moment one feed is down would hand an attacker a
  // denial-of-service: knock out an endpoint and every mark freezes.
  const r = crossCheck([{ source: "coingecko", usd: 95_000 }, { source: "amm-twap", usd: null }]);
  assert.equal(r.usd, 95_000);
  assert.match(r.reason!, /uncorroborated/);
});

test("ignores a stale source rather than averaging it in", () => {
  const r = crossCheck([
    { source: "fresh", usd: 95_000 },
    { source: "frozen", usd: 40_000, ageMs: 60 * 60_000 },
  ]);
  assert.equal(r.usd, 95_000);
  assert.deepEqual(r.used, ["fresh"]);
});

test("says so when nothing answered", () => {
  const r = crossCheck([{ source: "a", usd: null }, { source: "b", usd: null }]);
  assert.equal(r.usd, null);
  assert.match(r.reason!, /no source/);
});

test("ignores a source quoting zero or nonsense", () => {
  const r = crossCheck([
    { source: "good", usd: 95_000 },
    { source: "broken", usd: 0 },
    { source: "worse", usd: Number.NaN },
  ]);
  assert.equal(r.usd, 95_000);
});

test("agreement and the clamp are two defences in series", () => {
  // Agreement decides whether to move; the clamp decides how far.
  const p = proposeFromSources({
    asset: A,
    symbol: "cirBTC",
    current: P(95_000),
    quotes: [{ source: "a", usd: 60_000 }, { source: "b", usd: 60_100 }],
  });
  assert.equal(p.skip, undefined, "the sources agree, so a move is allowed");
  assert.equal(p.clamped, true, "but only one step of it");
  assert.equal(p.next, P(95_000) - (P(95_000) * 1000n) / 10_000n);
});

test("a compromised source cannot move the mark while an honest one disagrees", () => {
  const p = proposeFromSources({
    asset: A,
    symbol: "cirBTC",
    current: P(95_000),
    quotes: [{ source: "honest", usd: 95_000 }, { source: "compromised", usd: 1 }],
  });
  assert.ok(p.skip, "no move at all");
  assert.equal(p.next, p.current);
});

test("reports which sources were used, so a disagreement is actionable", () => {
  const p = proposeFromSources({
    asset: A,
    symbol: "cirBTC",
    current: P(95_000),
    quotes: [{ source: "coingecko", usd: 95_000 }, { source: "amm-twap", usd: 200_000 }],
  });
  assert.deepEqual(p.sources, ["coingecko", "amm-twap"]);
  assert.match(p.skip!, /coingecko vs amm-twap|amm-twap vs coingecko/);
});

/**
 * The outage this exists to prevent.
 *
 * USDC sat at exactly $1.00 for a week. It never moved enough to be re-pushed,
 * its mark passed the oracle's age limit, and `accountData` — which walks every
 * listed reserve — started reverting `NoUsablePrice`. Every borrow limit and
 * health factor on the site read "n/a" because a stablecoin was behaving
 * perfectly. The steadiest asset was the one guaranteed to break.
 */
const WEEK = 7 * 24 * 3600;

test("refreshes a mark that is going stale even when the price has not moved", () => {
  const p = proposePrice({
    asset: "0x36", symbol: "USDC", current: 100_000_000n, marketUsd: 1,
    markAgeSeconds: 4 * 24 * 3600, markMaxAgeSeconds: WEEK,
  });
  assert.equal(p.skip, undefined, "a mark past half its life is worth sending");
  assert.equal(p.refreshing, true);
  assert.ok(actionable([p]).length === 1, "and it reaches the chain");
});

test("stays quiet while the mark is still young", () => {
  const p = proposePrice({
    asset: "0x36", symbol: "USDC", current: 100_000_000n, marketUsd: 1,
    markAgeSeconds: 3600, markMaxAgeSeconds: WEEK,
  });
  assert.equal(p.skip, "already within tolerance");
  assert.deepEqual(actionable([p]), []);
});

test("an oracle with no age limit is never refreshed for age alone", () => {
  const p = proposePrice({
    asset: "0x36", symbol: "USDC", current: 100_000_000n, marketUsd: 1,
    markAgeSeconds: 10 * 365 * 24 * 3600, markMaxAgeSeconds: 0,
  });
  assert.equal(p.skip, "already within tolerance");
});

test("a real move still wins over the heartbeat, and is still clamped", () => {
  // Ageing must not weaken the safety rails: a 30% jump is still stepped.
  const p = proposePrice({
    asset: "0xf0", symbol: "cirBTC", current: 100_000_000n, marketUsd: 1.3,
    markAgeSeconds: 6 * 24 * 3600, markMaxAgeSeconds: WEEK,
  });
  assert.equal(p.clamped, true);
  assert.equal(p.refreshing, undefined);
  assert.equal(p.next, 110_000_000n);
});

test("a stale feed is still refused, however old the mark is", () => {
  // The one thing worse than a stale mark is a fresh mark carrying a stale
  // number. Age pressure must never override the quote's own freshness check.
  const p = proposePrice({
    asset: "0x36", symbol: "USDC", current: 100_000_000n, marketUsd: 1,
    quoteAgeMs: 60 * 60_000, markAgeSeconds: 6 * 24 * 3600, markMaxAgeSeconds: WEEK,
  });
  assert.match(String(p.skip), /old/);
  assert.deepEqual(actionable([p]), []);
});
