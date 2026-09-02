import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * "Leave blank for your own wallet" has to mean it.
 *
 * The faucet's address field is optional and its placeholder says so — blank
 * drips to the task's own owner. The form refused it anyway with "that is not
 * an address", so the one field that advertised a default was the one field
 * that would not accept one. The same check was written out twice, once for the
 * task form and once for the series-step form, and both were wrong the same way.
 *
 * This pins the rule rather than the wiring: the browser check that the step is
 * actually added lives where it belongs, in a real page, and what is worth
 * guarding here is which verbs may be left blank and which may not.
 */

const app = readFileSync(new URL("../../dashboard/public/app.js", import.meta.url), "utf8");

/** The rule as `addressProblem` applies it. */
const OPTIONAL_TO = new Set(["faucet:topUp", "wallet:fundFromOwner"]);
const problem = (verb: string, value: string) => {
  const v = value.trim();
  if (!v) return OPTIONAL_TO.has(verb) ? null : "that is not an address";
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? null : "that is not an address";
};

const ADDR = "0x4D31637a6f3d53debb214c1363556ab748004205";

test("blank is fine where a default exists", () => {
  // Both of these have somewhere better to send it than anything a reader would
  // type: the faucet drips to your own wallet, and a top-up from the deployer
  // lands in the app wallet it exists to fund.
  assert.equal(problem("faucet:topUp", ""), null);
  assert.equal(problem("wallet:fundFromOwner", ""), null);
  assert.equal(problem("faucet:topUp", "   "), null, "whitespace is blank");
});

test("blank is not fine where there is no default", () => {
  // A payment with no destination has nowhere sensible to go.
  assert.equal(problem("wallet:send", ""), "that is not an address");
});

test("a malformed address is refused wherever it appears", () => {
  for (const verb of ["faucet:topUp", "wallet:fundFromOwner", "wallet:send"]) {
    assert.equal(problem(verb, "not-an-address"), "that is not an address", verb);
    assert.equal(problem(verb, "0x123"), "that is not an address", verb);
  }
});

test("a real address is accepted wherever it appears", () => {
  for (const verb of ["faucet:topUp", "wallet:fundFromOwner", "wallet:send"]) {
    assert.equal(problem(verb, ADDR), null, verb);
    assert.equal(problem(verb, ` ${ADDR} `), null, `${verb} with padding`);
  }
});

test("the two forms share one rule, so they cannot disagree again", () => {
  /*
   * The defect was a duplicated check. Both call sites now go through
   * `addressProblem`, and neither tests the address itself — if a second
   * hand-written regex reappears next to a `data-tp="to"` lookup, this is the
   * test that should stop it.
   */
  assert.equal((app.match(/addressProblem\(/g) ?? []).length >= 3, true, "the helper is not shared by both forms");
  assert.equal(
    /querySelector\('\[data-tp="to"\]'\)[\s\S]{0,120}\/\^0x\[0-9a-fA-F\]\{40\}\$\//.test(app),
    false,
    "an address check was written out by hand again instead of using addressProblem",
  );
});
