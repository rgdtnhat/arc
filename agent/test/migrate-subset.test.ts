import test from "node:test";
import assert from "node:assert/strict";
import { planMigration, affordability, narrowPlan } from "../src/migrate.ts";

/**
 * The operator carries everybody else, and leaves its own wallet out.
 *
 * `supplyFor` re-creates a position out of the operator's tokens and leaves the
 * original where it is — deliberately, because the emitter sizes emissions from
 * the retired pool's balances. The consequence is that the operator funds a
 * second copy of every position it carries across, and on this deployment one
 * of those was the app wallet's own 47,650 TSRA supply. The migration was
 * unfinishable: the deployer held 0.11 TSRA and the affordability check
 * correctly refused, every run, for ever.
 *
 * The app wallet holds its own keys and `withdraw` is not frozen on the retired
 * pool, so it can move itself for nothing. Leaving it out of the operator's
 * plan turns a 47,650 TSRA bill into 29 USDC.
 */

const A = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;
const APP = A("a");
const USER = A("b");
const USDC = A("c");
const TSRA = A("d");

const source = [
  { user: APP, asset: TSRA, supplied: 47_650_000_000_000_000_000_000n, borrowed: 0n },
  { user: APP, asset: USDC, supplied: 36_000_000n, borrowed: 0n },
  { user: USER, asset: USDC, supplied: 23_000_000n, borrowed: 0n },
];

test("excluding one address drops its steps and re-prices the plan", () => {
  const plan = planMigration(source, []);
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.cost.get(TSRA), 47_650_000_000_000_000_000_000n);

  const narrowed = narrowPlan(plan, { except: [APP] });
  assert.equal(narrowed.steps.length, 1);
  assert.equal(narrowed.steps[0].user, USER);
  /*
   * The cost has to be re-derived, not carried over. An affordability check
   * against the unfiltered total would refuse a migration the operator can
   * plainly afford — which is the exact failure this exists to get past.
   */
  assert.equal(narrowed.cost.get(TSRA), undefined, "the excluded address's cost survived");
  assert.equal(narrowed.cost.get(USDC), 23_000_000n);
});

test("an unaffordable plan becomes affordable once the app wallet is left out", () => {
  const plan = planMigration(source, []);
  const balances = new Map([[USDC, 1_000_000_000n], [TSRA, 109_769_377_388_590_580n]]);

  assert.equal(affordability(plan, balances).ok, false, "the whole plan should not be affordable");
  assert.equal(affordability(narrowPlan(plan, { except: [APP] }), balances).ok, true);
});

test("--only is the other direction of the same filter", () => {
  const plan = planMigration(source, []);
  const only = narrowPlan(plan, { only: [USER] });
  assert.equal(only.steps.length, 1);
  assert.equal(only.steps[0].user, USER);
});

test("addresses match regardless of case", () => {
  const plan = planMigration(source, []);
  const narrowed = narrowPlan(plan, { except: [APP.toUpperCase()] });
  assert.equal(narrowed.steps.length, 1, "a checksummed address failed to match");
});

test("no filter is a no-op, and the same object comes back", () => {
  const plan = planMigration(source, []);
  assert.equal(narrowPlan(plan, {}), plan);
});

test("who is being left behind stays whole", () => {
  /*
   * `blockedByDebt` is the list of people the migration knowingly does not
   * move. Narrowing it would hide them, and the whole reason it is printed is
   * that somebody has to know.
   */
  const withDebt = [...source, { user: A("e"), asset: USDC, supplied: 5_000_000n, borrowed: 1n }];
  const plan = planMigration(withDebt, []);
  assert.equal(plan.blockedByDebt.length, 1);
  assert.equal(narrowPlan(plan, { except: [APP] }).blockedByDebt.length, 1);
});

test("only and except together is a mistake, not a merge", () => {
  const plan = planMigration(source, []);
  assert.throws(() => narrowPlan(plan, { only: [USER], except: [APP] }));
});
