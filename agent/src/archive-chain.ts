import { createPublicClient, parseAbiItem, type Chain, type Hex, type PublicClient } from "viem";
import {
  tesseraPoolAbi,
  tesseraVaultAbi,
  tesseraAmmAbi,
  erc20Abi,
  pacedHttp,
} from "@tessera/shared";
import type { ArchiveKind, HolderBalance } from "./history.js";
import { writeJsonAtomic, readJson } from "./state-file.js";

/**
 * Reading a retired contract's holders back off the chain.
 *
 * Solidity mappings can't be enumerated, so the holder *set* comes from event
 * logs — every address that ever supplied, deposited or provided liquidity. The
 * *balances* then come from `balanceOf`-style reads against the live contract,
 * never from replaying the events: replaying would drift the moment anything
 * happened that the log scan missed, and the whole point of this file is to
 * produce figures someone can be paid from.
 *
 * A partial log scan therefore under-reports *who*, never *how much*. That is
 * the safe direction to fail: a missing holder is visible as a balance the
 * totals don't account for, whereas a wrong amount would be paid out silently.
 */

import { findDeploymentBlock } from "./deploy-block.js";

const EVENTS = {
  poolSupply: parseAbiItem("event Supply(address indexed asset, address indexed user, uint256 amount, uint256 shares)"),
  vaultDeposit: parseAbiItem("event Deposit(address indexed user, uint256 assets, uint256 shares)"),
  ammAdded: parseAbiItem("event LiquidityAdded(uint256 indexed poolId, address indexed provider, uint256[] amounts, uint256 shares)"),
} as const;

/** Arc's public RPC caps `eth_getLogs` spans, so scan in windows. */
const LOG_WINDOW = BigInt(process.env.ARC_LOG_WINDOW ?? "9000"); // Arc caps eth_getLogs at 10k
/** How far back to look. Blocks, not time — the deploy is the real lower bound. */
const LOG_LOOKBACK = BigInt(process.env.ARC_LOG_LOOKBACK ?? "500000");

export interface ArchiveScan {
  holders: HolderBalance[];
  block: string;
  /** True when the log scan hit its window budget and may have missed holders. */
  partial: boolean;
  assets: { address: string; symbol: string; decimals: number }[];
}

/**
 * How far along a scan is, for callers that have a human waiting.
 *
 * The scan walks up to a few hundred windowed `getLogs` calls backwards through
 * a contract's whole history, and on a throttled public RPC each one can sit in
 * a retry backoff for seconds. In a server that is invisible and fine. On a
 * command line it is several minutes of a completely silent terminal, which
 * reads as a hung process — and a hung-looking process gets killed, which is
 * how a migration ends up half-scanned.
 */
export interface ScanProgress {
  /** Windows requested so far, and the ceiling before the scan gives up. */
  windows: number;
  maxWindows: number;
  /** The window just read, and the block the scan stops at. */
  from: bigint;
  to: bigint;
  floor: bigint;
  /** Distinct addresses found so far. */
  found: number;
  /** True once a window has been thrown away — the scan will be partial. */
  partial: boolean;
  /** This window was answered from an earlier run rather than re-read. */
  cached?: boolean;
}

export interface ScanOptions {
  onProgress?: (p: ScanProgress) => void;
  /**
   * Where to remember which block ranges have already been read.
   *
   * A refused window used to be a hole that the next run re-opened: nothing was
   * kept between attempts, so a throttled RPC produced the same partial answer
   * for ever. Blocks are immutable, so a range read once never needs reading
   * again — and with that written down, each run fills holes instead of
   * re-fighting them, and enough runs converge.
   */
  cacheFile?: string;
  /** How many times to re-ask for a window the endpoint refused. */
  attempts?: number;
}

/** One contract+event's scan history: ranges read, and who was in them. */
interface ScanCache {
  /** Inclusive `[from, to]` block ranges already read, as decimal strings. */
  done: [string, string][];
  addresses: string[];
}

