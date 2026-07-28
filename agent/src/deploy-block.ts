/**
 * When was this contract deployed?
 *
 * Every log scan in the app needs a lower bound. Using a fixed "look back N
 * blocks" is what the fee reader and the archive scanner did, and on Arc it is
 * quietly wrong: blocks are fast, so 500k of them is a few days, and a pool
 * deployed a week ago reports zero suppliers and zero fee history. Both look
 * exactly like "nothing has happened here yet".
 *
 * The contract's own creation block is the only correct floor, and it can be
 * found without an indexer: `getCode` returns empty before deployment and
 * non-empty after, so the answer is a binary search over the chain height —
 * ~26 calls for a 54M-block chain, once, then cached.
 */
import type { Hex, PublicClient } from "viem";

/** address -> creation block. Contracts are immutable, so this never expires. */
const cache = new Map<string, bigint>();
/** In-flight searches, so eight simultaneous panels do one search, not eight. */
const inflight = new Map<string, Promise<bigint | null>>();

/**
 * The first block at which `address` had code, or null if it has none now.
 *
 * A node that refuses historical state (`getCode` at an old block) makes the
 * search unreliable rather than wrong: the probe is treated as "no code yet",
 * which can only move the answer later, never earlier. A later floor means a
 * shorter scan, which surfaces as `partial`, not as a silently wrong total.
 */
export async function findDeploymentBlock(
  pub: PublicClient,
  address: Hex,
  latest?: bigint,
): Promise<bigint | null> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const search = (async () => {
    const top = latest ?? (await pub.getBlockNumber());
    const now = await pub.getCode({ address }).catch(() => undefined);
    if (!now || now === "0x") return null;

    let lo = 0n;
    let hi = top;
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      const code = await pub.getCode({ address, blockNumber: mid }).catch(() => undefined);
      if (code && code !== "0x") hi = mid;
      else lo = mid + 1n;
    }
    cache.set(key, lo);
    return lo;
  })();

  inflight.set(key, search);
  try {
    return await search;
  } finally {
    inflight.delete(key);
  }
}

/**
 * How many windows a scan needs, and whether that fits the budget.
 *
 * Separated out so the "we could not read it all" decision is made once, from
 * numbers, rather than being discovered halfway through a loop.
 */
export function windowPlan(
  from: bigint,
  to: bigint,
  window: bigint,
  maxWindows: number,
): { windows: number; complete: boolean } {
  if (to < from) return { windows: 0, complete: true };
  const span = to - from + 1n;
  const needed = Number((span + window - 1n) / window);
  return { windows: Math.min(needed, maxWindows), complete: needed <= maxWindows };
}
