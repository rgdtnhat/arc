import { auctionTerms, fillPreview, AUCTION_DURATION, type AuctionTerms } from "./auction.ts";

/**
 * The public list of positions worth liquidating, and what taking one is worth.
 *
 * ## Why publish it
 * The keeper in this project deleverages *our* agent. That is a wholly different
 * job from keeping the pool solvent, and conflating them was hiding a real
 * dependency: liquidations happened because we were running a bot, so the pool's
 * solvency rested on our uptime. Nobody else could have stepped in, because
 * nobody else could see which positions were open, what the auction clock said,
 * or whether a fill would be profitable — all of it required reconstructing pool
 * internals from scratch.
 *
 * A third party will run a keeper for the same reason anyone runs one: it pays.
 * What they need first is a feed. The economics of a Dutch auction do the rest —
 * the discount widens until somebody takes it, so a published list with honest
 * numbers is most of the incentive design.
 *
 * ## What "profitable" means here, and what it leaves out
 * `profitUsd` is the on-chain edge: collateral received minus debt repaid, both
 * marked at the pool's own prices. It deliberately does not model gas, slippage
 * on unwinding the seized collateral, or the price moving between simulating and
 * landing. A keeper's real threshold is higher than zero and only that keeper
 * knows by how much, so this reports the raw edge and lets them apply their own
 * margin rather than baking in an assumption that would be wrong for everyone.
 */

/** A position the pool would let somebody liquidate. */
export interface LiquidatablePosition {
  user: `0x${string}`;
  /** WAD. Below 1e18 the position is under water. */
  healthWad: bigint;
  /** Total debt, in USD at 1e8 — the pool's own price scale. */
  debtUsd: bigint;
  /** Total collateral, same scale. */
  collateralUsd: bigint;
  /** Seconds since the auction opened; null if none has been started. */
  auctionElapsed: number | null;
  /**
   * How much of the auction has already been taken, in bps.
   *
   * Carried through because a fill is a share of what *remains*, not of the
   * original — quoting against the original would overstate an auction that is
   * already 60% gone by more than double.
   */
  filledBps?: number;
}

export interface KeeperOpportunity extends LiquidatablePosition {
  /** Whether an auction exists yet, or someone must open one first. */
  auctionOpen: boolean;
  terms: AuctionTerms | null;
  /** Debt repaid and collateral seized for a full fill, at current terms. */
  repayUsd: bigint;
  seizeUsd: bigint;
  /** seize - repay. Negative means taking it now loses money. */
  profitUsd: bigint;
  /** Positive fraction of the repayment. Useful for ranking across sizes. */
  profitBps: number;
  /** Seconds until the auction hits its floor and stops improving. */
  secondsToFloor: number | null;
  /** Why a keeper might act, or why not. */
  note: string;
}

export const LIQUIDATION_THRESHOLD_WAD = 1_000_000_000_000_000_000n; // 1.0

/**
 * Turn raw positions into ranked opportunities.
 *
 * Sorted by absolute profit rather than by health: the least healthy position is
 * not the most worth taking, and a keeper deciding where to spend one
 * transaction cares about the size of the edge, not the depth of the distress.
 */
export function rankOpportunities(positions: LiquidatablePosition[]): KeeperOpportunity[] {
  return positions
    .filter((p) => p.healthWad > 0n && p.healthWad < LIQUIDATION_THRESHOLD_WAD)
    .map(toOpportunity)
    .sort((a, b) => {
      if (a.profitUsd === b.profitUsd) return b.profitBps - a.profitBps;
      return a.profitUsd > b.profitUsd ? -1 : 1;
    });
}

function toOpportunity(p: LiquidatablePosition): KeeperOpportunity {
  const auctionOpen = p.auctionElapsed !== null;

  if (!auctionOpen) {
    // Nothing to fill yet. Someone has to call startLiquidationAuction first,
    // and that call is free to make and pays nothing on its own — worth saying
    // plainly, because a keeper that expects a reward for it will be surprised.
    return {
      ...p,
      auctionOpen: false,
      terms: null,
      repayUsd: 0n,
      seizeUsd: 0n,
      profitUsd: 0n,
      profitBps: 0,
      secondsToFloor: null,
      note: "No auction yet — anyone may open one; opening it pays nothing by itself.",
    };
  }

  const elapsed = p.auctionElapsed!;
  const terms = auctionTerms(elapsed);
  // 10_000 means "all of what is left", which is what a keeper sizing up an
  // opportunity wants to know — not all of what the auction originally offered.
  const { repay, seize } = fillPreview(p.debtUsd, p.collateralUsd, p.filledBps ?? 0, 10_000, terms);

  const profit = seize - repay;
  const profitBps = repay === 0n ? 0 : Number((profit * 10_000n) / repay);
  const secondsToFloor = Math.max(0, AUCTION_DURATION - elapsed);

  let note: string;
  if (profit > 0n) {
    note =
      secondsToFloor > 0
        ? `Profitable now; the discount still widens for ${secondsToFloor}s.`
        : "Profitable, and at the auction floor — it will not improve further.";
  } else if (secondsToFloor > 0) {
    note = `Not yet profitable; the bid decays for another ${secondsToFloor}s.`;
  } else {
    note = "At the floor and still unprofitable — this is the bad-debt case.";
  }

  return {
    ...p,
    auctionOpen: true,
    terms,
    repayUsd: repay,
    seizeUsd: seize,
    profitUsd: profit,
    profitBps,
    secondsToFloor,
    note,
  };
}

/**
 * The subset a keeper would actually act on right now.
 *
 * `minProfitUsd` is the keeper's own margin — gas, slippage, and how much the
 * price can move between simulating and landing. Defaulted to zero rather than
 * to a guess, because a wrong default here silently hides opportunities from
 * everyone who trusted it.
 */
export function actionable(opps: KeeperOpportunity[], minProfitUsd = 0n): KeeperOpportunity[] {
  return opps.filter((o) => o.auctionOpen && o.profitUsd > minProfitUsd);
}

/** Positions with an auction at the floor that still nobody would take. */
export function badDebt(opps: KeeperOpportunity[]): KeeperOpportunity[] {
  return opps.filter((o) => o.auctionOpen && o.secondsToFloor === 0 && o.profitUsd <= 0n);
}
