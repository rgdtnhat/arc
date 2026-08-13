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
}): PriceProposal & { sources: string[]; spreadBps: number; agreedUsd: number | null } {
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
    /*
     * The agreed price itself, separately from what it implies for any one
     * writer.
     *
     * `target` cannot stand in for this: when no source answers it falls back
     * to `current`, so "the market says the mark is right" and "nobody could
     * tell us what the market says" arrive as the same number. A second writer
     * reading that would refresh a price on the strength of a feed that never
     * answered, which is the one thing staleness is supposed to catch.
     */
    agreedUsd: agreed.usd,
  };
}

/** The oracle's stored view of one asset, as `configOf` returns it. */
export interface OracleEntry {
  enabled: boolean;
  /** The manual price on record, 1e8. Zero when the asset was never seeded. */
  stored: bigint;
  /** Unix seconds of the last manual write. */
  updatedAt: number;
  /** Seconds after which the manual price stops counting as a source at all. */
  maxAge: number;
  /** Shortest gap the oracle will accept between manual writes. */
  minUpdateInterval: number;
  /** Largest single move the oracle will accept, in bps. */
  maxMoveBps: number;
}

export interface OracleWrite {
  asset: `0x${string}`;
  symbol: string;
  /** What the oracle currently has on record, 1e8. */
  stored: bigint;
  /** What the agreed feed says, 1e8. */
  target: bigint;
  /** What to actually send — `target`, or a clamped step toward it. */
  next: bigint;
  /** Signed, relative to `stored`. */
  moveBps: number;
  clamped: boolean;
  /** Why this is being sent, or null when nothing is. */
  reason: "drift" | "expiring" | null;
  /** Seconds until the stored price stops counting as a source. */
  expiresInS: number;
  /** True once it already has. */
  expired: boolean;
  /** Set when nothing should be sent, and why. */
  skip?: string;
}

/**
 * How much of an entry's life may pass before it is rewritten.
 *
 * Half, so a failed round has as long to recover as it has already used. With
 * the pool's seven-day `maxAge` that is a write every three and a half days per
 * asset — a handful of transactions a week against an outage that takes the
 * whole market down.
 */
export const ORACLE_REFRESH_AT = 0.5;

/**
 * Keep an asset's oracle entry alive, and pointed at the market.
 *
 * ## Why this is a separate decision from the pool's mark
 * There are two prices per asset, written by two different calls.
 * `TesseraPool.setPrice` sets the pool's own mark — the number the dashboard
 * displays. `TesseraOracle.setPrice` sets the manual source behind
 * `riskPrice`, which is what every borrow limit, health factor and liquidation
 * check actually reads.
 *
 * The tracker only ever wrote the first one, so the marks stayed current while
 * the oracle entries aged out on their own seven-day timer. That is not a
 * display problem: with no usable source the pool refuses `borrow`, `withdraw`
 * and `liquidate` outright, which is a frozen market and, worse, an underwater
 * position nobody can seize. It happened — three of four assets expired
 * together, eleven hours before anyone noticed, while the dashboard beside them
 * showed live prices.
 *
 * ## Why a heartbeat and not just a tracker
 * Move-driven updates cannot keep a stablecoin alive. USDC is $1.00 and stays
 * $1.00, so it never clears the "worth a transaction" threshold, never gets
 * written, and expires on schedule every single time. So an entry past
 * `ORACLE_REFRESH_AT` of its life is rewritten whether or not the number
 * changed.
 *
 * ## What it will not do
 * Refresh on a price no source would confirm. Rewriting the stored value when
 * the feed is down would keep the pool trading on a number nothing corroborates
 * and defeat the `maxAge` that exists to stop precisely that. With no agreed
 * quote this reports why and lets the entry expire — a frozen market is the
 * designed failure, and it is the recoverable one.
 */
