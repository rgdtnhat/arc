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
import {
  tesseraVaultAbi,
  tesseraRouterAbi,
  tesseraAmmAbi,
  tesseraFeeCollectorAbi,
  erc20Abi,
  pacedHttp,
  withGasMargin,
} from "@tessera/shared";
import { confirm } from "./confirm.js";

interface Cfg {
  chain: Chain;
  rpcUrl: string;
  account: Account;
}

/** Client for the TesseraVault (single-asset yield vault over the pool). */
export class VaultClient {
  readonly public: PublicClient;
  readonly wallet: WalletClient;
  constructor(
    private readonly cfg: Cfg,
    readonly vault: Hex,
    readonly asset: Hex,
  ) {
    this.public = createPublicClient({ chain: cfg.chain, transport: pacedHttp(cfg.rpcUrl), batch: { multicall: true } });
    this.wallet = withGasMargin(
      createWalletClient({ account: cfg.account, chain: cfg.chain, transport: pacedHttp(cfg.rpcUrl) }),
      this.public as never,
    );
  }

  private async ensureApproval(min: bigint) {
    const allowance = (await this.public.readContract({
      address: this.asset,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.cfg.account.address, this.vault],
    })) as bigint;
    if (allowance >= min) return;
    const hash = await this.wallet.writeContract({
      address: this.asset,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.vault, maxUint256],
      chain: this.cfg.chain,
      account: this.cfg.account,
    });
    await confirm(this.public, hash);
  }

  private async write(functionName: string, args: unknown[]): Promise<Hex> {
    const { request } = await this.public.simulateContract({
      address: this.vault,
      abi: tesseraVaultAbi,
      functionName: functionName as never,
      args: args as never,
      account: this.cfg.account,
    });
    const hash = await this.wallet.writeContract(request);
    await confirm(this.public, hash);
    return hash;
  }

  /** Deposit so that **`user`** holds the shares, paid from this wallet. */
  async depositFor(user: Hex, assets: bigint): Promise<Hex> {
    await this.ensureApproval(assets);
    return this.write("depositFor", [user, assets]);
  }

  /**
   * Redeem `user`'s shares, paying **`user`**, on an authority they granted.
   *
   * Only on a vault deployed with `positionOperator`; `canActForHolders` says
   * whether this one is. The assets go to the holder — this wallet triggers the
   * exit and can never receive it.
   */
  async withdrawFor(user: Hex, shares: bigint): Promise<Hex> {
    return this.write("withdrawFor", [user, shares]);
  }

  /** Has this holder named us as an operator of their position? */
  positionOperator(holder: Hex): Promise<boolean> {
    return this.public.readContract({
      address: this.vault, abi: tesseraVaultAbi, functionName: "positionOperator",
      args: [holder, this.cfg.account.address],
    }) as Promise<boolean>;
  }

  /**
   * Does the deployed vault understand acting for a holder at all?
   *
   * Asked rather than assumed: the live vault predates this, and offering a
   * scheduled withdrawal it would revert on is worse than not offering one.
   * Cached, because the answer is a property of the bytecode.
   */
  private _canAct: boolean | null = null;
  async canActForHolders(): Promise<boolean> {
    if (this._canAct !== null) return this._canAct;
    try {
      await this.public.readContract({
        address: this.vault, abi: tesseraVaultAbi, functionName: "positionOperator",
        args: [this.cfg.account.address, this.cfg.account.address],
      });
      this._canAct = true;
    } catch {
      this._canAct = false;
    }
    return this._canAct;
  }

  sharesOf(who: Hex): Promise<bigint> {
    return this.public.readContract({
      address: this.vault, abi: tesseraVaultAbi, functionName: "sharesOf", args: [who],
    }) as Promise<bigint>;
  }

  /**
   * What a given amount of the underlying is worth in shares, right now.
   *
   * A scheduled withdrawal is written in USDC because that is the only unit
   * anybody thinks in — "take out 5 USDC a week", never "burn 4,983,112
   * shares". The rate moves as the vault earns, so the conversion belongs at
   * the moment it runs, not at the moment it was written.
   */
  convertToShares(assets: bigint): Promise<bigint> {
    return this.public.readContract({
      address: this.vault, abi: tesseraVaultAbi, functionName: "convertToShares", args: [assets],
    }) as Promise<bigint>;
  }

  convertToAssets(shares: bigint): Promise<bigint> {
    return this.public.readContract({
      address: this.vault, abi: tesseraVaultAbi, functionName: "convertToAssets", args: [shares],
    }) as Promise<bigint>;
  }

  /** See `TesseraPoolClient.wouldSucceed` — a dry run before money moves. */
  async wouldSucceed(functionName: string, args: unknown[]): Promise<true | string> {
    try {
      await this.public.simulateContract({
        address: this.vault,
        abi: tesseraVaultAbi,
        functionName: functionName as never,
        args: args as never,
        account: this.cfg.account,
      });
      return true;
    } catch (e) {
      const m = e as { shortMessage?: string; message?: string };
      return m.shortMessage ?? m.message ?? String(e);
    }
  }

  async deposit(assets: bigint): Promise<Hex> {
    await this.ensureApproval(assets);
    return this.write("deposit", [assets]);
  }
  /** Withdraw a number of shares (use `sharesOf` for a full exit). */
  async withdrawShares(shares: bigint): Promise<Hex> {
    return this.write("withdraw", [shares]);
  }

  private read<T>(fn: string, args: unknown[] = []): Promise<T> {
    return this.public.readContract({ address: this.vault, abi: tesseraVaultAbi, functionName: fn as never, args: args as never }) as Promise<T>;
  }

  /**
   * Every vault field plus the caller's asset balance in **one** multicall.
   * Seven separate reads were being throttled by the public RPC, which left the
   * vault panel blank; a single round-trip fixes that.
   */
  async snapshot(user?: Hex) {
    const who = user ?? (this.cfg.account.address as Hex);
    const v = (functionName: string, args: unknown[] = []) =>
      ({ address: this.vault, abi: tesseraVaultAbi, functionName, args }) as const;
    const res = await this.public.multicall({
      allowFailure: true,
      contracts: [
        v("totalAssets"),
        v("sharesOf", [who]),
        v("balanceOfAssets", [who]),
        v("currentBufferBps"),
        v("maxWithdraw", [who]),
        v("reserveRatioBps"),
        v("performanceFeeBps"),
        { address: this.asset, abi: erc20Abi, functionName: "balanceOf", args: [who] } as const,
      ] as never,
    });
    const big = (i: number) => (res[i].status === "success" ? (res[i].result as bigint) : 0n);
    const num = (i: number) => (res[i].status === "success" ? Number(res[i].result) : 0);
    // The two config reads are the tell for "did the vault answer at all".
    const ok = res[5].status === "success" && res[0].status === "success";
    return {
      ok,
      totalAssets: big(0),
      shares: big(1),
      userAssets: big(2),
      bufferBps: big(3),
      maxWithdraw: big(4),
      reserveRatioBps: num(5),
      perfFeeBps: num(6),
      walletAsset: big(7),
    };
  }
}

