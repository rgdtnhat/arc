import { test } from "node:test";
import assert from "node:assert/strict";
import { isThrottle, isTransient } from "@tessera/shared";

/*
 * The classifier that decides whether a failed RPC call is retried.
 *
 * It is one predicate over a string, which is why it went wrong quietly: Arc's
 * public node says "Request exceeds defined limit", the list matched on "rate
 * limit" and "request limit", and a throttle that matches neither is treated as
 * a permanent failure. Every read in the app goes through here, so the cost of
 * a miss is not one slow call — it is a hard error surfacing wherever the
 * caller happened to be, wearing the name of whatever it was reading. A pool
 * migration aborted at cirBTC and reported it as a bad cirBTC price.
 *
 * Tested by the words nodes actually use, not by the shape of the code.
 */
test("the phrasings public nodes actually use are all throttles", () => {
  for (const message of [
    // Arc's public RPC — the one that was missed.
    "Request exceeds defined limit",
    "HTTP request failed: Request exceeds defined limit for eth_call",
    // Variations of the same sentence.
    "request exceeded the limit",
    "daily limit exceeded",
    "You have exceeded your compute units limit",
    // The ones already covered, which must stay covered.
    "request limit reached",
    "rate limit exceeded",
    "ratelimited",
    "429 Too Many Requests",
    "error -32005: limit",
    "monthly quota reached",
    "request was throttled",
  ]) {
    assert.equal(isThrottle(new Error(message)), true, message);
    // Anything throttled is transient by definition; reads retry on both.
    assert.equal(isTransient(new Error(message)), true, message);
  }
});

test("a revert is not a throttle, however long it waits", () => {
  /*
   * The failure that must never be retried. Retrying a revert wastes the whole
   * backoff budget and then reports the same error, having turned a fast, clear
   * failure into a slow one.
   */
  for (const message of [
    'The contract function "accountData" reverted.',
    "execution reverted: NoUsablePrice",
    "insufficient allowance",
    "nonce too low",
    "intrinsic gas too low",
    "invalid opcode",
  ]) {
    assert.equal(isThrottle(new Error(message)), false, message);
    assert.equal(isTransient(new Error(message)), false, message);
  }
});

test("the word 'limit' alone does not make a revert retryable", () => {
  // `limit` appears in plenty of contract errors. It takes "exceed" *and*
  // "limit" together to read as a throttle, so a borrow-limit revert is not
  // retried into the ground.
  assert.equal(isThrottle(new Error("BorrowCapReached: over the limit")), false);
  assert.equal(isThrottle(new Error("gas limit too low")), false);
  // But a cap the *node* enforces still is.
  assert.equal(isThrottle(new Error("block range exceeds the limit of 1000")), true);
});

test("a non-Error is classified without throwing", () => {
  // Transports hand back plain objects and strings as often as Errors.
  assert.equal(isThrottle("Request exceeds defined limit"), true);
  assert.equal(isThrottle({ message: "rate limit" }), true);
  assert.equal(isThrottle(null), false);
  assert.equal(isThrottle(undefined), false);
});
