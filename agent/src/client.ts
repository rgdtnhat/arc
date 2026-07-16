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
  tesseraTabAbi,
  erc20Abi,
  PaymentStatus,
} from "@tessera/shared";
import { encodePacked, keccak256 } from "viem";

export interface TesseraClientConfig {
  chain: Chain;
  rpcUrl: string;
  account: Account;
  escrowAddress: Hex;
  usdcAddress: Hex;
  /** TesseraTab contract for nanopayment sessions. Optional. */
  tabAddress?: Hex;
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
  readonly tab?: Hex;
  private readonly chain: Chain;

  constructor(cfg: TesseraClientConfig) {
    this.chain = cfg.chain;
    this.account = cfg.account;
    this.escrow = cfg.escrowAddress;
    this.usdc = cfg.usdcAddress;
    this.tab = cfg.tabAddress;
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

  async ensureApproval(min: bigint, spender: Hex = this.escrow): Promise<void> {
    const allowance = (await this.public.readContract({
      address: this.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, spender],
    })) as bigint;
    if (allowance >= min) return;
    const hash = await this.wallet.writeContract({
      address: this.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, maxUint256],
      chain: this.chain,
      account: this.account,
    });
    await this.public.waitForTransactionReceipt({ hash });
  }

  // --- Nanopayments (TesseraTab) ---------------------------------------------

  /** Open a tab with a provider: escrow `deposit` once, stream calls off-chain. */
  async openTab(
    provider: Hex,
    deposit: bigint,
    durationSeconds: number
  ): Promise<{ tabId: bigint; txHash: Hex }> {
    if (!this.tab) throw new Error("tabAddress not configured");
    await this.ensureApproval(deposit, this.tab);
    const { result, request } = await this.public.simulateContract({
      address: this.tab,
      abi: tesseraTabAbi,
      functionName: "openTab",
      args: [provider, deposit, BigInt(durationSeconds)],
      account: this.account,
    });
    const txHash = await this.wallet.writeContract(request);
    await this.public.waitForTransactionReceipt({ hash: txHash });
    return { tabId: result as bigint, txHash };
  }

  /** Sign a voucher for `cumulative` USDC on a tab — off-chain, free, instant. */
  async signVoucher(tabId: bigint, cumulative: bigint): Promise<Hex> {
    if (!this.tab) throw new Error("tabAddress not configured");
    const hash = keccak256(
      encodePacked(["address", "uint256", "uint256"], [this.tab, tabId, cumulative])
    );
    return this.wallet.signMessage({
      account: this.account,
      message: { raw: hash },
    });
  }

  /** Reclaim an expired tab's unclaimed funds. */
  async reclaimTab(tabId: bigint): Promise<Hex> {
    if (!this.tab) throw new Error("tabAddress not configured");
    const hash = await this.wallet.writeContract({
      address: this.tab,
      abi: tesseraTabAbi,
      functionName: "reclaim",
      args: [tabId],
      chain: this.chain,
      account: this.account,
    });
    await this.public.waitForTransactionReceipt({ hash });
    return hash;
  }

  async stakeOf(provider: Hex): Promise<bigint> {
    return this.public.readContract({
      address: this.escrow,
      abi: tesseraEscrowAbi,
      functionName: "stakeOf",
      args: [provider],
    }) as Promise<bigint>;
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
