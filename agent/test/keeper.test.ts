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
  planDeleverage,
  DELEVERAGE_TRIGGER,
  DELEVERAGE_TARGET,
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

// --- protecting the agent's own position -------------------------------------
//
// Being liquidated is strictly worse than deleveraging: the liquidation bonus
// comes out of the borrower's collateral. These pin that the agent acts while
// that is still avoidable.

const WAD = 10n ** 18n;
/**
 * 1 cirBTC marked to $27,500 (80% liquidation factor) against a 20,000 USDC
 * debt. Health lands at ~1.04: still solvent, no auction possible yet, and
 * already past the point where the agent should be doing something.
 */
const TIGHT = {
  liquidationLimit: USD(22_000),
  borrowLimit: USD(19_250),
  liability: (USD(20_000) * 10_000n) / 9_500n,
};

test("does nothing while health is above the trigger", () => {
  const healthy = { liquidationLimit: USD(24_000), borrowLimit: USD(21_000), liability: USD(10_000) };
  const p = planDeleverage({
    limits: healthy,
    triggerHealth: DELEVERAGE_TRIGGER,
    targetHealth: DELEVERAGE_TARGET,
    debtLFactorBps: 9_500n,
    repayableValue: USD(50_000),
  });
  assert.equal(p.action, "none");
  assert.equal(p.repayValue, 0n);
});

test("does nothing when there is no debt at all", () => {
  const p = planDeleverage({
    limits: { liquidationLimit: USD(24_000), borrowLimit: USD(21_000), liability: 0n },
    triggerHealth: DELEVERAGE_TRIGGER,
    targetHealth: DELEVERAGE_TARGET,
    debtLFactorBps: 9_500n,
    repayableValue: USD(50_000),
  });
  assert.equal(p.action, "none");
  assert.match(p.reason, /no debt/);
});

test("acts above 1.0, while liquidation is still avoidable", () => {
  // Health here is ~1.14 — comfortably solvent, and already worth unwinding.
  assert.ok(healthFactor(TIGHT) > WAD);
  assert.ok(healthFactor(TIGHT) < DELEVERAGE_TRIGGER);
  const p = planDeleverage({
    limits: TIGHT,
    triggerHealth: DELEVERAGE_TRIGGER,
    targetHealth: DELEVERAGE_TARGET,
    debtLFactorBps: 9_500n,
    repayableValue: USD(50_000),
  });
  assert.equal(p.action, "repay");
  assert.ok(p.repayValue > 0n);
});

test("repays enough to reach the target, not merely to clear the trigger", () => {
  const p = planDeleverage({
    limits: TIGHT,
    triggerHealth: DELEVERAGE_TRIGGER,
    targetHealth: DELEVERAGE_TARGET,
    debtLFactorBps: 9_500n,
    repayableValue: USD(50_000),
  });
  // Landing on the trigger would put the account back under it on the next
  // tick of interest, and it would pay gas to discover that every block.
  assert.ok(p.healthAfter >= DELEVERAGE_TARGET, `${p.healthAfter} < ${DELEVERAGE_TARGET}`);
  assert.equal(p.partial, false);
});

test("repays what it can when it cannot repay everything", () => {
  const p = planDeleverage({
    limits: TIGHT,
    triggerHealth: DELEVERAGE_TRIGGER,
    targetHealth: DELEVERAGE_TARGET,
    debtLFactorBps: 9_500n,
    repayableValue: USD(500),
  });
  assert.equal(p.action, "repay");
  assert.equal(p.partial, true);
  assert.equal(p.repayValue, USD(500));
  // Partial help is still help: health improves even though it misses target.
  assert.ok(p.healthAfter > p.healthNow);
  assert.ok(p.healthAfter < DELEVERAGE_TARGET);
});

test("prefers repaying to posting more collateral", () => {
  // Both routes are open. Adding collateral to a failing position increases the
  // amount at risk, which is the wrong direction when the collateral is what
  // fell.
  const p = planDeleverage({
    limits: TIGHT,
    triggerHealth: DELEVERAGE_TRIGGER,
    targetHealth: DELEVERAGE_TARGET,
    debtLFactorBps: 9_500n,
    repayableValue: USD(50_000),
    collateralLiqFactorBps: 8_000n,
    topUpAvailableValue: USD(50_000),
  });
  assert.equal(p.action, "repay");
  assert.equal(p.topUpValue, 0n);
});

test("posts collateral only when there is nothing to repay with", () => {
  const p = planDeleverage({
    limits: TIGHT,
    triggerHealth: DELEVERAGE_TRIGGER,
    targetHealth: DELEVERAGE_TARGET,
    debtLFactorBps: 9_500n,
    repayableValue: 0n,
    collateralLiqFactorBps: 8_000n,
    topUpAvailableValue: USD(50_000),
  });
  assert.equal(p.action, "topUp");
  assert.ok(p.topUpValue > 0n);
  assert.ok(p.healthAfter >= DELEVERAGE_TARGET);
});

test("says so plainly when it can do neither", () => {
  const p = planDeleverage({
    limits: TIGHT,
    triggerHealth: DELEVERAGE_TRIGGER,
    targetHealth: DELEVERAGE_TARGET,
    debtLFactorBps: 9_500n,
    repayableValue: 0n,
  });
  assert.equal(p.action, "none");
  assert.match(p.reason, /nothing to repay/);
});

test("acts on a position that is already underwater, rather than giving up", () => {
  // Past the seizure line the agent is being auctioned. Repaying still helps —
  // every unit of health recovered is bonus it does not hand to a liquidator.
  assert.ok(isLiquidatable(UNDERWATER));
  const p = planDeleverage({
    limits: UNDERWATER,
    triggerHealth: DELEVERAGE_TRIGGER,
    targetHealth: DELEVERAGE_TARGET,
    debtLFactorBps: 9_500n,
    repayableValue: USD(50_000),
  });
  assert.equal(p.action, "repay");
  assert.ok(p.healthAfter > p.healthNow);
});

test("the trigger sits above 1.0 and below the target", () => {
  // The band is the whole design: act before the auction opens, and leave
  // enough room that ordinary interest does not immediately re-trigger.
  assert.ok(DELEVERAGE_TRIGGER > WAD);
  assert.ok(DELEVERAGE_TARGET > DELEVERAGE_TRIGGER);
});

test("a plan it carries out leaves the account above the trigger", () => {
  // The property that matters end to end: after acting, the agent is not
  // immediately back in the same place.
  const p = planDeleverage({
    limits: TIGHT,
    triggerHealth: DELEVERAGE_TRIGGER,
    targetHealth: DELEVERAGE_TARGET,
    debtLFactorBps: 9_500n,
    repayableValue: USD(50_000),
  });
  const after = {
    ...TIGHT,
    liability: TIGHT.liability - (p.repayValue * 10_000n) / 9_500n,
  };
  const settled = planDeleverage({
    limits: after,
    triggerHealth: DELEVERAGE_TRIGGER,
    targetHealth: DELEVERAGE_TARGET,
    debtLFactorBps: 9_500n,
    repayableValue: USD(50_000),
  });
  assert.equal(settled.action, "none");
});
