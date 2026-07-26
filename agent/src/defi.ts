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
import { tesseraVaultAbi, tesseraSwapAbi, tesseraAmmAbi, erc20Abi, pacedHttp } from "@tessera/shared";

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
    this.wallet = createWalletClient({ account: cfg.account, chain: cfg.chain, transport: pacedHttp(cfg.rpcUrl) });
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
    await this.public.waitForTransactionReceipt({ hash });
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
    await this.public.waitForTransactionReceipt({ hash });
    return hash;
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

/** Client for the TesseraSwap (oracle-priced swap desk). */
export class SwapClient {
  readonly public: PublicClient;
  readonly wallet: WalletClient;
  constructor(
    private readonly cfg: Cfg,
    readonly swap: Hex,
  ) {
    this.public = createPublicClient({ chain: cfg.chain, transport: pacedHttp(cfg.rpcUrl), batch: { multicall: true } });
    this.wallet = createWalletClient({ account: cfg.account, chain: cfg.chain, transport: pacedHttp(cfg.rpcUrl) });
  }

  quote(tokenIn: Hex, tokenOut: Hex, amountIn: bigint): Promise<readonly [bigint, bigint, bigint]> {
    return this.public.readContract({
      address: this.swap,
      abi: tesseraSwapAbi,
      functionName: "quote",
      args: [tokenIn, tokenOut, amountIn],
    }) as Promise<readonly [bigint, bigint, bigint]>;
  }

  inventory(token: Hex): Promise<bigint> {
    return this.public.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [this.swap] }) as Promise<bigint>;
  }

  private async ensureApproval(token: Hex, min: bigint) {
    const allowance = (await this.public.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.cfg.account.address, this.swap],
    })) as bigint;
    if (allowance >= min) return;
    const hash = await this.wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.swap, maxUint256],
      chain: this.cfg.chain,
      account: this.cfg.account,
    });
    await this.public.waitForTransactionReceipt({ hash });
  }

  async execute(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, minOut: bigint): Promise<Hex> {
    await this.ensureApproval(tokenIn, amountIn);
    const { request } = await this.public.simulateContract({
      address: this.swap,
      abi: tesseraSwapAbi,
      functionName: "swap",
      args: [tokenIn, tokenOut, amountIn, minOut],
      account: this.cfg.account,
    });
    const hash = await this.wallet.writeContract(request);
    await this.public.waitForTransactionReceipt({ hash });
    return hash;
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
    this.wallet = createWalletClient({ account: cfg.account, chain: cfg.chain, transport: pacedHttp(cfg.rpcUrl) });
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
    await this.public.waitForTransactionReceipt({ hash });
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
    await this.public.waitForTransactionReceipt({ hash });
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

  async removeLiquidity(poolId: number, shares: bigint, minAmounts: bigint[]): Promise<Hex> {
    return this.write("removeLiquidity", [BigInt(poolId), shares, minAmounts]);
  }
}
