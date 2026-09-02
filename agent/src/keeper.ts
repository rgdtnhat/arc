/**
 * Keeper decisions: what the agent should do about the pool, and about its own
 * idle cash.
 *
 * Kept as pure functions over plain numbers, deliberately. Both of these are
 * judgement calls that spend money — opening a liquidation auction, moving the
 * operating float into a vault — and the reasoning behind them is worth being
 * able to test without a chain, a fork, or a mocked RPC. The chain-touching
 * parts live in the caller; everything that decides lives here.
 */

const BPS = 10_000n;
const WAD = 10n ** 18n;

/** Health-factor band a Blend-style auction has to leave the borrower in. */
export const HF_TARGET_MIN = 1_030_000_000_000_000_000n; // 1.03e18
export const HF_TARGET_MAX = 1_150_000_000_000_000_000n; // 1.15e18
/** The pool's fixed liquidation bonus, in bps. */
export const LIQ_BONUS_BPS = 1_000n;

// --- liquidation ------------------------------------------------------------

export interface AccountLimits {
  /** USD, pool scale. Where borrowing stops. */
  borrowLimit: bigint;
  /** USD, pool scale. Where seizure starts. */
  liquidationLimit: bigint;
  /** USD, pool scale, weighted by each debt's liability factor. */
  liability: bigint;
}

export interface LiquidationPlan {
  /** Percentage of the borrower's debt to auction, in bps. */
  percentBps: number;
  /** The health factor a full fill would leave them at. */
  healthAfter: bigint;
}

/**
 * Is this account past the seizure line?
 *
 * Note which line. Exceeding the *borrow* limit only means no new debt may be
 * taken on; it is not grounds for seizing anything, and treating it as such is
 * how a borrower who drew to their limit gets liquidated by the next block of
 * interest.
 */
export function isLiquidatable(a: AccountLimits): boolean {
  return a.liability > a.liquidationLimit;
}

/** Health factor as the pool reports it: distance to liquidation, in WAD. */
export function healthFactor(a: AccountLimits): bigint {
  if (a.liability === 0n) return 2n ** 255n; // effectively infinite
  return (a.liquidationLimit * WAD) / a.liability;
}

/**
 * What a full fill of `percentBps` would leave the borrower's health at.
 *
 * Mirrors the contract's `_requireLandsInBand` exactly, in the same
 * multiply-then-divide order, so a percentage this function proposes is one the
 * contract will accept rather than one it rejects a block later.
 */
export function healthAfterFill(args: {
  limits: AccountLimits;
  /** USD value of the debt being auctioned. */
  debtValue: bigint;
  /** USD value of the collateral lot, bonus included. */
  lotValue: bigint;
  collateralLiqFactorBps: bigint;
  debtLFactorBps: bigint;
}): bigint | null {
  const lostLimit = (args.lotValue * args.collateralLiqFactorBps) / BPS;
  const cleared = args.debtLFactorBps === 0n ? 0n : (args.debtValue * BPS) / args.debtLFactorBps;
  const newLimit = args.limits.liquidationLimit > lostLimit ? args.limits.liquidationLimit - lostLimit : 0n;
  const newLiability = args.limits.liability > cleared ? args.limits.liability - cleared : 0n;
  // No debt left is the best outcome available, not an out-of-band one.
  if (newLiability === 0n) return null;
  return (newLimit * WAD) / newLiability;
}

/** The collateral a given debt buys, bonus included, in USD scale. */
export function lotValueFor(debtValue: bigint): bigint {
  return (debtValue * (BPS + LIQ_BONUS_BPS)) / BPS;
}

/**
 * Find a percentage the pool's health band will accept, or `null`.
 *
 * The contract's answer to a bad percentage is a revert, and a revert does not
 * say which direction to move. Searching here means the keeper opens an auction
 * that works on the first attempt instead of bisecting against gas.
 *
 * Steps in whole percent because that is the granularity a human reads on the
 * dashboard, and because the band is wide enough that finer steps buy nothing.
 */
