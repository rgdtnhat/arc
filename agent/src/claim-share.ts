/**
 * Who gets paid when the pot cannot pay everybody.
 *
 * `TesseraEmissions.claim` pays `min(what you are owed, what the contract
 * holds)`. That is first come, first served: the earliest claimant takes the
 * whole pot up to their own balance, and everybody else waits for a refill.
 * With emissions that had run unfunded for a long time, the practical effect is
 * that one address empties the pot every time it is topped up, and the pot
 * guard — correctly — pauses the emission again the moment it does. Nobody else
 * is ever paid, and the emission never restarts.
 *
 * Rewards accrue in proportion to each holder's share of the market. A payout
 * queue that ignores that proportion undoes it at the last step, so this caps
 * what a claim may take to the caller's **pro-rata share of the pot**: the same
 * fraction of what is there as their balance is of everything owed.
 *
 * ## What this can and cannot do
 * The contract takes no amount — it pays `min(accrued, held)` over whichever
 * streams it is handed. So the cap is applied by *choosing streams*: the caller
 * claims a subset of what they are owed whose total fits inside their share.
 * That is exact to stream granularity, not to the wei, and it binds only claims
 * made through this app — the contract remains first come, first served for
 * anyone calling it directly. Making it binding for everyone is a change to
 * `claim` itself, and a redeployment.
 */

export interface OwedStream {
  /** Opaque handle the caller uses to identify the stream again. */
  key: string;
  /** Accrued and unpaid on this stream, in reward base units. */
  owed: bigint;
}

export interface ClaimPlan {
  /** The streams to hand to `claim`. */
  take: OwedStream[];
  /** What those streams total — what the claim will actually pay. */
  amount: bigint;
  /** The caller's share of the pot, whether or not it could be filled exactly. */
  cap: bigint;
  /** Why, for the panel. */
  reason: string;
}

/**
 * The caller's fair share of what is in the pot right now.
 *
 * When the pot covers everything owed there is nothing to ration and the cap is
 * simply the caller's whole balance. Below that, it is `pot × yours / total` —
 * the same fraction of the money as their claim is of the debt.
 */
export function proRataCap(yourOwed: bigint, totalOwed: bigint, pot: bigint): bigint {
  if (yourOwed <= 0n || pot <= 0n) return 0n;
  if (totalOwed <= pot) return yourOwed < pot ? yourOwed : pot;
  // `totalOwed` is protocol-wide and always includes the caller's own balance,
  // so this is never a division by something smaller than the numerator.
  const share = (pot * yourOwed) / totalOwed;
  return share < yourOwed ? share : yourOwed;
}

/**
 * Pick the streams that fit inside the cap, largest first.
 *
 * Largest-first gets closest to the cap in the fewest transactions' worth of
 * gas, and leaves the small remainders for the next refill, where they are
 * worth relatively more.
 *
 * ## Why the plan is allowed to overshoot by one stream
 * The first version stopped at the last stream that fit. Two things went wrong
 * with that, and both were bad enough to see in production.
 *
 * A caller whose rewards sit in a single large stream — which is most holders —
 * claimed *nothing*, ever, because no whole stream fits a share smaller than
 * it. Somebody owed the same amount across several small streams claimed
 * freely. That is not fairness; it is an accident of how a balance is shaped.
 *
 * And a caller with one huge stream and a handful of small ones claimed the
 * handful: 1,535 TSRA against a share of 62,420, because the only stream that
 * would have used the share did not fit inside it. Getting paid what you are
 * owed then takes dozens of claims, each costing gas.
 *
 * So when the greedy pass leaves room under the cap, the plan adds one more
 * stream — the smallest of the ones left. The overshoot is bounded by a single
 * stream, and bounded again by the pot, because `claim` pays `min(owed, held)`
 * and deducts proportionally: the remainder stays accrued and coherent either
 * way. Nothing else may exceed the cap.
 */
export function planClaim(streams: OwedStream[], cap: bigint): ClaimPlan {
  const owed = streams.reduce((t, s) => t + (s.owed > 0n ? s.owed : 0n), 0n);
  if (owed <= 0n) return { take: [], amount: 0n, cap, reason: "nothing has accrued yet" };
  if (cap <= 0n) {
    return { take: [], amount: 0n, cap, reason: "the pot is empty, so a claim would pay nothing" };
  }
  if (cap >= owed) {
    const take = streams.filter((s) => s.owed > 0n);
    return { take, amount: owed, cap, reason: "the pot covers your whole balance" };
  }

  const sorted = [...streams].filter((s) => s.owed > 0n).sort((a, b) => (a.owed < b.owed ? 1 : a.owed > b.owed ? -1 : 0));
  const take: OwedStream[] = [];
  let amount = 0n;
  for (const s of sorted) {
    if (amount + s.owed <= cap) {
      take.push(s);
      amount += s.owed;
    }
  }
  if (amount < cap) {
    // Room left under the cap that no remaining stream fits into. Take the
    // smallest of them, so the overshoot is the least available.
    const rest = sorted.filter((s) => !take.includes(s));
    const smallest = rest[rest.length - 1];
    if (smallest) {
      return {
        take: [...take, smallest],
        amount: amount + smallest.owed,
        cap,
        reason: take.length
          ? "the pot is short of what everyone is owed, so this claims up to your share of it — the pot pays what " +
            "it can and the rest stays accrued"
          : "your share of the pot is smaller than your smallest single stream, so this claims that one stream — " +
            "the pot pays what it can and the rest stays accrued",
      };
    }
  }
  return {
    take, amount, cap,
    reason: "the pot is short of what everyone is owed, so this claim takes your share of it and leaves the rest",
  };
}
