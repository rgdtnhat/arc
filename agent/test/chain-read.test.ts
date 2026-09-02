import test from "node:test";
import assert from "node:assert/strict";
import { read, readerFor, valueOr, orNull, collect, toJson, describeError, ok, failed } from "../src/chain-read.js";

/**
 * The distinction this module exists to preserve: a zero the chain reported and
 * a zero we invented because the question failed. Every test here is really
 * asking whether those two are still telling apart.
 */

const ADDR = "0x1111111111111111111111111111111111111111" as const;

const clientReturning = (value: unknown) => ({ readContract: async () => value });
const clientThrowing = (e: unknown) => ({
  readContract: async () => {
    throw e;
  },
});

test("a real zero is a value, not a failure", async () => {
  const r = await read<bigint>(clientReturning(0n), ADDR, [], "balanceOf", []);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value, 0n);
});

test("a failed read is not a zero", async () => {
  /*
   * The whole point. Before this, both of these were `0n` and no call site
   * could tell them apart — which is how a wallet holding 658 TSRA displayed
   * nothing at all for a week.
   */
  const r = await read<bigint>(clientThrowing(new Error("execution reverted")), ADDR, [], "balanceOf", []);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /balanceOf: execution reverted/);
});

test("a missing contract address is a reason, not a crash", async () => {
  // Deployments genuinely differ; asking a contract that is not there is a
  // normal condition and should read as one.
  const r = await read<bigint>(clientReturning(1n), null, [], "totalSupply", []);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /no contract address/);
});

test("shortens a chain error to its first useful line", () => {
  // viem attaches the whole ABI and a docs link. Put that in a JSON field and
  // responses become unreadable, so people go back to swallowing errors.
  const long = new Error(
    "The contract function \"reserves\" reverted.\n\nContract Call:\n  address: 0x…\n  function: reserves\n" +
      "Docs: https://viem.sh/docs/contract/readContract",
  );
  const d = describeError(long);
  assert.equal(d, 'The contract function "reserves" reverted.');
});

test("caps a pathologically long message rather than pasting a wall", () => {
  const d = describeError(new Error("x".repeat(500)));
  assert.ok(d.length <= 160);
  assert.match(d, /…$/);
});

test("a bound reader keeps the address and abi out of every call site", async () => {
  const r = readerFor(clientReturning(7n), ADDR, []);
  const v = await r<bigint>("supplyShares", [ADDR]);
  assert.equal(v.ok && v.value, 7n);
});

test("valueOr makes the fallback a decision somebody typed", async () => {
  const r = await read<bigint>(clientThrowing(new Error("nope")), ADDR, [], "x", []);
  assert.equal(valueOr(r, 42n), 42n);
});

test("orNull spells unknown as null, which JSON and the page both understand", async () => {
  const bad = await read<bigint>(clientThrowing(new Error("nope")), ADDR, [], "x", []);
  const good = await read<bigint>(clientReturning(0n), ADDR, [], "x", []);
  assert.equal(orNull(bad), null);
  assert.equal(orNull(good), 0n); // and a real zero survives as a zero
});

test("collect keeps the failures instead of dropping the response", () => {
  /*
   * A panel showing four of six numbers with two dashes is honest. The same
   * panel showing four numbers and two zeroes is a lie, and throwing the whole
   * response away over one bad read is how a single retired contract takes a
   * page down.
   */
  const { values, unavailable } = collect({
    supply: ok(100n),
    borrow: failed<bigint>("borrowShares: reverted"),
    price: ok(5n),
  });
  assert.equal(values.supply, 100n);
  assert.equal(values.borrow, null);
  assert.equal(values.price, 5n);
  assert.equal(unavailable.length, 1);
  assert.match(unavailable[0], /^borrow \(borrowShares: reverted\)$/);
});

test("collect reports nothing missing when nothing is", () => {
  const { unavailable } = collect({ a: ok(1n), b: ok(2n) });
  assert.deepEqual(unavailable, []);
});

test("bigints survive JSON as strings, and failures as null", () => {
  assert.equal(toJson(ok(123n)), "123");
  assert.equal(toJson(ok(0n)), "0"); // a real zero, still a zero
  assert.equal(toJson(failed<bigint>("gone")), null);
  assert.equal(toJson(ok(false)), false); // and false is not null
});
