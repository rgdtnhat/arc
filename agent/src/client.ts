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
import {
  tesseraEscrowAbi,
  erc20Abi,
  PaymentStatus,
} from "@tessera/shared";

export interface TesseraClientConfig {
  chain: Chain;
  rpcUrl: string;
  account: Account;
  escrowAddress: Hex;
  usdcAddress: Hex;
}

export interface PaymentRecord {
  agent: Hex;
  provider: Hex;
  amount: bigint;
  deadline: bigint;
  quoteHash: Hex;
  responseHash: Hex;
  status: PaymentStatus;
}

/** Thin, typed wrapper over TesseraEscrow + USDC for the agent. */
export class TesseraClient {
  readonly public: PublicClient;
  readonly wallet: WalletClient;
  readonly account: Account;
  readonly escrow: Hex;
  readonly usdc: Hex;
  private readonly chain: Chain;

  constructor(cfg: TesseraClientConfig) {
    this.chain = cfg.chain;
    this.account = cfg.account;
    this.escrow = cfg.escrowAddress;
    this.usdc = cfg.usdcAddress;
    this.public = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
    this.wallet = createWalletClient({
      account: cfg.account,
      chain: cfg.chain,
      transport: http(cfg.rpcUrl),
    });
  }

  /** Current chain time (seconds). Deadlines must be relative to this, not to
   *  the agent's wall clock, which can lag the chain when blocks mine quickly. */
  async chainTime(): Promise<bigint> {
    const block = await this.public.getBlock({ blockTag: "latest" });
    return block.timestamp;
  }

  usdcBalance(who?: Hex): Promise<bigint> {
    return this.public.readContract({
      address: this.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [who ?? this.account.address],
    }) as Promise<bigint>;
  }

  async ensureApproval(min: bigint): Promise<void> {
    const allowance = (await this.public.readContract({
      address: this.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, this.escrow],
    })) as bigint;
    if (allowance >= min) return;
    const hash = await this.wallet.writeContract({
      address: this.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.escrow, maxUint256],
      chain: this.chain,
      account: this.account,
    });
    await this.public.waitForTransactionReceipt({ hash });
  }

  /** Escrow `amount` for `provider`; returns the on-chain paymentId + tx hash. */
  async open(
    provider: Hex,
    amount: bigint,
    deadline: bigint,
    quoteHash: Hex
  ): Promise<{ paymentId: bigint; txHash: Hex }> {
    const { result, request } = await this.public.simulateContract({
      address: this.escrow,
      abi: tesseraEscrowAbi,
      functionName: "open",
      args: [provider, amount, deadline, quoteHash],
      account: this.account,
    });
    const txHash = await this.wallet.writeContract(request);
    await this.public.waitForTransactionReceipt({ hash: txHash });
    return { paymentId: result as bigint, txHash };
  }

  async settle(paymentId: bigint): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.escrow,
      abi: tesseraEscrowAbi,
      functionName: "settle",
      args: [paymentId],
      chain: this.chain,
      account: this.account,
    });
    await this.public.waitForTransactionReceipt({ hash });
    return hash;
  }

  async refund(paymentId: bigint): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.escrow,
      abi: tesseraEscrowAbi,
      functionName: "refund",
      args: [paymentId],
      chain: this.chain,
      account: this.account,
    });
    await this.public.waitForTransactionReceipt({ hash });
    return hash;
  }

  async getPayment(paymentId: bigint): Promise<PaymentRecord> {
    const p = (await this.public.readContract({
      address: this.escrow,
      abi: tesseraEscrowAbi,
      functionName: "getPayment",
      args: [paymentId],
    })) as [Hex, Hex, bigint, bigint, Hex, Hex, number];
    return {
      agent: p[0],
      provider: p[1],
      amount: p[2],
      deadline: p[3],
      quoteHash: p[4],
      responseHash: p[5],
      status: p[6] as PaymentStatus,
    };
  }

  async reputation(provider: Hex): Promise<{ fulfilled: bigint; failed: bigint; earned: bigint }> {
    const r = (await this.public.readContract({
      address: this.escrow,
      abi: tesseraEscrowAbi,
      functionName: "reputation",
      args: [provider],
    })) as [bigint, bigint, bigint];
    return { fulfilled: r[0], failed: r[1], earned: r[2] };
  }
}
