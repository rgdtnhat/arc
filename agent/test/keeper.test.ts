import test from "node:test";
import assert from "node:assert/strict";
import {
  isLiquidatable,
  healthFactor,
  planLiquidation,
  lotValueFor,
  auctionTerms,
  shouldFill,
  planSweep,
  HF_TARGET_MIN,
  HF_TARGET_MAX,
  AUCTION_HALF_LIFE,
  AUCTION_DURATION,
  MIN_BID_BPS,
} from "../src/keeper.ts";

const USD = (n: number) => BigInt(Math.round(n * 1e8));
const U = (n: number) => BigInt(Math.round(n * 1e6));

/** 1 cirBTC marked to $22,000 against an 18,000 USDC debt. */
const UNDERWATER = {
  liquidationLimit: USD(17_600),
  borrowLimit: USD(15_400),
  liability: (USD(18_000) * 10_000n) / 9_500n,
};

test("liquidation is gated on the seizure line, not the borrow line", () => {
  // Exceeding the borrow limit only means no new debt. Treating it as grounds
  // for seizure is how a borrower who drew to their limit gets liquidated by
  // the next block of interest.
  const drawnToLimit = { borrowLimit: USD(1_000), liquidationLimit: USD(1_100), liability: USD(1_050) };
  assert.equal(drawnToLimit.liability > drawnToLimit.borrowLimit, true);
  assert.equal(isLiquidatable(drawnToLimit), false);

  assert.equal(isLiquidatable(UNDERWATER), true);
});

test("health factor measures distance to liquidation", () => {
  assert.ok(healthFactor(UNDERWATER) < 10n ** 18n);
  const noDebt = { borrowLimit: USD(100), liquidationLimit: USD(110), liability: 0n };
  assert.ok(healthFactor(noDebt) > 10n ** 30n);
});

const PLAN_ARGS = {
  limits: UNDERWATER,
  totalDebtValue: USD(18_000),
  collateralLiqFactorBps: 8_000n,
  debtLFactorBps: 9_500n,
  maxLotValue: USD(22_000),
};

test("plans a percentage the pool's band will accept", () => {
  const plan = planLiquidation(PLAN_ARGS);
  assert.ok(plan, "a workable percentage exists");
  assert.ok(plan!.percentBps > 0 && plan!.percentBps <= 10_000);
  if (plan!.healthAfter !== 0n) {
    assert.ok(plan!.healthAfter >= HF_TARGET_MIN, "not under-liquidating");
    assert.ok(plan!.healthAfter <= HF_TARGET_MAX, "not over-liquidating");
  }
});

test("picks the smallest percentage that works", () => {
  const plan = planLiquidation(PLAN_ARGS)!;
  // Anything smaller would leave them liquidatable again on the next tick of
  // interest — which is how a borrower gets seized repeatedly for one episode
  // of distress.
  const smaller = plan.percentBps - 100;
  if (smaller > 0) {
    const debtValue = (PLAN_ARGS.totalDebtValue * BigInt(smaller)) / 10_000n;
    const lostLimit = (lotValueFor(debtValue) * 8_000n) / 10_000n;
    const cleared = (debtValue * 10_000n) / 9_500n;
    const hf =
      ((UNDERWATER.liquidationLimit - lostLimit) * 10n ** 18n) / (UNDERWATER.liability - cleared);
    assert.ok(hf < HF_TARGET_MIN, "the next smaller step really is under the floor");
  }
});

test("plans nothing for a healthy account", () => {
  const healthy = { borrowLimit: USD(1_000), liquidationLimit: USD(1_100), liability: USD(500) };
  assert.equal(planLiquidation({ ...PLAN_ARGS, limits: healthy }), null);
});

test("plans nothing when there is no debt to auction", () => {
  assert.equal(planLiquidation({ ...PLAN_ARGS, totalDebtValue: 0n }), null);
});

test("never plans to seize more collateral than the borrower holds", () => {
  // A borrower whose collateral has almost vanished: the lot is capped, so a
  // plan built on the uncapped figure would be rejected by the contract.
  const plan = planLiquidation({ ...PLAN_ARGS, maxLotValue: USD(500) });
  if (plan) {
    const debtValue = (PLAN_ARGS.totalDebtValue * BigInt(plan.percentBps)) / 10_000n;
    assert.ok(lotValueFor(debtValue) >= USD(500) || plan.healthAfter === 0n);
  }
});

