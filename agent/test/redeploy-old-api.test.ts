import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toFunctionSelector } from "viem";

/**
 * The pool being replaced is older code, and its wiring API is not this one.
 *
 * Every call the redeploy makes is against the pool it just deployed — except
 * one. To repoint the outflow limiter it must first detach it from the *old*
 * pool, and it sent `setWiring(uint8,address)`: the newer consolidated setter,
 * which the live deployment predates. It has `setRateLimiter(address)`.
 *
 * That reverted twenty transactions into a migration, naming a function the old
 * pool has never had, and left a fully configured new pool that nothing pointed
 * at. Confirmed against the live contracts: `setWiring` is absent from the old
 * pool's bytecode and *every* slot reverts, while `setRateLimiter` is present
 * and simulates clean.
 */

const script = readFileSync(new URL("../../scripts/redeploy-pool.mjs", import.meta.url), "utf8");

test("the detach asks the old pool's bytecode which setter it answers to", () => {
  const at = script.indexOf("detach the limiter from the retired pool");
  assert.notEqual(at, -1, "the detach step is gone");
  const around = script.slice(at - 1800, at + 900);
  assert.match(around, /getCode\(\{ address: OLD \}\)/, "it assumes the old pool's ABI instead of reading it");
  assert.match(around, /setRateLimiter/, "the older setter is not tried");
  assert.match(around, /toFunctionSelector/, "presence is guessed rather than checked");
});

test("a pool with neither setter stops the run instead of half-migrating", () => {
  const at = script.indexOf("detach the limiter from the retired pool");
  const around = script.slice(at - 1800, at + 1600);
  assert.match(around, /exposes neither setWiring nor setRateLimiter/);
  // It must say what happens if this is skipped, because the consequence is
  // the retired pool refusing withdrawals.
  assert.match(around, /stops letting people withdraw/);
});

test("selector detection distinguishes the two APIs", () => {
  // The mechanism, rather than the wiring: two different functions, two
  // different selectors, and neither is a prefix of the other.
  const consolidated = toFunctionSelector("function setWiring(uint8,address)");
  const older = toFunctionSelector("function setRateLimiter(address)");
  assert.notEqual(consolidated, older);
  assert.match(consolidated, /^0x[0-9a-f]{8}$/);
  assert.match(older, /^0x[0-9a-f]{8}$/);
});

test("a failed run can be resumed onto the pool it already deployed", () => {
  /*
   * Without this the next attempt deploys a second pool and pays to list every
   * reserve again, while the first sits abandoned — which is a bad enough
   * answer that somebody finishes the job by hand instead.
   */
  assert.match(script, /const REUSE = /, "there is no way to continue onto an existing pool");
  assert.match(script, /--reuse must be an address/, "a mistyped --reuse would be taken as a pool");
  assert.match(script, /const NEW = REUSE \?\?/, "reuse does not actually skip the deployment");
});

test("reuse refuses a pool it must not configure", () => {
  const at = script.indexOf("if (REUSE) {");
  const body = script.slice(at, at + 1200);
  assert.match(body, /has no contract at it/, "an empty address would be accepted");
  assert.match(body, /is owned by \$\{ownedBy\}/, "somebody else's pool would be accepted");
  assert.match(body, /--reuse names the pool being replaced/, "the old pool would be accepted as the new one");
});

test("the usage says how to resume, where somebody looking will find it", () => {
  const header = script.slice(0, script.indexOf("import "));
  assert.match(header, /--reuse=0x/, "the flag exists but is undocumented");
});
