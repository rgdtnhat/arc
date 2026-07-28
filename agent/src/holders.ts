/**
 * Who holds what, right now, in each DeFi venue.
 *
 * The archive scanner already knows how to read a contract's holder set off its
 * event logs and price the positions from live `balanceOf`-style reads. This
 * points that same machinery at the contracts that are *still running*, so the
 * dashboard can show a leaderboard of suppliers, depositors and liquidity
 * providers rather than only the connected wallet's own row.
 *
 * Two things this deliberately does not do:
 *
 *  - It does not rank by summing raw token amounts. 1 cirBTC and 1 USDC are not
 *    comparable, and a leaderboard that added them would put a dust holder above
 *    a real one. Lending ranks by the pool's own USD valuation (`accountData`,
 *    the same number the protocol liquidates on); the vault and AMM rank by
 *    share count, which is unambiguous because each has a single share class.
 *
 *  - It does not hide an incomplete scan. Arc's public RPC caps `eth_getLogs`
 *    spans, so the holder set can be short. `partial` is passed straight
 *    through, and the caller is expected to say so — a leaderboard that is
 *    quietly missing the largest holder is worse than one that admits it.
 */
import { createPublicClient, type Chain, type Hex, type PublicClient } from "viem";
import { tesseraPoolAbi, erc20Abi, pacedHttp } from "@tessera/shared";
import { ArchiveScanner } from "./archive-chain.js";

export type HolderKind = "lending" | "vault" | "amm" | "swap";

export interface HolderRow {
  address: string;
  /** Raw per-asset amounts, keyed by lowercased token address. */
  balances: Record<string, string>;
  /** Share count for the share-based venues. */
  shares?: string;
  /** What the row is ranked on. USD (6dp) for lending, share count elsewhere. */
  rank: string;
  /** Share of the venue's total, 0-100. */
  pct: number;
  /** True when this address is the app's own (agent wallet, collector, treasury). */
  isApp?: boolean;
}

export interface HolderReport {
  kind: HolderKind;
  contract: Hex | null;
  /** What `rank` means, so the UI can label the column honestly. */
  rankLabel: string;
  assets: { address: string; symbol: string; decimals: number }[];
  /** Sorted by `rank`, largest first. */
  holders: HolderRow[];
  /** Sum of `rank` across every holder found. */
  total: string;
  partial: boolean;
  block: string;
  /** Set when the venue has no per-wallet positions at all (the swap desk). */
  note?: string;
}

/** Addresses that belong to the app rather than to a user. */
export interface AppAddresses {
  agent?: Hex;
  collector?: Hex;
  treasury?: Hex;
}

export class HolderReader {
  readonly public: PublicClient;
  private readonly scanner: ArchiveScanner;
  /** Log scans are expensive on a throttled RPC; serve a recent one instead. */
  private cache = new Map<string, { at: number; report: HolderReport }>();

  constructor(
    private readonly chain: Chain,
    private readonly rpcUrl: string,
    private readonly app: AppAddresses = {},
    // A full-history log sweep is ~90 windowed requests on a throttled RPC.
    // Worth doing well and reusing, not worth redoing every minute.
    private readonly ttlMs = 5 * 60_000,
  ) {
    this.public = createPublicClient({ chain, transport: pacedHttp(rpcUrl), batch: { multicall: true } });
    this.scanner = new ArchiveScanner(chain, rpcUrl);
  }

  private isApp(address: string) {
    const a = address.toLowerCase();
    return [this.app.agent, this.app.collector, this.app.treasury]
      .some((x) => x && x.toLowerCase() === a);
  }

  invalidate() {
    this.cache.clear();
  }

  async read(
    kind: HolderKind,
    opts: {
      pool?: Hex;
      vault?: Hex;
      vaultAsset?: { address: Hex; symbol: string; decimals: number };
      amm?: Hex;
      poolId?: number;
      swap?: Hex;
      assets?: { address: Hex; symbol: string; decimals: number }[];
      force?: boolean;
    },
  ): Promise<HolderReport> {
    const key = `${kind}:${opts.poolId ?? 0}`;
    const hit = this.cache.get(key);
    if (!opts.force && hit && Date.now() - hit.at < this.ttlMs) return hit.report;

    const report = await this.build(kind, opts);
    this.cache.set(key, { at: Date.now(), report });
    return report;
  }

  private async build(
    kind: HolderKind,
    opts: Parameters<HolderReader["read"]>[1],
  ): Promise<HolderReport> {
    if (kind === "lending") return this.lending(opts.pool, opts.assets ?? []);
    if (kind === "vault") return this.vault(opts.vault, opts.vaultAsset);
    if (kind === "amm") return this.amm(opts.amm, opts.poolId ?? 0);
    return this.swap(opts.swap, opts.assets ?? []);
  }

  // --- lending ---------------------------------------------------------------

  private async lending(
    pool: Hex | undefined,
    assets: { address: Hex; symbol: string; decimals: number }[],
  ): Promise<HolderReport> {
    const empty = {
      kind: "lending" as const, contract: pool ?? null, rankLabel: "Supplied (USD)",
      assets: [], holders: [], total: "0", partial: false, block: "0",
    };
    if (!pool || !assets.length) return { ...empty, note: "The lending pool is not deployed on this network yet." };

    const scan = await this.scanner.scanPool(pool, assets);
    if (!scan.holders.length) {
      return { ...empty, assets: scan.assets, block: scan.block, partial: scan.partial };
    }

    // Rank on the pool's own valuation rather than on summed token amounts —
    // this is the figure the protocol itself lends and liquidates against.
    const res = await this.public.multicall({
      contracts: scan.holders.map(
        (h) => ({ address: pool, abi: tesseraPoolAbi, functionName: "accountData", args: [h.address as Hex] }) as const,
      ) as never,
      allowFailure: true,
    });

    const ranked = scan.holders.map((h, i) => {
      const row = res[i];
      const supplied = row?.status === "success" ? ((row.result as bigint[])[0] ?? 0n) : 0n;
      return { h, value: supplied };
    });
    return this.finish("lending", pool, "Supplied (USD)", scan, ranked);
  }

