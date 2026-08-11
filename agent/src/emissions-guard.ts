/**
 * Keep the emission in step with the pot that has to pay for it.
 *
 * ## The problem this exists for
 * `TesseraEmissions` and `TesseraLpEmissions` both separate the promise from
 * the money on purpose: a rate keeps accruing whether or not the contract holds
 * a single reward token, and `claim` pays `min(what you are owed, what is
 * there)`. That is the right behaviour for a claim — it never strands anybody's
 * balance and never lies about the debt — but it makes an *unfunded* rate a
 * quiet fiction. The card says you have earned 62,322 TSRA, the pot says 0, and
 * every second that passes adds to the first number without adding anything to
 * the second. What the reader is looking at is a number nobody can be paid.
 *
 * So: when the pot runs out, the emission stops. What was earned while the pot
 * was funded stays earned and stays claimable — a pause cannot touch it — and
 * accrual resumes when somebody refills. Every claimable figure on the page is
 * then backed by a token that exists.
 *
 * ## Why the decision is a pure function
 * Same argument as `autopilot.ts` and `keeper.ts`. This runs unattended and
 * signs with the owner key, so the reasoning has to be arguable against a table
 * of numbers rather than against a live chain. The caller reads state, calls
 * this, and does exactly what it says.
 *
 * ## The rule it must never break
 * It may only undo *its own* pause. An operator who pauses emissions during an
 * incident and finds a keeper switching them back on ten minutes later has a
 * worse problem than the one they paused for, so the guard resumes only when
 * the flag says the guard is the one that stopped it. Whoever else touches
 * `setPaused` — an admin through the panel, a script, the governor — owns the
 * switch from that point on, and this steps back.
 *
 * ## What "run out" means, exactly
 * `free = held - totalOwed`: the balance beyond what is already booked to
 * somebody. `totalOwed` lags a little, because it only rises when a position is
 * checkpointed, so a pot can be nearer to empty than it looks. That is why the
 * pause trips on a *floor* — the emission the streams would create before the
 * next check — rather than on zero. Stopping a tick early costs a few seconds
 * of rewards; stopping a tick late books rewards that cannot be paid, which is
 * the whole thing this is here to prevent.
 */

/** What the chain says about one emissions contract, at one moment. */
export interface PotSnapshot {
  /** Reward token held by the emissions contract, in base units. */
  held: bigint;
  /** Already earned and not yet paid out, in base units (`totalOwed`). */
  owed: bigint;
  /**
   * What the streams emit per second *if running*, in base units.
   *
   * Deliberately not `totalRatePerSecond()`: that view returns zero while
   * paused ("paused is not slow, it is stopped"), which is the right answer for
   * a runway display and the wrong one here — a guard that reads zero while
   * paused cannot tell how much runway a refill just bought. The caller sums
   * the streams itself so the figure means the same thing in both states.
   */
  ratePerSecond: bigint;
  /** `paused()` as the contract reports it. */
  paused: boolean;
  /** Did this guard set that pause? Persisted by the caller across restarts. */
  pausedByGuard: boolean;
}

export interface GuardSettings {
  /**
   * Seconds of emission the pot must still be able to cover, or the guard
   * stops it. Set to the check interval or a little above: the point is to trip
   * before the next tick's worth of rewards is booked unbacked.
   */
  pauseBelowSeconds: number;
  /**
   * Seconds of runway a refill has to buy before the guard restarts anything.
   *
   * Comfortably above `pauseBelowSeconds` on purpose. A dust transfer that
   * bought one tick of emission would otherwise pause and resume forever, and
   * each flip is a transaction over every stream.
   */
  resumeRunwaySeconds: number;
}

export const DEFAULT_GUARD: GuardSettings = { pauseBelowSeconds: 600, resumeRunwaySeconds: 3600 };

export type GuardAction = "pause" | "resume" | "none";

export interface GuardDecision {
  action: GuardAction;
  /** Why, in a sentence, for the log and the panel. */
  reason: string;
  /** Balance beyond what is already booked, in base units. */
  free: bigint;
  /** Seconds the free balance sustains the current rates; null when idle. */
  runwaySeconds: number | null;
}

const decision = (action: GuardAction, reason: string, free: bigint, rate: bigint): GuardDecision => ({
  action,
  reason,
  free,
  runwaySeconds: rate > 0n ? Number(free / rate) : null,
});

/**
 * Should the guard stop the emission, restart it, or leave it alone?
 *
 * Returns `none` by default and from every branch it is not certain about,
 * because the failure mode of acting here is worse than the failure mode of
 * waiting one more tick.
 */
export function decideEmissionsGuard(snap: PotSnapshot, settings: GuardSettings = DEFAULT_GUARD): GuardDecision {
  const rate = snap.ratePerSecond > 0n ? snap.ratePerSecond : 0n;
  const free = snap.held > snap.owed ? snap.held - snap.owed : 0n;

  if (snap.paused) {
    // The one rule the guard cannot break: an operator's pause is theirs.
    if (!snap.pausedByGuard) {
      return decision("none", "paused by an operator, so the guard leaves the switch alone", free, rate);
    }
    const need = rate * BigInt(Math.max(0, Math.floor(settings.resumeRunwaySeconds)));
    if (free > 0n && free >= need) {
      return decision(
        "resume",
        need > 0n
          ? `the pot is funded again and covers ${settings.resumeRunwaySeconds}s at the current rates, so emission restarts`
          : "the pot is funded again, so emission restarts",
        free,
        rate,
      );
    }
    return decision("none", "still paused: the pot has not been refilled enough to cover the streams", free, rate);
  }

  // Nothing is streaming, so there is nothing an empty pot can over-promise.
  if (rate === 0n) return decision("none", "no stream is emitting, so there is nothing to stop", free, rate);

  const floor = rate * BigInt(Math.max(0, Math.floor(settings.pauseBelowSeconds)));
  if (free <= floor) {
    return decision(
      "pause",
      free === 0n
        ? "the pot is empty, so emission stops rather than booking rewards nobody can claim"
        : `the pot covers under ${settings.pauseBelowSeconds}s at the current rates, so emission stops before it books rewards nobody can claim`,
      free,
      rate,
    );
  }
  return decision("none", "the pot backs the current rates", free, rate);
}
