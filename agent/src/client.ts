import {
  toFunctionSelector,
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
import { confirm } from "./confirm.js";
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

  /** Balance of any ERC-20 the agent holds, not just the escrow asset. */
  tokenBalance(token: Hex, who?: Hex): Promise<bigint> {
    return this.public.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [who ?? this.account.address],
    }) as Promise<bigint>;
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
    await confirm(this.public, hash);
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
    const receipt = await confirm(this.public, txHash);
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
    await confirm(this.public, hash);
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
   * What `maxIn` of `tokenIn` would buy in the escrow asset, and in how many
   * hops. Zero means there is no route — asked, not assumed, so the agent can
   * decide whether paying in this asset is even possible before it commits.
   */
  async quoteOpenWith(tokenIn: Hex, amountIn: bigint): Promise<{ out: bigint; hops: number }> {
    try {
      const r = (await this.public.readContract({
        address: this.escrow,
        abi: tesseraEscrowAbi,
        functionName: "quoteOpenWith",
        args: [tokenIn, amountIn],
      })) as readonly [bigint, bigint];
      return { out: r[0], hops: Number(r[1]) };
    } catch {
      return { out: 0n, hops: 0 };
    }
  }

  /**
   * Open a payment funded with an asset the agent actually holds.
   *
   * The provider is paid in the asset it quoted; the route happens inside the
   * escrow, in the same transaction. `maxIn` is the agent's slippage bound and
   * has to cover the bond as well as the price — `openWith` reverts rather than
   * opening a payment for less than was agreed, so a bound set against the price
   * alone simply fails instead of silently underfunding.
   */
  async openWith(
    tokenIn: Hex,
    maxIn: bigint,
    provider: Hex,
    amount: bigint,
    deadline: bigint,
    quoteHash: Hex
  ): Promise<{ paymentId: bigint; txHash: Hex }> {
    await this.ensureApprovalFor(tokenIn, maxIn);
    const { request } = await this.public.simulateContract({
      address: this.escrow,
      abi: tesseraEscrowAbi,
      functionName: "openWith",
      args: [tokenIn, maxIn, provider, amount, deadline, quoteHash],
      account: this.account,
    });
    const txHash = await this.wallet.writeContract(request);
    const receipt = await confirm(this.public, txHash);
    return { paymentId: this.paymentIdFromReceipt(receipt), txHash };
  }

  /** Approve an arbitrary token for the escrow, not just USDC. */
  async ensureApprovalFor(token: Hex, min: bigint): Promise<void> {
    const allowance = (await this.public.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, this.escrow],
    })) as bigint;
    if (allowance >= min) return;
    const hash = await this.wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.escrow, maxUint256],
      chain: this.chain,
      account: this.account,
    });
    await confirm(this.public, hash);
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
    const receipt = await confirm(this.public, txHash);
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
    await confirm(this.public, hash);
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
    await confirm(this.public, hash);
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

  /**
   * A provider's record, read so that an older escrow still answers.
   *
   * `reputation` grew from three words to five when distinct-buyer counting
   * and a last-settled timestamp were added. A deployment made before that
   * returns 96 bytes where the committed ABI expects 160, and viem's decoder
   * throws `Position 127 is out of bounds` — so on the live escrow this read
   * failed on every single refresh cycle, logging a stack trace and leaving
   * provider reputation blank.
   *
   * Decoding by hand costs nothing here: the return is a flat run of static
   * words, so taking the first three and treating the rest as optional works
   * against both shapes. The alternative — pinning the ABI to whatever is
   * deployed — breaks the next deployment instead of this one.
   */
  async reputation(provider: Hex): Promise<{ fulfilled: bigint; failed: bigint; earned: bigint }> {
    const data = await this.public.call({
      to: this.escrow,
      data: (toFunctionSelector("function reputation(address)") +
        provider.replace(/^0x/, "").toLowerCase().padStart(64, "0")) as Hex,
    });
    const body = String(data.data ?? "").replace(/^0x/, "");
    if (body.length < 192) throw new Error("reputation: escrow returned fewer than three words");
    const word = (i: number) => BigInt("0x" + body.slice(i * 64, i * 64 + 64));
    return { fulfilled: word(0), failed: word(1), earned: word(2) };
  }
}