export function planLiquidation(args: {
  limits: AccountLimits;
  /** Total USD value of the debt asset this borrower owes. */
  totalDebtValue: bigint;
  collateralLiqFactorBps: bigint;
  debtLFactorBps: bigint;
  /** USD value of collateral actually available to seize, bonus included. */
  maxLotValue: bigint;
}): LiquidationPlan | null {
  if (!isLiquidatable(args.limits)) return null;
  if (args.totalDebtValue === 0n) return null;

  for (let pct = 100; pct <= 10_000; pct += 100) {
    const debtValue = (args.totalDebtValue * BigInt(pct)) / BPS;
    let lotValue = lotValueFor(debtValue);
    // Never plan to seize more than the borrower actually has.
    if (lotValue > args.maxLotValue) lotValue = args.maxLotValue;
    const hf = healthAfterFill({
      limits: args.limits,
      debtValue,
      lotValue,
      collateralLiqFactorBps: args.collateralLiqFactorBps,
      debtLFactorBps: args.debtLFactorBps,
    });
    // A full clear leaves no residual position for the ceiling to protect.
    if (hf === null) return { percentBps: pct, healthAfter: 0n };
    if (hf >= HF_TARGET_MIN && hf <= HF_TARGET_MAX) return { percentBps: pct, healthAfter: hf };
  }
  return null;
}

// --- auction fills ----------------------------------------------------------

export const AUCTION_HALF_LIFE = 600; // seconds
export const AUCTION_DURATION = 1_200;
export const MIN_BID_BPS = 1_000;

export interface AuctionTerms {
  lotBps: number;
  bidBps: number;
}

/** The lot and bid an auction is offering `elapsed` seconds in. */
export function auctionTerms(elapsed: number): AuctionTerms {
  const t = Math.max(0, Math.floor(elapsed));
  const lotBps = t >= AUCTION_HALF_LIFE ? 10_000 : Math.floor((t * 10_000) / AUCTION_HALF_LIFE);
  let bidBps: number;
  if (t <= AUCTION_HALF_LIFE) bidBps = 10_000;
  else if (t >= AUCTION_DURATION) bidBps = MIN_BID_BPS;
  else bidBps = 10_000 - Math.floor(((t - AUCTION_HALF_LIFE) * (10_000 - MIN_BID_BPS)) / AUCTION_HALF_LIFE);
  return { lotBps, bidBps };
}

/**
 * Should the keeper fill now?
 *
 * The whole point of a descending auction is that it opens at terms nobody
 * would take. A keeper that fills the moment one exists is not participating in
 * price discovery, it is donating: at t=0 it pays the full debt for none of the
 * collateral. So the rule is a margin, not a trigger — wait until what is on
 * offer is worth more than what it costs, by at least `minMarginBps`.
 *
 * @param lotValue USD value of the full collateral lot.
 * @param debtValue USD value of the full debt being auctioned.
 */
export function shouldFill(args: {
  elapsed: number;
  lotValue: bigint;
  debtValue: bigint;
  minMarginBps: number;
}): { fill: boolean; marginBps: number; terms: AuctionTerms } {
  const terms = auctionTerms(args.elapsed);
  const get = (args.lotValue * BigInt(terms.lotBps)) / BPS;
  const pay = (args.debtValue * BigInt(terms.bidBps)) / BPS;
  if (pay === 0n) {
    // Nothing to pay means nothing to weigh — take it.
    return { fill: get > 0n, marginBps: 10_000, terms };
  }
  const marginBps = Number(((get - pay) * BPS) / pay);
  return { fill: marginBps >= args.minMarginBps, marginBps, terms };
}

// --- protecting the agent's own position -------------------------------------

/** Health at which the agent starts unwinding its own borrow. */
export const DELEVERAGE_TRIGGER = 1_100_000_000_000_000_000n; // 1.10e18
/** Health it unwinds back up to. */
export const DELEVERAGE_TARGET = 1_400_000_000_000_000_000n; // 1.40e18