test("the auction opens at terms nobody would take", () => {
  const t = auctionTerms(0);
  assert.equal(t.lotBps, 0);
  assert.equal(t.bidBps, 10_000);
});

test("the midpoint is the fair exchange, and the bid never reaches zero", () => {
  const mid = auctionTerms(AUCTION_HALF_LIFE);
  assert.equal(mid.lotBps, 10_000);
  assert.equal(mid.bidBps, 10_000);

  assert.equal(auctionTerms(AUCTION_DURATION).bidBps, MIN_BID_BPS);
  assert.equal(auctionTerms(86_400).bidBps, MIN_BID_BPS);
});

test("the keeper does not fill at the open — that would be a donation", () => {
  // At t=0 it would pay the whole debt for none of the collateral. A keeper
  // that fills the moment an auction exists is not participating in price
  // discovery.
  const r = shouldFill({ elapsed: 0, lotValue: USD(11_000), debtValue: USD(10_000), minMarginBps: 200 });
  assert.equal(r.fill, false);
  assert.equal(r.terms.lotBps, 0);
});

test("the keeper waits for a real margin, then fills", () => {
  const args = { lotValue: USD(11_000), debtValue: USD(10_000), minMarginBps: 500 };
  const early = shouldFill({ ...args, elapsed: 60 });
  assert.equal(early.fill, false);

  const fair = shouldFill({ ...args, elapsed: AUCTION_HALF_LIFE });
  // At the midpoint the whole lot is on offer for the whole debt: a 10% bonus
  // pool gives exactly the 10% margin.
  assert.ok(fair.marginBps >= 500, `margin was ${fair.marginBps}`);
  assert.equal(fair.fill, true);
});

test("margin only improves as the auction runs", () => {
  const args = { lotValue: USD(11_000), debtValue: USD(10_000), minMarginBps: 0 };
  let last = -1_000_000;
  for (let t = AUCTION_HALF_LIFE; t <= AUCTION_DURATION; t += 30) {
    const m = shouldFill({ ...args, elapsed: t }).marginBps;
    assert.ok(m >= last, `margin fell at ${t}s`);
    last = m;
  }
});

test("a position deep underwater never reaches the keeper's margin until late", () => {
  // The lot is worth less than the debt: no fill is profitable at the midpoint,
  // and the keeper correctly waits rather than taking a loss to be helpful.
  const args = { lotValue: USD(6_000), debtValue: USD(10_000), minMarginBps: 200 };
  assert.equal(shouldFill({ ...args, elapsed: AUCTION_HALF_LIFE }).fill, false);
  assert.equal(shouldFill({ ...args, elapsed: AUCTION_DURATION }).fill, true);
});

test("sweeps idle cash into the vault", () => {
  const p = planSweep({ wallet: U(500), vault: 0n, buffer: U(100), tolerance: U(20), minMove: U(10) });
  assert.equal(p.deltaIn, U(400));
});

test("pulls cash back when the float runs low", () => {
  const p = planSweep({ wallet: U(30), vault: U(400), buffer: U(100), tolerance: U(20), minMove: U(10) });
  assert.equal(p.deltaIn, -U(70));
});

test("does nothing inside the band, so it cannot thrash", () => {
  // With a single threshold, a balance hovering at the line would deposit and
  // withdraw on alternating ticks and pay gas for both.
  for (const wallet of [U(85), U(100), U(115)]) {
    const p = planSweep({ wallet, vault: U(400), buffer: U(100), tolerance: U(20), minMove: U(1) });
    assert.equal(p.deltaIn, 0n, `moved at ${wallet}`);
  }
});

test("will not pay gas to move dust", () => {
  const p = planSweep({ wallet: U(125), vault: 0n, buffer: U(100), tolerance: U(20), minMove: U(50) });
  assert.equal(p.deltaIn, 0n);
  assert.match(p.reason, /minimum worth moving/);
});

test("pulls only what the vault actually holds", () => {
  const p = planSweep({ wallet: U(10), vault: U(25), buffer: U(500), tolerance: U(20), minMove: U(1) });
  assert.equal(p.deltaIn, -U(25));
});

test("says so rather than failing when the vault is empty", () => {
  const p = planSweep({ wallet: U(10), vault: 0n, buffer: U(500), tolerance: U(20), minMove: U(1) });
  assert.equal(p.deltaIn, 0n);
  assert.match(p.reason, /nothing in the vault/);
});