  // --- vault -----------------------------------------------------------------

  private async vault(
    vault: Hex | undefined,
    asset?: { address: Hex; symbol: string; decimals: number },
  ): Promise<HolderReport> {
    const empty = {
      kind: "vault" as const, contract: vault ?? null, rankLabel: "Shares",
      assets: [], holders: [], total: "0", partial: false, block: "0",
    };
    if (!vault || !asset) return { ...empty, note: "The yield vault is not deployed on this network yet." };

    const scan = await this.scanner.scanVault(vault, asset);
    const ranked = scan.holders.map((h) => ({ h, value: BigInt(h.shares ?? "0") }));
    return this.finish("vault", vault, "Shares", scan, ranked);
  }

  // --- AMM -------------------------------------------------------------------

  private async amm(amm: Hex | undefined, poolId: number): Promise<HolderReport> {
    const empty = {
      kind: "amm" as const, contract: amm ?? null, rankLabel: "LP shares",
      assets: [], holders: [], total: "0", partial: false, block: "0",
    };
    if (!amm) return { ...empty, note: "No AMM is deployed on this network yet." };

    const scan = await this.scanner.scanAmm(amm, poolId);
    const ranked = scan.holders.map((h) => ({ h, value: BigInt(h.shares ?? "0") }));
    return this.finish("amm", amm, "LP shares", scan, ranked);
  }

  // --- swap desk -------------------------------------------------------------

  /**
   * The desk has no depositors. Its inventory *is* its token balance, so there
   * is no per-wallet position to rank — showing an empty leaderboard here would
   * read as a bug. Report the inventory instead, and say why.
   */
  private async swap(
    swap: Hex | undefined,
    assets: { address: Hex; symbol: string; decimals: number }[],
  ): Promise<HolderReport> {
    const base = {
      kind: "swap" as const, contract: swap ?? null, rankLabel: "Inventory",
      assets: assets.map((a) => ({ ...a, address: a.address.toLowerCase() })),
      holders: [] as HolderRow[], total: "0", partial: false, block: "0",
      note:
        "The swap desk has no depositors — its inventory is its own token balance, so there are no " +
        "per-wallet shares to rank. What it holds is shown below; the app owns all of it.",
    };
    if (!swap || !assets.length) return base;

    const res = await this.public.multicall({
      contracts: assets.map(
        (a) => ({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [swap] }) as const,
      ) as never,
      allowFailure: true,
    });
    const balances: Record<string, string> = {};
    assets.forEach((a, i) => {
      const v = res[i]?.status === "success" ? (res[i].result as bigint) : 0n;
      balances[a.address.toLowerCase()] = v.toString();
    });
    const block = (await this.public.getBlockNumber()).toString();
    const anything = Object.values(balances).some((v) => v !== "0");
    return {
      ...base,
      block,
      holders: anything
        ? [{ address: swap.toLowerCase(), balances, rank: "0", pct: 100, isApp: true }]
        : [],
    };
  }

  // --- shared ----------------------------------------------------------------

  /** Sort, compute each holder's percentage, and mark the app's own rows. */
  private finish(
    kind: HolderKind,
    contract: Hex,
    rankLabel: string,
    scan: { holders: { address: string; balances: Record<string, string>; shares?: string }[]; assets: HolderReport["assets"]; block: string; partial: boolean },
    ranked: { h: { address: string; balances: Record<string, string>; shares?: string }; value: bigint }[],
  ): HolderReport {
    const withValue = ranked.filter((r) => r.value > 0n);
    withValue.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
    const total = withValue.reduce((s, r) => s + r.value, 0n);
    return {
      kind,
      contract,
      rankLabel,
      assets: scan.assets,
      holders: withValue.map((r) => ({
        address: r.h.address,
        balances: r.h.balances,
        shares: r.h.shares,
        rank: r.value.toString(),
        pct: percentOf(r.value, total),
        isApp: this.isApp(r.h.address) || undefined,
      })),
      total: total.toString(),
      partial: scan.partial,
      block: scan.block,
    };
  }
}

/**
 * A holder's share of the total, as a percentage with 2dp.
 *
 * Done in integer arithmetic before converting: `Number(big) / Number(total)`
 * loses precision once the values exceed 2^53, which share counts routinely do.
 */
export function percentOf(value: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((value * 1_000_000n) / total) / 10_000;
}

/**
 * Slice a sorted list for display.
 *
 * Exported because the paging maths is the part that quietly goes wrong: an
 * out-of-range page should clamp to the last one rather than render blank, and
 * an empty list is one page, not zero.
 */
export function paginate<T>(rows: T[], page: number, size: number): {
  rows: T[];
  page: number;
  pages: number;
  size: number;
  total: number;
} {
  const s = Math.max(1, Math.floor(size) || 10);
  const pages = Math.max(1, Math.ceil(rows.length / s));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: rows.slice((p - 1) * s, p * s), page: p, pages, size: s, total: rows.length };
}
