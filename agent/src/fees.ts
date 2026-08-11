/**
 * App-fee visibility: what the collector has taken in, and where it went.
 *
 * `TesseraFeeCollector` splits every fee it holds across five sinks — the agent
 * wallet, the lending pool, the vault, an AMM pool and a
 * retained remainder — on a cadence, and emits `Allocated` with the exact
 * amounts each time. Current state comes from the contract; the history and the
 * running totals come from those logs, so nothing here is estimated.
 *
 * The log scan is windowed and bounded, because Arc's public RPC caps
 * `eth_getLogs` spans. A scan that had to stop early reports `partial: true`
 * rather than presenting an incomplete total as complete — an under-reported
 * "distributed to the vault" figure is worse than an honest "we could not read
 * it all", since someone would reconcile against it.
 */
import { createPublicClient, parseAbiItem, type Chain, type Hex, type PublicClient } from "viem";
import { tesseraFeeCollectorAbi, erc20Abi, pacedHttp } from "@tessera/shared";
import { findDeploymentBlock } from "./deploy-block.js";

const ALLOCATED = parseAbiItem(
  "event Allocated(uint256 total, uint256 toAgent, uint256 toLending, uint256 toVault, uint256 toSwap, uint256 retained)",
);

const LOG_WINDOW = BigInt(process.env.ARC_LOG_WINDOW ?? "9000");
const LOG_LOOKBACK = BigInt(process.env.ARC_LOG_LOOKBACK ?? "500000");
const MAX_WINDOWS = Number(process.env.ARC_LOG_MAX_WINDOWS ?? "220");

export interface Allocation {
  blockNumber: string;
  txHash: string;
  /** Seconds since the epoch, from the block. Null when the header read failed. */
  at: number | null;
  total: bigint;
  toAgent: bigint;
  toLending: bigint;
  toVault: bigint;
  toSwap: bigint;
  retained: bigint;
}

export interface FeeSplit {
  agentBps: number;
  lendingBps: number;
  vaultBps: number;
  swapBps: number;
  retainedBps: number;
}

export interface FeeReport {
  collector: Hex;
  asset: Hex;
  decimals: number;
  /** Sitting in the collector, not yet distributed. */
  pending: bigint;
  split: FeeSplit;
  intervalSeconds: number;
  secondsUntilAllocatable: number;
  /** Cumulative, from the logs that were read. */
  totals: { total: bigint; toAgent: bigint; toLending: bigint; toVault: bigint; toSwap: bigint; retained: bigint };
  /** Most recent first. */
  allocations: Allocation[];
  /** One row per calendar day (UTC), oldest first — the daily fee chart. */
  daily: { day: string; total: number; toAgent: number; toLending: number; toVault: number; toSwap: number; retained: number }[];
  /** True when the log scan hit its budget; the totals are a lower bound. */
  partial: boolean;
  block: string;
}

export class FeeReader {
  readonly public: PublicClient;

  constructor(chain: Chain, rpcUrl: string, readonly collector: Hex, readonly asset: Hex, readonly decimals: number) {
    this.public = createPublicClient({ chain, transport: pacedHttp(rpcUrl), batch: { multicall: true } });
  }

  /** Every `Allocated` log we can reach, newest window first. */
  private async allocations(): Promise<{ list: Allocation[]; partial: boolean; block: string }> {
    const latest = await this.public.getBlockNumber();
    // From the collector's own creation block, not a fixed lookback: on a fast
    // chain a lookback is a few days, so an older collector reported an empty
    // fee history that looked exactly like "no fees have ever been taken".
    const created = await findDeploymentBlock(this.public, this.collector, latest).catch(() => null);
    const floor = created ?? (latest > LOG_LOOKBACK ? latest - LOG_LOOKBACK : 0n);
    const out: Allocation[] = [];
    let partial = false;
    let to = latest;
    let windows = 0;
    while (to > floor) {
      if (windows++ >= MAX_WINDOWS) { partial = true; break; }
      const from = to > LOG_WINDOW ? to - LOG_WINDOW : 0n;
      try {
        const logs = await this.public.getLogs({ address: this.collector, event: ALLOCATED, fromBlock: from, toBlock: to });
        for (const l of logs) {
          const a = l.args as Record<string, bigint>;
          out.push({
            blockNumber: String(l.blockNumber),
            txHash: String(l.transactionHash),
            at: null,
            total: a.total ?? 0n,
            toAgent: a.toAgent ?? 0n,
            toLending: a.toLending ?? 0n,
            toVault: a.toVault ?? 0n,
            toSwap: a.toSwap ?? 0n,
            retained: a.retained ?? 0n,
          });
        }
      } catch {
        partial = true;
      }
      if (from === 0n) break;
      to = from - 1n;
    }
    out.sort((x, y) => Number(BigInt(y.blockNumber) - BigInt(x.blockNumber)));
    return { list: out, partial, block: latest.toString() };
  }

  /**
   * Timestamps for the blocks the allocations landed in.
   *
   * Only the most recent are fetched: a block header per allocation would be a
   * lot of round-trips on a throttled RPC, and the daily chart only needs dates
   * for the rows it plots. Anything unresolved keeps `at: null` and is left out
   * of the chart rather than being bucketed under a guessed date.
   */
  private async timestamps(list: Allocation[], limit = 120) {
    const want = list.slice(0, limit);
    await Promise.all(
      want.map(async (a) => {
        try {
          const b = await this.public.getBlock({ blockNumber: BigInt(a.blockNumber) });
          a.at = Number(b.timestamp);
        } catch {
          /* leave null */
        }
      }),
    );
  }