/**
 * Client for TesseraRouter — swaps backed by AMM pool liquidity.
 *
 * Replaces the old `SwapClient`, which drove an inventory desk. The desk had a
 * balance to fund, a balance to withdraw, and an owner/admin question about who
 * was allowed to do either; a router has none of those, because it holds nothing
 * between calls. What is left is quoting and swapping.
 */
export class RouterClient {
  readonly public: PublicClient;
  readonly wallet: WalletClient;

  constructor(
    private readonly cfg: Cfg,
    readonly router: Hex,
  ) {
    this.public = createPublicClient({ chain: cfg.chain, transport: pacedHttp(cfg.rpcUrl), batch: { multicall: true } });
    this.wallet = withGasMargin(
      createWalletClient({ account: cfg.account, chain: cfg.chain, transport: pacedHttp(cfg.rpcUrl) }),
      this.public as never,
    );
  }

  /** The best route the router can find, and what it would pay out. */
  estimate(tokenIn: Hex, tokenOut: Hex, amountIn: bigint): Promise<readonly [bigint, readonly bigint[], readonly Hex[]]> {
    return this.public.readContract({
      address: this.router,
      abi: tesseraRouterAbi,
      functionName: "estimate",
      args: [tokenIn, tokenOut, amountIn],
    }) as Promise<readonly [bigint, readonly bigint[], readonly Hex[]]>;
  }

