import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A migration moves somebody else's position into a pool they did not choose.
 *
 * It never asked whether that pool works. A redeploy that fails part way leaves
 * one that looks finished — reserves listed, prices set, guard attached — and
 * still cannot serve a withdrawal, because `TesseraRateLimiter` trusts exactly
 * one consumer and it is still the pool being retired. `_meter` then reverts
 * inside every withdraw and every borrow.
 *
 * That is the worst thing this script can do: funds moved, by somebody else,
 * into somewhere the owner cannot leave. It is also entirely detectable
 * beforehand, which is why it is checked in the script and not in a runbook.
 *
 * Confirmed against the live chain, where the refusal names both addresses and
 * the command that fixes it.
 */

const script = readFileSync(new URL("../../scripts/migrate-pool.mjs", import.meta.url), "utf8");
const guarded = script.slice(script.indexOf("if (!VERIFY_ONLY) {"), script.indexOf("── Executing"));

test("it refuses a destination whose limiter will not answer it", () => {
  assert.match(guarded, /functionName: "rateLimiter"/, "the destination's limiter is never read");
  assert.match(guarded, /functionName: "consumer"/, "the limiter is never asked who it trusts");
  assert.match(guarded, /NotConsumer\(\)/, "the refusal does not say what would actually happen");
  assert.match(guarded, /nobody can exit/);
});

test("the refusal tells the operator how to fix it", () => {
  // A blocker with no next step gets worked around by hand, which is how a
  // migration ends up half done.
  assert.match(guarded, /redeploy:pool -- --emitter=keep --reuse=/);
});

test("it refuses a destination that cannot receive the asset at all", () => {
  assert.match(guarded, /is not an enabled reserve on/, "an unlisted reserve is discovered per-position");
});

test("an incomplete log scan is fatal to --execute, not a warning", () => {
  /*
   * Anybody a throttled RPC hid is left behind on a pool the migration is about
   * to have frozen against new supply. In a survey that is a line to read; with
   * `--execute` it is somebody's money.
   */
  assert.match(guarded, /scan\.partial/, "--execute proceeds on a partial scan");
  assert.match(guarded, /leaves whoever is missing behind/);
  // And it must still be only a warning in the survey, or nobody can plan.
  const survey = script.slice(0, script.indexOf("if (!VERIFY_ONLY) {"));
  assert.match(survey, /console\.warn\([\s\S]{0,80}The log scan was incomplete/);
});

test("the destination is checked before the operator's balance", () => {
  /*
   * Both refuse, but they are not equally important: "they cannot get their
   * money out" outranks "you are short of a token", and whichever prints last
   * is the one somebody acts on.
   */
  const limiter = guarded.indexOf('functionName: "consumer"');
  const afford = guarded.indexOf("cannot finish.");
  assert.notEqual(limiter, -1);
  assert.notEqual(afford, -1);
  assert.equal(limiter < afford, true, "the affordability refusal masks the destination one");
});

test("a destination with no limiter at all is not blocked by this", () => {
  // Not every deployment meters outflow, and a pool without a limiter has
  // nothing to disagree with.
  assert.match(guarded, /limiter && limiter !== ZERO/, "a pool with no limiter would be refused");
});