export interface DeleveragePlan {
  action: "none" | "repay" | "topUp";
  /** USD value of debt to repay, pool scale. */
  repayValue: bigint;
  /** USD value of collateral to add, pool scale. */
  topUpValue: bigint;
  healthNow: bigint;
  /** Health the plan would leave the account at. */
  healthAfter: bigint;
  /** True when the plan closes less of the gap than it wanted to. */
  partial: boolean;
  reason: string;
}

/**
 * Liability that has to disappear for health to reach `target`.
 *
 * Health is `liquidationLimit / liability`, so the liability that satisfies a
 * target is `liquidationLimit / target` and the reduction is whatever sits above
 * it.
 */
function liabilityAbove(limits: AccountLimits, target: bigint): bigint {
  if (target === 0n) return 0n;
  const allowed = (limits.liquidationLimit * WAD) / target;
  return limits.liability > allowed ? limits.liability - allowed : 0n;
}

/**
 * Divide, rounding away from zero.
 *
 * Sizing a repayment floors twice — once turning a liability into a debt value,
 * once turning it back — and two floors land the account a few wei under the
 * target it was aiming for. A plan that misses by a rounding error is a plan
 * that fires again on the next tick, so round up and overshoot by one unit.
 */
function ceilDiv(a: bigint, b: bigint): bigint {
  return b === 0n ? 0n : (a + b - 1n) / b;
}

/**
 * Decide whether the agent should unwind its own borrow, and by how much.
 *
 * The keeper already liquidates other people. This is the same arithmetic
 * pointed inward, and it matters more: being liquidated is strictly worse than
 * deleveraging, because the liquidation bonus is paid out of the borrower's
 * collateral. Every unit of health the agent lets slip below 1.0 is a discount
 * it hands to whoever shows up first.
 *
 * So the trigger sits above 1.0, not at it. By the time health reaches 1.0 the
 * auction is already open; acting at 1.10 leaves room for the price move that
 * would otherwise finish the job.
 *
 * Trigger and target are deliberately far apart, for the reason `planSweep` has
 * a dead band: repaying just enough to clear the trigger means the next tick of
 * interest puts the account straight back under it, and the agent pays gas to
 * re-learn that every block.
 *
 * Repaying is preferred over adding collateral. Both restore the ratio, but
 * adding collateral to a position that is failing increases the amount at risk,
 * which is the wrong direction when the reason health fell is that the
 * collateral is worth less than it was.
 */
