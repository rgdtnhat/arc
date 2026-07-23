import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { tesseraPoolAbi, erc20Abi } from "@tessera/shared";

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
      transport: http(cfg.rpcUrl, { retryCount: 8, retryDelay: 4000 }),
      pollingInterval: 8000,
    });
    this.wallet = createWalletClient({
      account: cfg.account,
      chain: cfg.chain,
      transport: http(cfg.rpcUrl, { retryCount: 8, retryDelay: 4000 }),
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
}
