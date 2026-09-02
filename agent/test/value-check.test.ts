import { test } from "node:test";
import assert from "node:assert/strict";
import { valueCheck, VALUE_SEVERE_PCT, VALUE_WARN_PCT } from "../src/impact.js";

const USDC = { decimals: 6, price: 100_000_000n, symbol: "USDC" };   // $1.00
const EURC = { decimals: 6, price: 108_000_000n, symbol: "EURC" };   // $1.08

const check = (amountIn: bigint, amountOut: bigint) =>
  valueCheck({
    amountIn, decimalsIn: USDC.decimals, priceInE8: USDC.price, symbolIn: USDC.symbol,
    amountOut, decimalsOut: EURC.decimals, priceOutE8: EURC.price, symbolOut: EURC.symbol,
  });

test("the live trade that had no guard is flagged severe", () => {
  // What actually happened on Arc: 0.5 USDC in, 0.148706 EURC out, from a pool
  // holding 1.6 USDC against 0.63 EURC. The quote came back ok with an empty
  // blockers array.
  const v = check(500_000n, 148_706n);
  assert.ok(v);
  assert.equal(v.severity, "severe");
  assert.ok(v.lossPct > 60, `expected >60% loss, got ${v.lossPct.toFixed(1)}%`);
  assert.match(v.reason, /priced away from the market/);
});

test("a small trade into the same mispriced pool is caught too", () => {
  // The case price impact cannot see: tiny order, negligible impact, and it
  // still loses two thirds of its value because the pool itself is wrong.
  const v = check(1_000n, 300n);
  assert.ok(v);
  assert.equal(v.severity, "severe");
});

test("a fair trade at the marks passes", () => {
  // 1 USDC ($1.00) for 0.9259 EURC ($1.00) is exactly the marked rate.
  const v = check(1_000_000n, 925_926n);
  assert.ok(v);
  assert.equal(v.severity, "fine");
  assert.equal(v.reason, "");
  assert.ok(Math.abs(v.lossPct) < 0.01);
});

test("an ordinary fee is a warning, not a block", () => {
  // ~3% down: worth saying, not worth refusing.
  const v = check(1_000_000n, 898_000n);
  assert.ok(v);
  assert.equal(v.severity, "warn");
  assert.ok(v.lossPct >= VALUE_WARN_PCT && v.lossPct < VALUE_SEVERE_PCT);
  assert.match(v.reason, /Check the rate before signing/);
});

test("a trade in the trader's favour is never flagged", () => {
  const v = check(1_000_000n, 1_200_000n);
  assert.ok(v);
  assert.equal(v.severity, "fine");
  assert.ok(v.lossPct < 0);
});

test("a missing mark returns null rather than a passing grade", () => {
  // An unknown value must not be reported as a safe one — inventing a zero
  // here would silently disarm the guard, which is the exact failure shape
  // this codebase keeps finding.
  assert.equal(
    valueCheck({
      amountIn: 500_000n, decimalsIn: 6, priceInE8: 0n, symbolIn: "USDC",
      amountOut: 148_706n, decimalsOut: 6, priceOutE8: EURC.price, symbolOut: "EURC",
    }),
    null,
  );
  assert.equal(
    valueCheck({
      amountIn: 500_000n, decimalsIn: 6, priceInE8: USDC.price, symbolIn: "USDC",
      amountOut: 148_706n, decimalsOut: 6, priceOutE8: 0n, symbolOut: "EURC",
    }),
    null,
  );
});

test("decimals of different widths are handled", () => {
  // cirBTC is 8dp at ~$95,000. 0.00001 cirBTC is $0.95; paying 1 USDC for it
  // is a ~5% loss, and the maths must not be thrown by the decimal gap.
  const v = valueCheck({
    amountIn: 1_000_000n, decimalsIn: 6, priceInE8: 100_000_000n, symbolIn: "USDC",
    amountOut: 1_000n, decimalsOut: 8, priceOutE8: 9_500_000_000_000n, symbolOut: "cirBTC",
  });
  assert.ok(v);
  assert.ok(Math.abs(v.outUsd - 0.95) < 0.001, `outUsd was ${v.outUsd}`);
  assert.equal(v.severity, "warn");
});

test("a zero amount in returns null rather than dividing by zero", () => {
  assert.equal(
    valueCheck({
      amountIn: 0n, decimalsIn: 6, priceInE8: USDC.price, symbolIn: "USDC",
      amountOut: 0n, decimalsOut: 6, priceOutE8: EURC.price, symbolOut: "EURC",
    }),
    null,
  );
});
