/**
 * The nanopayment voucher ledger's key.
 *
 * This exists because of a real billing bypass. The provider tracks the best
 * voucher seen per tab in a Map so it can settle many ticks in one on-chain
 * claim. That Map was keyed by the raw `x-tessera-tab` header, while both the
 * signature hash and the contract read went through `BigInt(tabId)`.
 *
 * So "1", "01", "0x1" and " 1" were one tab on-chain, covered by one signature —
 * and four separate ledger entries. A buyer could sign a single voucher and
 * replay it under each spelling: every new key found no previous voucher, so
 * `prev` fell back to the on-chain `claimed` value and the `cum - prev >= price`
 * check passed again. The provider served a tick each time and, at close, could
 * only claim one of them.
 *
 * The fix is to key on the numeric identity. These tests pin that the key is a
 * function of the *value*, not of how it was written.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tabKey } from "@tessera/providers";

test("every spelling of the same tab collapses to one ledger key", () => {
  // Each of these previously opened its own billing namespace.
  const spellings = ["1", "01", "001", " 1", "\t1\n", "0x1", "0X1"];
  const keys = new Set(spellings.map((s) => tabKey(s)));
  assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(", ")}`);
  assert.equal([...keys][0], "1");
});

test("different tabs still get different keys", () => {
  // The fix must not over-collapse: distinct tabs must stay distinct, or one
  // buyer's voucher would settle against another's deposit.
  assert.notEqual(tabKey("1"), tabKey("2"));
  assert.equal(tabKey("0x10"), "16");
  assert.notEqual(tabKey("0x10"), tabKey("10"));
});

test("the key matches the decimal form the contract sees", () => {
  // `BigInt(key)` must equal `BigInt(raw)` — the ledger and the chain have to
  // agree on which tab is being settled.
  for (const raw of ["1", "01", "0x1f", " 42 ", "1000000"]) {
    assert.equal(BigInt(tabKey(raw)!), BigInt(raw.trim()));
  }
});

test("zero is a usable tab id, not a falsy reject", () => {
  // Tab ids start at 0 in some deployments; a truthiness check would drop it.
  assert.equal(tabKey("0"), "0");
  assert.equal(tabKey("00"), "0");
  assert.equal(tabKey("0x0"), "0");
});

test("negatives are refused rather than given their own namespace", () => {
  // BigInt("-1") parses fine. Left alone it would be a second key for a tab
  // that cannot exist on-chain.
  assert.equal(tabKey("-1"), null);
  assert.equal(tabKey("-0x1"), null);
});

test("junk is refused rather than throwing", () => {
  for (const bad of ["", "abc", "1.5", "1e3", "0x", "NaN", "1,000", undefined]) {
    assert.doesNotThrow(() => tabKey(bad as string | undefined));
    assert.equal(tabKey(bad as string | undefined), null, `${String(bad)} should be refused`);
  }
});

test("a very large id survives without precision loss", () => {
  // uint256 ids exceed Number's safe range; going through a float would alias
  // two distinct tabs onto one key.
  const big = (2n ** 200n).toString();
  assert.equal(tabKey(big), big);
  assert.notEqual(tabKey(big), tabKey((2n ** 200n + 1n).toString()));
});
