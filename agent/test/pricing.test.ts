import test from "node:test";
import assert from "node:assert/strict";
import {
  quotePrice,
  loadMultiplier,
  buyerMultiplier,
  LoadMeter,
  MIN_MULTIPLIER,
  MAX_MULTIPLIER,
} from "@tessera/providers/pricing";

const U = (n: number) => BigInt(Math.round(n * 1e6));

test("an idle provider charges the catalog price", () => {
  const q = quotePrice({ basePrice: U(1), load: { callsPerMinute: 5, comfortableRate: 60 } });
  assert.equal(q.price, U(1));
  assert.equal(q.multiplier, 1);
  assert.deepEqual(q.reasons, []);
});

test("price rises only past the comfortable rate", () => {
  // A provider with spare capacity has no reason to charge more, and one that
  // surges at 10% load is just expensive.
  assert.equal(loadMultiplier({ callsPerMinute: 30, comfortableRate: 60 }), 1);
  assert.equal(loadMultiplier({ callsPerMinute: 60, comfortableRate: 60 }), 1);
  assert.ok(loadMultiplier({ callsPerMinute: 120, comfortableRate: 60 }) > 1);
});

test("surge is proportional to the overshoot", () => {
  assert.equal(loadMultiplier({ callsPerMinute: 120, comfortableRate: 60 }), 1.5);
  assert.equal(loadMultiplier({ callsPerMinute: 240, comfortableRate: 60 }), 2.5);
});

test("a disputing buyer pays more, a settling one pays the base price", () => {
  // No discount for a clean record: the base price already assumes honest
  // counterparties, so a rebate would mean everyone else was overpaying.
  assert.equal(buyerMultiplier({ settled: 20, disputed: 0 }), 1);
  assert.ok(buyerMultiplier({ settled: 10, disputed: 10 }) > 1);
});

test("a newcomer is not surcharged for having no record", () => {
  // Punishing an empty history would make the rail unusable for anyone new.
  assert.equal(buyerMultiplier({ settled: 1, disputed: 1 }), 1);
  assert.equal(buyerMultiplier(null), 1);
  assert.equal(buyerMultiplier(undefined), 1);
});

test("the surcharge is capped however bad the record", () => {
  const worst = buyerMultiplier({ settled: 0, disputed: 100 });
  assert.ok(worst <= 1.5, `${worst}`);
});

test("the multiplier is bounded at both ends", () => {
  const extreme = quotePrice({
    basePrice: U(1),
    load: { callsPerMinute: 100_000, comfortableRate: 1 },
    buyer: { settled: 0, disputed: 1000 },
  });
  assert.ok(extreme.multiplier <= MAX_MULTIPLIER, `${extreme.multiplier}`);
  assert.ok(extreme.multiplier >= MIN_MULTIPLIER);
  assert.equal(extreme.price, U(1) * BigInt(MAX_MULTIPLIER));
});

test("never quotes zero, whatever the arithmetic says", () => {
  // A price that rounds to nothing is a service given away by accident.
  const q = quotePrice({ basePrice: 1n, load: { callsPerMinute: 0, comfortableRate: 60 } });
  assert.ok(q.price > 0n);
});

test("explains itself when it moves the price", () => {
  const q = quotePrice({
    basePrice: U(1),
    load: { callsPerMinute: 200, comfortableRate: 60 },
    buyer: { settled: 5, disputed: 5 },
  });
  assert.ok(q.reasons.length === 2, JSON.stringify(q.reasons));
  assert.match(q.reasons.join(" "), /load/);
  assert.match(q.reasons.join(" "), /disputed/);
});

test("a zero comfortable rate does not divide by zero", () => {
  assert.equal(loadMultiplier({ callsPerMinute: 100, comfortableRate: 0 }), 1);
});

test("the meter counts a rolling window and forgets what falls out of it", () => {
  const m = new LoadMeter(60_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) m.record("x", t0 + i * 100);
  assert.equal(m.ratePerMinute("x", t0 + 1_000), 10);
  // A minute later those calls no longer count.
  assert.equal(m.ratePerMinute("x", t0 + 120_000), 0);
});

test("the meter keeps resources separate", () => {
  const m = new LoadMeter();
  m.record("a");
  m.record("a");
  m.record("b");
  assert.equal(m.ratePerMinute("a"), 2);
  assert.equal(m.ratePerMinute("b"), 1);
  assert.equal(m.ratePerMinute("never-seen"), 0);
});
