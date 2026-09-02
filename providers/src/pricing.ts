/**
 * What a provider charges, right now.
 *
 * Prices in the catalog are constants — `price: usdc("0.0025")` — which means a
 * provider cannot respond to anything. It charges the same when it is idle as
 * when it is saturated, and the same to a buyer that settles every time as to
 * one that disputes half of them. Neither is how a seller behaves, and an agent
 * negotiating against a constant is not negotiating.
 *
 * This is the smallest thing that fixes it: a base price the catalog still owns,
 * moved by conditions the provider can actually observe.
 *
 * ## What moves it
 * **Load.** Recent calls per minute against a stated comfortable rate. Pricing
 * up under load is what makes a queue shorter rather than longer, and it is the
 * signal a provider always has.
 *
 * **The buyer's record.** A buyer that disputes a third of its deliveries costs
 * more to serve than one that settles, and charging both the same means the
 * settling buyers subsidise the disputing ones. The escrow already publishes
 * `buyerRecord`, so this is a number the provider can look up before agreeing to
 * work.
 *
 * ## What deliberately does not move it
 * Nothing about *who* the buyer is beyond their on-chain record — no
 * address-based tiering, no "this one seems rich". A price that depends on
 * identity rather than behaviour is one an agent cannot reason about, and the
 * whole point of quoting on a public rail is that the quote can be checked.
 *
 * Bounds are hard: a multiplier floor and ceiling, so a bug in the load counter
 * cannot produce a price nobody would pay, or one that gives the service away.
 */

/** Never quote below this fraction of the catalog price. */
export const MIN_MULTIPLIER = 0.5;
/** Never quote above this. Surge is a signal, not an opportunity. */
export const MAX_MULTIPLIER = 4;

export interface LoadWindow {
  /** Calls seen in the last minute. */
  callsPerMinute: number;
  /** The rate this provider is comfortable serving. */
  comfortableRate: number;
}

export interface BuyerRecord {
  settled: number;
  disputed: number;
}

/**
 * Surge from load.
 *
 * Flat until the comfortable rate, then rising — a provider with spare capacity
 * has no reason to charge more, and one that starts pricing up at 10% load is
 * just expensive.
 */
export function loadMultiplier(w: LoadWindow): number {
  if (w.comfortableRate <= 0) return 1;
  const ratio = w.callsPerMinute / w.comfortableRate;
  if (ratio <= 1) return 1;
  // Linear in the overshoot: twice the comfortable rate is 1.5x, four times is
  // 2.5x. Steep enough to shed load, gentle enough that a brief spike does not
  // read as extortion.
  return 1 + (ratio - 1) * 0.5;
}

/**
 * Surcharge for a buyer that disputes.
 *
 * Only applied once there is enough history to mean something — punishing a
 * newcomer for having no record would make the rail unusable for anyone new,
 * which is the opposite of what a reputation signal is for.
 */
export function buyerMultiplier(r: BuyerRecord | null | undefined, minHistory = 5): number {
  if (!r) return 1;
  const total = r.settled + r.disputed;
  if (total < minHistory) return 1;
  const disputeRate = r.disputed / total;
  // Up to 1.5x at a 50% dispute rate, and no discount below — a spotless record
  // earns the base price rather than a rebate, because the base price already
  // assumes honest counterparties.
  return 1 + Math.min(disputeRate, 0.5);
}

/** The quoted price, in the same base units as the catalog price. */
export function quotePrice(args: {
  basePrice: bigint;
  load?: LoadWindow;
  buyer?: BuyerRecord | null;
}): { price: bigint; multiplier: number; reasons: string[] } {
  const reasons: string[] = [];
  const load = args.load ? loadMultiplier(args.load) : 1;
  const buyer = buyerMultiplier(args.buyer);

  if (load > 1) reasons.push(`load ${args.load!.callsPerMinute}/min over a comfortable ${args.load!.comfortableRate}/min`);
  if (buyer > 1) reasons.push(`buyer has disputed ${args.buyer!.disputed} of ${args.buyer!.settled + args.buyer!.disputed} deliveries`);

  let m = load * buyer;
  if (m < MIN_MULTIPLIER) m = MIN_MULTIPLIER;
  if (m > MAX_MULTIPLIER) m = MAX_MULTIPLIER;

  // Integer maths on the base units, rounded up: a price that rounds down to
  // zero is a service given away by accident.
  const scaled = (args.basePrice * BigInt(Math.round(m * 10_000))) / 10_000n;
  const price = scaled === 0n ? args.basePrice : scaled;
  return { price, multiplier: Number(m.toFixed(4)), reasons };
}

/**
 * A rolling count of recent calls, per resource.
 *
 * Deliberately in memory and deliberately small. This informs a price; it is not
 * accounting, and a provider that restarts should start quoting from a clean
 * slate rather than from whatever it believed an hour ago.
 */
export class LoadMeter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly windowMs = 60_000) {}

  record(resource: string, now = Date.now()) {
    const xs = this.hits.get(resource) ?? [];
    xs.push(now);
    this.hits.set(resource, xs);
  }

  /** Calls in the last window, dropping anything older as it goes. */
  ratePerMinute(resource: string, now = Date.now()): number {
    const xs = this.hits.get(resource);
    if (!xs?.length) return 0;
    const cutoff = now - this.windowMs;
    // Trimmed on read rather than on a timer: no background work, and the array
    // cannot grow without somebody asking about it.
    let i = 0;
    while (i < xs.length && xs[i]! < cutoff) i++;
    if (i > 0) xs.splice(0, i);
    return xs.length * (60_000 / this.windowMs);
  }
}
