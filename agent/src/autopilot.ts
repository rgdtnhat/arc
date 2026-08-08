/**
 * Treasury autopilot: what the agent should do with what it has been earning.
 *
 * ## Why these are pure functions
 * Same reason as `keeper.ts`, and more so. Every decision here spends money
 * without a human present — claiming rewards, compounding them into a
 * first-loss position, pointing the protocol's emissions somewhere. That is
 * exactly the kind of code that must be arguable on paper before it is trusted
 * with a key, so the reasoning lives here where it can be tested against a
 * table of numbers, and the caller does nothing but carry out what these
 * return.
 *
 * ## The rule they all obey
 * Every function can return "do nothing", and returns it by default. An
 * autopilot whose failure mode is *acting* is a much worse thing to own than
 * one whose failure mode is sitting still, so each of these has to be argued
 * into moving rather than argued out of it.
 */

export type Confidence = "act" | "hold";

export interface Decision {
  /** What to do. `hold` means the caller does nothing at all. */
  action: Confidence;
  /** Amount in the relevant asset's base units. Zero when holding. */
  amount: bigint;
  /** Why, in a sentence, for the log and the page. */
  reason: string;
}

const hold = (reason: string): Decision => ({ action: "hold", amount: 0n, reason });

// --- claiming ---------------------------------------------------------------

/**
 * Is claiming worth what it costs to claim?
 *
 * The trap this exists to avoid is a bot that claims every tick and pays more
 * in gas than it collects — which looks like diligence in the logs and is a
 * slow leak. So the reward has to clear the gas cost by a margin, in the same
 * unit, which means valuing the reward token rather than counting it.
 *
 * `rewardUsd` is deliberately a caller-supplied valuation and not something
 * this function derives: on this deployment the TSRA price is either an
 * operator parameter or an oracle that is openly refusing to price a
 * one-dollar pool, and burying that choice in here would hide which of the two
 * a decision was made on.
 */
export function planClaim(args: {
  /** Reward accrued, in reward-token base units. */
  claimable: bigint;
  /** What one whole reward token is worth, in USD cents. May be null. */
  rewardCentsPerToken: number | null;
  /** Reward token decimals. */
  decimals: number;
  /** What the claim transaction costs, in USD cents. */
  gasCents: number;
  /** How many times the gas cost the reward must be worth before claiming. */
  multiple: number;
}): Decision {
  const { claimable, rewardCentsPerToken, decimals, gasCents, multiple } = args;
  if (claimable === 0n) return hold("nothing accrued");
  if (rewardCentsPerToken === null) {
    /*
     * No usable price. Holding is right: the reward keeps accruing and loses
     * nothing by waiting, whereas claiming on a guessed valuation is how a bot
     * spends a dollar of gas to collect a cent — and the guess would not even
     * be recorded anywhere.
     */
    return hold("no usable price for the reward token — not guessing at whether this pays for itself");
  }
  const whole = Number(claimable) / 10 ** decimals;
  const valueCents = whole * rewardCentsPerToken;
  const bar = gasCents * multiple;
  if (valueCents < bar) {
    return hold(`worth ${valueCents.toFixed(2)}c, needs ${bar.toFixed(2)}c to clear ${multiple}x gas`);
  }
  return { action: "act", amount: claimable, reason: `${valueCents.toFixed(2)}c of reward against ${gasCents.toFixed(2)}c of gas` };
}

// --- compounding ------------------------------------------------------------

/**
 * How much of a claimed reward to put into the backstop.
 *
 * The backstop pays the highest rate in the protocol because it takes the
 * first loss — so compounding into it is not the obviously-correct default it
 * looks like. Two limits keep it honest:
 *
 *  · A share, not the lot. Sweeping every claim into first-loss risk quietly
 *    converts a treasury into a leveraged bet on the pool never taking a bad
 *    debt, one tick at a time, without anybody deciding to do that.
 *  · A ceiling on the resulting position. Past it, the answer is no regardless
 *    of how much came in, because the point of a cap is that a run of good
 *    weeks cannot talk you out of it.
 */
