import test from "node:test";
import assert from "node:assert/strict";
import { ERROR_TABLE, matchErrorTable } from "../src/error-table.ts";

/**
 * The revert table, tested against the table that actually runs.
 *
 * `refusal-wording.test.ts` had to re-type its matcher because the rules were
 * declared inside `friendlyError`, private to `dashboard.ts`. A test that reads
 * its own copy of a table cannot notice a rule the real one is missing — and
 * the real one was missing `ActionFrozen` for as long as the live pool was
 * frozen, which is the whole of the outage this fixes.
 */

/** The haystack `friendlyError` builds: every field viem might use, lowercased. */
const viemError = (reason: string) =>
  [
    "the contract function \"supply\" reverted.",
    `error: ${reason}()`,
    "contract call:",
  ].join(" | ").toLowerCase();

test("a frozen action is named as a freeze, not as a bad amount", () => {
  const hit = matchErrorTable(viemError("ActionFrozen"));
  assert.ok(hit, "ActionFrozen falls through the whole table");
  const [, msg] = hit;
  assert.match(msg, /frozen/i);
  /*
   * The defect, stated exactly. This is the sentence the user saw for every
   * scheduled supply and borrow while all four reserves sat at mask 5, and it
   * sends somebody to try a smaller number — which cannot work, because a
   * freeze is a switch and not a limit.
   */
  assert.doesNotMatch(msg, /double-check the amount/i);
  assert.notEqual(msg, "");
});

test("the freeze rule is above the generic reverted rule, or it never fires", () => {
  const frozen = ERROR_TABLE.findIndex(([re]) => re.test("actionfrozen"));
  const generic = ERROR_TABLE.findIndex(([re]) => re.source === "reverted");
  assert.notEqual(frozen, -1);
  assert.notEqual(generic, -1);
  assert.ok(frozen < generic, "the generic rule would swallow every freeze");
});

test("no earlier rule claims a frozen revert first", () => {
  /*
   * Order is the meaning here, and `\bzero\b`, `expired`, `network` and
   * `balance` are all broad enough to catch a message they were not written
   * for. Pinning the winner rather than the position is what survives the next
   * rule somebody inserts above it.
   */
  const hit = matchErrorTable(viemError("ActionFrozen"));
  assert.equal(hit?.[0].source, "actionfrozen");
});

test("refusals the app wrote itself still pass through whole", () => {
  // Same corpus as refusal-wording.test.ts, run against the shipped rules.
  const refusals = [
    "the lending pool on this deployment predates scheduled exits — it has no way to act for a holder, " +
      "so only your own wallet can withdraw or borrow. Do it from the DeFi tab.",
    "the vault on this deployment predates scheduled withdrawals — it has no way to act for a holder, " +
      "so only your own wallet can redeem. Withdraw from the DeFi tab.",
    "only a connected wallet's own task can act on its own position",
  ];
  for (const message of refusals) {
    const hit = matchErrorTable(message.toLowerCase());
    assert.ok(hit, message.slice(0, 40));
    assert.equal(hit[1], "", `would be rewritten as "${hit[1].slice(0, 40)}…"`);
  }
});

test("every rule is a usable pair", () => {
  for (const rule of ERROR_TABLE) {
    assert.ok(rule[0] instanceof RegExp);
    assert.equal(typeof rule[1], "string");
    // Every pattern is matched against a lowercased haystack, so an uppercase
    // letter in one is a rule that can never fire. (Escapes in this table are
    // all lowercase — \b, \s, \w — so a bare /[A-Z]/ is the right net.)
    assert.doesNotMatch(rule[0].source, /[A-Z]/, `unreachable rule: /${rule[0].source}/`);
  }
});
