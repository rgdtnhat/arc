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
import { createPublicClient, parseAbiItem, type Chain, type Hex, type PublicClient } from "viem";
import { tesseraPoolAbi, tesseraVaultAbi, tesseraAmmAbi, erc20Abi, pacedHttp } from "@tessera/shared";
import { HolderIndex, mergeAddresses, type IndexProgress } from "./holder-index.js";

/** The events that reveal a holder. Balances always come from live reads. */
const EVENTS = {
  supply: parseAbiItem("event Supply(address indexed asset, address indexed user, uint256 amount, uint256 shares)"),
  deposit: parseAbiItem("event Deposit(address indexed user, uint256 assets, uint256 shares)"),
  liquidity: parseAbiItem("event LiquidityAdded(uint256 indexed poolId, address indexed provider, uint256[] amounts, uint256 shares)"),
} as const;

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
  /** A scan is running; these figures will be replaced. Poll again. */
  scanning?: boolean;
  /** Served from an older scan while a fresh one runs. */
  stale?: boolean;
  /** How far the address index has got. Absent for venues that need no index. */
  progress?: IndexProgress;
}

/** The shape returned before a venue has ever been scanned. */
function emptyReport(kind: HolderKind): HolderReport {
  const rankLabel = kind === "lending" ? "Supplied (USD)"
    : kind === "amm" ? "LP shares"
    : kind === "swap" ? "Inventory" : "Shares";
  return { kind, contract: null, rankLabel, assets: [], holders: [], total: "0", partial: false, block: "0" };
}

/** Addresses that belong to the app rather than to a user. */
export interface AppAddresses {
  agent?: Hex;
  collector?: Hex;
  treasury?: Hex;
}

export class HolderReader {
  readonly public: PublicClient;
  private readonly index: HolderIndex;
  /** Log scans are expensive on a throttled RPC; serve a recent one instead. */
  private cache = new Map<string, { at: number; report: HolderReport }>();
  /** Scans in flight, so N pollers cause one sweep rather than N. */
  private scans = new Map<string, Promise<HolderReport>>();

  constructor(
    private readonly chain: Chain,
    private readonly rpcUrl: string,
    private readonly app: AppAddresses = {},
    /** Where the address index is persisted, so a restart doesn't re-scan. */
    indexFile = ".tessera-holders.json",
    /** Balances move with every trade; the reads behind them are cheap. */
    private readonly ttlMs = 30_000,
  ) {
    this.public = createPublicClient({ chain, transport: pacedHttp(rpcUrl), batch: { multicall: true } });
    this.index = new HolderIndex(indexFile);
  }

  /** Addresses we can show without any log scan at all. */
  private seeds(): (string | undefined)[] {
    return [this.app.agent, this.app.collector, this.app.treasury];
  }

  /**
   * Read the index, kick it forward in the background, and return what is known.
   *
   * The background advance is deliberately not awaited: it is bounded-burst work
   * sharing one global RPC pacing gate with everything a user is waiting on.
   * Seeding with the app's own wallets means the table has correct rows on the
   * very first render, before the index has found anybody.
   */
  private addressesFor(contract: Hex, tag: keyof typeof EVENTS, field: string) {
    const { addresses, progress } = this.index.known(contract, tag);
    void this.index.advance(this.public, contract, tag, EVENTS[tag], field).catch(() => {});
    return { addresses: mergeAddresses(addresses, this.seeds()), progress };
  }

  private isApp(address: string) {
    const a = address.toLowerCase();
    return [this.app.agent, this.app.collector, this.app.treasury]
      .some((x) => x && x.toLowerCase() === a);
  }

  invalidate() {
    this.cache.clear();
  }

  /**
   * A venue's current holders.
   *
   * Fast by construction now: the address set comes from the persisted index
   * (no scanning on the request path) and the balances are one bounded
   * multicall. What used to be a minute-long sweep is a handful of reads.
   */
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

    const inflight = this.scans.get(key);
    if (inflight) return inflight;