export function proposeOracleWrite(args: {
  asset: `0x${string}`;
  symbol: string;
  entry: OracleEntry;
  /** The cross-checked price, or null when the sources did not agree. */
  agreedUsd: number | null;
  /** Chain time, in seconds — the clock the oracle's own guards are measured against. */
  nowS: number;
  minMoveBps?: number;
  refreshAt?: number;
}): OracleWrite {
  const { asset, symbol, entry, agreedUsd, nowS } = args;
  const minMoveBps = args.minMoveBps ?? MIN_MOVE_BPS;
  const refreshAt = args.refreshAt ?? ORACLE_REFRESH_AT;

  const age = nowS - entry.updatedAt;
  const expiresInS = entry.maxAge - age;
  const base: OracleWrite = {
    asset,
    symbol,
    stored: entry.stored,
    target: entry.stored,
    next: entry.stored,
    moveBps: 0,
    clamped: false,
    reason: null,
    expiresInS,
    expired: expiresInS <= 0,
  };

  // Each of the next three guards mirrors a revert in `TesseraOracle.setPrice`.
  // Skipping here rather than discovering it on-chain keeps a keeper that runs
  // every ten minutes from burning a transaction every ten minutes.
  if (!entry.enabled) {
    return { ...base, skip: "not configured on the risk oracle — configureAsset seeds it first" };
  }
  if (entry.stored === 0n) {
    // `setPrice` measures every move against the stored value, so there is
    // nothing to move from. Seeding a first price is a deliberate act.
    return { ...base, skip: "the oracle has no price on record for this asset — seed it by hand" };
  }
  const nextAllowedAt = entry.updatedAt + entry.minUpdateInterval;
  if (nowS < nextAllowedAt) {
    return { ...base, skip: `the oracle accepts the next write in ${Math.ceil((nextAllowedAt - nowS) / 60)}m` };
  }

  const target = agreedUsd === null ? null : toPoolPrice(agreedUsd);
  if (target === null) {
    return {
      ...base,
      // Named by urgency: an entry that is about to stop pricing the pool is a
      // different message from one that is merely not being tracked today.
      skip:
        base.expired ? "no agreed quote — the entry has already expired and the pool is refusing new risk"
        : expiresInS <= entry.maxAge * (1 - refreshAt) ? `no agreed quote — the entry expires in ${Math.round(expiresInS / 3600)}h`
        : "no agreed quote for this asset",
    };
  }
  if (target < SANITY_FLOOR || target > SANITY_CEIL) {
    return { ...base, target, skip: "quote is outside the sanity band — treating the feed as broken" };
  }

  const diff = target - entry.stored;
  const moveBps = Number((diff * 10_000n) / entry.stored);
  const limit = (entry.stored * BigInt(entry.maxMoveBps)) / 10_000n;
  const clamped = diff > limit || diff < -limit;
  const next = clamped ? (diff > 0n ? entry.stored + limit : entry.stored - limit) : target;

  const drifted = Math.abs(moveBps) >= minMoveBps;
  const expiring = age >= entry.maxAge * refreshAt;
  if (!drifted && !expiring) {
    return {
      ...base,
      target,
      moveBps,
      skip: `on the market and good for another ${Math.round(expiresInS / 3600)}h`,
    };
  }

  return {
    ...base,
    target,
    next,
    moveBps,
    clamped,
    // Expiry is the more useful headline when both are true: it says the write
    // had a deadline, which is the part an operator reading a log needs.
    reason: expiring ? "expiring" : "drift",
  };
}

/**
 * Every oracle entry that should be written this round, most urgent first.
 *
 * Deliberately not `actionable`: that filters on the value having changed,
 * which would drop the identical-price heartbeat — the one write a stablecoin
 * ever needs. Ordered by how soon the entry stops pricing the pool, so an
 * interrupted round has still done the part that mattered.
 */
export function actionableOracleWrites(writes: OracleWrite[]): OracleWrite[] {
  return writes.filter((w) => !w.skip).sort((a, b) => a.expiresInS - b.expiresInS);
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
