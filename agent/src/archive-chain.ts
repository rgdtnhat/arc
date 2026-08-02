import { createPublicClient, parseAbiItem, type Chain, type Hex, type PublicClient } from "viem";
import {
  tesseraPoolAbi,
  tesseraVaultAbi,
  tesseraAmmAbi,
  erc20Abi,
  pacedHttp,
} from "@tessera/shared";
import type { ArchiveKind, HolderBalance } from "./history.js";

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

export class ArchiveScanner {
  readonly public: PublicClient;

  constructor(chain: Chain, rpcUrl: string) {
    this.public = createPublicClient({ chain, transport: pacedHttp(rpcUrl), batch: { multicall: true } });
  }

  /** Collect the distinct `user`/`provider` addresses from an event, in windows. */
  private async holderAddresses(address: Hex, event: (typeof EVENTS)[keyof typeof EVENTS], field: string) {
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
      try {
        const logs = await this.public.getLogs({ address, event, fromBlock: from, toBlock: to });
        for (const l of logs) {
          const v = (l.args as Record<string, unknown>)[field];
          if (typeof v === "string") found.add(v.toLowerCase());
        }
      } catch {
        // A throttled or refused window is a hole in the holder set, and
        // pretending otherwise is how someone gets left out of a payout.
        partial = true;
      }
      if (from === 0n) break;
      to = from - 1n;
    }
    return { addresses: [...found], block: latest.toString(), partial };
  }

  /** Retired lending pool: every supplier and what they can still withdraw. */
  async scanPool(pool: Hex, assets: { address: Hex; symbol: string; decimals: number }[]): Promise<ArchiveScan> {
    const { addresses, block, partial } = await this.holderAddresses(pool, EVENTS.poolSupply, "user");
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