    const job = this.build(kind, opts)
      .then((report) => {
        this.cache.set(key, { at: Date.now(), report });
        return report;
      })
      .catch((err) => ({
        ...emptyReport(kind),
        note: `Could not read holders: ${err instanceof Error ? err.message : String(err)}`,
      }))
      .finally(() => this.scans.delete(key));
    this.scans.set(key, job);
    return job;
  }

  /** Block until the venue's index has fully caught up. Used at boot. */
  async warm(kind: HolderKind, opts: Parameters<HolderReader["read"]>[1]): Promise<void> {
    const target =
      kind === "lending" ? ([opts.pool, "supply", "user"] as const)
      : kind === "vault" ? ([opts.vault, "deposit", "user"] as const)
      : kind === "amm" ? ([opts.amm, "liquidity", "provider"] as const)
      : null;
    if (!target || !target[0]) return;
    await this.index
      .advance(this.public, target[0], target[1], EVENTS[target[1]], target[2])
      .catch(() => {});
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
    if (!pool || !assets.length) {
      return { ...emptyReport("lending"), note: "The lending pool is not deployed on this network yet." };
    }
    const { addresses, progress } = this.addressesFor(pool, "supply", "user");
    const meta = assets.map((a) => ({ ...a, address: a.address.toLowerCase() }));
    if (!addresses.length) {
      return { ...emptyReport("lending"), contract: pool, assets: meta, progress };
    }

    // Per-asset balances plus the pool's own USD valuation, in one round trip.
    const perHolder = assets.length + 1;
    const res = await this.public.multicall({
      contracts: addresses.flatMap((who) => [
        ...assets.map(
          (a) => ({ address: pool, abi: tesseraPoolAbi, functionName: "supplyBalance", args: [a.address, who as Hex] }) as const,
        ),
        { address: pool, abi: tesseraPoolAbi, functionName: "accountData", args: [who as Hex] } as const,
      ]) as never,
      allowFailure: true,
    });

    const rows = addresses.map((who, i) => {
      const base = i * perHolder;
      const balances: Record<string, string> = {};
      assets.forEach((a, j) => {
        const r = res[base + j];
        balances[a.address.toLowerCase()] = (r?.status === "success" ? (r.result as bigint) : 0n).toString();
      });
      const acct = res[base + assets.length];
      // Rank on the pool's own valuation, not on summed token amounts: 1 cirBTC
      // and 1 USDC are not comparable and adding them ranks dust above real size.
      const supplied = acct?.status === "success" ? ((acct.result as bigint[])[0] ?? 0n) : 0n;
      return { h: { address: who, balances }, value: supplied };
    });

    const block = (await this.public.getBlockNumber()).toString();
    return { ...this.finish("lending", pool, "Supplied (USD)", meta, block, progress, rows) };
  }

  // --- vault -----------------------------------------------------------------

  private async vault(
    vault: Hex | undefined,
    asset?: { address: Hex; symbol: string; decimals: number },
  ): Promise<HolderReport> {
    if (!vault || !asset) {
      return { ...emptyReport("vault"), note: "The yield vault is not deployed on this network yet." };
    }
    const { addresses, progress } = this.addressesFor(vault, "deposit", "user");
    const meta = [{ ...asset, address: asset.address.toLowerCase() }];
    if (!addresses.length) return { ...emptyReport("vault"), contract: vault, assets: meta, progress };

    const res = await this.public.multicall({
      contracts: addresses.flatMap((who) => [
        { address: vault, abi: tesseraVaultAbi, functionName: "sharesOf", args: [who as Hex] } as const,
        { address: vault, abi: tesseraVaultAbi, functionName: "balanceOfAssets", args: [who as Hex] } as const,
      ]) as never,
      allowFailure: true,
    });
    const rows = addresses.map((who, i) => {
      const sh = res[i * 2]?.status === "success" ? (res[i * 2].result as bigint) : 0n;
      const val = res[i * 2 + 1]?.status === "success" ? (res[i * 2 + 1].result as bigint) : 0n;
      return { h: { address: who, balances: { [meta[0].address]: val.toString() }, shares: sh.toString() }, value: sh };
    });
    const block = (await this.public.getBlockNumber()).toString();
    return this.finish("vault", vault, "Shares", meta, block, progress, rows);
  }

  // --- AMM -------------------------------------------------------------------

  private async amm(amm: Hex | undefined, poolId: number): Promise<HolderReport> {
    if (!amm) return { ...emptyReport("amm"), note: "No AMM is deployed on this network yet." };

    const { addresses, progress } = this.addressesFor(amm, "liquidity", "provider");
    const info = (await this.public.readContract({
      address: amm, abi: tesseraAmmAbi, functionName: "poolInfo", args: [BigInt(poolId)],
    })) as readonly [Hex[], bigint[], number, number, bigint, boolean, string];
    const [assetAddrs, balances, , , totalShares] = info;

    const metaRes = await this.public.multicall({
      contracts: assetAddrs.flatMap((a) => [
        { address: a, abi: erc20Abi, functionName: "symbol" } as const,
        { address: a, abi: erc20Abi, functionName: "decimals" } as const,
      ]) as never,
      allowFailure: true,
    });
    const meta = assetAddrs.map((a, i) => ({
      address: a.toLowerCase(),
      symbol: metaRes[i * 2]?.status === "success" ? String(metaRes[i * 2].result) : a.slice(0, 8),
      decimals: metaRes[i * 2 + 1]?.status === "success" ? Number(metaRes[i * 2 + 1].result) : 18,
    }));
    if (!addresses.length || totalShares === 0n) {
      return { ...emptyReport("amm"), contract: amm, assets: meta, progress };
    }

    const res = await this.public.multicall({
      contracts: addresses.map(
        (who) => ({ address: amm, abi: tesseraAmmAbi, functionName: "sharesOf", args: [BigInt(poolId), who as Hex] }) as const,
      ) as never,
      allowFailure: true,
    });
    const rows = addresses.map((who, i) => {
      const sh = res[i]?.status === "success" ? (res[i].result as bigint) : 0n;
      const bal: Record<string, string> = {};
      assetAddrs.forEach((a, j) => {
        bal[a.toLowerCase()] = (((balances[j] ?? 0n) * sh) / totalShares).toString();
      });
      return { h: { address: who, balances: bal, shares: sh.toString() }, value: sh };
    });
    const block = (await this.public.getBlockNumber()).toString();
    return this.finish("amm", amm, "LP shares", meta, block, progress, rows);
  }

  // --- swap desk -------------------------------------------------------------

  /**
   * The desk has no depositors. Its inventory *is* its token balance, so there
   * is no per-wallet position to rank — an empty leaderboard here would read as
   * a bug. Report the inventory instead, and say why. No index needed.
   */
  private async swap(
    swap: Hex | undefined,
    assets: { address: Hex; symbol: string; decimals: number }[],
  ): Promise<HolderReport> {
    const meta = assets.map((a) => ({ ...a, address: a.address.toLowerCase() }));
    const base: HolderReport = {
      ...emptyReport("swap"),
      contract: swap ?? null,
      assets: meta,
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
      holders: anything ? [{ address: swap.toLowerCase(), balances, rank: "0", pct: 100, isApp: true }] : [],
    };
  }

  // --- shared ----------------------------------------------------------------

  /** Sort, compute each holder's percentage, and mark the app's own rows. */
  private finish(
    kind: HolderKind,
    contract: Hex,
    rankLabel: string,
    assets: HolderReport["assets"],
    block: string,
    progress: IndexProgress,
    rows: { h: { address: string; balances: Record<string, string>; shares?: string }; value: bigint }[],
  ): HolderReport {
    // Someone who has fully withdrawn isn't a holder. Dropping them here is
    // also what keeps the seeded app addresses from showing as zero rows on a
    // venue the app has never used.
    const withValue = rows.filter((r) => r.value > 0n);
    withValue.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
    const total = withValue.reduce((s, r) => s + r.value, 0n);
    return {
      kind,
      contract,
      rankLabel,
      assets,
      holders: withValue.map((r) => ({
        address: r.h.address,
        balances: r.h.balances,
        shares: r.h.shares,
        rank: r.value.toString(),
        pct: percentOf(r.value, total),
        isApp: this.isApp(r.h.address) || undefined,
      })),
      total: total.toString(),
      // The index can be short, which under-reports *who*, never *how much*.
      partial: !progress.complete || progress.gaps > 0,
      progress,
      block,
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
