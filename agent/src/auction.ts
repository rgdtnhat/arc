/**
 * The arithmetic of a descending liquidation auction, kept out of the route.
 *
 * A liquidator does not decide on "lot 62%, bid 100%". They decide on "I pay
 * this much and receive that much". Turning the one into the other is a few
 * lines, but they are the few lines that decide whether someone takes the trade,
 * so they belong somewhere they can be tested rather than inline in an HTTP
 * handler where the only way to exercise them is to run a chain.
 *
 * Mirrors `TesseraPool.auctionTerms` / `fillLiquidationAuction`: the same
 * ordering of multiply-then-divide, so this preview and the contract's own
 * result agree to the wei rather than drifting by a rounding step.
 */

export const BPS = 10_000n;

/** Auction constants, matching the contract. */
export const AUCTION_HALF_LIFE = 600; // seconds
export const AUCTION_DURATION = 1_200; // seconds
export const MIN_BID_BPS = 1_000;

export interface AuctionTerms {
  /** Share of the collateral lot on offer, in bps. */
  lotBps: number;
  /** Share of the debt a filler must repay, in bps. */
  bidBps: number;
}

/**
 * The terms an auction is offering `elapsed` seconds in.
 *
 * First half: the lot climbs 0% → 100% at a full bid, so an early filler
 * overpays. Second half: the lot is full and the bid decays toward the floor,
 * so a late one is being paid to take the position on. The clearing point in
 * between is the market's answer rather than an operator's guess.
 */
export function auctionTerms(elapsed: number): AuctionTerms {
  const t = Math.max(0, Math.floor(elapsed));
  const lotBps = t >= AUCTION_HALF_LIFE ? 10_000 : Math.floor((t * 10_000) / AUCTION_HALF_LIFE);
  let bidBps: number;
  if (t <= AUCTION_HALF_LIFE) {
    bidBps = 10_000;
  } else if (t >= AUCTION_DURATION) {
    bidBps = MIN_BID_BPS;
  } else {
    const decayed = Math.floor(((t - AUCTION_HALF_LIFE) * (10_000 - MIN_BID_BPS)) / AUCTION_HALF_LIFE);
    bidBps = 10_000 - decayed;
  }
  return { lotBps, bidBps };
}

export interface FillPreview {
  /** Debt the filler repays, in the debt asset's base units. */
  repay: bigint;
  /** Collateral the filler receives, in the collateral asset's base units. */
  seize: bigint;
}

/**
 * What taking `fillBps` of what remains would cost and pay, at these terms.
 *
 * `fillBps` is a share of the **remaining** auction, not of the original — a
 * fill of 100% against an auction that is already 60% gone takes the last 40%.
 * That is the contract's own convention and getting it backwards in a preview
 * would quote a liquidator more than twice what they will actually pay.
 */
export function fillPreview(
  debtAmount: bigint,
  collateralAmount: bigint,
  filledBps: number,
  fillBps: number,
  terms: AuctionTerms,
): FillPreview {
  const remaining = 10_000 - Math.min(10_000, Math.max(0, filledBps));
  const take = BigInt(Math.min(remaining, Math.min(10_000, Math.max(0, fillBps))));
  if (take === 0n) return { repay: 0n, seize: 0n };
  return {
    repay: ((debtAmount * take) / BPS) * BigInt(terms.bidBps) / BPS,
    seize: ((collateralAmount * take) / BPS) * BigInt(terms.lotBps) / BPS,
  };
}

/**
 * Whether a percentage of a borrower's debt would land them in the health band
 * a full fill has to leave them in.
 *
 * Used to suggest a workable percentage before the transaction, because the
 * contract's answer is a revert and a revert does not say which direction to
 * move. All values are in the pool's USD scale; `liqFactor` and `lFactor` are
 * bps, as stored.
 */
export const HF_TARGET_MIN = 1_030_000_000_000_000_000n; // 1.03e18
export const HF_TARGET_MAX = 1_150_000_000_000_000_000n; // 1.15e18
const WAD = 10n ** 18n;
const LIQ_BONUS = 1_000n;

export function healthAfterFullFill(args: {
  liquidationLimit: bigint;
  liability: bigint;
  /** USD value of the debt being auctioned. */
  debtValue: bigint;
  /** USD value of the collateral lot, bonus included. */
  lotValue: bigint;
  collateralLiqFactorBps: bigint;
  debtLFactorBps: bigint;
}): { healthFactor: bigint | null; inBand: boolean } {
  const lostLimit = (args.lotValue * args.collateralLiqFactorBps) / BPS;
  const cleared = args.debtLFactorBps === 0n ? 0n : (args.debtValue * BPS) / args.debtLFactorBps;
  const newLimit = args.liquidationLimit > lostLimit ? args.liquidationLimit - lostLimit : 0n;
  const newLiability = args.liability > cleared ? args.liability - cleared : 0n;
  // No debt left is the best outcome available, not an out-of-band one — there
  // is no residual position for the ceiling to be protecting.
  if (newLiability === 0n) return { healthFactor: null, inBand: true };
  const hf = (newLimit * WAD) / newLiability;
  return { healthFactor: hf, inBand: hf >= HF_TARGET_MIN && hf <= HF_TARGET_MAX };
}

/** The collateral lot a given debt buys, bonus included, in USD scale. */
export function lotValueFor(debtValue: bigint): bigint {
  return (debtValue * (BPS + LIQ_BONUS)) / BPS;
}
