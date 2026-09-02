import test from "node:test";
import assert from "node:assert/strict";
import {
  planMigration,
  affordability,
  verifyMigration,
  validateReserves,
  DUST,
  type Position,
  type ReserveConfig,
} from "../src/migrate.ts";

const A = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const B = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as const;
const C = "0x90f79bf6eb2c4f870365e785982e1f101e93b906" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const EURC = "0x89b50855aa3be2f677cd6303cec089b5f319d72a" as const;

const U = (n: number) => BigInt(Math.round(n * 1e6));
const pos = (o: Partial<Position> = {}): Position => ({
  user: A,
  asset: USDC,
  supplied: U(100),
  borrowed: 0n,
  ...o,
});

// --- planning ---------------------------------------------------------------

test("plans a top-up for every supplier on a first run", () => {
  const plan = planMigration([pos({ user: A, supplied: U(100) }), pos({ user: B, supplied: U(50) })], []);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.cost.get(USDC), U(150));
});

test("re-running tops up the difference rather than doubling the position", () => {
  // The property the whole migration rests on: it will be interrupted against a
  // throttled RPC, and the second run must not pay twice.
  const source = [pos({ user: A, supplied: U(100) })];
  const partial = [pos({ user: A, supplied: U(40) })];
  const plan = planMigration(source, partial);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]!.topUp, U(60));
  assert.equal(plan.steps[0]!.already, U(40));
});

test("does nothing for a position already fully present", () => {
  const source = [pos({ user: A, supplied: U(100) })];
  const plan = planMigration(source, [pos({ user: A, supplied: U(100) })]);
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.alreadyDone, 1);
});

test("does not claw back when the destination somehow holds more", () => {
  // Over-supply is not this script's problem to solve, and a negative top-up
  // would underflow into an enormous one.
  const plan = planMigration([pos({ supplied: U(10) })], [pos({ supplied: U(999) })]);
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.alreadyDone, 1);
});

test("refuses to move a borrower, and says so rather than going quiet", () => {
  // Creating debt for somebody in a new contract without their consent is not a
  // migration; it is signing a loan in their name.
  const plan = planMigration([pos({ user: A, supplied: U(500), borrowed: U(100) })], []);
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.blockedByDebt.length, 1);
  assert.equal(plan.blockedByDebt[0]!.borrowed, U(100));
});

test("blocks a borrower whose debt is in a different asset from their collateral", () => {
  /*
   * The ordinary case, not an exotic one, and the first version got it wrong:
   * a borrower posts cirBTC and draws USDC against it, so the cirBTC row shows
   * `borrowed: 0` and read as perfectly migratable. Moving it would have taken
   * the collateral out from under a live loan — over-collateralised in the new
   * pool, possibly liquidatable in the old one.
   *
   * Caught by the end-to-end chain test, which is why that test exists.
   */
  const plan = planMigration(
    [
      { user: A, asset: EURC, supplied: U(1_000), borrowed: 0n },
      { user: A, asset: USDC, supplied: 0n, borrowed: U(200) },
    ],
    [],
  );
  assert.equal(plan.steps.length, 0, "no part of an indebted account may move");
  assert.equal(plan.blockedByDebt.length, 1);
  assert.equal(plan.blockedByDebt[0]!.asset, USDC, "report the row carrying the debt");
});

test("verification uses the same account-wide debt rule as the plan", () => {
  // Verifying against a different notion of "in scope" than the plan worked to
  // would report a correct migration as a failure.
  const source: Position[] = [
    { user: A, asset: EURC, supplied: U(1_000), borrowed: 0n },
    { user: A, asset: USDC, supplied: 0n, borrowed: U(200) },
  ];
  assert.equal(verifyMigration(source, []).ok, true);
});

test("moves the debt-free suppliers even when a borrower is present", () => {
  const plan = planMigration(
    [pos({ user: A, supplied: U(500), borrowed: U(100) }), pos({ user: B, supplied: U(200) })],
    [],
  );
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]!.user, B);
  assert.equal(plan.blockedByDebt.length, 1);
});

test("skips dust rather than spending a transaction on it", () => {
  const plan = planMigration([pos({ supplied: DUST })], []);
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.skippedDust, 1);
});

test("keeps assets separate in the cost, because they are different tokens", () => {
  const plan = planMigration(
    [pos({ user: A, asset: USDC, supplied: U(100) }), pos({ user: A, asset: EURC, supplied: U(70) })],
    [],
  );
  assert.equal(plan.cost.get(USDC), U(100));
  assert.equal(plan.cost.get(EURC), U(70));
});

test("does the largest positions first", () => {
  // An interrupted run should have done the ones that mattered.
  const plan = planMigration(
    [
      pos({ user: A, supplied: U(1) }),
      pos({ user: B, supplied: U(1_000) }),
      pos({ user: C, supplied: U(50) }),
    ],
    [],
  );
  assert.deepEqual(plan.steps.map((s) => s.user), [B, C, A]);
});

