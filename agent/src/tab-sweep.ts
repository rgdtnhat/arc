/**
 * Which expired tabs are worth reclaiming, and which are not.
 *
 * ## The gap this closes
 * A tab locks a deposit up front and hands the provider signed vouchers it can
 * redeem whenever it likes. If the provider never settles, `streamTicks` logs
 * that the deposit *"will reclaim after expiry"* — and then nothing does.
 * `TesseraTab.reclaim` was reachable only through the action kit, so recovering
 * the money needed a person who remembered the tab id, from an activity feed
 * that does not survive a restart. The funds were recoverable but not
 * recovered, which is a slow leak dressed as a safety net.
 *
 * ## Why the deciding is separated from the doing
 * Same reason as `keeper.ts` and `autopilot.ts`: this runs unattended and it
 * spends gas. The rules below are the part worth arguing about on paper, so
 * they are a pure function over plain rows — no client, no chain, no clock —
 * and the caller does nothing but carry out what this returns.
 *
 * ## Every skip carries its reason
 * A sweep that silently examines forty tabs and reclaims none is
 * indistinguishable from a sweep that is broken. Each row that is passed over
 * says why, so "nothing to do" and "could not tell" never render the same way.
 * That is the same lesson `chain-read.ts` exists for, one level up.
 */

export type Address = `0x${string}`;

/** One tab as `TesseraTab.tabs(id)` reports it. */
export interface TabRow {
  tabId: bigint;
  /** Who opened it. Compared case-insensitively; addresses arrive in both cases. */
  agent: Address;
  /** USDC escrowed at open, 6 decimals. */
  deposit: bigint;
  /** USDC the provider has already redeemed. */
  claimed: bigint;
  /** Unix seconds. The contract allows `reclaim` strictly after this. */
  expiry: bigint;
  closed: boolean;
}

export interface SweepPlan {
  /** Tabs to reclaim, most valuable first. */
  reclaim: { tabId: bigint; remainder: bigint }[];
  /** Everything passed over, and why. */
  skipped: { tabId: bigint; why: string }[];
}

export const SWEEP_DEFAULTS = {
  /**
   * Below this, reclaiming costs more than it recovers.
   *
   * Gas on Arc is paid in USDC, so a reclaim that returns a hundredth of a cent
   * is a net loss recorded as a recovery — the failure mode `autopilot.planClaim`
   * exists to avoid, in the same unit. 0.01 USDC is roughly an order of
   * magnitude above a reclaim's observed fee, which leaves room for the fee to
   * move without turning the rule upside down.
   *
   * It is a floor, not an abandonment: dust stays reclaimable by hand through
   * the action kit, and a later tab on the same provider is unaffected.
   */
  minRemainderUsdc: 10_000n, // 0.01 USDC, 6 decimals
  /**
   * Tabs to reclaim in one pass.
   *
   * Each reclaim is its own transaction. Unbounded, a first sweep against a
   * long-lived agent would fire dozens of writes back to back, trip the RPC's
   * per-window limit, and leave a half-finished pass nobody can reason about.
   * Five per pass drains a backlog over a few runs and keeps any single pass
   * something an operator can read in the feed.
   */
  maxPerPass: 5,
  /**
   * Tabs to *examine* in one pass, oldest first.
   *
   * `tabsAsAgent` grows for the life of the agent and never shrinks — a closed
   * tab stays in the array. Reading every row forever is the shape of a job
   * that works in the demo and times out in the second month. Oldest first
   * because an unreclaimed tab only becomes more overdue.
   */
  maxScan: 50,
} as const;

/**
 * An expiry as a readable instant, or the raw seconds when it is not one.
 *
 * `expiry` is a `uint64` off a public contract, so it is whatever was written
 * there — and `new Date(n).toISOString()` throws a `RangeError` past year
 * 275760. One absurd row must not take down a sweep that had four good ones to
 * do, so this degrades to the number instead of throwing.
 */
function describeExpiry(expiry: bigint): string {
  const ms = Number(expiry) * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return `epoch ${expiry}`;
  return new Date(ms).toISOString();
}

/**
 * Decide what to reclaim.
 *
 * The order of the checks matters. `closed` comes first because a closed tab is
 * the normal, healthy end state and the commonest row in the list — reporting
 * it as "not expired" or "nothing to reclaim" would be true but would bury the
 * rows that need attention. Ownership comes next, because a tab belonging to
 * someone else is a sign the caller passed the wrong list, not a routine skip.
 */
export function planTabSweep(args: {
  /** Unix seconds, as the chain measures it. */
  now: number;
  /** The agent's own address. */
  me: Address;
  tabs: TabRow[];
  minRemainder?: bigint;
  maxPerPass?: number;
}): SweepPlan {
  const minRemainder = args.minRemainder ?? SWEEP_DEFAULTS.minRemainderUsdc;
  const maxPerPass = args.maxPerPass ?? SWEEP_DEFAULTS.maxPerPass;
  const me = args.me.toLowerCase();
  const now = BigInt(Math.floor(args.now));

  const reclaim: { tabId: bigint; remainder: bigint }[] = [];
  const skipped: { tabId: bigint; why: string }[] = [];

  for (const t of args.tabs) {
    if (t.closed) {
      skipped.push({ tabId: t.tabId, why: "already closed" });
      continue;
    }
    if (t.agent.toLowerCase() !== me) {
      skipped.push({ tabId: t.tabId, why: "opened by another agent" });
      continue;
    }
    // The contract reverts with NotExpired while `block.timestamp <= expiry`,
    // so the boundary second is not reclaimable and asking would burn gas on a
    // revert. Mirrored exactly rather than approximated.
    if (now <= t.expiry) {
      skipped.push({ tabId: t.tabId, why: `still open until ${describeExpiry(t.expiry)}` });
      continue;
    }
    // `claimed > deposit` is unreachable through the contract, which rejects it
    // with OverDeposit. Treated as nothing owed rather than trusted into a
    // negative: an underflow here would become a bigint the caller sends to a
    // uint256 argument.
    const remainder = t.deposit > t.claimed ? t.deposit - t.claimed : 0n;
    if (remainder === 0n) {
      skipped.push({ tabId: t.tabId, why: "fully claimed — nothing to reclaim" });
      continue;
    }
    if (remainder < minRemainder) {
      skipped.push({ tabId: t.tabId, why: `${remainder} below the ${minRemainder} minimum worth the gas` });
      continue;
    }
    reclaim.push({ tabId: t.tabId, remainder });
  }

  // Most valuable first, so a capped pass recovers the most money rather than
  // whichever tabs happen to sort lowest by id.
  reclaim.sort((a, b) => (b.remainder === a.remainder ? Number(a.tabId - b.tabId) : b.remainder > a.remainder ? 1 : -1));
  for (const over of reclaim.splice(maxPerPass)) {
    skipped.push({ tabId: over.tabId, why: "over the per-pass cap — next sweep" });
  }

  return { reclaim, skipped };
}

/** Total the plan expects to recover. */
export function sweepValue(plan: SweepPlan): bigint {
  return plan.reclaim.reduce((sum, r) => sum + r.remainder, 0n);
}