  async read(): Promise<FeeReport> {
    const c = (functionName: string) =>
      ({ address: this.collector, abi: tesseraFeeCollectorAbi, functionName }) as const;
    const res = await this.public.multicall({
      allowFailure: true,
      contracts: [
        c("balance"),
        c("shares"),
        c("interval"),
        c("timeUntilAllocatable"),
        { address: this.asset, abi: erc20Abi, functionName: "balanceOf", args: [this.collector] } as const,
      ] as never,
    });
    const ok = (i: number) => res[i].status === "success";
    const pending = ok(0) ? (res[0].result as bigint) : ok(4) ? (res[4].result as bigint) : 0n;
    const sh = ok(1) ? (res[1].result as readonly number[]) : [2000, 2000, 2000, 2000, 2000];
    const split: FeeSplit = {
      agentBps: Number(sh[0] ?? 0),
      lendingBps: Number(sh[1] ?? 0),
      vaultBps: Number(sh[2] ?? 0),
      swapBps: Number(sh[3] ?? 0),
      retainedBps: Number(sh[4] ?? 0),
    };

    const { list, partial, block } = await this.allocations();
    await this.timestamps(list);

    const { totals, daily } = aggregate(list, this.decimals);

    return {
      collector: this.collector,
      asset: this.asset,
      decimals: this.decimals,
      pending,
      split,
      intervalSeconds: ok(2) ? Number(res[2].result) : 0,
      secondsUntilAllocatable: ok(3) ? Number(res[3].result) : 0,
      totals,
      allocations: list.slice(0, 50),
      daily,
      partial,
      block,
    };
  }
}

/**
 * Roll a list of allocations into cumulative totals and per-day buckets.
 *
 * Pulled out of `FeeReader` so it can be tested without a chain: this is the
 * arithmetic a reader would reconcile against, and getting the day boundary or a
 * decimal conversion wrong is both easy and invisible.
 *
 * Allocations with no timestamp are counted in the totals but left out of the
 * daily buckets — a fee that happened is real even when the block header could
 * not be read, but putting it under a guessed date would invent a data point.
 */
export function aggregate(list: Allocation[], decimals: number) {
  const totals = list.reduce(
    (t, a) => ({
      total: t.total + a.total,
      toAgent: t.toAgent + a.toAgent,
      toLending: t.toLending + a.toLending,
      toVault: t.toVault + a.toVault,
      toSwap: t.toSwap + a.toSwap,
      retained: t.retained + a.retained,
    }),
    { total: 0n, toAgent: 0n, toLending: 0n, toVault: 0n, toSwap: 0n, retained: 0n },
  );

  const unit = 10 ** decimals;
  const byDay = new Map<string, FeeReport["daily"][number]>();
  for (const a of list) {
    if (a.at === null) continue;
    const day = new Date(a.at * 1000).toISOString().slice(0, 10); // UTC
    const row = byDay.get(day) ?? { day, total: 0, toAgent: 0, toLending: 0, toVault: 0, toSwap: 0, retained: 0 };
    row.total += Number(a.total) / unit;
    row.toAgent += Number(a.toAgent) / unit;
    row.toLending += Number(a.toLending) / unit;
    row.toVault += Number(a.toVault) / unit;
    row.toSwap += Number(a.toSwap) / unit;
    row.retained += Number(a.retained) / unit;
    byDay.set(day, row);
  }
  const daily = [...byDay.values()].sort((x, y) => (x.day < y.day ? -1 : 1));
  return { totals, daily };
}

/* -------------------------------------------------------------------------
 * Harvesting the protocol's own revenue
 * ---------------------------------------------------------------------- */

/**
 * Why anything has to be harvested at all.
 *
 * `TesseraPool` takes its cut of borrower interest by crediting the treasury a
 * **supply position** — `supplyShares[asset][treasury] += feeShares` — rather
 * than by transferring tokens. That is the right design: the protocol's revenue
 * keeps earning while it waits, and a fee that moved tokens on every accrual
 * would cost more gas than it collects.
 *
 * But `TesseraFeeCollector` splits only what it *holds*. It can be supplied to,
 * swept and allocated; it has no path to withdraw from the pool. So with the
 * collector set as the pool's treasury, revenue accrued into an address that
 * could never realise it, and the App fees panel read 0.000000 across every
 * destination — correctly, because nothing had ever arrived.
 *
 * Harvesting closes that gap: the treasury's position is withdrawn to an
 * address the server can sign for, forwarded to the collector, and split by the
 * collector's own cadence. Which assets are worth moving is decided here, where
 * it can be tested, because the trap is a keeper that spends more on gas than
 * it collects — the same trap `planClaim` exists to avoid.
 */
export interface HarvestCandidate {
  symbol: string;
  address: string;
  decimals: number;
  /** What the treasury has accrued in this asset, in base units. */
  accrued: bigint;
  /** The pool's mark for the asset, 1e8-scaled. Zero means unpriced. */
  priceE8: bigint;
}

/** Value of an accrued balance in whole US cents, floored. */
export function harvestValueCents(c: HarvestCandidate): bigint {
  if (c.priceE8 <= 0n || c.accrued <= 0n) return 0n;
  return (c.accrued * c.priceE8 * 100n) / (10n ** BigInt(c.decimals) * 100_000_000n);
}

/**
 * Which balances are worth a withdrawal and a transfer right now.
 *
 * An unpriced asset is skipped rather than assumed worthless *or* valuable:
 * without a mark there is no way to say whether the transaction pays for
 * itself, and moving it on the next pass costs nothing but time.
 */
export function planHarvest(candidates: HarvestCandidate[], minCents: number): HarvestCandidate[] {
  const floor = BigInt(Math.max(0, Math.floor(minCents)));
  return candidates.filter((c) => c.accrued > 0n && c.priceE8 > 0n && harvestValueCents(c) >= floor);
}
