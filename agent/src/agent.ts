import { keccak256, toHex, verifyTypedData, type Hex } from "viem";
import {
  HEADERS,
  formatUsdc,
  PaymentStatus,
  arcscanTx,
  quoteTypedData,
  receiptFromPayment,
  type Quote,
} from "@tessera/shared";
import { TesseraClient } from "./client.js";
import {
  decideByLlm,
  decideByRules,
  passesQuality,
  quoteMatchesOffer,
  trustScore,
  type AgentTask,
  type Decision,
  type OfferedService,
} from "./decide.js";
import { ApprovalQueue, type SpendingPolicy } from "./policy.js";
import type { TrustMemory } from "./memory.js";
import { createTesseraActions, type TesseraActionKit } from "./agentkit.js";
import type { Faucet } from "./circle/faucet.js";
import type { TesseraTreasury } from "./treasury.js";
import type { TesseraPoolClient } from "./pool.js";
import { adviseFrom } from "./scenario.js";

export type Brain = "rules" | "llm";

export interface AgentConfig {
  client: TesseraClient;
  providersBaseUrl: string;
  brain?: Brain;
  anthropicApiKey?: string;
  explorer?: boolean; // link tx hashes to Arcscan in events
  /** Safety sandbox: spends above the cap escalate to a guardian. */
  policy?: SpendingPolicy;
  /** Personal cross-run memory of providers (address book + trust penalty). */
  memory?: TrustMemory;
  /** Testnet faucet, exposed as an Agent Stack `request_faucet` action. */
  faucet?: Faucet;
  /** Treasury workflow, exposed as `treasury_snapshot` / `treasury_topup`. */
  treasury?: TesseraTreasury;
  /** Lending pool client, exposed as pool_supply / pool_borrow / etc. */
  pool?: TesseraPoolClient;
  /**
   * Assets the agent may fund a payment with when it is short of the escrow
   * asset, in preference order. Empty means USDC or nothing.
   */
  fundingAssets?: { address: Hex; symbol: string }[];
  /**
   * Charge the buyer's service credit for a call that settled.
   *
   * Until this existed the fee credit contract had exactly one caller: an
   * operator endpoint somebody had to remember to POST to. A pay-per-use
   * protocol whose own fee is collected by hand is a pay-per-use protocol in
   * the demo sense only.
   *
   * It is a callback rather than a client the agent owns, because who gets
   * billed is a deployment question — the run should not have to know whether
   * there is a fee contract, whether an account has been nominated, or what
   * the rate is. Returning null means "not charged", which is the normal case
   * on a deployment with no fee account configured.
   *
   * Failures here must never unwind a settlement. The provider has been paid
   * and the buyer has their answer; a fee that could reverse that would make
   * the fee more important than the trade.
   */
  chargeCredit?: (settledUsdc: bigint, memo: string) => Promise<Hex | null>;
  onEvent?: (e: AgentEvent) => void;
}

export type LedgerStatus = "settled" | "refunded" | "skipped" | "error";

export interface LedgerEntry {
  resource: string;
  name: string;
  provider: Hex;
  price: bigint;
  status: LedgerStatus;
  reason: string;
  paymentId?: string;
  txs: { open?: string; settle?: string; refund?: string };
  data?: unknown;
  /**
   * The provider's signed statement of what it served. Kept alongside the
   * response because the response on its own proves nothing — this is the half
   * that a third party could check.
   */
  receipt?: {
    signature: Hex;
    issuedAt: string;
    responseHash: Hex;
    /**
     * The escrowed amount the provider actually signed over, which is not
     * necessarily the quoted price — the escrow only requires `amount >= price`.
     * Kept so the receipt can be rebuilt exactly; rebuilding it from the quote
     * would produce a payload that fails to verify whenever a buyer overpaid.
     */
    amount: bigint;
    /** Whether the signature recovered to the provider that was paid. */
    valid: boolean;
  };
}

export interface AgentEvent {
  ts: number;
  level: "info" | "decide" | "pay" | "settle" | "refund" | "skip" | "done" | "guardian";
  resource?: string;
  message: string;
  txHash?: string;
  txUrl?: string;
}

