import test from "node:test";
import assert from "node:assert/strict";
import { parseUsdcAmount, usdc, formatUsdc } from "@tessera/shared";

/**
 * Reading a price somebody typed is not the same job as scaling a number.
 *
 * The launchpad reached for `baseUnits` — a parser for integers *already* in the
 * token's smallest unit — to read a human figure. A drop submitted at "1" USDC
 * was listed at 0.000001, a factor of a million; minting it then failed, because
 * "0.000001" contains a dot the integer parser rejects. One misuse, two
 * symptoms, and neither message mentioned scale: the mint error told the reader
 * to "send the price as a plain decimal", which is exactly what they had sent.
 */

test("a whole number is whole USDC, not a millionth of one", () => {
  // The bug, stated as a number. 1 USDC is 1,000,000 base units.
  assert.equal(parseUsdcAmount("1"), 1_000_000n);
  assert.equal(parseUsdcAmount("1"), usdc("1"));
  assert.notEqual(parseUsdcAmount("1"), 1n);
});

test("the decimal the panel displays parses back to what it displayed", () => {
  /*
   * The other half. The row renders `formatUsdc(price)` and the mint sends that
   * string straight back, so the two have to be exact inverses or a mint is
   * refused for quoting the price it was shown.
   */
  for (const raw of [1n, 999n, 1_000_000n, 1_500_000n, 123_456_789n, 0n]) {
    assert.equal(parseUsdcAmount(formatUsdc(raw)), raw, `round trip failed for ${raw}`);
  }
});

test("precision it cannot hold is a refusal, not a truncation", () => {
  /*
   * `parseUnits("1.0000001", 6)` truncates and says nothing. Silently dropping
   * a digit from a price is how somebody is charged an amount they did not
   * type, so this is the one case worth being strict about.
   */
  assert.throws(() => parseUsdcAmount("1.0000001"), /6 decimal places/);
  assert.equal(parseUsdcAmount("1.000001"), 1_000_001n);
});

test("blank is zero — a free drop is a real thing", () => {
  assert.equal(parseUsdcAmount(""), 0n);
  assert.equal(parseUsdcAmount("   "), 0n);
  assert.equal(parseUsdcAmount(undefined), 0n);
  assert.equal(parseUsdcAmount("0"), 0n);
});

test("thousands separators are accepted, because forms produce them", () => {
  assert.equal(parseUsdcAmount("1,000"), 1_000_000_000n);
  assert.equal(parseUsdcAmount("1,234.56"), 1_234_560_000n);
});

test("anything that is not an amount is refused with a sentence", () => {
  for (const bad of ["abc", "1e6", "-1", "1.2.3", "0x10", "1 USDC", ".", "--1", "1..0"]) {
    assert.throws(() => parseUsdcAmount(bad), /plain amount of USDC/, `accepted ${JSON.stringify(bad)}`);
  }
});

test("a big price does not lose its scale", () => {
  assert.equal(parseUsdcAmount("1000000"), 1_000_000_000_000n);
  assert.equal(formatUsdc(parseUsdcAmount("1000000")), "1000000");
});
