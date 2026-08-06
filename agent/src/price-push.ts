/**
 * Keeping the pool's prices honest, from the market feed the app already has.
 *
 * ## The problem
 * `addReserve` bakes a USD price in at deployment and nothing moves it. cirBTC
 * has therefore been worth exactly $95,000 since the day it was listed, whatever
 * bitcoin actually did. That is not a display quirk: this number sets every
 * borrow limit and every liquidation threshold, so a stale mark is a standing
 * invitation to borrow against collateral the pool is overvaluing — or to be
 * liquidated at a price nobody traded at.
 *
 * ## What this does
 * Turns the app's live feed into a bounded proposal to move the on-chain mark.
 * It is pure: the decisions are all here, the sending lives in the caller. That
 * matters because "should this price change, and by how much" is exactly the
 * logic an attacker would want wrong, and it is much easier to be sure of when
 * it can be tested without a chain.
 *
 * ## Why every update is clamped
 * The feed is an HTTP endpoint. It can be wrong, it can be stale, and it can be
 * attacked — CoinGecko returning 0.01 for bitcoin would, unclamped, mark every
 * cirBTC position to nothing and liquidate the lot in one transaction. So a
 * proposal is refused unless it is *small*, and a genuinely large real move is
 * tracked in steps over hours rather than in one jump. The pool's own risk
 * oracle enforces the same ceiling on-chain (`maxMoveBps`); this is the same
 * rule applied before the transaction is even built, so the operator sees why.
 *
 * A price that has run away from the feed by more than a step therefore takes
 * several intervals to catch up. That is the intended behaviour: a mark that can
 * only move slowly is one an attacker cannot yank, and the slow catch-up is
 * visible in the log rather than silent.
 */

/** The pool's price scale: USD with 8 decimals. */
export const PRICE_SCALE = 100_000_000n;

/** Largest single move, in basis points. Matches the oracle's default. */
export const MAX_MOVE_BPS = 1_000; // 10%

/** Below this, the move is not worth a transaction. */
export const MIN_MOVE_BPS = 25; // 0.25%

/** Refuse to act on a quote older than this. */
export const MAX_QUOTE_AGE_MS = 15 * 60_000;

/** Never propose a price outside this band, whatever the feed says. */
export const SANITY_FLOOR = 1n; // 1e-8 USD
export const SANITY_CEIL = 10_000_000n * PRICE_SCALE; // $10m

export interface PriceProposal {
  asset: `0x${string}`;
  symbol: string;
  /** What the pool currently marks it at, 1e8. */
  current: bigint;
  /** What the feed says, 1e8. */
  target: bigint;
  /** What to actually send — `target`, or a clamped step toward it. */
  next: bigint;
  /** Signed, relative to `current`. */
  moveBps: number;
  clamped: boolean;
  /** Set when nothing should be sent, and why. */
  skip?: string;
}

/** Convert a floating-point feed quote to the pool's integer scale. */
export function toPoolPrice(usd: number): bigint | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  // Round rather than truncate: truncation biases every mark downward, which
  // over many updates walks collateral values quietly toward zero.
  return BigInt(Math.round(usd * Number(PRICE_SCALE)));
}

/**
 * One source's opinion of a price, and how old it is.
 *
 * Named, because when two sources disagree the operator needs to know *which*
 * two — "the feeds disagree" is not something anybody can act on.
 */
export interface Quote {
  source: string;
  usd: number | null;
  ageMs?: number;
}

/** How far two independent sources may sit apart before neither is trusted. */
export const MAX_SOURCE_SPREAD_BPS = 200; // 2%

export interface CrossCheck {
  /** The agreed price, or null when there is no usable agreement. */
  usd: number | null;
  /** Which sources actually answered. */
  used: string[];
  spreadBps: number;
  /** Set when the answer is null, saying why in terms an operator can act on. */
  reason?: string;
}

/**
 * Agree a price across independent sources, or refuse.
 *
 * ## Why one feed is not enough
 * A clamp bounds how fast a wrong price moves; it does not stop it moving. A
 * single compromised or malfunctioning feed still walks the mark 10% a round,
 * every round, and every round is a fresh chance to borrow against it. That is
 * the shape of the KelpDAO compromise in April 2026: not a contract bug, but a
 * single verifier fed by infrastructure an attacker could reach, and $292m
 * behind it.
 *
 * ## What agreement means here
 * The **median** of the sources that answered, and only if the extremes sit
 * within `MAX_SOURCE_SPREAD_BPS` of each other. Median rather than mean so one
 * source cannot drag the result by being wrong by a lot — with three sources it
 * takes two compromised feeds to move the answer at all, and with two it takes
 * agreement between them.
 *
 * Disagreement returns null rather than picking a winner. There is no rule for
 * choosing between two sources that contradict each other which is not really a
 * guess, and a guess is exactly what should not be setting a borrow limit. A
 * refused update leaves the previous mark standing, which is the safe direction:
 * stale is a known quantity, wrong is not.
 */
