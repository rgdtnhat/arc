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
  tesseraSwapAbi,
  tesseraAmmAbi,
  tesseraFeeCollectorAbi,
  erc20Abi,
  pacedHttp,
} from "@tessera/shared";

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

/** `fund(address,uint256)` and `seed(address,uint256)` — see `fundInventory`. */
const FUND_SELECTOR = "7b1837de";
const SEED_SELECTOR = "5684d86a";
/** `amm()` — present only on desks built with the AMM fallback. */
const AMM_GETTER_SELECTOR = "2a943945";

/** Client for the TesseraSwap (oracle-priced swap desk). */
export class SwapClient {
  readonly public: PublicClient;
  readonly wallet: WalletClient;
  /** Probed once from the deployed bytecode; a contract's code never changes. */
  private ammFallback: boolean | null = null;

  /**
   * Does the *deployed* desk have the AMM fallback, and is it wired to one?
   *
   * The ABI in this build has it; a desk deployed earlier does not, and on that
   * desk a trade the inventory can't cover reverts with "insufficient
   * inventory" no matter how much liquidity the AMM holds. Reading the selector
   * out of the code is the only way to tell — an `amm()` call on a contract
   * without the getter and one that returns the zero address are equally empty.
   */
  async hasAmmFallback(): Promise<boolean> {
    if (this.ammFallback !== null) return this.ammFallback;
    const code = String((await this.public.getCode({ address: this.swap })) ?? "").toLowerCase();
    if (!code.includes(AMM_GETTER_SELECTOR)) {
      this.ammFallback = false;
      return false;
    }
    const amm = await this.public
      .readContract({ address: this.swap, abi: tesseraSwapAbi, functionName: "amm" })
      .catch(() => null);
    this.ammFallback = typeof amm === "string" && /^0x[0-9a-f]{40}$/i.test(amm) && BigInt(amm) !== 0n;
    return this.ammFallback;
  }

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

  /**
   * Add inventory so the desk can fill swaps.
   *
   * Three routes, because a desk deployed before `fund()` existed is still live
   * and still needs topping up. `swap` measures inventory as the desk's own
   * balance, so all three end in the same place:
   *
   *   1. `fund()`  — permissionless, emits InventoryChanged. Preferred.
   *   2. `seed()`  — owner-only; used when we still own the desk and (1) is absent.
   *   3. `transfer` — a plain ERC-20 send. Works on any desk, always has.
   *
   * The route is *probed*, not assumed: the ABI compiled into this build is
   * newer than the bytecode that may already be deployed, so only the contract
   * can say which functions it has.
   */
  async fundInventory(token: Hex, amount: bigint): Promise<{ txHash: Hex; route: "fund" | "seed" | "transfer" }> {
    if (amount <= 0n) throw new Error("amount must be positive");

    // Which entry points does the *deployed* code have? Read the selectors out
    // of the bytecode rather than simulating a call: `fund` and `seed` return
    // nothing, so an `eth_call` returning empty data is a valid success and is
    // indistinguishable from the empty data a node gives for a selector that
    // isn't there. Solidity embeds each selector as a PUSH4 constant.
    const code = String((await this.public.getCode({ address: this.swap })) ?? "").toLowerCase();
    const has = (selector: string) => code.includes(selector);
    const owner = await this.public
      .readContract({ address: this.swap, abi: tesseraSwapAbi, functionName: "owner" })
      .catch(() => null);
    const weOwnIt =
      typeof owner === "string" && owner.toLowerCase() === this.cfg.account.address.toLowerCase();

    const route: "fund" | "seed" | "transfer" = has(FUND_SELECTOR)
      ? "fund"
      : has(SEED_SELECTOR) && weOwnIt
        ? "seed"
        : "transfer";

    if (route !== "transfer") {
      await this.ensureApproval(token, amount);
      const { request } = await this.public.simulateContract({
        address: this.swap,
        abi: tesseraSwapAbi,
        functionName: route,
        args: [token, amount],
        account: this.cfg.account,
      });
      const hash = await this.wallet.writeContract(request);
      await this.public.waitForTransactionReceipt({ hash });
      return { txHash: hash, route };
    }

    // No callable entry point: send the tokens directly. The desk's balance *is*
    // its inventory, so this lands in the same place — it just emits no
    // InventoryChanged event.
    const hash = await this.wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [this.swap, amount],
      chain: this.cfg.chain,
      account: this.cfg.account,
    });
    await this.public.waitForTransactionReceipt({ hash });
    return { txHash: hash, route: "transfer" };
  }

  /**
   * Take inventory back out of the desk.
   *
   * Two routes, because withdrawal is gated and which gate the caller can pass
   * depends on how the desk was deployed:
   *
   *   1. **Direct** — the desk's `withdrawInventory`, if this wallet is its
   *      `owner` or its `admin`.
   *   2. **Via the fee collector** — deployment hands the desk's ownership to
   *      `TesseraFeeCollector` so its `seed` leg works, which on a desk with no
   *      `admin` key leaves the collector as the only account that can withdraw.
   *      The collector's `withdrawSwapInventory` forwards the call for its own
   *      owner.
   *
   * A desk predating both (`withdrawInventory` owner-only, collector with no
   * forwarder) genuinely cannot be drained — reported as such rather than
   * failing obscurely.
   */
  async withdrawInventory(
    token: Hex,
    amount: bigint,
    to: Hex,
    feeCollector?: Hex,
  ): Promise<{ txHash: Hex; route: "direct" | "collector" }> {
    if (amount <= 0n) throw new Error("amount must be positive");

    const attempt = async (address: Hex, abi: typeof tesseraSwapAbi | typeof tesseraFeeCollectorAbi,
                           functionName: string, args: unknown[]) => {
      const { request } = await this.public.simulateContract({
        address, abi: abi as never, functionName: functionName as never,
        args: args as never, account: this.cfg.account,
      });
      const hash = await this.wallet.writeContract(request);
      await this.public.waitForTransactionReceipt({ hash });
      return hash;
    };

    let directError = "";
    try {
      return { txHash: await attempt(this.swap, tesseraSwapAbi, "withdrawInventory", [token, amount, to]), route: "direct" };
    } catch (e) {
      directError = String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e)
        .split("\n")[0]
        .slice(0, 120);
    }

    if (feeCollector) {
      try {
        return {
          txHash: await attempt(feeCollector, tesseraFeeCollectorAbi, "withdrawSwapInventory", [token, amount, to]),
          route: "collector",
        };
      } catch (e) {
        const via = String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e)
          .split("\n")[0]
          .slice(0, 120);
        throw new Error(
          `Neither route could withdraw. Directly: ${directError}. Via the fee collector: ${via}. ` +
            `A swap desk deployed before the admin key and the collector's forwarder existed cannot be ` +
            `drained — redeploy with \`npm run pool:arc -- --fresh\` to move to one that can.`,
        );
      }
    }
    throw new Error(directError || "withdrawInventory failed");
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
