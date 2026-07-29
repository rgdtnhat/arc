/**
 * Price impact on a constant-product swap, and when to refuse one.
 *
 * The reported symptom was "I swap something and receive nothing, only the pool
 * quantities change". That is not a bug in the maths — it is what `x*y=k` does
 * when the trade is large relative to the reserves. A pool holding 11 USDC and
 * 9 EURC cannot give you 400 USDC for 400 EURC; it can only ever give you a
 * fraction approaching its entire USDC balance, so a big order returns almost
 * nothing per unit and moves the ratio violently.
 *
 * The pool cannot be made deep by code. What can be fixed is a UI that quotes
 * such a trade without saying what it costs you. So: compute the impact, show
 * it, and refuse to execute past a threshold unless the trader explicitly
 * overrides — the same guard every serious AMM front-end has, and the reason
 * they exist.
 */

/** Impact above this is shown as a warning. */
export const IMPACT_WARN_PCT = 1;
/** Impact above this is blocked unless the caller passes an explicit override. */
export const IMPACT_MAX_PCT = 15;

export interface Impact {
  /** Marginal price before the trade, out-per-in. */
  spotPrice: number;
  /** Price actually paid across the whole order, out-per-in. */
  execPrice: number;
  /** How far exec is from spot, as a positive percentage. */
  impactPct: number;
  /** Fraction of the output reserve this trade consumes, 0-100. */
  reserveUsedPct: number;
  severity: "fine" | "warn" | "severe";
  /** Plain-language reason, or empty when the trade is unremarkable. */
  reason: string;
}

/**
 * Measure a quote against the pool it came from.
 *
 * Takes the *actual* quoted output rather than recomputing it, so this stays
 * correct whatever fee the contract applies — recomputing the curve here would
 * drift from the contract the moment either changed.
 */
export function priceImpact(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  amountOut: bigint,
  decimalsIn: number,
  decimalsOut: number,
): Impact {
  const none: Impact = {
    spotPrice: 0, execPrice: 0, impactPct: 0, reserveUsedPct: 0, severity: "fine", reason: "",
  };
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return none;

  const scaleIn = 10 ** decimalsIn;
  const scaleOut = 10 ** decimalsOut;
  const rIn = Number(reserveIn) / scaleIn;
  const rOut = Number(reserveOut) / scaleOut;
  const aIn = Number(amountIn) / scaleIn;
  const aOut = Number(amountOut) / scaleOut;
  if (!Number.isFinite(rIn) || !Number.isFinite(rOut) || rIn <= 0 || rOut <= 0) return none;

  const spotPrice = rOut / rIn;             // marginal rate before the trade
  const execPrice = aIn > 0 ? aOut / aIn : 0; // what the whole order actually gets
  const impactPct = spotPrice > 0 ? Math.max(0, (1 - execPrice / spotPrice) * 100) : 0;
  const reserveUsedPct = rOut > 0 ? Math.min(100, (aOut / rOut) * 100) : 0;

  const severity: Impact["severity"] =
    impactPct >= IMPACT_MAX_PCT ? "severe" : impactPct >= IMPACT_WARN_PCT ? "warn" : "fine";

  let reason = "";
  if (severity === "severe") {
    reason =
      `This trade moves the price ${impactPct.toFixed(1)}% against you and takes ` +
      `${reserveUsedPct.toFixed(1)}% of the pool's ${"output"} reserve. The pool is too shallow for ` +
      `this size — you would receive far less than the market rate. Trade a smaller amount, or add ` +
      `liquidity first.`;
  } else if (severity === "warn") {
    reason = `Price impact ${impactPct.toFixed(2)}% — you receive slightly less than the quoted spot rate.`;
  }
  return { spotPrice, execPrice, impactPct, reserveUsedPct, severity, reason };
}

/**
 * The largest input that keeps impact within `maxPct`, by bisection.
 *
 * Used to tell a trader what size *would* work rather than only that theirs
 * doesn't. Bisection rather than algebra so it stays correct for whatever fee
 * the quoting function applies.
 */
export function maxInputWithin(
  quote: (amountIn: bigint) => bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  decimalsIn: number,
  decimalsOut: number,
  maxPct = IMPACT_MAX_PCT,
): bigint {
  const within = (x: bigint) =>
    x > 0n &&
    priceImpact(reserveIn, reserveOut, x, quote(x), decimalsIn, decimalsOut).impactPct <= maxPct;

  if (within(amountIn)) return amountIn;
  let lo = 0n;
  let hi = amountIn;
  // 40 halvings resolves to well under a wei of the original size.
  for (let i = 0; i < 40 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (within(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
