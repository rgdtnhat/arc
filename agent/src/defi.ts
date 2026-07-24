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
import { tesseraVaultAbi, tesseraSwapAbi, erc20Abi, pacedHttp } from "@tessera/shared";

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

  async snapshot(user?: Hex) {
    const who = user ?? (this.cfg.account.address as Hex);
    const [totalAssets, shares, userAssets, bufferBps, maxWithdraw, reserveRatioBps, perfFeeBps] = await Promise.all([
      this.read<bigint>("totalAssets"),
      this.read<bigint>("sharesOf", [who]),
      this.read<bigint>("balanceOfAssets", [who]),
      this.read<bigint>("currentBufferBps"),
      this.read<bigint>("maxWithdraw", [who]),
      this.read<number>("reserveRatioBps"),
      this.read<number>("performanceFeeBps"),
    ]);
    return { totalAssets, shares, userAssets, bufferBps, maxWithdraw, reserveRatioBps, perfFeeBps };
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
