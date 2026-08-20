import test from "node:test";
import assert from "node:assert/strict";

/**
 * Naming the asset that broke the lending summary.
 *
 * `accountData` walks every listed reserve, so one asset the risk oracle cannot
 * price takes the whole call down and the panel loses its borrow limit and
 * health factor. The banner used to say "usually one listed asset the risk
 * oracle has no price for", which is the right diagnosis and a useless message:
 * it describes the shape of the problem and leaves the reader to work out which
 * of four assets it is — or, in practice, to conclude the app is broken.
 *
 * The revert says which. This pins the matcher against the exact bytes Arc
 * returned on the live deployment, because the whole value of the message is
 * that the address in it is right.
 */

/** Lifted verbatim from the live node's reply to `accountData(agent)`. */
const LIVE_REVERT =
  "0xde5a26660000000000000000000000008bb6bca8cb41147844a58327603eeab433f407b0";
const TSRA = "0x8bb6bca8cb41147844a58327603eeab433f407b0";

/** The matcher as the dashboard applies it. */
const named = (err: unknown) => {
  const hit = /0xde5a2666[0-9a-f]{24}([0-9a-f]{40})/i.exec(String(err ?? ""));
  return hit ? `0x${hit[1].toLowerCase()}` : null;
};

test("the asset is picked out of the live revert data", () => {
  assert.equal(named(LIVE_REVERT), TSRA);
});

test("it is found however viem happens to have nested it", () => {
  /*
   * Matched out of the stringified error rather than decoded through an ABI,
   * because viem nests revert data differently depending on where the call
   * failed — and a banner that only works for one of those shapes is a banner
   * that goes vague exactly when something unusual happened.
   */
  for (const shape of [
    new Error(`execution reverted\n\nDetails: ${LIVE_REVERT}`),
    { message: "reverted", data: LIVE_REVERT },
    { cause: { data: LIVE_REVERT } },
    `ContractFunctionExecutionError: ... data="${LIVE_REVERT.toUpperCase().replace("0XDE5A2666", "0xde5a2666")}"`,
  ]) {
    assert.equal(named(JSON.stringify(shape) + String(shape)), TSRA, JSON.stringify(shape));
  }
});

test("a different revert does not get an asset name attached to it", () => {
  // Guessing here would be worse than the vague message it replaced: it would
  // send somebody to fix the price of an asset that is perfectly fine.
  assert.equal(named("execution reverted: InsufficientLiquidity"), null);
  assert.equal(named(""), null);
  assert.equal(named(null), null);
  // A different custom error carrying an address is still not this one.
  assert.equal(named("0x81927929" + "0".repeat(24) + TSRA.slice(2)), null);
});