export class TesseraAgent {
  private readonly cfg: AgentConfig;
  readonly ledger: LedgerEntry[] = [];
  /** Guardian approval queue (populated when a policy escalates a spend). */
  readonly approvals = new ApprovalQueue();

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
  }

  /**
   * The agent's Agent Stack surface: its wallet, USDC-payment, and on-chain
   * actions exposed as typed tools bound to this agent's client. A model brain
   * can enumerate `.manifest()` and `.invoke()`; the deterministic flow uses the
   * same client underneath.
   */
  actionKit(): TesseraActionKit {
    return createTesseraActions(this.cfg.client, {
      providersBaseUrl: this.cfg.providersBaseUrl,
      faucet: this.cfg.faucet,
      treasury: this.cfg.treasury,
      pool: this.cfg.pool,
      /*
       * The same ceiling the deterministic loop escalates at.
       *
       * A model brain driving this surface is the caller least able to be
       * trusted with an unbounded `escrow_payment`, and there is no guardian on
       * the other end of a tool call to ask. So the kit stops at the cap rather
       * than escalating past it: over that, the buying loop is the way in,
       * because that is where a human can be asked.
       *
       * With no policy configured the kit gets no cap and refuses to move
       * anything, which is the right answer to "nobody has decided a limit".
       */
      spendCap: this.cfg.policy?.autoApproveMax,
    });
  }

  private emit(e: Omit<AgentEvent, "ts">) {
    const evt: AgentEvent = {
      ts: Date.now(),
      ...e,
      txUrl: e.txHash && this.cfg.explorer ? arcscanTx(e.txHash) : undefined,
    };
    this.cfg.onEvent?.(evt);
  }

  /**
   * Bill the protocol's own fee for a call that settled.
   *
   * Deliberately after the settle event rather than before it: the event is the
   * record that the trade happened, and it should not be gated on a fee. A
   * charge that reverts — no credit, no fee account, contract paused — is
   * reported and dropped. Nothing about it can undo the settlement, because
   * the money has already moved and the buyer already has what they bought.
   */
  private async chargeForSettlement(amount: bigint, name: string, resource: string): Promise<void> {
    if (!this.cfg.chargeCredit) return;
    try {
      const txHash = await this.cfg.chargeCredit(amount, `${name} · ${resource}`);
      if (!txHash) return;
      this.emit({
        level: "pay",
        resource,
        message: `Protocol fee charged to service credit`,
        txHash,
      });
    } catch (e) {
      this.emit({
        level: "skip",
        resource,
        message: `Service credit not charged (${String(e).slice(0, 80)}) — the call still settled`,
      });
    }
  }

  /** Discover what providers are selling, with live on-chain reputation. */
  async discover(): Promise<OfferedService[]> {
    const res = await fetch(`${this.cfg.providersBaseUrl}/catalog`);
    const json = (await res.json()) as { services: any[] };
    return json.services.map((s) => ({
      resource: s.resource,
      name: s.name,
      tags: s.tags,
      path: s.path,
      price: BigInt(s.price),
      slaSeconds: s.slaSeconds,
      billing: s.billing ?? "escrow",
      provider: s.provider,
      stakeUsdc: s.stakeUsdc ?? "0",
      reputation: s.reputation,
    }));
  }

  /** Run a task end to end, autonomously buying only what's worth it. */
  async run(task: AgentTask): Promise<LedgerEntry[]> {
    this.emit({ level: "info", message: `Task: ${task.goal}` });
    this.emit({
      level: "info",
      message: `Budget ${formatUsdc(task.budget)} USDC · brain: ${this.cfg.brain ?? "rules"}`,
    });

    const services = await this.discover();
    this.emit({ level: "info", message: `Discovered ${services.length} services on the marketplace` });

    let remaining = task.budget;

    // Satisfy each need with the best affordable, most-trusted matching service.
    // Tab-billed (streaming) services are bought via streamTicks(), not here.
    // On rate-limited public RPCs, pace on-chain actions (TESSERA_PACE_MS).
    const paceMs = Number(process.env.TESSERA_PACE_MS ?? 0);
    let needIndex = 0;
    for (const need of task.needs) {
      if (paceMs > 0 && needIndex++ > 0) await sleep(paceMs);
      const candidates = services
        .filter((s) => s.tags.includes(need.tag) && s.billing !== "tab")
        .sort((a, b) => (a.price === b.price ? 0 : a.price < b.price ? -1 : 1));

      if (candidates.length === 0) {
        this.emit({ level: "skip", resource: need.tag, message: `No provider offers "${need.tag}"` });
        continue;
      }

      let satisfied = false;
      for (const svc of candidates) {
        const decision = await this.decide(task, svc, remaining);
        this.emit({
          level: "decide",
          resource: svc.resource,
          message: `${decision.buy ? "BUY" : "SKIP"} ${svc.name} — ${decision.reason}`,
        });
        if (!decision.buy) {
          if (candidates.indexOf(svc) === candidates.length - 1 && !satisfied) {
            this.ledger.push({
              resource: svc.resource,
              name: svc.name,
              provider: svc.provider,
              price: svc.price,
              status: "skipped",
              reason: decision.reason,
              txs: {},
            });
          }
          continue;
        }

        // The guardian cap is enforced inside `purchase`, against the amount it
        // is about to escrow. A declined spend comes back as a skipped entry.
        let entry: LedgerEntry;
        try {
          entry = await this.purchase(svc, decision, this.resolveQuery(need.query));
        } catch (err) {
          const ve = err as { metaMessages?: string[]; shortMessage?: string; message?: string };
          const reason =
            ve.metaMessages?.find((m) => m.trim().startsWith("Error:"))?.trim() ??
            ve.shortMessage ??
            ve.message?.split("\n")[0] ??
            String(err);
          entry = {
            resource: svc.resource,
            name: svc.name,
            provider: svc.provider,
            price: svc.price,
            status: "error",
            reason,
            txs: {},
          };
          this.emit({ level: "skip", resource: svc.resource, message: `Purchase failed: ${entry.reason}` });
        }
        this.ledger.push(entry);
        if (entry.status === "settled" || entry.status === "refunded") {
          this.cfg.memory?.record(svc.provider, svc.name, entry.status);
        }
        if (entry.status === "settled") {
          remaining -= svc.price;
          satisfied = true;
          break; // need met, move on
        }
        // refunded/error: budget restored, try the next candidate for this need
      }
    }

    const spent = this.ledger
      .filter((e) => e.status === "settled")
      .reduce((a, e) => a + e.price, 0n);
    this.emit({
      level: "done",
      message: `Done. Spent ${formatUsdc(spent)} USDC across ${
        this.ledger.filter((e) => e.status === "settled").length
      } settled call(s); ${this.ledger.filter((e) => e.status === "refunded").length} refunded.`,
    });
    return this.ledger;
  }

  private async decide(
    task: AgentTask,
    svc: OfferedService,
    remaining: bigint
  ): Promise<Decision> {
    // Hard policy checks come before any reasoning.
    if (this.cfg.policy?.blockedProviders?.some((p) => p.toLowerCase() === svc.provider.toLowerCase())) {
      return { buy: false, reason: "provider is blocked by policy", trust: 0 };
    }
    const penalty = this.cfg.memory?.penalty(svc.provider) ?? 0;
    if (penalty > 0) {
      this.emit({
        level: "decide",
        resource: svc.resource,
        message: `Memory: ${svc.name} burned this agent before — personal trust penalty −${penalty.toFixed(2)}`,
      });
    }
    if (this.cfg.brain === "llm" && this.cfg.anthropicApiKey) {
      return decideByLlm(task, svc, remaining, this.cfg.anthropicApiKey, penalty);
    }
    return decideByRules(task, svc, remaining, penalty);
  }

  /** Ask the guardian to co-sign an over-cap spend. */
  private async escalate(svc: OfferedService, decision: Decision, price = svc.price): Promise<boolean> {
    const policy = this.cfg.policy!;
    // The price asked of the guardian is the price about to be escrowed, not
    // the listed one — approving a figure other than the one that moves is the
    // same defect as capping one.
    this.emit({
      level: "guardian",
      resource: svc.resource,
      message: `ESCALATED: ${svc.name} costs ${formatUsdc(price)} USDC (> ${formatUsdc(policy.autoApproveMax)} cap) — awaiting guardian`,
    });
    if (policy.autoApprove) {
      await new Promise((r) => setTimeout(r, 400)); // brief, visible pause
      return true;
    }
    return this.approvals.request(
      {
        resource: svc.resource,
        name: svc.name,
        provider: svc.provider,
        priceUsdc: formatUsdc(price),
        reason: decision.reason,
      },
      policy.approvalTimeoutMs ?? 60_000
    );
  }

  /** The 402 handshake: quote -> escrow -> deliver -> verify -> settle/refund. */
  /**
   * Fill in runtime values the scenario could not know when it was written.
   * `$self` is the agent's own address — used by the health and reputation
   * reads, which refuse to answer without a subject.
   */
  private resolveQuery(q?: Record<string, string>): string {
    if (!q) return "";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      params.set(k, v === "$self" ? this.cfg.client.account.address : v);
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  private async purchase(svc: OfferedService, decision: Decision, query = ""): Promise<LedgerEntry> {
    const entry: LedgerEntry = {
      resource: svc.resource,
      name: svc.name,
      provider: svc.provider,
      price: svc.price,
      status: "error",
      reason: "",
      txs: {},
    };

    // 1) Get a fresh 402 quote.
    const quote = await this.fetchQuote(svc, query);
    if (!quote) {
      entry.reason = "provider did not return a 402 quote";
      return entry;
    }

    // 1b) The quote — not the catalog entry — is what gets escrowed, so it has
    //     to be checked against what the policy gate actually approved. This is
    //     the last point before funds move; every spending path passes here.
    const match = quoteMatchesOffer(quote, svc);
    if (!match.ok) {
      entry.status = "skipped";
      entry.reason = match.reason;
      this.emit({
        level: "skip",
        resource: svc.resource,
        message: `Refusing ${svc.name} — ${match.reason}`,
      });
      return entry;
    }
    // Record what will actually move, which may be below the vetted price.
    entry.price = quote.price;

    /*
     * 1c) The guardian cap, at the choke point — and measured against the
     *     amount that is about to be escrowed.
     *
     * This used to sit in the callers. Both of them checked something, but the
     * invoice path checked the *invoice's* amount and then escrowed the
     * *quote's* price, which is bounded by the catalog entry and not by the
     * bill: a provider that invoiced a penny for a service listed at a pound
     * was escalated for the penny and paid the pound, with no guardian asked
     * about the difference. That is the failure the money invariants describe —
     * a cap each caller must remember is not a cap.
     *
     * Here there is one gate, and the number it reads is the number that moves.
     * The cost is one quote request for a spend that is then declined; a quote
     * moves nothing, and the alternative was moving money nobody approved.
     */
    if (this.cfg.policy && quote.price > this.cfg.policy.autoApproveMax) {
      const approved = await this.escalate(svc, decision, quote.price);
      if (!approved) {
        entry.status = "skipped";
        entry.reason = "guardian declined (over policy cap)";
        this.emit({
          level: "guardian",
          resource: svc.resource,
          message: `Guardian declined ${svc.name} (${formatUsdc(quote.price)} USDC) — not buying`,
        });
        return entry;
      }
      this.emit({
        level: "guardian",
        resource: svc.resource,
        message: `Guardian approved ${svc.name} (${formatUsdc(quote.price)} USDC)`,
      });
    }

    // 2) Escrow the payment on Arc. Chain time and wall time can skew either
    //    way (fast-mined blocks run ahead; idle local chains fall behind), so
    //    anchor the deadline to whichever clock is further ahead.
    await this.cfg.client.ensureApproval(quote.price);
    const chainNow = await this.cfg.client.chainTime();
    const wallNow = BigInt(Math.floor(Date.now() / 1000));
    // Floor the on-chain deadline so a short provider SLA plus public-RPC
    // confirmation latency can't make open() revert with DeadlinePassed before
    // the escrow is even created. (Runtime tuning for the rate-limited testnet.)
    const minDeadlineSeconds = Number(process.env.TESSERA_MIN_DEADLINE_SECONDS ?? 60);
    const deadlineSeconds = BigInt(Math.max(quote.deadlineSeconds, minDeadlineSeconds));
    const deadline = (chainNow > wallNow ? chainNow : wallNow) + deadlineSeconds;

    /*
     * Pay in USDC when there is enough of it, and route from something else when
     * there is not.
     *
     * The provider quoted in USDC and is paid in USDC either way — that is what
     * makes a quote a quote. What changes is where the USDC comes from. An agent
     * holding EURC and no USDC could previously not trade at all, which is an odd
     * limitation on a chain that ships three Circle assets and a router
     * connecting them, and an odder one for an agent that is meant to operate
     * unattended: running dry in one asset while holding another should not stop
     * it.
     *
     * USDC stays the default rather than always routing, because a swap costs
     * fees and slippage that a direct payment does not.
     */
    const bond = await this.cfg.client.bondFor(quote.price);
    const needed = quote.price + bond;
    const usdcHeld = await this.cfg.client.usdcBalance().catch(() => needed);

    let paymentId: bigint;
    let openTx: Hex;
    let fundedWith: { symbol: string; spent: bigint } | null = null;

    if (usdcHeld >= needed) {
      ({ paymentId, txHash: openTx } = await this.cfg.client.open(
        quote.provider,
        quote.price,
        deadline,
        quote.quoteHash
      ));
    } else {
      const alt = await this.pickFundingAsset(needed);
      if (!alt) {
        entry.reason = `not enough USDC (${formatUsdc(usdcHeld)}) and no other asset can cover it`;
        return entry;
      }
      ({ paymentId, txHash: openTx } = await this.cfg.client.openWith(
        alt.token,
        alt.maxIn,
        quote.provider,
        quote.price,
        deadline,
        quote.quoteHash
      ));
      fundedWith = { symbol: alt.symbol, spent: alt.maxIn };
    }

    entry.paymentId = paymentId.toString();
    entry.txs.open = openTx;
    this.emit({
      level: "pay",
      resource: svc.resource,
      message: fundedWith
        ? `Escrowed ${formatUsdc(quote.price)} USDC (payment #${paymentId}) — routed from ${fundedWith.symbol}`
        : `Escrowed ${formatUsdc(quote.price)} USDC (payment #${paymentId})`,
      txHash: openTx,
    });

    // 3) Re-request with proof of payment.
    let body: unknown;
    let receiptSig: Hex | null = null;
    let receiptIssued: string | null = null;
    try {
      const res = await fetch(`${this.cfg.providersBaseUrl}${quote.url}`, {
        headers: { [HEADERS.payment]: paymentId.toString() },
        // Never hang forever on a stuck provider — time out and let the escrow's
        // SLA deadline drive a refund instead.
        signal: AbortSignal.timeout(30_000),
      });
      receiptSig = res.headers.get(HEADERS.receiptSig) as Hex | null;
      receiptIssued = res.headers.get(HEADERS.receiptIssued);
      body = await res.json();
    } catch (err) {
      body = undefined;
    }

    // 4) Verify delivery on-chain + quality, then settle or reclaim.
    const payment = await this.cfg.client.getPayment(paymentId);

    if (payment.status === PaymentStatus.Fulfilled) {
      const integrity = keccak256(toHex(JSON.stringify(body))) === payment.responseHash;
      const quality = passesQuality(svc.resource, body);

      // Keep the provider's signed receipt. This is evidence, not a gate: the
      // chain already proves the payment was fulfilled against this hash, and
      // refusing to settle over a missing signature would let a provider that
      // genuinely delivered be punished for a dropped header.
      if (receiptSig && receiptIssued) {
        let valid = false;
        try {
          valid = await verifyTypedData({
            address: quote.provider,
            signature: receiptSig,
            ...receiptFromPayment(
              this.cfg.client.public.chain!.id,
              this.cfg.client.escrow,
              paymentId,
              {
                agent: this.cfg.client.account.address,
                provider: quote.provider,
                amount: payment.amount,
                responseHash: payment.responseHash,
              },
              svc.resource,
              BigInt(receiptIssued),
            ),
          });
        } catch {
          valid = false;
        }
        entry.receipt = {
          signature: receiptSig,
          issuedAt: receiptIssued,
          responseHash: payment.responseHash,
          amount: payment.amount,
          valid,
        };
        if (!valid) {
          this.emit({
            level: "skip",
            resource: svc.resource,
            message: `Receipt signature from ${svc.name} did not verify — settling anyway, but the receipt is worthless`,
          });
        }
      }
      if (integrity && quality.ok) {
        const settleTx = await this.cfg.client.settle(paymentId);
        entry.status = "settled";
        entry.reason = quality.reason;
        entry.txs.settle = settleTx;
        entry.data = body;
        this.emit({
          level: "settle",
          resource: svc.resource,
          message: `Verified (${quality.reason}) — released ${formatUsdc(quote.price)} USDC to provider`,
          txHash: settleTx,
        });
        await this.chargeForSettlement(svc.price, svc.name, svc.resource);
      } else {
        const refundTx = await this.cfg.client.refund(paymentId);
        entry.status = "refunded";
        entry.reason = !integrity ? "response hash mismatch" : `SLA fail: ${quality.reason}`;
        entry.txs.refund = refundTx;
        this.emit({
          level: "refund",
          resource: svc.resource,
          message: `SLA breach (${entry.reason}) — reclaimed ${formatUsdc(svc.price)} USDC`,
          txHash: refundTx,
        });
      }
      return entry;
    }

    // 5) Never fulfilled: wait out the deadline, then reclaim on timeout.
    //
    // The wait has to cover the *whole* remaining deadline. Capping it at 20s
    // while the escrow's minimum deadline is 60s meant refund() was called
    // before the contract would allow it and reverted with DeadlineNotReached,
    // leaving the payment open and the money stuck until someone noticed. The
    // deadline is chain time, so also re-check against the chain rather than
    // trusting the local clock, and retry once if we were still early.
    const deadlineMs = Number(payment.deadline) * 1000;
    const waitFor = async () => {
      const chainNow = Number(await this.cfg.client.chainTime()) * 1000;
      const remaining = deadlineMs - Math.max(chainNow, Date.now()) + 2000;
      if (remaining > 0) await sleep(Math.min(remaining, 180_000));
    };
    await waitFor();
    let refundTx: Hex;
    try {
      refundTx = await this.cfg.client.refund(paymentId);
    } catch (err) {
      if (!/DeadlineNotReached/i.test(String(err))) throw err;
      await waitFor();
      refundTx = await this.cfg.client.refund(paymentId);
    }
    entry.status = "refunded";
    entry.reason = "provider missed SLA deadline";
    entry.txs.refund = refundTx;
    this.emit({
      level: "refund",
      resource: svc.resource,
      message: `Deadline missed — reclaimed ${formatUsdc(svc.price)} USDC`,
      txHash: refundTx,
    });
    return entry;
  }

  /**
   * Nanopayments: stream `ticks` micro-calls from a tab-billed service.
   * One on-chain deposit, one off-chain voucher per call (no gas), one on-chain
   * settlement at the end. Returns the collected ticks.
   */
  async streamTicks(
    resource: string,
    ticks: number,
    depositMultiple = 2n
  ): Promise<{ data: unknown[]; spent: bigint; tabId?: bigint } | null> {
    const services = await this.discover();
    const svc = services.find((s) => s.resource === resource && s.billing === "tab");
    if (!svc) {
      this.emit({ level: "skip", resource, message: `No tab-billed service for "${resource}"` });
      return null;
    }

    const deposit = svc.price * BigInt(ticks) * depositMultiple;

    /*
     * The tab rail moves money exactly as the escrow rail does, so it passes the
     * same gate. `agentkit`'s `open_tab` action already caps its deposit; this
     * method reached `client.openTab` directly — the same shortcut past the cap,
     * the guardian and the blocklist that the kit was fixed for.
     *
     * The number checked is the deposit, not the per-tick price. The deposit is
     * what leaves the wallet and it is `ticks * depositMultiple` times larger,
     * so capping the tick price would authorise a figure nobody sees. It is also
     * computed from a catalog price the provider controls, which means without
     * this gate a large enough listing opens a tab for any amount at all.
     */
    if (this.cfg.policy?.blockedProviders?.some((p) => p.toLowerCase() === svc.provider.toLowerCase())) {
      this.emit({ level: "skip", resource, message: `${svc.name} is blocked by policy — no tab opened` });
      return null;
    }
    if (this.cfg.policy && deposit > this.cfg.policy.autoApproveMax) {
      const trust = Math.max(
        0,
        trustScore(svc.reputation, svc.stakeUsdc) - (this.cfg.memory?.penalty(svc.provider) ?? 0)
      );
      const approved = await this.escalate(
        svc,
        { buy: true, reason: `tab deposit for ~${ticks} ticks`, trust },
        deposit
      );
      if (!approved) {
        this.emit({
          level: "guardian",
          resource,
          message: `Guardian declined the ${formatUsdc(deposit)} USDC tab deposit — no tab opened`,
        });
        return null;
      }
      this.emit({
        level: "guardian",
        resource,
        message: `Guardian approved the ${formatUsdc(deposit)} USDC tab deposit`,
      });
    }

    this.emit({
      level: "decide",
      resource,
      message: `OPEN TAB with ${svc.name} — deposit ${formatUsdc(deposit)} USDC for ~${ticks} ticks @ ${formatUsdc(svc.price)}/tick`,
    });

    const { tabId, txHash } = await this.cfg.client.openTab(svc.provider, deposit, 3600);
    this.emit({
      level: "pay",
      resource,
      message: `Tab #${tabId} funded with ${formatUsdc(deposit)} USDC (single escrow tx)`,
      txHash,
    });

    const data: unknown[] = [];
    let cum = 0n;
    // Space out ticks: the provider verifies each voucher with one on-chain read,
    // and a rapid burst trips the public RPC's per-window eth_call limit.
    const tickPaceMs = Number(process.env.TESSERA_TICK_PACE_MS ?? 0);
    for (let i = 0; i < ticks; i++) {
      if (tickPaceMs > 0 && i > 0) await sleep(tickPaceMs);
      cum += svc.price;
      const sig = await this.cfg.client.signVoucher(tabId, cum);
      const res = await fetch(`${this.cfg.providersBaseUrl}${svc.path}?n=${i}`, {
        headers: {
          [HEADERS.tab]: tabId.toString(),
          [HEADERS.voucher]: cum.toString(),
          [HEADERS.voucherSig]: sig,
        },
      });
      if (res.status !== 200) {
        this.emit({ level: "skip", resource, message: `Tick ${i} rejected — stopping stream` });
        break;
      }
      const body = await res.json();
      data.push(body);
      this.emit({
        level: "pay",
        resource,
        message: `Tick ${i + 1}/${ticks} — voucher ${formatUsdc(cum)} USDC signed off-chain (no gas)`,
      });
    }

    // Ask the provider to settle: one claim() for the whole stream, remainder back.
    const closeRes = await fetch(`${this.cfg.providersBaseUrl}/tab/${tabId}/close`, {
      method: "POST",
    });
    if (closeRes.ok) {
      const closed = (await closeRes.json()) as { settled: string; txHash: string };
      /*
       * Report what the chain says moved, not what the provider says it moved.
       * `settled` arrives in the provider's own close response, so a provider
       * that claims the full deposit on-chain can still report zero here and the
       * activity feed would show the operator a refund that never happened.
       * The tab's `claimed` field is the settled figure the contract recorded.
       */
      this.emit({
        level: "settle",
        resource,
        message: `Tab #${tabId} closed — ${formatUsdc(BigInt(closed.settled))} USDC to provider, ${formatUsdc(deposit - BigInt(closed.settled))} USDC returned`,
        txHash: closed.txHash as `0x${string}`,
      });
    } else {
      this.emit({
        level: "refund",
        resource,
        message: `Provider didn't settle tab #${tabId} — will reclaim after expiry`,
      });
    }

    return { data, spent: cum, tabId };
  }

  /**
   * Payment requests: fetch provider-issued invoices and autonomously decide
   * each one — pay (through the normal escrow flow), decline from personal
   * memory, or escalate to the guardian if over the policy cap.
   */
  readonly invoiceVerdicts: { invoiceId: string; verdict: "paid" | "declined"; reason: string }[] = [];

  async processInvoices(budget: bigint): Promise<void> {
    let invoices: Array<{
      invoiceId: string;
      resource: string;
      name: string;
      amount: string;
      amountUsdc: string;
      memo: string;
      status: string;
    }>;
    try {
      const res = await fetch(`${this.cfg.providersBaseUrl}/invoices`);
      invoices = ((await res.json()) as { invoices: typeof invoices }).invoices;
    } catch {
      return; // no billing inbox — nothing to do
    }
    const pending = invoices.filter((i) => i.status === "pending");
    if (pending.length === 0) return;
    this.emit({ level: "info", message: `Billing inbox: ${pending.length} payment request(s)` });

    const services = await this.discover();
    let remaining = budget;

    for (const inv of pending) {
      const svc = services.find((s) => s.resource === inv.resource);
      if (!svc) continue;
      const amount = BigInt(inv.amount);
      const penalty = this.cfg.memory?.penalty(svc.provider) ?? 0;
      const trust = Math.max(0, trustScore(svc.reputation, svc.stakeUsdc) - penalty);

      const decline = (reason: string) => {
        this.invoiceVerdicts.push({ invoiceId: inv.invoiceId, verdict: "declined", reason });
        this.emit({ level: "decide", resource: inv.resource, message: `DECLINE invoice "${inv.memo}" — ${reason}` });
      };

      if (penalty > 0) {
        decline(`provider burned this agent before (personal trust −${penalty.toFixed(2)})`);
        continue;
      }
      if (trust < 0.34) {
        decline(`trust ${trust.toFixed(2)} below floor`);
        continue;
      }
      if (amount > remaining) {
        decline(`amount ${inv.amountUsdc} exceeds invoice budget`);
        continue;
      }
      this.emit({ level: "decide", resource: inv.resource, message: `PAY invoice "${inv.memo}" (${inv.amountUsdc} USDC) — trust ${trust.toFixed(2)}` });
      const entry = await this.purchase(svc, { buy: true, reason: `invoice: ${inv.memo}`, trust });
      this.ledger.push(entry);
      if (entry.status === "settled" || entry.status === "refunded") {
        this.cfg.memory?.record(svc.provider, svc.name, entry.status);
      }
      if (entry.status === "settled") {
        // What was escrowed, not what was billed. `purchase` writes the quoted
        // price onto the entry, and the two need not agree — a budget spent
        // against the invoice while a different sum left the wallet is a budget
        // that does not bind.
        remaining -= entry.price;
        this.invoiceVerdicts.push({ invoiceId: inv.invoiceId, verdict: "paid", reason: inv.memo });
      } else {
        this.invoiceVerdicts.push({ invoiceId: inv.invoiceId, verdict: "declined", reason: entry.reason });
      }
    }
  }

  /** Compose everything the agent bought into the final deliverable. */
  briefing(streamData?: unknown[]): string[] {
    const lines: string[] = [];

    // The treasury advice comes first: it is the conclusion the run was for.
    // Everything below it is the evidence and the incidental purchases.
    const advice = adviseFrom(this.ledger);
    if (advice.lines.length) {
      lines.push(`${advice.headline}:`);
      for (const l of advice.lines) lines.push(`• ${l}`);
    }

    for (const e of this.ledger) {
      if (e.status !== "settled" || !e.data) continue;
      const d = e.data as Record<string, unknown>;
      if (e.resource === "weather:current") {
        lines.push(
          `Weather in ${d.city}: ${d.tempC}°C, ${d.condition}, humidity ${d.humidity}%`
        );
      } else if (e.resource === "fx:quote") {
        lines.push(`FX ${d.pair}: ${d.rate} (spread ${d.spread})`);
      } else if (e.resource === "news:headlines") {
        const h = (d.headlines as string[]) ?? [];
        lines.push(`Headlines: ${h.slice(0, 3).join(" · ")}`);
      } else if (e.resource === "alpha:report") {
        lines.push(
          `Analysis (${d.subject}): ${d.stance}, confidence ${Math.round(Number(d.confidence) * 100)}% — ${(d.drivers as string[]).join(", ")}`
        );
      } else if (e.resource === "subscription:fx") {
        lines.push(`Subscription: ${d.plan} renewed until ${d.until}`);
      }
    }
    const refunded = this.ledger.filter((e) => e.status === "refunded");
    for (const e of refunded) {
      lines.push(`⚠ ${e.name}: not included — ${e.reason} (USDC reclaimed)`);
    }
    if (streamData && streamData.length > 0) {
      const ticks = streamData as Array<Record<string, unknown>>;
      const last = ticks[ticks.length - 1];
      const first = ticks[0];
      lines.push(
        `Live ${last.pair}: ${last.price} after ${ticks.length} streamed ticks (opened at ${first.price})`
      );
    }
    return lines;
  }

  /**
   * Find an asset the agent holds that can cover `needed` of the escrow asset.
   *
   * Picks the first configured asset whose route clears the requirement with
   * headroom, and returns a bound sized against the *quote* rather than the
   * balance: sending the whole balance as `maxIn` would let a thin pool take all
   * of it and return the surplus as change, which is a worse trade than not
   * trading. `SLIPPAGE_BPS` over the amount the route says it needs is the most
   * the agent is willing to be wrong by.
   */
  private async pickFundingAsset(
    needed: bigint
  ): Promise<{ token: Hex; symbol: string; maxIn: bigint } | null> {
    const assets = this.cfg.fundingAssets ?? [];
    const SLIPPAGE_BPS = 300n; // 3%

    for (const a of assets) {
      let held: bigint;
      try {
        held = await this.cfg.client.tokenBalance(a.address);
      } catch {
        continue;
      }
      if (held === 0n) continue;

      // What the whole balance would fetch, to see whether this asset can cover
      // the payment at all.
      const { out } = await this.cfg.client.quoteOpenWith(a.address, held);
      if (out < needed) continue;

      // Then size the actual spend: scale the balance down to roughly what is
      // required, plus slippage, and never above what is held.
      let maxIn = (held * needed) / out;
      maxIn = (maxIn * (10_000n + SLIPPAGE_BPS)) / 10_000n;
      if (maxIn > held) maxIn = held;

      // Re-check at the size actually being sent — a route that clears at full
      // balance can still fall short at a fraction of it.
      const { out: outAtSize } = await this.cfg.client.quoteOpenWith(a.address, maxIn);
      if (outAtSize < needed) continue;

      return { token: a.address, symbol: a.symbol, maxIn };
    }
    return null;
  }

  private async fetchQuote(svc: OfferedService, query = ""): Promise<Quote | null> {
    const res = await fetch(`${this.cfg.providersBaseUrl}${svc.path}${query}`);
    if (res.status !== 402) return null;
    const provider = res.headers.get(HEADERS.provider) as Hex | null;
    const price = res.headers.get(HEADERS.price);
    const quoteHash = res.headers.get(HEADERS.quote) as Hex | null;
    const deadline = res.headers.get(HEADERS.deadline);
    const resource = res.headers.get(HEADERS.resource);
    if (!provider || !price || !quoteHash || !deadline || !resource) return null;

    // Verify the provider's EIP-712 signature over the quote before trusting it.
    // Required, not optional: when the signature headers merely gated the check,
    // a provider could skip verification entirely by omitting them. Honest
    // providers always sign (see providers/src/app.ts).
    const nonce = res.headers.get(HEADERS.quoteNonce) as Hex | null;
    const expiry = res.headers.get(HEADERS.quoteExpiry);
    const sig = res.headers.get(HEADERS.quoteSig) as Hex | null;
    if (!nonce || !expiry || !sig) {
      this.emit({ level: "skip", resource, message: `Quote from ${svc.name} is unsigned — refusing to pay` });
      return null;
    }
    {
      if (BigInt(expiry) < BigInt(Math.floor(Date.now() / 1000))) {
        this.emit({ level: "skip", resource, message: `Quote from ${svc.name} expired — skipping` });
        return null;
      }
      const typed = quoteTypedData(this.cfg.client.public.chain!.id, this.cfg.client.escrow, {
        provider,
        price: BigInt(price),
        resource,
        nonce,
        expiry: BigInt(expiry),
      });
      const valid = await verifyTypedData({ address: provider, signature: sig, ...typed });
      if (!valid) {
        this.emit({ level: "skip", resource, message: `Quote signature from ${svc.name} INVALID — refusing to pay` });
        return null;
      }
    }

    return {
      provider,
      price: BigInt(price),
      quoteHash,
      deadlineSeconds: Number(deadline),
      resource,
      url: `${svc.path}${query}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