/** Merge a range into a sorted, non-overlapping list. */
export function coverRange(done: [bigint, bigint][], add: [bigint, bigint]): [bigint, bigint][] {
  const all = [...done, add].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: [bigint, bigint][] = [];
  for (const r of all) {
    const last = out[out.length - 1];
    // Touching counts as overlapping: [1,10] and [11,20] are one range, and
    // leaving a one-block seam between them would re-read it for ever.
    if (last && r[0] <= last[1] + 1n) last[1] = r[1] > last[1] ? r[1] : last[1];
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Is every block in `[from, to]` already inside one covered range? */
export function isCovered(done: [bigint, bigint][], from: bigint, to: bigint): boolean {
  return done.some((r) => r[0] <= from && r[1] >= to);
}

export class ArchiveScanner {
  readonly public: PublicClient;

  constructor(chain: Chain, rpcUrl: string) {
    this.public = createPublicClient({ chain, transport: pacedHttp(rpcUrl), batch: { multicall: true } });
  }

  /** Collect the distinct `user`/`provider` addresses from an event, in windows. */
  private async holderAddresses(
    address: Hex,
    event: (typeof EVENTS)[keyof typeof EVENTS],
    field: string,
    opts: ScanOptions = {},
  ) {
    const latest = await this.public.getBlockNumber();
    // Start at the contract's own creation block. A fixed lookback is a few
    // days on a fast chain, so anything older reads as "no holders" — which is
    // indistinguishable from an empty pool and the reason this used to return
    // nothing for a week-old deployment.
    const created = await findDeploymentBlock(this.public, address, latest).catch(() => null);
    const floor = created ?? (latest > LOG_LOOKBACK ? latest - LOG_LOOKBACK : 0n);
    const found = new Set<string>();
    let partial = false;
    let to = latest;

    /*
     * What earlier runs already read, so this one does not read it again.
     *
     * Keyed by contract, event and field: two scans of the same pool for
     * different events cover different ground and must not share a record.
     */
    const key = `${address}:${event.name ?? "event"}:${field}`.toLowerCase();
    const cacheFile = opts.cacheFile ?? null;
    const store = cacheFile
      ? (readJson<Record<string, ScanCache>>(cacheFile, {}).value ?? {})
      : {};
    const mine: ScanCache = store[key] ?? { done: [], addresses: [] };
    let covered: [bigint, bigint][] = mine.done.map(([a, b]) => [BigInt(a), BigInt(b)] as [bigint, bigint]);
    for (const a of mine.addresses) found.add(a);
    const saveCache = () => {
      if (!cacheFile) return;
      store[key] = {
        done: covered.map(([a, b]) => [a.toString(), b.toString()] as [string, string]),
        addresses: [...found],
      };
      try { writeJsonAtomic(cacheFile, store); } catch { /* a cache that cannot be written is still a scan */ }
    };
    // Walk backwards so the most recent activity is captured first: if the scan
    // has to stop early, what it has is the part most likely to still matter.
    let windows = 0;
    // Enough windows to cover a real deployment's lifetime. The budget still
    // exists so a pathological range can't hang a request; hitting it sets
    // `partial` rather than passing off a short scan as a full one.
    const MAX_WINDOWS = Number(process.env.ARC_LOG_MAX_WINDOWS ?? "220");
    while (to > floor) {
      if (windows++ >= MAX_WINDOWS) { partial = true; break; }
      const from = to > LOG_WINDOW ? to - LOG_WINDOW : 0n;
      if (isCovered(covered, from, to)) {
        // Read by an earlier run. Blocks do not change, so neither does the
        // answer — and skipping it is what lets a throttled endpoint finish
        // across several attempts instead of never.
        opts.onProgress?.({ windows, maxWindows: MAX_WINDOWS, from, to, floor, found: found.size, partial, cached: true });
        if (from === 0n) break;
        to = from - 1n;
        continue;
      }
      /*
       * Ask again before calling it a hole.
       *
       * A refused window used to be dropped on the first refusal, which on a
       * public endpoint that throttles under load meant most of them. The
       * transport already backs off between calls; this just declines to give
       * up on the first no.
       */
      let got = false;
      for (let attempt = 0; attempt < Math.max(1, opts.attempts ?? 3) && !got; attempt++) {
        try {
          const logs = await this.public.getLogs({ address, event, fromBlock: from, toBlock: to });
          for (const l of logs) {
            const v = (l.args as Record<string, unknown>)[field];
            if (typeof v === "string") found.add(v.toLowerCase());
          }
          got = true;
        } catch {
          // Give the endpoint room before asking again; the last attempt does
          // not wait, because nothing follows it.
          if (attempt < Math.max(1, opts.attempts ?? 3) - 1) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      if (got) {
        covered = coverRange(covered, [from, to]);
        saveCache();
      } else {
        // A throttled or refused window is a hole in the holder set, and
        // pretending otherwise is how someone gets left out of a payout.
        partial = true;
      }
      // Reported after the window rather than before, so the count reflects
      // work actually done and a caller can tell a slow scan from a stuck one.
      opts.onProgress?.({ windows, maxWindows: MAX_WINDOWS, from, to, floor, found: found.size, partial });
      if (from === 0n) break;
      to = from - 1n;
    }
    saveCache();
    return { addresses: [...found], block: latest.toString(), partial };
  }

  /** Retired lending pool: every supplier and what they can still withdraw. */
  async scanPool(
    pool: Hex,
    assets: { address: Hex; symbol: string; decimals: number }[],
    opts: ScanOptions = {},
  ): Promise<ArchiveScan> {
    const { addresses, block, partial } = await this.holderAddresses(pool, EVENTS.poolSupply, "user", opts);
    if (!addresses.length) return { holders: [], block, partial, assets };
    const calls = addresses.flatMap((who) =>
      assets.map(
        (a) =>
          ({ address: pool, abi: tesseraPoolAbi, functionName: "supplyBalance", args: [a.address, who as Hex] }) as const,
      ),
    );
    const res = await this.public.multicall({ contracts: calls as never, allowFailure: true });
    const holders: HolderBalance[] = [];
    addresses.forEach((who, i) => {
      const balances: Record<string, string> = {};
      let any = false;
      assets.forEach((a, j) => {
        const row = res[i * assets.length + j];
        const v = row?.status === "success" ? (row.result as bigint) : 0n;
        if (v > 0n) any = true;
        balances[a.address.toLowerCase()] = v.toString();
      });
      // Someone who already withdrew everything isn't owed anything; listing
      // them as a zero row just makes the real work harder to see.
      if (any) holders.push({ address: who, balances });
    });
    return { holders, block, partial, assets };
  }

  /** Retired vault: every depositor, their shares, and what those shares are worth. */
  async scanVault(vault: Hex, asset: { address: Hex; symbol: string; decimals: number }): Promise<ArchiveScan> {
    const { addresses, block, partial } = await this.holderAddresses(vault, EVENTS.vaultDeposit, "user");
    if (!addresses.length) return { holders: [], block, partial, assets: [asset] };
    const calls = addresses.flatMap((who) => [
      { address: vault, abi: tesseraVaultAbi, functionName: "sharesOf", args: [who as Hex] } as const,
      { address: vault, abi: tesseraVaultAbi, functionName: "balanceOfAssets", args: [who as Hex] } as const,
    ]);
    const res = await this.public.multicall({ contracts: calls as never, allowFailure: true });
    const holders: HolderBalance[] = [];
    addresses.forEach((who, i) => {
      const sh = res[i * 2]?.status === "success" ? (res[i * 2].result as bigint) : 0n;
      const val = res[i * 2 + 1]?.status === "success" ? (res[i * 2 + 1].result as bigint) : 0n;
      if (sh > 0n) {
        holders.push({ address: who, shares: sh.toString(), balances: { [asset.address.toLowerCase()]: val.toString() } });
      }
    });
    return { holders, block, partial, assets: [asset] };
  }

  /** Retired AMM pool: every provider, their shares, and their slice of each asset. */
  async scanAmm(amm: Hex, poolId: number): Promise<ArchiveScan> {
    const { addresses, block, partial } = await this.holderAddresses(amm, EVENTS.ammAdded, "provider");
    const info = (await this.public.readContract({
      address: amm,
      abi: tesseraAmmAbi,
      functionName: "poolInfo",
      args: [BigInt(poolId)],
    })) as readonly [Hex[], bigint[], number, number, bigint, boolean, string];
    const [assetAddrs, balances, , , totalShares] = info;
    const meta = await this.public.multicall({
      contracts: assetAddrs.flatMap((a) => [
        { address: a, abi: erc20Abi, functionName: "symbol" } as const,
        { address: a, abi: erc20Abi, functionName: "decimals" } as const,
      ]) as never,
      allowFailure: true,
    });
    const assets = assetAddrs.map((a, i) => ({
      address: a.toLowerCase(),
      symbol: meta[i * 2]?.status === "success" ? String(meta[i * 2].result) : a.slice(0, 8),
      decimals: meta[i * 2 + 1]?.status === "success" ? Number(meta[i * 2 + 1].result) : 18,
    }));
    if (!addresses.length || totalShares === 0n) return { holders: [], block, partial, assets };

    const res = await this.public.multicall({
      contracts: addresses.map(
        (who) => ({ address: amm, abi: tesseraAmmAbi, functionName: "sharesOf", args: [BigInt(poolId), who as Hex] }) as const,
      ) as never,
      allowFailure: true,
    });
    const holders: HolderBalance[] = [];
    addresses.forEach((who, i) => {
      const sh = res[i]?.status === "success" ? (res[i].result as bigint) : 0n;
      if (sh === 0n) return;
      const bal: Record<string, string> = {};
      assetAddrs.forEach((a, j) => {
        bal[a.toLowerCase()] = (((balances[j] ?? 0n) * sh) / totalShares).toString();
      });
      holders.push({ address: who, shares: sh.toString(), balances: bal });
    });
    return { holders, block, partial, assets };
  }

  /**
   * The fee collector, the router, and the retired swap desk hold **no per-user
   * balances** — whatever is in them belongs to the app. Archiving one records
   * what the contract still holds so it can be swept, with the treasury named as
   * the single "holder". For a router the answer is normally zero, since it
   * holds nothing between calls; a non-zero reading means stray tokens worth
   * sweeping.
   */
  async scanTreasury(
    contract: Hex,
    assets: { address: Hex; symbol: string; decimals: number }[],
    treasury: Hex,
  ): Promise<ArchiveScan> {
    const block = (await this.public.getBlockNumber()).toString();
    const res = await this.public.multicall({
      contracts: assets.map(
        (a) => ({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [contract] }) as const,
      ) as never,
      allowFailure: true,
    });
    const balances: Record<string, string> = {};
    let any = false;
    assets.forEach((a, i) => {
      const v = res[i]?.status === "success" ? (res[i].result as bigint) : 0n;
      if (v > 0n) any = true;
      balances[a.address.toLowerCase()] = v.toString();
    });
    return {
      holders: any ? [{ address: treasury.toLowerCase(), balances }] : [],
      block,
      partial: false,
      assets: assets.map((a) => ({ ...a, address: a.address.toLowerCase() })),
    };
  }

  scan(
    kind: ArchiveKind,
    address: Hex,
    opts: { assets?: { address: Hex; symbol: string; decimals: number }[]; poolId?: number; treasury?: Hex },
  ): Promise<ArchiveScan> {
    const assets = opts.assets ?? [];
    switch (kind) {
      case "pool":
        return this.scanPool(address, assets);
      case "vault":
        if (!assets[0]) throw new Error("A vault archive needs its asset.");
        return this.scanVault(address, assets[0]);
      case "amm":
        return this.scanAmm(address, opts.poolId ?? 0);
      case "swap":
      case "router":
      case "collector":
        if (!opts.treasury) throw new Error("A treasury archive needs the destination address.");
        return this.scanTreasury(address, assets, opts.treasury);
    }
  }
}