test("matches accounts case-insensitively, because addresses arrive both ways", () => {
  const plan = planMigration(
    [pos({ user: A.toUpperCase().replace("0X", "0x") as typeof A, supplied: U(100) })],
    [pos({ user: A, supplied: U(100) })],
  );
  assert.equal(plan.steps.length, 0, "a checksummed and a lowercase address are the same account");
});

test("an empty source is a complete plan, not an error", () => {
  const plan = planMigration([], []);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.cost.size, 0);
});

// --- affordability ----------------------------------------------------------

test("checks the operator can pay before the first transaction, not the twentieth", () => {
  const plan = planMigration([pos({ supplied: U(100) })], []);
  const short = affordability(plan, new Map([[USDC, U(40)]]));
  assert.equal(short.ok, false);
  assert.equal(short.shortfalls[0]!.short, U(60));

  const fine = affordability(plan, new Map([[USDC, U(100)]]));
  assert.equal(fine.ok, true);
});

test("a missing balance reads as zero, not as unlimited", () => {
  const plan = planMigration([pos({ supplied: U(100) })], []);
  assert.equal(affordability(plan, new Map()).ok, false);
});

// --- verification -----------------------------------------------------------

test("confirms the destination matches the source", () => {
  const source = [pos({ user: A, supplied: U(100) }), pos({ user: B, supplied: U(50) })];
  assert.equal(verifyMigration(source, source).ok, true);
});

test("catches a position that silently did not land", () => {
  // The failure mode worth guarding: a transaction that did not throw but did
  // not do what it meant to, on behalf of somebody who is not watching.
  const source = [pos({ user: A, supplied: U(100) }), pos({ user: B, supplied: U(50) })];
  const dest = [pos({ user: A, supplied: U(100) })];
  const v = verifyMigration(source, dest);
  assert.equal(v.ok, false);
  assert.equal(v.missing[0]!.user, B);
  assert.equal(v.missing[0]!.expected, U(50));
  assert.equal(v.missing[0]!.actual, 0n);
});

test("does not report borrowers or dust as failures — they were never promised", () => {
  const source = [pos({ user: A, supplied: U(500), borrowed: U(1) }), pos({ user: B, supplied: DUST })];
  assert.equal(verifyMigration(source, []).ok, true);
});

test("a destination with more than promised still verifies", () => {
  const source = [pos({ user: A, supplied: U(100) })];
  assert.equal(verifyMigration(source, [pos({ user: A, supplied: U(101) })]).ok, true);
});

// --- reserve validation -----------------------------------------------------

const reserve = (o: Partial<ReserveConfig> = {}): ReserveConfig => ({
  asset: USDC,
  symbol: "USDC",
  decimals: 6,
  cFactor: 9000,
  liqFactor: 9500,
  lFactor: 9500,
  reserveFactor: 1000,
  borrowable: true,
  price: 100_000_000n,
  ...o,
});

test("accepts a sane reserve set", () => {
  assert.deepEqual(validateReserves([reserve()]), []);
});

test("refuses a collateral factor at or above the liquidation factor", () => {
  // The one mistake here that creates bad debt rather than inconvenience.
  assert.ok(validateReserves([reserve({ cFactor: 9500, liqFactor: 9500 })]).length > 0);
  assert.ok(validateReserves([reserve({ cFactor: 9600, liqFactor: 9500 })]).length > 0);
});

test("refuses a zero price, which would value all collateral at nothing", () => {
  assert.ok(validateReserves([reserve({ price: 0n })]).length > 0);
});

test("refuses the same asset listed twice", () => {
  const problems = validateReserves([reserve(), reserve({ symbol: "USDC (again)" })]);
  assert.ok(problems.some((p) => p.includes("twice")));
});

test("refuses an empty reserve set", () => {
  assert.ok(validateReserves([]).length > 0);
});

test("catches out-of-range factors", () => {
  assert.ok(validateReserves([reserve({ cFactor: 0 })]).length > 0);
  assert.ok(validateReserves([reserve({ liqFactor: 10_001 })]).length > 0);
  assert.ok(validateReserves([reserve({ lFactor: 0 })]).length > 0);
  assert.ok(validateReserves([reserve({ reserveFactor: 10_000 })]).length > 0);
});

test("names every problem at once rather than one per run", () => {
  // An operator fixing a reserve table should not have to deploy, fail, fix,
  // and repeat for each field in turn.
  const problems = validateReserves([reserve({ cFactor: 0, price: 0n, decimals: 40 })]);
  assert.ok(problems.length >= 3, `expected several, got ${problems.length}`);
});