export function planDeleverage(args: {
  limits: AccountLimits;
  triggerHealth: bigint;
  targetHealth: bigint;
  /** Liability factor of the debt being repaid, bps. */
  debtLFactorBps: bigint;
  /** USD value of debt the agent can actually repay right now. */
  repayableValue: bigint;
  /** Liquidation factor of the collateral it could post, bps. */
  collateralLiqFactorBps?: bigint;
  /** USD value of collateral available to post. */
  topUpAvailableValue?: bigint;
}): DeleveragePlan {
  const { limits, triggerHealth, targetHealth, debtLFactorBps, repayableValue } = args;
  const healthNow = healthFactor(limits);

  const none = (reason: string): DeleveragePlan => ({
    action: "none",
    repayValue: 0n,
    topUpValue: 0n,
    healthNow,
    healthAfter: healthNow,
    partial: false,
    reason,
  });

  if (limits.liability === 0n) return none("no debt to unwind");
  if (healthNow >= triggerHealth) return none("health is above the trigger — nothing to do");

  const needed = liabilityAbove(limits, targetHealth);
  if (needed === 0n) return none("already at or above the target");

  // Repaying debt worth V removes V * BPS / lFactor of liability, so the debt
  // value needed is the inverse of that.
  if (debtLFactorBps > 0n && repayableValue > 0n) {
    const wantDebtValue = ceilDiv(needed * debtLFactorBps, BPS);
    const repayValue = wantDebtValue > repayableValue ? repayableValue : wantDebtValue;
    const clearedLiability = (repayValue * BPS) / debtLFactorBps;
    const after: AccountLimits = {
      ...limits,
      liability: limits.liability > clearedLiability ? limits.liability - clearedLiability : 0n,
    };
    const partial = repayValue < wantDebtValue;
    return {
      action: "repay",
      repayValue,
      topUpValue: 0n,
      healthNow,
      healthAfter: healthFactor(after),
      partial,
      reason: partial
        ? `only ${repayValue} of ${wantDebtValue} is repayable — repaying what there is`
        : `repay ${repayValue} to restore health`,
    };
  }

  // Nothing repayable. Posting collateral is second best, but it beats waiting
  // for the auction.
  const f = args.collateralLiqFactorBps ?? 0n;
  const available = args.topUpAvailableValue ?? 0n;
  if (f > 0n && available > 0n) {
    // Health reaches the target when liquidationLimit is target * liability.
    const wantLimit = ceilDiv(targetHealth * limits.liability, WAD);
    const gap = wantLimit > limits.liquidationLimit ? wantLimit - limits.liquidationLimit : 0n;
    const wantCollateral = ceilDiv(gap * BPS, f);
    const topUpValue = wantCollateral > available ? available : wantCollateral;
    if (topUpValue === 0n) return none("nothing available to post");
    const after: AccountLimits = {
      ...limits,
      liquidationLimit: limits.liquidationLimit + (topUpValue * f) / BPS,
    };
    const partial = topUpValue < wantCollateral;
    return {
      action: "topUp",
      repayValue: 0n,
      topUpValue,
      healthNow,
      healthAfter: healthFactor(after),
      partial,
      reason: partial
        ? `only ${topUpValue} of ${wantCollateral} collateral is available — posting what there is`
        : `post ${topUpValue} of collateral to restore health`,
    };
  }

  return none("under the trigger, but there is nothing to repay and nothing to post");
}

// --- idle float -------------------------------------------------------------

export interface SweepPlan {
  /** Positive: move this much into the vault. Negative: pull this much back. */
  deltaIn: bigint;
  reason: string;
}

/**
 * What to do with the agent's operating cash.
 *
 * The float exists to pay for calls, so the first call on it is liveness: keep
 * enough on hand that the agent never has to wait for a withdrawal to buy
 * something. Everything above that is doing nothing, and a vault deposit is
 * reversible.
 *
 * The band is what stops this thrashing. With a single threshold, a balance
 * hovering at the line would deposit and withdraw on alternating ticks and pay
 * gas for both; `buffer` is the target, and nothing moves until the balance is
 * outside [buffer - tolerance, buffer + tolerance].
 */
export function planSweep(args: {
  /** Spendable balance in the agent's own wallet. */
  wallet: bigint;
  /** What the agent's vault position is currently worth. */
  vault: bigint;
  /** How much to keep on hand for immediate spending. */
  buffer: bigint;
  /** Dead band around the buffer, to stop deposit/withdraw thrash. */
  tolerance: bigint;
  /** Smallest move worth paying gas for. */
  minMove: bigint;
}): SweepPlan {
  const { wallet, vault, buffer, tolerance, minMove } = args;

  if (wallet > buffer + tolerance) {
    const excess = wallet - buffer;
    if (excess < minMove) return { deltaIn: 0n, reason: "idle cash is below the minimum worth moving" };
    return { deltaIn: excess, reason: `${excess} above the buffer is idle — deposit it` };
  }

  if (wallet < buffer - tolerance) {
    const shortfall = buffer - wallet;
    if (vault === 0n) return { deltaIn: 0n, reason: "below buffer, but there is nothing in the vault to pull" };
    const pull = shortfall > vault ? vault : shortfall;
    if (pull < minMove) return { deltaIn: 0n, reason: "shortfall is below the minimum worth moving" };
    return { deltaIn: -pull, reason: `${pull} short of the buffer — withdraw it` };
  }

  return { deltaIn: 0n, reason: "inside the band — nothing to do" };
}