  /** Price a route the caller already chose. */
  estimateChained(poolIds: readonly bigint[], path: readonly Hex[], amountIn: bigint): Promise<bigint> {
    return this.public.readContract({
      address: this.router,
      abi: tesseraRouterAbi,
      functionName: "estimateChained",
      args: [poolIds, path, amountIn],
    }) as Promise<bigint>;
  }

  private async ensureApproval(token: Hex, min: bigint) {
    const allowance = (await this.public.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.cfg.account.address, this.router],
    })) as bigint;
    if (allowance >= min) return;
    const hash = await this.wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.router, maxUint256],
      chain: this.cfg.chain,
      account: this.cfg.account,
    });
    await confirm(this.public, hash);
  }

  /**
   * Swap, letting the router pick the route.
   *
   * @param deadlineSeconds How long the transaction stays valid. The default is
   *   short on purpose: a swap that sits in the mempool is a free option written
   *   against the sender, and the pool it prices against keeps moving.
   */
  async execute(
    tokenIn: Hex,
    tokenOut: Hex,
    amountIn: bigint,
    minOut: bigint,
    deadlineSeconds = 300,
  ): Promise<Hex> {
    await this.ensureApproval(tokenIn, amountIn);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
    const { request } = await this.public.simulateContract({
      address: this.router,
      abi: tesseraRouterAbi,
      functionName: "swap",
      args: [tokenIn, tokenOut, amountIn, minOut, deadline],
      account: this.cfg.account,
    });
    const hash = await this.wallet.writeContract(request);
    await confirm(this.public, hash);
    return hash;
  }

  /** Swap along an explicit route, with one guard on the final output. */
  async executeChained(
    poolIds: readonly bigint[],
    path: readonly Hex[],
    amountIn: bigint,
    minOut: bigint,
    deadlineSeconds = 300,
  ): Promise<Hex> {
    if (path.length < 2) throw new Error("a route needs at least two tokens");
    await this.ensureApproval(path[0]!, amountIn);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
    const { request } = await this.public.simulateContract({
      address: this.router,
      abi: tesseraRouterAbi,
      functionName: "swapChained",
      args: [poolIds, path, amountIn, minOut, deadline],
      account: this.cfg.account,
    });
    const hash = await this.wallet.writeContract(request);
    await confirm(this.public, hash);
    return hash;
  }

  /** The assets the router will try as a middle leg when no direct pool exists. */
  async hubTokens(): Promise<Hex[]> {
    const n = (await this.public.readContract({
      address: this.router, abi: tesseraRouterAbi, functionName: "hubTokenCount",
    })) as bigint;
    const out: Hex[] = [];
    for (let i = 0n; i < n; i++) {
      out.push((await this.public.readContract({
        address: this.router, abi: tesseraRouterAbi, functionName: "hubTokens", args: [i],
      })) as Hex);
    }
    return out;
  }
}

export interface AmmPoolView {
  id: number;
  name: string;
  assets: Hex[];
  balances: bigint[];
  swapFeeBps: number;
  lpShareBps: number;
  totalShares: bigint;
  frozen: boolean;
  /** Shares held by the account the snapshot was taken for. */
  myShares: bigint;
}

