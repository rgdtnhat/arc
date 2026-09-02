import test from "node:test";
import assert from "node:assert/strict";

/**
 * "Repay max" does not always mean "clear this debt".
 *
 * The maximum the app offers is the debt capped by what the wallet holds. When
 * the wallet is short, pressing it repays what it can and leaves the rest — and
 * because the pool's `_hasDebt` tests for *any* debt rather than a meaningful
 * amount, the leftover keeps every collateral withdrawal frozen exactly as the
 * whole debt did.
 *
 * That is a dead end with no sign on it, and it cost real confusion on the live
 * deployment: the operator repaid everything the app offered, saw no change in
 * what they were allowed to do, and reasonably concluded the repayment had not
 * worked. Measured at the time: 745.86 USDC owed against 553.25 held, so the
 * maximum left 192.61 outstanding and the wallet stayed frozen.
 *
 * `repayShortRaw` is what would still be owed afterwards, so the panel can say
 * so before the button is pressed.
 */

const minB = (a: bigint, b: bigint) => (a < b ? a : b);

/** The rule as `readLending` applies it. */
const repayPlan = (borrowed: bigint, wallet: bigint) => {
  const max = minB(borrowed, wallet);
  return { max, short: borrowed > max ? borrowed - max : 0n };
};

test("a wallet that cannot cover its debt is told what would be left", () => {
  // The live numbers.
  const { max, short } = repayPlan(745_860_269n, 553_247_121n);
  assert.equal(max, 553_247_121n, "offered more than the wallet holds");
  assert.equal(short, 192_613_148n, "the leftover was not reported");
});

test("a wallet that can cover its debt is short nothing", () => {
  const { max, short } = repayPlan(1_000_016n, 301_287_342n);
  assert.equal(max, 1_000_016n, "offered more than is owed");
  assert.equal(short, 0n);
});

test("the two always add back up to the debt", () => {
  /*
   * The property that makes the number trustworthy: whatever is offered plus
   * whatever is left is exactly what is owed. A shortfall that did not
   * reconcile would be worse than none, because somebody would plan around it.
   */
  for (const [borrowed, wallet] of [
    [745_860_269n, 553_247_121n],
    [1_000_016n, 301_287_342n],
    [10_000n, 0n],
    [0n, 500n],
    [7n, 7n],
    [1n, 0n],
  ] as [bigint, bigint][]) {
    const { max, short } = repayPlan(borrowed, wallet);
    assert.equal(max + short, borrowed, `${borrowed} vs ${wallet}`);
    assert.ok(max <= wallet, "offered more than the wallet holds");
    assert.ok(short >= 0n);
  }
});

test("an empty wallet can repay nothing and owes all of it", () => {
  // The clearest case of the trap: the button is offered, does nothing, and
  // the position stays frozen.
  const { max, short } = repayPlan(10_000n, 0n);
  assert.equal(max, 0n);
  assert.equal(short, 10_000n);
});

test("owing nothing is not a shortfall", () => {
  const { max, short } = repayPlan(0n, 500n);
  assert.equal(max, 0n);
  assert.equal(short, 0n, "a debt-free wallet was reported as short");
});
