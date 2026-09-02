import test from "node:test";
import assert from "node:assert/strict";
import { tesseraPoolAbi } from "@tessera/shared";
import { PRICE_IX } from "../src/pool.ts";

/**
 * The reserve tuple, pinned against the ABI rather than against a memory of it.
 *
 * Two readers in pool.ts took index 6 for `price` and got `reserveFactor` —
 * 1000 where they meant 1e8. `priceE8` sizes the borrow limit, so that quotes a
 * maximum borrow five orders of magnitude too large and presents it as a number
 * to act on. Counting the struct's four uint16 risk parameters as three is an
 * easy mistake to make twice, so it is checked here against the compiled output.
 */
function reservesOutputs() {
  const fn = (tesseraPoolAbi as readonly any[]).find(
    (e) => e.type === "function" && e.name === "reserves",
  );
  assert.ok(fn, "the pool ABI must expose `reserves`");
  return fn.outputs as { name: string; type: string }[];
}

test("price sits where PRICE_IX says it does", () => {
  const outs = reservesOutputs();
  assert.equal(outs[PRICE_IX]?.name, "price", `index ${PRICE_IX} is ${outs[PRICE_IX]?.name}, not price`);
});

test("index 6 is reserveFactor — the value the bug was reading as a price", () => {
  assert.equal(reservesOutputs()[6]?.name, "reserveFactor");
});

test("all four risk parameters are present, in order", () => {
  // Counting three of these instead of four is what shifted every later index.
  const names = reservesOutputs().map((o) => o.name);
  assert.deepEqual(names.slice(3, 7), ["cFactor", "liqFactor", "lFactor", "reserveFactor"]);
});

test("the leading fields are where the readers assume", () => {
  const names = reservesOutputs().map((o) => o.name);
  assert.deepEqual(names.slice(0, 3), ["enabled", "borrowable", "decimals"]);
});

test("price is a uint256, so a reader gets a bigint rather than a number", () => {
  assert.equal(reservesOutputs()[PRICE_IX]?.type, "uint256");
});

test("the tuple is the length the type declares", () => {
  // A field appended to the struct is fine; one inserted moves `price` and
  // every reader with it, which is exactly what this file exists to catch.
  assert.equal(reservesOutputs().length, 13);
});
