import {
  createPublicClient,
  createWalletClient,
  maxUint256,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { tesseraPoolAbi, erc20Abi, pacedHttp } from "@tessera/shared";

/**
 * Thin, typed wrapper over TesseraPool for an agent: supply idle USDC to earn
 * yield, or borrow against collateral to fund pay-per-call operations.
 */
export interface TesseraPoolConfig {
  chain: Chain;
  rpcUrl: string;
  account: Account;
  poolAddress: Hex;
}

export interface PoolAccount {
  supplyValueUsd: string; // 1e8 USD scale, formatted below by caller if needed
  borrowValueUsd: string;
  borrowLimitUsd: string;
  healthFactor: bigint; // WAD; maxUint256 when no debt
}

export interface ReserveStats {
  cash: bigint;
  totalBorrows: bigint;
  utilizationWad: bigint;
  borrowAprWad: bigint;
  supplyAprWad: bigint;
}

export class TesseraPoolClient {
  readonly public: PublicClient;
  readonly wallet: WalletClient;
  readonly account: Account;
  readonly pool: Hex;
  private readonly chain: Chain;

  constructor(cfg: TesseraPoolConfig) {
    this.chain = cfg.chain;
    this.account = cfg.account;
    this.pool = cfg.poolAddress;
    this.public = createPublicClient({
      chain: cfg.chain,
      transport: pacedHttp(cfg.rpcUrl),
      pollingInterval: 8000,
      // Batch the per-asset reserve/position reads into one multicall3 call.
      batch: { multicall: true },
    });
    this.wallet = createWalletClient({
      account: cfg.account,
      chain: cfg.chain,
      transport: pacedHttp(cfg.rpcUrl),
    });
  }

  private async ensureApproval(asset: Hex, min: bigint): Promise<void> {
    const allowance = (await this.public.readContract({
      address: asset,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, this.pool],
    })) as bigint;
    if (allowance >= min) return;
    const hash = await this.wallet.writeContract({
      address: asset,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.pool, maxUint256],
      chain: this.chain,
      account: this.account,
    });
    await this.public.waitForTransactionReceipt({ hash });
  }

  private async write(functionName: string, args: unknown[]): Promise<Hex> {
    const { request } = await this.public.simulateContract({
      address: this.pool,
      abi: tesseraPoolAbi,
      functionName: functionName as never,
      args: args as never,
      account: this.account,
    });
    const hash = await this.wallet.writeContract(request);
    await this.public.waitForTransactionReceipt({ hash });
    return hash;
  }

  async supply(asset: Hex, amount: bigint): Promise<Hex> {
    await this.ensureApproval(asset, amount);
    return this.write("supply", [asset, amount]);
  }
  async withdraw(asset: Hex, amount: bigint): Promise<Hex> {
    return this.write("withdraw", [asset, amount]);
  }
  async borrow(asset: Hex, amount: bigint): Promise<Hex> {
    return this.write("borrow", [asset, amount]);
  }
  async repay(asset: Hex, amount: bigint): Promise<Hex> {
    await this.ensureApproval(asset, amount);
    return this.write("repay", [asset, amount]);
  }

  // --- backstop (first-loss capital) ----------------------------------------

  async backstopDeposit(asset: Hex, amount: bigint): Promise<Hex> {
    await this.ensureApproval(asset, amount);
    return this.write("backstopDeposit", [asset, amount]);
  }
  async fundBackstop(asset: Hex, amount: bigint): Promise<Hex> {
    await this.ensureApproval(asset, amount);
    return this.write("fundBackstop", [asset, amount]);
  }
  async queueBackstopExit(asset: Hex, shares: bigint): Promise<Hex> {
    return this.write("queueBackstopExit", [asset, shares]);
  }
  async cancelBackstopExit(asset: Hex): Promise<Hex> {
    return this.write("cancelBackstopExit", [asset]);
  }
  async withdrawBackstop(asset: Hex): Promise<Hex> {
    return this.write("withdrawBackstop", [asset]);
  }

  /**
   * One asset's backstop state for a holder.
   *
   * `allowFailure` throughout because a pool deployed before the backstop
   * existed has none of these selectors, and the app must show that pool
   * without the section rather than failing to render the lending tab at all.
   */
  async backstopOf(asset: Hex, user?: Hex) {
    const who = user ?? this.account.address;
    const c = (functionName: string, args: unknown[]) =>
      ({ address: this.pool, abi: tesseraPoolAbi, functionName, args }) as const;
    const res = await this.public.multicall({
      contracts: [
        c("backstopBalance", [asset]),
        c("backstopBalanceOf", [asset, who]),
        c("backstopShares", [asset, who]),
        c("backstopQueued", [asset, who]),
        c("backstopUnlockAt", [asset, who]),
        c("backstopTakeRate", []),
      ] as never,
      allowFailure: true,
    });
    const big = (i: number) => (res[i]?.status === "success" ? (res[i].result as bigint) : 0n);
    return {
      // The take-rate read is the tell for "does this pool have a backstop":
      // it is the one call that cannot legitimately fail on a pool that does.
      supported: res[5]?.status === "success",
      pot: big(0),
      myValue: big(1),
      myShares: big(2),
      queuedShares: big(3),
      unlockAt: Number(big(4)),
      takeRateBps: res[5]?.status === "success" ? Number(res[5].result) : 0,
    };
  }

  // --- liquidation auctions --------------------------------------------------

  async startAuction(user: Hex, debtAsset: Hex, collateralAsset: Hex, percentBps: number): Promise<Hex> {
    return this.write("startLiquidationAuction", [user, debtAsset, collateralAsset, percentBps]);
  }
  async fillAuction(user: Hex, debtAsset: Hex, fillBps: number): Promise<Hex> {
    // The filler pays the debt asset, so the pool needs an allowance for it.
    // Approving the maximum here rather than the exact bid: the bid moves with
    // the auction ramp between the read and the fill, and an approval that was
    // exact a block ago is the most common way a fill reverts.
    await this.ensureApproval(debtAsset, maxUint256 / 2n);
    return this.write("fillLiquidationAuction", [user, fillBps]);
  }
  async cancelAuction(user: Hex): Promise<Hex> {
    return this.write("cancelLiquidationAuction", [user]);
  }
  async clearBadDebt(user: Hex, asset: Hex): Promise<Hex> {
    return this.write("clearBadDebt", [user, asset]);
  }

  /** An account's open auction and the terms it is offering right now. */
  async auctionOf(user: Hex) {
    const r = await this.public
      .readContract({ address: this.pool, abi: tesseraPoolAbi, functionName: "auctionData", args: [user] })
      .catch(() => null);
    if (!r) return { supported: false, open: false } as const;
    const [startedAt, debtAsset, collateralAsset, debtAmount, collateralAmount, filledBps, lotBps, bidBps] =
      r as readonly [bigint, Hex, Hex, bigint, bigint, number, number, number];
    return {
      supported: true,
      open: startedAt > 0n,
      startedAt: Number(startedAt),
      debtAsset,
      collateralAsset,
      debtAmount,
      collateralAmount,
      filledBps,
      lotBps,
      bidBps,
    } as const;
  }

  /** The two lines a borrower cares about, plus their weighted liability. */
  async accountLimits(user?: Hex) {
    const r = (await this.public
      .readContract({
        address: this.pool,
        abi: tesseraPoolAbi,
        functionName: "accountLimits",
        args: [user ?? this.account.address],
      })
      .catch(() => null)) as readonly [bigint, bigint, bigint] | null;
    if (!r) return null;
    return { borrowLimit: r[0], liquidationLimit: r[1], liability: r[2] };
  }

  async accountData(user?: Hex): Promise<{
    supplyValue: bigint;
    borrowValue: bigint;
    borrowLimit: bigint;
    healthFactor: bigint;
  }> {
    const r = (await this.public.readContract({
      address: this.pool,
      abi: tesseraPoolAbi,
      functionName: "accountData",
      args: [user ?? this.account.address],
    })) as [bigint, bigint, bigint, bigint];
    return { supplyValue: r[0], borrowValue: r[1], borrowLimit: r[2], healthFactor: r[3] };
  }

  async reserveData(asset: Hex): Promise<ReserveStats> {
    const r = (await this.public.readContract({
      address: this.pool,
      abi: tesseraPoolAbi,
      functionName: "reserveData",
      args: [asset],
    })) as [bigint, bigint, bigint, bigint, bigint];
    return { cash: r[0], totalBorrows: r[1], utilizationWad: r[2], borrowAprWad: r[3], supplyAprWad: r[4] };
  }

  supplyBalance(asset: Hex, user?: Hex): Promise<bigint> {
    return this.public.readContract({
      address: this.pool,
      abi: tesseraPoolAbi,
      functionName: "supplyBalance",
      args: [asset, user ?? this.account.address],
    }) as Promise<bigint>;
  }

  borrowBalance(asset: Hex, user?: Hex): Promise<bigint> {
    return this.public.readContract({
      address: this.pool,
      abi: tesseraPoolAbi,
      functionName: "borrowBalance",
      args: [asset, user ?? this.account.address],
    }) as Promise<bigint>;
  }

  /**
   * Reserve config. `enabled` is false when the asset was never registered with
   * `addReserve` — worth surfacing, because an unregistered reserve otherwise
   * looks identical to a read failure.
   */
  async reserveConfig(
    asset: Hex,
  ): Promise<{ enabled: boolean; decimals: number; priceE8: bigint; borrowable: boolean }> {
    const r = (await this.public.readContract({
      address: this.pool,
      abi: tesseraPoolAbi,
      functionName: "reserves",
      args: [asset],
    })) as readonly [boolean, boolean, number, number, number, number, bigint, bigint, bigint, bigint, bigint, bigint];
    return { enabled: r[0], borrowable: r[1], decimals: Number(r[2]), priceE8: r[6] };
  }

  /**
   * Read the whole lending picture in **one** RPC round-trip.
   *
   * Reading per-asset with separate calls meant ~5 requests per reserve, which
   * the public RPC throttled — panels then showed stale or empty values. This
   * aggregates every field for every asset (plus the account summary) into a
   * single multicall3 `eth_call`. `allowFailure` keeps one bad reserve from
   * discarding the rest.
   */
  async readAll(assets: Hex[], user?: Hex) {
    const who = user ?? (this.account.address as Hex);
    const per = (asset: Hex) => [
      { address: this.pool, abi: tesseraPoolAbi, functionName: "reserves", args: [asset] } as const,
      { address: this.pool, abi: tesseraPoolAbi, functionName: "reserveData", args: [asset] } as const,
      { address: this.pool, abi: tesseraPoolAbi, functionName: "supplyBalance", args: [asset, who] } as const,
      { address: this.pool, abi: tesseraPoolAbi, functionName: "borrowBalance", args: [asset, who] } as const,
      { address: asset, abi: erc20Abi, functionName: "balanceOf", args: [who] } as const,
      // Freeze mask + display name + hidden flag, and whether the price is
      // currently usable. `priceOk` never reverts, so a dead oracle feed shows
      // up in the UI as "price unavailable" rather than blanking the panel.
      { address: this.pool, abi: tesseraPoolAbi, functionName: "reserveMeta", args: [asset] } as const,
      { address: this.pool, abi: tesseraPoolAbi, functionName: "priceOk", args: [asset] } as const,
    ];
    const contracts = [
      { address: this.pool, abi: tesseraPoolAbi, functionName: "accountData", args: [who] } as const,
      ...assets.flatMap(per),
    ];
    const res = await this.public.multicall({ contracts: contracts as never, allowFailure: true });
    const acctRow = res[0];
    const account =
      acctRow.status === "success"
        ? (() => {
            const v = acctRow.result as readonly [bigint, bigint, bigint, bigint];
            return { supplyValue: v[0], borrowValue: v[1], borrowLimit: v[2], healthFactor: v[3] };
          })()
        : null;
    const FIELDS = 7;
    const perAsset = assets.map((asset, i) => {
      const base = 1 + i * FIELDS;
      const [cfgR, dataR, supR, borR, walR, metaR, okR] = res.slice(base, base + FIELDS);
      const meta = metaR?.status === "success"
        ? (() => {
            const m = metaR.result as readonly [number, boolean, string];
            return { frozen: Number(m[0]), hidden: m[1], name: m[2] };
          })()
        : { frozen: 0, hidden: false, name: "" };
      const priceOk = okR?.status === "success" ? Boolean(okR.result) : true;
      if (cfgR.status !== "success") return { asset, ok: false as const };
      const c = cfgR.result as readonly [boolean, boolean, number, number, number, number, bigint, bigint, bigint, bigint, bigint, bigint];
      const cfg = { enabled: c[0], borrowable: c[1], decimals: Number(c[2]), priceE8: c[6] };
      if (!cfg.enabled) return { asset, ok: true as const, cfg, meta, priceOk, reserve: null, supplied: 0n, borrowed: 0n, wallet: 0n };
      if (dataR.status !== "success") return { asset, ok: false as const };
      const d = dataR.result as readonly [bigint, bigint, bigint, bigint, bigint];
      return {
        asset,
        ok: true as const,
        cfg,
        meta,
        priceOk,
        reserve: { cash: d[0], totalBorrows: d[1], utilizationWad: d[2], borrowAprWad: d[3], supplyAprWad: d[4] },
        supplied: supR.status === "success" ? (supR.result as bigint) : 0n,
        borrowed: borR.status === "success" ? (borR.result as bigint) : 0n,
        wallet: walR.status === "success" ? (walR.result as bigint) : 0n,
      };
    });
    return { account, perAsset };
  }

  /** The account's raw ERC-20 balance of an asset (its spendable wallet funds). */
  walletBalance(asset: Hex, user?: Hex): Promise<bigint> {
    return this.public.readContract({
      address: asset,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [user ?? this.account.address],
    }) as Promise<bigint>;
  }
}