export function planCompound(args: {
  /** Reward just claimed, in reward-token base units. */
  claimed: bigint;
  /** What the agent already has in the backstop, same units. */
  positionNow: bigint;
  /** Share of a claim to compound, in basis points. */
  shareBps: number;
  /** Largest backstop position the agent may hold, same units. */
  cap: bigint;
  /** Smallest deposit worth the gas. */
  minMove: bigint;
}): Decision {
  const { claimed, positionNow, shareBps, cap, minMove } = args;
  if (claimed === 0n) return hold("nothing was claimed");
  if (shareBps <= 0) return hold("compounding is switched off");
  if (positionNow >= cap) return hold(`backstop position is already at its ${cap} cap`);

  let want = (claimed * BigInt(shareBps)) / 10_000n;
  const room = cap - positionNow;
  if (want > room) want = room; // the cap wins, not the inflow
  if (want < minMove) return hold(`${want} is below the minimum worth depositing`);
  return { action: "act", amount: want, reason: `compound ${want} of ${claimed} into the backstop` };
}

// --- voting -----------------------------------------------------------------

export interface GaugeMarket {
  id: number;
  /** Votes already cast on it this epoch. */
  votes: bigint;
  /** Whether the registry considers it eligible to earn. */
  eligible: boolean;
  /** Does the agent hold a position in this market? */
  mine: boolean;
}

export interface VotePlan {
  action: Confidence;
  /** Market ids and the weight in bps to give each. Sums to 10,000 when acting. */
  allocations: { id: number; bps: number }[];
  reason: string;
}

/**
 * Where the agent should point its own gauge weight.
 *
 * ## Why it only votes for markets it is in
 * An agent voting on markets it has no exposure to is an agent expressing an
 * opinion about somebody else's business with the protocol's money. Voting for
 * the markets it actually supplies to is the one allocation that is both
 * self-interested and legible — everybody can see why it voted that way, and
 * nobody has to trust that it worked something out on their behalf.
 *
 * ## Why it spreads evenly rather than optimising
 * A weight-maximising vote would pile into whichever market is closest to the
 * reward-zone edge, which is a strategy that only works while nobody else runs
 * it and turns into a scramble the moment two do. An even split across its own
 * markets is stable, explicable, and does not quietly make the agent the
 * largest tactical voter in a system its operator also controls.
 *
 * Ineligible markets are dropped: votes still record against them on chain but
 * earn nothing, so weight sent there is weight thrown away.
 */
export function planVote(markets: GaugeMarket[], args: { hasWeight: boolean }): VotePlan {
  if (!args.hasWeight) {
    /*
     * `hasWeight` must be answered by the gauge's `availableWeight`, not by the
     * token's `getVotes`. The gauge spends weight as it stood at the epoch's
     * snapshot block and nets off what has already been allocated, so an
     * address can hold tokens, be freshly delegated, and still have nothing to
     * cast this epoch. Saying that plainly matters — an operator looking at a
     * balance and being told "no weight" will otherwise assume a bug.
     */
    return {
      action: "hold",
      allocations: [],
      reason: "no weight available this epoch — tokens delegated after the epoch's snapshot carry no say until the next one",
    };
  }
  const mine = markets.filter((m) => m.mine && m.eligible);
  if (!mine.length) {
    return {
      action: "hold",
      allocations: [],
      reason: markets.some((m) => m.mine)
        ? "every market the agent is in is ineligible — weight there would earn nothing"
        : "the agent holds no position in any listed market",
    };
  }
  // An even split, with the remainder on the first so the total is exactly
  // 10,000 — a gauge that rejects a sum of 9,999 would reject three markets.
  const each = Math.floor(10_000 / mine.length);
  const allocations = mine.map((m) => ({ id: m.id, bps: each }));
  allocations[0].bps += 10_000 - each * mine.length;
  return {
    action: "act",
    allocations,
    reason: `even split across the ${mine.length} eligible market(s) the agent supplies`,
  };
}

// --- the run ----------------------------------------------------------------

export interface AutopilotLimits {
  /** Nothing runs more often than this. */
  minIntervalMs: number;
  /** Hard ceiling on actions in one run, whatever the plans say. */
  maxActionsPerRun: number;
}

/**
 * May a run happen at all?
 *
 * Separated from the plans because "should we act" and "are we allowed to act"
 * are different questions, and collapsing them is how a rate limit ends up
 * being enforced in three places and skipped in a fourth.
 */
export function mayRun(args: { now: number; lastRunAt: number; limits: AutopilotLimits; enabled: boolean }):
  { ok: boolean; reason: string; retryInSeconds: number } {
  if (!args.enabled) return { ok: false, reason: "autopilot is off", retryInSeconds: 0 };
  const since = args.now - args.lastRunAt;
  if (args.lastRunAt !== 0 && since < args.limits.minIntervalMs) {
    return {
      ok: false,
      reason: "too soon since the last run",
      retryInSeconds: Math.ceil((args.limits.minIntervalMs - since) / 1000),
    };
  }
  return { ok: true, reason: "clear to run", retryInSeconds: 0 };
}