export function crossCheck(quotes: Quote[], maxSpreadBps = MAX_SOURCE_SPREAD_BPS): CrossCheck {
  const usable = quotes.filter(
    (q) => q.usd !== null && Number.isFinite(q.usd) && q.usd > 0 && (q.ageMs ?? 0) <= MAX_QUOTE_AGE_MS,
  );
  const used = usable.map((q) => q.source);

  if (usable.length === 0) return { usd: null, used, spreadBps: 0, reason: "no source answered" };
  if (usable.length === 1) {
    // Deliberately allowed, and deliberately named. A second source is better,
    // but refusing to price anything the moment one feed is down would hand an
    // attacker a denial-of-service: knock out one endpoint and the marks freeze.
    // The clamp is still doing its job underneath.
    return { usd: usable[0]!.usd, used, spreadBps: 0, reason: `only ${used[0]} answered — uncorroborated` };
  }

  const sorted = [...usable].map((q) => q.usd as number).sort((a, b) => a - b);
  const low = sorted[0]!;
  const high = sorted[sorted.length - 1]!;
  const spreadBps = Math.round(((high - low) / low) * 10_000);
  if (spreadBps > maxSpreadBps) {
    return {
      usd: null,
      used,
      spreadBps,
      reason: `sources disagree by ${(spreadBps / 100).toFixed(2)}% (${used.join(" vs ")}) — not repricing on a guess`,
    };
  }

  const mid = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]!
    : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return { usd: mid, used, spreadBps };
}

/**
 * `proposePrice`, fed by several sources instead of one.
 *
 * The clamp, the sanity band and the staleness rule all still apply — this only
 * changes where the target number comes from. Two independent defences in
 * series: agreement decides *whether* to move, the clamp decides *how far*.
 */
export function proposeFromSources(args: {
  asset: `0x${string}`;
  symbol: string;
  current: bigint;
  quotes: Quote[];
  maxSpreadBps?: number;
  maxMoveBps?: number;
  minMoveBps?: number;
}): PriceProposal & { sources: string[]; spreadBps: number } {
  const agreed = crossCheck(args.quotes, args.maxSpreadBps);
  const p = proposePrice({
    asset: args.asset,
    symbol: args.symbol,
    current: args.current,
    marketUsd: agreed.usd,
    maxMoveBps: args.maxMoveBps,
    minMoveBps: args.minMoveBps,
  });
  return {
    ...p,
    // A refusal to agree is the more useful thing to report, so it wins.
    skip: agreed.usd === null ? agreed.reason : p.skip,
    sources: agreed.used,
    spreadBps: agreed.spreadBps,
  };
}

/**
 * Decide what, if anything, to send for one asset.
 *
 * @param quoteAgeMs how old the feed's answer is. A stale quote is refused
 *        rather than used, because the failure it guards against — a feed that
 *        froze mid-crash — is precisely when a wrong mark does the most damage.
 */
export function proposePrice(args: {
  asset: `0x${string}`;
  symbol: string;
  current: bigint;
  marketUsd: number | null;
  quoteAgeMs?: number;
  maxMoveBps?: number;
  minMoveBps?: number;
}): PriceProposal {
  const {
    asset,
    symbol,
    current,
    marketUsd,
    quoteAgeMs = 0,
    maxMoveBps = MAX_MOVE_BPS,
    minMoveBps = MIN_MOVE_BPS,
  } = args;

  const base: PriceProposal = {
    asset,
    symbol,
    current,
    target: current,
    next: current,
    moveBps: 0,
    clamped: false,
  };

  const target = marketUsd === null ? null : toPoolPrice(marketUsd);
  if (target === null) return { ...base, skip: "no market quote for this asset" };
  if (quoteAgeMs > MAX_QUOTE_AGE_MS) {
    return { ...base, target, skip: `quote is ${Math.round(quoteAgeMs / 60_000)}m old` };
  }
  if (target < SANITY_FLOOR || target > SANITY_CEIL) {
    return { ...base, target, skip: "quote is outside the sanity band — treating the feed as broken" };
  }
  if (current === 0n) {
    // Nothing to measure a move against. Seeding a price from a feed is a
    // deliberate act, not something a routine keeper should do silently.
    return { ...base, target, skip: "the pool has no price for this asset yet — set the first one by hand" };
  }

  const diff = target - current;
  const moveBps = Number((diff * 10_000n) / current);
  if (Math.abs(moveBps) < minMoveBps) {
    return { ...base, target, moveBps, skip: "already within tolerance" };
  }

  // Clamp toward the target rather than refusing outright: a real 30% move
  // should still be tracked, three steps at a time, instead of leaving the mark
  // frozen exactly when it matters most.
  const limit = (current * BigInt(maxMoveBps)) / 10_000n;
  const clamped = diff > limit || diff < -limit;
  const next = clamped ? (diff > 0n ? current + limit : current - limit) : target;

  return {
    asset,
    symbol,
    current,
    target,
    next,
    moveBps,
    clamped,
  };
}

/** Everything that should be sent this round, largest move first. */
export function actionable(proposals: PriceProposal[]): PriceProposal[] {
  return proposals
    .filter((p) => !p.skip && p.next !== p.current)
    .sort((a, b) => Math.abs(b.moveBps) - Math.abs(a.moveBps));
}

/**
 * How many rounds it would take to close the gap at the current step size.
 *
 * Shown to the operator so a clamped update reads as "tracking, 3 rounds out"
 * rather than "the price is wrong and nothing is happening".
 */
export function roundsToTarget(p: PriceProposal, maxMoveBps = MAX_MOVE_BPS): number {
  if (p.skip || p.current === 0n) return 0;
  const ratio = Number(p.target) / Number(p.current);
  if (ratio <= 0) return 0;
  const step = Math.log(1 + maxMoveBps / 10_000);
  return Math.max(1, Math.ceil(Math.abs(Math.log(ratio)) / step));
}
