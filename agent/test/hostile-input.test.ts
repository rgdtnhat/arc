import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Two things a caller could do to the scheduling routes.
 *
 * **Hang a request for ever.** `TASK_ACTIONS[venue]` is a plain object used as
 * a lookup table for a string the caller chose. `TASK_ACTIONS["constructor"]`
 * is not undefined — it is the inherited `Object.prototype.constructor`, a
 * function, which passes a falsy check and then throws on `.includes`. In an
 * async Express handler that throw is an unhandled rejection: no response is
 * written and the socket is held open. Measured against the running server
 * before the fix: 35 seconds, then the client's own timeout. After: 400 in
 * about 2ms. Same for `toString`, `valueOf`, `__proto__`, `hasOwnProperty`.
 *
 * **Pass an amount that is not base units.** `BigInt(String(x))` rejects "1.5"
 * and "1e30" and accepts "0x10" as sixteen.
 */

const server = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");

/** The venue lookup as `gateScheduled` now performs it. */
const TASK_ACTIONS: Record<string, string[]> = { wallet: ["send"], lending: ["supply"] };
const verbsFor = (venue: string) =>
  Object.hasOwn(TASK_ACTIONS, venue) ? TASK_ACTIONS[venue] : undefined;

/** The amount parser as `baseUnits` now performs it. */
function baseUnits(v: unknown): bigint {
  const raw = String(v ?? "0").trim();
  if (!/^\d+$/.test(raw)) throw new Error("not base units");
  return BigInt(raw);
}

test("a venue named after Object.prototype is unknown, not a function", () => {
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
    const verbs = verbsFor(name);
    assert.equal(verbs, undefined, `${name} resolved to something`);
    // The guard the route applies. A function would pass a bare `!verbs`.
    assert.equal(Array.isArray(verbs), false, `${name} would reach .includes()`);
  }
});

test("a real venue still resolves", () => {
  assert.deepEqual(verbsFor("wallet"), ["send"]);
  assert.equal(verbsFor("nonsense"), undefined);
});

test("the route checks ownership of the key rather than truthiness", () => {
  const at = server.indexOf("async function gateScheduled(");
  const body = server.slice(at, at + 3000);
  assert.match(body, /Object\.hasOwn\(TASK_ACTIONS, venue\)/, "the venue lookup walks the prototype chain again");
  assert.match(body, /Object\.hasOwn\(SESSION_ACTIONS, venue\)/, "the visitor's verb list walks it too");
  assert.match(body, /!Array\.isArray\(verbs\)/, "a truthy non-array would still reach .includes()");
});

test("a scheduling route always answers, even on an unexpected fault", () => {
  /*
   * `sendGate` used to return false for anything that was not a `Gate`, and
   * every caller re-threw — which in an async handler means the caller waits
   * for ever. A 500 is worse than a 200 and far better than silence.
   */
  const at = server.indexOf("function sendGate(");
  const body = server.slice(at, at + 700);
  assert.match(body, /res\.status\(500\)/, "an unexpected error still goes unanswered");
  assert.match(body, /headersSent/, "a second write could be attempted on a sent response");
  const callers = server.slice(server.indexOf("app.post(\"/api/tasks\""));
  assert.equal(
    /if \(sendGate\(res, e\)\) return;\s*\n\s*throw e;/.test(callers),
    false,
    "a handler re-throws after sendGate again, which hangs the request",
  );
});

test("an amount must be base units, in decimal", () => {
  assert.equal(baseUnits("1000000"), 1000000n);
  assert.equal(baseUnits(" 42 "), 42n, "padding is trimmed, not rejected");
  assert.equal(baseUnits(undefined), 0n);
  for (const bad of ["0x10", "0b1010", "0o17", "1.5", "1e30", "-1", "1_000", "1,000", "NaN", "Infinity", "٣"]) {
    assert.throws(() => baseUnits(bad), `${bad} was accepted as an amount`);
  }
});

test("0x10 is not sixteen", () => {
  // The specific survivor: every other malformed amount was already refused.
  assert.throws(() => baseUnits("0x10"));
  assert.equal(BigInt("0x10"), 16n, "the looser parse this replaces");
});