/** Client for the TesseraAMM (multi-asset liquidity pools). */
export class AmmClient {
  readonly public: PublicClient;
  readonly wallet: WalletClient;
  constructor(
    private readonly cfg: Cfg,
    readonly amm: Hex,
  ) {
    this.public = createPublicClient({ chain: cfg.chain, transport: pacedHttp(cfg.rpcUrl), batch: { multicall: true } });
    this.wallet = withGasMargin(
      createWalletClient({ account: cfg.account, chain: cfg.chain, transport: pacedHttp(cfg.rpcUrl) }),
      this.public as never,
    );
  }

  private a(functionName: string, args: unknown[] = []) {
    return { address: this.amm, abi: tesseraAmmAbi, functionName, args } as const;
  }

  /**
   * Every pool, its balances, and the user's share of each — in two multicalls
   * (one to learn the pool count, one for everything else). The public RPC
   * throttles hard, so per-pool round-trips are not an option.
   */
  async snapshot(user?: Hex): Promise<{ ok: boolean; pools: AmmPoolView[]; maxAssetsPerPool: number }> {
    const who = user ?? (this.cfg.account.address as Hex);
    let count = 0;
    let maxAssets = 0;
    try {
      const head = await this.public.multicall({
        allowFailure: true,
        contracts: [this.a("poolCount"), this.a("maxAssetsPerPool")] as never,
      });
      if (head[0].status !== "success") return { ok: false, pools: [], maxAssetsPerPool: 0 };
      count = Number(head[0].result as bigint);
      maxAssets = head[1].status === "success" ? Number(head[1].result) : 0;
    } catch {
      return { ok: false, pools: [], maxAssetsPerPool: 0 };
    }
    if (count === 0) return { ok: true, pools: [], maxAssetsPerPool: maxAssets };

    const ids = Array.from({ length: count }, (_, i) => i);
    const res = await this.public.multicall({
      allowFailure: true,
      contracts: ids.flatMap((i) => [
        this.a("poolInfo", [BigInt(i)]),
        this.a("sharesOf", [BigInt(i), who]),
      ]) as never,
    });

    const pools: AmmPoolView[] = [];
    for (const i of ids) {
      const info = res[i * 2];
      if (info.status !== "success") continue;
      const [assets, balances, swapFeeBps, lpShareBps, totalShares, frozen, name] = info.result as readonly [
        Hex[], bigint[], number, number, bigint, boolean, string,
      ];
      const sh = res[i * 2 + 1];
      pools.push({
        id: i,
        name,
        assets: [...assets],
        balances: [...balances],
        swapFeeBps: Number(swapFeeBps),
        lpShareBps: Number(lpShareBps),
        totalShares,
        frozen,
        myShares: sh.status === "success" ? (sh.result as bigint) : 0n,
      });
    }
    return { ok: true, pools, maxAssetsPerPool: maxAssets };
  }

  quote(poolId: number, tokenIn: Hex, tokenOut: Hex, amountIn: bigint): Promise<readonly [bigint, bigint, bigint]> {
    return this.public.readContract({
      address: this.amm,
      abi: tesseraAmmAbi,
      functionName: "quote",
      args: [BigInt(poolId), tokenIn, tokenOut, amountIn],
    }) as Promise<readonly [bigint, bigint, bigint]>;
  }

