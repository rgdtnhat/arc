import {
  createPublicClient,
  createWalletClient,
  maxUint256,
  parseEventLogs,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import {
  tesseraEscrowAbi,
  tesseraTabAbi,
  erc20Abi,
  PaymentStatus,
  pacedHttp,
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
    this.public = createPublicClient({
      chain: cfg.chain,
      transport: pacedHttp(cfg.rpcUrl),
      pollingInterval: 8000,
      // Collapse concurrent contract reads into one multicall3 eth_call (Arc has
      // it at the canonical address) — far fewer round-trips, much faster loads.
      batch: { multicall: true },
    });
    this.wallet = createWalletClient({
      account: cfg.account,
      chain: cfg.chain,
      transport: pacedHttp(cfg.rpcUrl),
    });
  }

  /** Time the NEXT block will see (seconds). Prefer the pending block: on dev
   *  chains the node's clock keeps ticking while no blocks mine, so `latest`
   *  can be far behind (or ahead of) both the last block and the wall clock. */
  async chainTime(): Promise<bigint> {
    try {
      const pending = await this.public.getBlock({ blockTag: "pending" });
      if (pending?.timestamp) return pending.timestamp;
    } catch {
      // node may not expose a pending block — fall through
    }
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
    const { request } = await this.public.simulateContract({
      address: this.tab,
      abi: tesseraTabAbi,
      functionName: "openTab",
      args: [provider, deposit, BigInt(durationSeconds)],
      account: this.account,
    });
    const txHash = await this.wallet.writeContract(request);
    const receipt = await this.public.waitForTransactionReceipt({ hash: txHash });
    // Read the real tabId from the emitted TabOpened event — the simulated
    // return value is speculative and collides under concurrent opens.
    const logs = parseEventLogs({ abi: tesseraTabAbi, eventName: "TabOpened", logs: receipt.logs });
    const tabId = (logs[0]?.args as { tabId?: bigint })?.tabId;
    if (tabId === undefined) throw new Error("openTab: TabOpened event not found in receipt");
    return { tabId, txHash };
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

  /**
   * The dispute bond the escrow will pull alongside a payment of `amount`.
   *
   * Read from the contract rather than recomputed here. An escrow deployed
   * before bonds existed has no `bondFor`, and answering 0 for it is correct —
   * it will not pull one.
   */
  async bondFor(amount: bigint): Promise<bigint> {
    try {
      return (await this.public.readContract({
        address: this.escrow,
        abi: tesseraEscrowAbi,
        functionName: "bondFor",
        args: [amount],
      })) as bigint;
    } catch {
      return 0n;
    }
  }

  /**
   * Escrow `amount` for `provider`; returns the on-chain paymentId + tx hash.
   *
   * @dev Approval is ensured here, for the payment *and* its bond. Leaving that
   *      to callers meant three places each had to remember that `open` pulls
   *      more than the price, and a caller that approved exactly the price would
   *      revert at the door.
   */
  async open(
    provider: Hex,
    amount: bigint,
    deadline: bigint,
    quoteHash: Hex
  ): Promise<{ paymentId: bigint; txHash: Hex }> {
    await this.ensureApproval(amount + (await this.bondFor(amount)));
    const { request } = await this.public.simulateContract({
      address: this.escrow,
      abi: tesseraEscrowAbi,
      functionName: "open",
      args: [provider, amount, deadline, quoteHash],
      account: this.account,
    });
    const txHash = await this.wallet.writeContract(request);
    const receipt = await this.public.waitForTransactionReceipt({ hash: txHash });
    // Read the REAL paymentId from the emitted PaymentOpened event. The simulated
    // return value is speculative: under concurrent opens (e.g. a fleet), two
    // agents would both predict the same next id but get different ids on-chain.
    const paymentId = this.paymentIdFromReceipt(receipt);
    return { paymentId, txHash };
  }

  /** Extract this agent's paymentId from an open() receipt's PaymentOpened event. */
  private paymentIdFromReceipt(receipt: TransactionReceipt): bigint {
    const logs = parseEventLogs({ abi: tesseraEscrowAbi, eventName: "PaymentOpened", logs: receipt.logs });
    const mine = logs.find(
      (l) => (l.args as { agent?: Hex }).agent?.toLowerCase() === this.account.address.toLowerCase()
    ) ?? logs[0];
    const paymentId = (mine?.args as { paymentId?: bigint })?.paymentId;
    if (paymentId === undefined) throw new Error("open: PaymentOpened event not found in receipt");
    return paymentId;
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
