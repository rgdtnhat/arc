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
 *
 * ## The "once" was doing a lot of work
 *
 * It was cached in memory, on success only. A probe that fails throws out of
 * the search, so nothing is cached, and the next caller starts the same 26-call
 * search again. The probe that fails most often is a throttled one — and 26
 * calls landing at once is itself what trips the throttle. That is a loop that
 * feeds itself: the search causes the throttle, the throttle fails the search,
 * the failed search runs again. Measured on this deployment it was 27 of the 53
 * requests a cold page load made, repeated on every load, for a single address.
 *
 * So the result is now written to disk as well: found once, kept across
 * restarts, and never re-derived for a contract already in the file.
 *
 * ## A refused probe is not "no code here"
 *
 * The probes used to swallow every error as "not deployed yet", which moves the
 * answer later. That is safe for a node that genuinely cannot serve historical
 * state, and *not* safe for a throttle, because the wrong answer is then cached
 * forever and every log scan silently starts too late — a fee history that
 * quietly begins halfway. Throttles are told apart from refusals: a throttled
 * probe abandons the search, to be retried later, rather than poisoning it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isThrottle } from "@tessera/shared";
import type { Hex, PublicClient } from "viem";

/** address -> creation block. Contracts are immutable, so this never expires. */
const cache = new Map<string, bigint>();
/** In-flight searches, so eight simultaneous panels do one search, not eight. */
const inflight = new Map<string, Promise<bigint | null>>();

/**
 * Where found blocks are kept between restarts. Set once at boot by the app;
 * without it everything below still works, just only for this process.
 */
let store: string | null = null;

export function useDeploymentBlockFile(file: string): void {
  store = file;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    for (const [addr, block] of Object.entries(raw)) {
      // A malformed line is skipped rather than failing the boot: the cost of
      // ignoring it is one search, and the cost of throwing is no app.
      try { cache.set(addr.toLowerCase(), BigInt(block)); } catch { /* skip */ }
    }
  } catch { /* no file yet, or unreadable — the searches will rebuild it */ }
}

function persist(): void {
  if (!store) return;
  const out: Record<string, string> = {};
  for (const [addr, block] of cache) out[addr] = block.toString();
  try { writeFileSync(store, JSON.stringify(out, null, 2)); } catch { /* best effort */ }
}

/** Only in this process, for tests that need a clean slate. */
export function forgetDeploymentBlocks(): void {
  cache.clear();
  inflight.clear();
  store = null;
}

/** A probe that could not be answered, as distinct from one answered "no". */
class ProbeRefused extends Error {}

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

  /**
   * One probe. `true` = code was there, `false` = it was not, and a throttle
   * throws — because "the node would not tell us" is a third answer, and
   * folding it into `false` is what silently moved deploy blocks later.
   */
  const hasCode = async (block?: bigint): Promise<boolean> => {
    try {
      const code = await pub.getCode(block === undefined ? { address } : { address, blockNumber: block });
      return !!code && code !== "0x";
    } catch (err) {
      if (isThrottle(err)) throw new ProbeRefused(String(err));
      // Anything else — a node that will not serve state this old, most often —
      // reads as "no code yet", which can only move the floor later. A later
      // floor is a shorter scan, which the caller reports as partial.
      return false;
    }
  };

  const search = (async () => {
    const top = latest ?? (await pub.getBlockNumber());
    if (!(await hasCode())) return null;

    let lo = 0n;
    let hi = top;
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      if (await hasCode(mid)) hi = mid;
      else lo = mid + 1n;
    }
    cache.set(key, lo);
    persist();
    return lo;
  })();

  inflight.set(key, search);
  try {
    return await search;
  } catch (err) {
    // An abandoned search is not an error the caller can do anything with: it
    // means "not known yet, ask again". Nothing is cached, so the next call
    // retries — by which time the limiter has backed off and it can succeed.
    if (err instanceof ProbeRefused) return null;
    throw err;
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
