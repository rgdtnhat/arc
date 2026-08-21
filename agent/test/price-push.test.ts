import test from "node:test";
import assert from "node:assert/strict";
import {
  proposePrice,
  toPoolPrice,
  actionable,
  roundsToTarget,
  PRICE_SCALE,
  MAX_MOVE_BPS,
  proposeOracleWrite,
  actionableOracleWrites,
  type OracleEntry,
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

/* ---- keeping the risk oracle's entries alive ---------------------------- */

const DAY = 86_400;
const WEEK = 7 * DAY;

const entry = (o: Partial<OracleEntry> = {}): OracleEntry => ({
  enabled: true,
  stored: P(95_000),
  updatedAt: 0,
  maxAge: WEEK,
  minUpdateInterval: 1800,
  maxMoveBps: 1000,
  ...o,
});

const oracleAt = (o: { agreedUsd?: number | null; nowS?: number; entry?: Partial<OracleEntry> } = {}) =>
  proposeOracleWrite({
    asset: A,
    symbol: "cirBTC",
    entry: entry(o.entry),
    agreedUsd: o.agreedUsd === undefined ? 95_000 : o.agreedUsd,
    nowS: o.nowS ?? DAY,
  });

test("leaves a fresh entry that is already on the market alone", () => {
  const w = oracleAt({ nowS: DAY });
  assert.ok(w.skip, "no transaction for an entry with six days left and nothing to correct");
  assert.equal(w.reason, null);
});

test("rewrites an unchanged price once the entry is past half its life", () => {
  // The failure this exists to stop: a stablecoin never moves 0.25%, so a
  // move-driven tracker never writes it, and the entry expires on schedule
  // every single time — taking borrowing, withdrawal and liquidation with it.
  const w = proposeOracleWrite({
    asset: A,
    symbol: "USDC",
    entry: entry({ stored: P(1), maxAge: WEEK, updatedAt: 0 }),
    agreedUsd: 1,
    nowS: 4 * DAY,
  });
  assert.equal(w.skip, undefined);
  assert.equal(w.reason, "expiring");
  assert.equal(w.next, P(1), "the same number, written again — that is the whole point");
  assert.equal(w.moveBps, 0);
});

test("tracks a real move without waiting for the entry to age", () => {
  const w = oracleAt({ agreedUsd: 99_000, nowS: DAY });
  assert.equal(w.reason, "drift");
  assert.equal(w.next, P(99_000));
});

test("clamps an oracle move to the limit the oracle itself will accept", () => {
  // Sent unclamped, this reverts MoveTooLarge and the entry expires anyway.
  const w = oracleAt({ agreedUsd: 63_400, nowS: 4 * DAY });
  assert.equal(w.clamped, true);
  assert.equal(w.next, P(95_000) - (P(95_000) * 1000n) / 10_000n);
  assert.ok(w.next > P(63_400), "one step, and the entry lives to take the next one");
});

test("will not refresh an entry on a price nothing confirms", () => {
  // Rewriting the stored value on a dead feed keeps the pool trading on a
  // number no source stands behind, which is exactly what maxAge is for.
  const w = oracleAt({ agreedUsd: null, nowS: 6 * DAY });
  assert.ok(w.skip?.includes("no agreed quote"));
  assert.equal(w.reason, null);
});

test("says how close an unconfirmable entry is to taking the market down", () => {
  assert.match(oracleAt({ agreedUsd: null, nowS: 6 * DAY }).skip!, /expires in \d+h/);
  assert.match(oracleAt({ agreedUsd: null, nowS: 8 * DAY }).skip!, /already expired/);
});

test("reports an expired entry as expired", () => {
  const w = oracleAt({ nowS: 8 * DAY });
  assert.equal(w.expired, true);
  assert.ok(w.expiresInS < 0);
  assert.equal(w.reason, "expiring", "and still writes it — this is the outage");
});

test("holds off inside the oracle's own update interval", () => {
  // Otherwise a ten-minute keeper burns a reverting transaction every ten
  // minutes against a thirty-minute minimum.
  const w = oracleAt({ agreedUsd: 99_000, entry: { updatedAt: 1000 }, nowS: 1600 });
  assert.ok(w.skip?.includes("next write in"));
});

test("refuses an asset the oracle was never told about", () => {
  assert.ok(oracleAt({ entry: { enabled: false } }).skip?.includes("configureAsset"));
  assert.ok(oracleAt({ entry: { stored: 0n } }).skip?.includes("by hand"));
});

test("refuses a broken quote outright rather than clamping toward it", () => {
  assert.ok(oracleAt({ agreedUsd: 50_000_000, nowS: 6 * DAY }).skip?.includes("sanity"));
});

test("orders oracle writes by how soon the entry stops pricing the pool", () => {
  const urgent = proposeOracleWrite({
    asset: A, symbol: "USDC", entry: entry({ stored: P(1), updatedAt: 0 }), agreedUsd: 1, nowS: 6.5 * DAY,
  });
  const later = proposeOracleWrite({
    asset: A, symbol: "cirBTC", entry: entry({ updatedAt: 0 }), agreedUsd: 99_000, nowS: 4 * DAY,
  });
  const out = actionableOracleWrites([later, urgent]);
  assert.equal(out[0]!.symbol, "USDC", "the one about to expire goes first");
  assert.equal(out.length, 2);
});

test("actionableOracleWrites keeps the no-change heartbeat that actionable would drop", () => {
  const beat = proposeOracleWrite({
    asset: A, symbol: "USDC", entry: entry({ stored: P(1) }), agreedUsd: 1, nowS: 5 * DAY,
  });
  assert.equal(beat.next, beat.stored);
  assert.equal(actionableOracleWrites([beat]).length, 1);
});

test("agreedUsd distinguishes a confirmed price from a feed that never answered", () => {
  const quiet = proposeFromSources({ asset: A, symbol: "cirBTC", current: P(95_000), quotes: [] });
  assert.equal(quiet.agreedUsd, null);
  assert.equal(quiet.target, quiet.current, "target falls back to the mark — which is why it cannot stand in");
  const agreed = proposeFromSources({
    asset: A, symbol: "cirBTC", current: P(95_000),
    quotes: [{ source: "a", usd: 96_000 }, { source: "b", usd: 96_050 }],
  });
  assert.ok(agreed.agreedUsd! > 0);
});

/*
 * The heartbeat, and the line it must not cross.
 *
 * An earlier version of this held *any* expiring entry at its stored value, and
 * the test above — "will not refresh an entry on a price nothing confirms" —
 * correctly refused it: `maxAge` exists so that if every source for an asset
 * dies, the pool stops trading rather than trading on a number nobody stands
 * behind. Making a mark immortal would mean a real price collapse left the pool
 * lending against it for ever.
 *
 * The narrow case is different. Once an asset is off collateral duty — cFactor
 * zero, not borrowable — its price sizes no loan, sets no borrow limit and gates
 * no liquidation. There is nothing for `maxAge` to protect, and letting the
 * entry lapse actively causes harm: the pool checks every listed reserve before
 * releasing value, so one unpriceable asset freezes borrowing and every
 * leveraged withdrawal across all of them. Live, that left a wallet holding 987
 * USDC of collateral against 345 USDC of debt unable to withdraw anything.
 */

test("an asset that still carries risk is never held at an unconfirmed price", () => {
  // The rule the earlier attempt broke. Nothing about the heartbeat may weaken
  // it: an asset that can back a loan must be allowed to expire.
  for (const nowS of [6 * DAY, 8 * DAY]) {
    const w = oracleAt({ agreedUsd: null, nowS });
    assert.ok(w.skip, `an asset with risk weight was written at ${nowS / DAY} days`);
    assert.notEqual(w.reason, "heartbeat");
  }
});

test("an asset with no risk weight is held rather than allowed to freeze the pool", () => {
  const w = proposeOracleWrite({
    asset: A, symbol: "TSRA", entry: entry({ stored: P(0.125), updatedAt: 0 }),
    agreedUsd: null, nowS: 8 * DAY, riskFree: true,
  });
  assert.ok(!w.skip, `the entry was left to expire: ${w.skip}`);
  assert.equal(w.reason, "heartbeat");
  assert.equal(actionableOracleWrites([w]).length, 1, "the heartbeat would never be sent");
});

test("a heartbeat cannot move a price — that is what makes it allowed", () => {
  /*
   * The safety property in one assertion. Writing without a quote would be
   * indefensible if it could change what anything is worth; it cannot, because
   * the value sent is the value already stored. If this ever fails, the
   * heartbeat has become a price write with no source behind it.
   */
  for (const stored of [P(0.125), P(1), P(95_000)]) {
    const w = proposeOracleWrite({
      asset: A, symbol: "X", entry: entry({ stored, updatedAt: 0 }),
      agreedUsd: null, nowS: 8 * DAY, riskFree: true,
    });
    assert.equal(w.next, stored, "the heartbeat sent something other than the stored value");
    assert.equal(w.moveBps, 0);
    assert.equal(w.clamped, false);
  }
});

test("a risk-free asset with plenty of life is still left alone", () => {
  // The heartbeat is for entries running out, not a licence to write every
  // round. A quiet asset should cost no transactions at all.
  const w = proposeOracleWrite({
    asset: A, symbol: "TSRA", entry: entry({ stored: P(0.125), updatedAt: 0 }),
    agreedUsd: null, nowS: DAY, riskFree: true,
  });
  assert.match(w.skip ?? "", /no agreed quote/);
  assert.equal(w.reason, null);
});

test("a heartbeat is never the first price an asset gets", () => {
  /*
   * With nothing stored there is no mark to hold, and sending zero is not a
   * heartbeat — it is seeding a price from nowhere, which is the thing the skip
   * exists to prevent. Seeding stays a deliberate act.
   */
  const w = proposeOracleWrite({
    asset: A, symbol: "NEW", entry: entry({ stored: 0n, updatedAt: 0 }),
    agreedUsd: null, nowS: 8 * DAY, riskFree: true,
  });
  assert.ok(w.skip, "an unseeded asset was written to");
  assert.match(w.skip ?? "", /no price on record/);
});

test("a heartbeat still waits for the oracle's own update interval", () => {
  // `setPrice` reverts inside `minUpdateInterval`; a keeper that ignores it
  // burns a reverting transaction every round.
  const w = proposeOracleWrite({
    asset: A, symbol: "TSRA",
    entry: entry({ stored: P(0.125), updatedAt: 8 * DAY - 60, minUpdateInterval: 1800 }),
    agreedUsd: null, nowS: 8 * DAY, riskFree: true,
  });
  assert.ok(w.skip, "the heartbeat ignored minUpdateInterval");
  assert.match(w.skip ?? "", /accepts the next write/);
});

test("a real quote is still preferred over holding the old mark", () => {
  // The heartbeat is the fallback, not the plan. When sources agree, track them.
  const w = proposeOracleWrite({
    asset: A, symbol: "TSRA", entry: entry({ stored: P(0.125), updatedAt: 0 }),
    agreedUsd: 0.13, nowS: 8 * DAY, riskFree: true,
  });
  assert.notEqual(w.reason, "heartbeat");
  assert.ok(w.next > P(0.125), "it held the old mark instead of tracking the quote");
});
