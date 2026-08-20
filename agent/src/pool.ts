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
import { tesseraPoolAbi, erc20Abi, pacedHttp, withGasMargin } from "@tessera/shared";
import { confirm } from "./confirm.js";

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

/**
 * `TesseraPool.reserves(asset)` as it actually comes back.
 *
 * Written out in full because reading it by hand-counted index is how this went
 * wrong: the struct carries **four** uint16 risk parameters — cFactor,
 * liqFactor, lFactor, reserveFactor — and two readers here counted three, so
 * they took index 6 and got `reserveFactor` (1000) where they meant `price`.
 *
 * That is not a display bug. `priceE8` sizes the borrow limit, so a price of
 * 1000 base units instead of, say, 1e8 inflates the maximum borrow by five
 * orders of magnitude and quotes it to the user as a number they can act on.
 *
 * Named constants below, so the next field added to the struct moves one line
 * rather than silently repointing every reader at its neighbour.
 */
export type ReserveTuple = readonly [
  boolean, // 0 enabled
  boolean, // 1 borrowable
  number,  // 2 decimals
  number,  // 3 cFactor
  number,  // 4 liqFactor
  number,  // 5 lFactor
  number,  // 6 reserveFactor
  bigint,  // 7 price (PRICE_SCALE, 1e8)
  bigint,  // 8 totalSupplyShares
  bigint,  // 9 totalSupplyAssets
  bigint,  // 10 totalBorrowShares
  bigint,  // 11 totalBorrowAssets
  bigint,  // 12 lastAccrual
];

/** Index of `price` in `ReserveTuple`. Seven, not six. */
export const PRICE_IX = 7;

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
    /*
     * Wrapped, so every write through this client carries a gas margin. This
     * RPC's estimate has come back a shade short twice, and these are the
     * calls that lose money when they revert — see shared/src/gas.ts.
     */
    this.wallet = withGasMargin(
      createWalletClient({
        account: cfg.account,
        chain: cfg.chain,
        transport: pacedHttp(cfg.rpcUrl),
      }),
      this.public as never,
    );
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
    await confirm(this.public, hash);
  }

  /**
   * Would this call succeed, without sending it?
   *
   * Used before a session-funded supply: the visitor's money moves in one
   * transaction and lands in the pool in the next, so the second is simulated
   * first. A revert discovered afterwards would leave their funds sitting in
   * the app's wallet, which is the one outcome this flow must not have.
   */
  async wouldSucceed(functionName: string, args: unknown[]): Promise<true | string> {
    try {
      await this.public.simulateContract({
        address: this.pool,
        abi: tesseraPoolAbi,
        functionName: functionName as never,
        args: args as never,
        account: this.account,
      });
      return true;
    } catch (e) {
      const m = e as { shortMessage?: string; message?: string };
      return m.shortMessage ?? m.message ?? String(e);
    }
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
    await confirm(this.public, hash);
    return hash;
  }

  async supply(asset: Hex, amount: bigint): Promise<Hex> {
    await this.ensureApproval(asset, amount);
    return this.write("supply", [asset, amount]);
  }
  /**
   * Supply so that **`user`** holds the position, paid for from this wallet.
   *
   * The pool's own words: you pay, they get the position, and it is
   * permissionless because handing somebody your money can only help them.
   * What it makes possible here is a scheduled supply funded by a *visitor's*
   * session key — their USDC comes through the delegation, this wallet passes
   * it straight into the pool, and the shares are minted to them. There is no
   * step at which the position belongs to the app.
   */
  async supplyFor(asset: Hex, user: Hex, amount: bigint): Promise<Hex> {
    await this.ensureApproval(asset, amount);
    return this.write("supplyFor", [asset, user, amount]);
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
  /**
   * Withdraw or borrow for `user`, paid **to `user`**, on their authority.
   *
   * The mirror of `supplyFor`: that one needs no permission because paying into
   * a position can only help; this one needs the holder to have named this
   * wallet an operator, and pays them rather than us. Nothing passes through
   * this wallet at all — of the exit paths, this is the one with no window.
   */
  async actFor(asset: Hex, user: Hex, amount: bigint, borrowing: boolean): Promise<Hex> {
    return this.write("actFor", [asset, user, amount, borrowing]);
  }

  /** Has this holder named us as an operator of their position? */
  positionOperator(holder: Hex): Promise<boolean> {
    return this.public.readContract({
      address: this.pool, abi: tesseraPoolAbi, functionName: "positionOperator",
      args: [holder, this.account.address],
    }) as Promise<boolean>;
  }

  /**
   * Does the deployed pool understand acting for a holder at all?
   *
   * Asked rather than assumed: a pool deployed before this has no such
   * function, and offering a scheduled withdrawal it would revert on is worse
   * than not offering one. Cached — it is a property of the bytecode.
   */
  private _canAct: boolean | null = null;
  async canActForHolders(): Promise<boolean> {
    if (this._canAct !== null) return this._canAct;
    try {
      await this.public.readContract({
        address: this.pool, abi: tesseraPoolAbi, functionName: "positionOperator",
        args: [this.account.address, this.account.address],
      });
      this._canAct = true;
    } catch {
      this._canAct = false;
    }
    return this._canAct;
  }

  /** Repay **`user`'s** debt out of this wallet. See `supplyFor`. */
  async repayFor(asset: Hex, user: Hex, amount: bigint): Promise<Hex> {
    await this.ensureApproval(asset, amount);
    return this.write("repayFor", [asset, user, amount]);
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
    })) as ReserveTuple;
    return { enabled: r[0], borrowable: r[1], decimals: Number(r[2]), priceE8: r[PRICE_IX], cFactorBps: Number(r[3]), lFactorBps: Number(r[5]) };
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
    /*
     * Why the summary failed, kept rather than dropped.
     *
     * `accountData` walks every listed reserve, so one asset the *risk oracle*
     * cannot price takes the whole call down — and the revert names that asset:
     * `NoUsablePrice(address)`. Without this the dashboard could only say a
     * listed asset was probably unpriced and leave the reader to guess which.
     *
     * `priceOk` beside it is not the same question and cannot answer this one:
     * it reports the *pool's* own mark, which on this deployment is present and
     * fine for the very asset the risk oracle refuses to price.
     */
    const accountError = account === null ? ((acctRow as unknown as { error?: unknown }).error ?? null) : null;
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
      const c = cfgR.result as ReserveTuple;
      // Index 3 is cFactor — see the ReserveTuple comment above; the struct
      // carries four uint16 risk parameters before the price.
      const cfg = { enabled: c[0], borrowable: c[1], decimals: Number(c[2]), priceE8: c[PRICE_IX], cFactorBps: Number(c[3]), lFactorBps: Number(c[5]) };
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
    return { account, accountError, perAsset };
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