  private async ensureApproval(token: Hex, min: bigint) {
    const allowance = (await this.public.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.cfg.account.address, this.amm],
    })) as bigint;
    if (allowance >= min) return;
    const hash = await this.wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.amm, maxUint256],
      chain: this.cfg.chain,
      account: this.cfg.account,
    });
    await confirm(this.public, hash);
  }

  private async write(functionName: string, args: unknown[]): Promise<Hex> {
    const { request } = await this.public.simulateContract({
      address: this.amm,
      abi: tesseraAmmAbi,
      functionName: functionName as never,
      args: args as never,
      account: this.cfg.account,
    });
    const hash = await this.wallet.writeContract(request);
    await confirm(this.public, hash);
    return hash;
  }

  async swap(poolId: number, tokenIn: Hex, tokenOut: Hex, amountIn: bigint, minOut: bigint): Promise<Hex> {
    await this.ensureApproval(tokenIn, amountIn);
    return this.write("swap", [BigInt(poolId), tokenIn, tokenOut, amountIn, minOut]);
  }

  async addLiquidity(poolId: number, assets: Hex[], amounts: bigint[], minShares = 0n): Promise<Hex> {
    for (let i = 0; i < assets.length; i++) await this.ensureApproval(assets[i], amounts[i]);
    return this.write("addLiquidity", [BigInt(poolId), amounts, minShares]);
  }

  /**
   * Add liquidity so that **`to`** holds the shares, paid for from this wallet.
   *
   * The pool's own words again: you pay, they get the shares. What it allows
   * here is a scheduled deposit funded by a visitor's session keys — note the
   * plural, because `_addLiquidity` requires every asset's amount to be above
   * zero, so a pool of two assets needs a delegation for each.
   */
  async addLiquidityFor(
    poolId: number, to: Hex, assets: Hex[], amounts: bigint[], minShares = 0n,
  ): Promise<Hex> {
    for (let i = 0; i < assets.length; i++) await this.ensureApproval(assets[i], amounts[i]);
    return this.write("addLiquidityFor", [BigInt(poolId), to, amounts, minShares]);
  }

  /**
   * What a call would return, without sending it.
   *
   * `wouldSucceed` answers yes-or-no; this answers with the number, which is
   * what a slippage floor has to be built from. An unattended add or exit
   * cannot use a floor written when the task was — the pool's ratio moves —
   * so the expectation is taken at the moment it runs and the floor is a
   * bounded haircut off it.
   */
  async simulateResult<T>(functionName: string, args: unknown[]): Promise<T | null> {
    try {
      const { result } = await this.public.simulateContract({
        address: this.amm, abi: tesseraAmmAbi,
        functionName: functionName as never, args: args as never, account: this.cfg.account,
      });
      return result as T;
    } catch {
      return null;
    }
  }

  /** See `TesseraPoolClient.wouldSucceed` — a dry run before money moves. */
  async wouldSucceed(functionName: string, args: unknown[]): Promise<true | string> {
    try {
      await this.public.simulateContract({
        address: this.amm, abi: tesseraAmmAbi,
        functionName: functionName as never, args: args as never, account: this.cfg.account,
      });
      return true;
    } catch (e) {
      const m = e as { shortMessage?: string; message?: string };
      return m.shortMessage ?? m.message ?? String(e);
    }
  }

  async removeLiquidity(poolId: number, shares: bigint, minAmounts: bigint[]): Promise<Hex> {
    return this.write("removeLiquidity", [BigInt(poolId), shares, minAmounts]);
  }

  /** How many of `owner`'s shares in `poolId` this wallet may move. */
  shareAllowance(poolId: number, owner: Hex): Promise<bigint> {
    return this.public.readContract({
      address: this.amm, abi: tesseraAmmAbi, functionName: "shareAllowance",
      args: [BigInt(poolId), owner, this.cfg.account.address],
    }) as Promise<bigint>;
  }

  /** This wallet's own shares in a pool. */
  sharesOf(poolId: number, who: Hex): Promise<bigint> {
    return this.public.readContract({
      address: this.amm, abi: tesseraAmmAbi, functionName: "sharesOf", args: [BigInt(poolId), who],
    }) as Promise<bigint>;
  }

  /**
   * Take shares a holder has approved this wallet to move.
   *
   * The AMM gives LP positions an ERC-20-style allowance of their own, which is
   * what makes a scheduled withdrawal possible at all: a session key moves
   * tokens, and a pool exit starts from shares. The holder approves once, and
   * can set it back to zero from their own wallet at any time.
   */
  async takeShares(poolId: number, from: Hex, shares: bigint): Promise<Hex> {
    return this.write("transferSharesFrom", [BigInt(poolId), from, this.cfg.account.address, shares]);
  }

  /** Hand shares back, for when an exit could not be completed. */
  async giveShares(poolId: number, to: Hex, shares: bigint): Promise<Hex> {
    return this.write("transferShares", [BigInt(poolId), to, shares]);
  }
}
