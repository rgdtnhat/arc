import { keccak256, toHex, verifyTypedData, type Hex } from "viem";
import {
  HEADERS,
  formatUsdc,
  PaymentStatus,
  arcscanTx,
  quoteTypedData,
  type Quote,
} from "@tessera/shared";
import { TesseraClient } from "./client.js";
import {
  decideByLlm,
  decideByRules,
  passesQuality,
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

        // Safety sandbox: above the policy cap, a guardian must co-sign.
        if (this.cfg.policy && svc.price > this.cfg.policy.autoApproveMax) {
          const approved = await this.escalate(svc, decision);
          if (!approved) {
            this.emit({
              level: "guardian",
              resource: svc.resource,
              message: `Guardian declined ${svc.name} (${formatUsdc(svc.price)} USDC) — not buying`,
            });
            this.ledger.push({
              resource: svc.resource,
              name: svc.name,
              provider: svc.provider,
              price: svc.price,
              status: "skipped",
              reason: "guardian declined (over policy cap)",
              txs: {},
            });
            continue;
          }
          this.emit({
            level: "guardian",
            resource: svc.resource,
            message: `Guardian approved ${svc.name} (${formatUsdc(svc.price)} USDC)`,
          });
        }

        let entry: LedgerEntry;
        try {
          entry = await this.purchase(svc, decision);
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
  private async escalate(svc: OfferedService, decision: Decision): Promise<boolean> {
    const policy = this.cfg.policy!;
    this.emit({
      level: "guardian",
      resource: svc.resource,
      message: `ESCALATED: ${svc.name} costs ${formatUsdc(svc.price)} USDC (> ${formatUsdc(policy.autoApproveMax)} cap) — awaiting guardian`,
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
        priceUsdc: formatUsdc(svc.price),
        reason: decision.reason,
      },
      policy.approvalTimeoutMs ?? 60_000
    );
  }

  /** The 402 handshake: quote -> escrow -> deliver -> verify -> settle/refund. */
  private async purchase(svc: OfferedService, decision: Decision): Promise<LedgerEntry> {
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
    const quote = await this.fetchQuote(svc);
    if (!quote) {
      entry.reason = "provider did not return a 402 quote";
      return entry;
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
    const { paymentId, txHash: openTx } = await this.cfg.client.open(
      quote.provider,
      quote.price,
      deadline,
      quote.quoteHash
    );
    entry.paymentId = paymentId.toString();
    entry.txs.open = openTx;
    this.emit({
      level: "pay",
      resource: svc.resource,
      message: `Escrowed ${formatUsdc(quote.price)} USDC (payment #${paymentId})`,
      txHash: openTx,
    });

    // 3) Re-request with proof of payment.
    let body: unknown;
    try {
      const res = await fetch(`${this.cfg.providersBaseUrl}${quote.url}`, {
        headers: { [HEADERS.payment]: paymentId.toString() },
      });
      body = await res.json();
    } catch (err) {
      body = undefined;
    }

    // 4) Verify delivery on-chain + quality, then settle or reclaim.
    const payment = await this.cfg.client.getPayment(paymentId);

    if (payment.status === PaymentStatus.Fulfilled) {
      const integrity = keccak256(toHex(JSON.stringify(body))) === payment.responseHash;
      const quality = passesQuality(svc.resource, body);
      if (integrity && quality.ok) {
        const settleTx = await this.cfg.client.settle(paymentId);
        entry.status = "settled";
        entry.reason = quality.reason;
        entry.txs.settle = settleTx;
        entry.data = body;
        this.emit({
          level: "settle",
          resource: svc.resource,
          message: `Verified (${quality.reason}) — released ${formatUsdc(svc.price)} USDC to provider`,
          txHash: settleTx,
        });
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
    const waitMs = Number(payment.deadline) * 1000 - Date.now() + 1500;
    if (waitMs > 0) await sleep(Math.min(waitMs, 20_000));
    const refundTx = await this.cfg.client.refund(paymentId);
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
      if (this.cfg.policy && amount > this.cfg.policy.autoApproveMax) {
        const approved = await this.escalate(svc, { buy: true, reason: `invoice: ${inv.memo}`, trust });
        if (!approved) {
          decline("guardian declined (over policy cap)");
          continue;
        }
      }

      this.emit({ level: "decide", resource: inv.resource, message: `PAY invoice "${inv.memo}" (${inv.amountUsdc} USDC) — trust ${trust.toFixed(2)}` });
      const entry = await this.purchase(svc, { buy: true, reason: `invoice: ${inv.memo}`, trust });
      this.ledger.push(entry);
      if (entry.status === "settled" || entry.status === "refunded") {
        this.cfg.memory?.record(svc.provider, svc.name, entry.status);
      }
      if (entry.status === "settled") {
        remaining -= amount;
        this.invoiceVerdicts.push({ invoiceId: inv.invoiceId, verdict: "paid", reason: inv.memo });
      } else {
        this.invoiceVerdicts.push({ invoiceId: inv.invoiceId, verdict: "declined", reason: entry.reason });
      }
    }
  }

  /** Compose everything the agent bought into the final deliverable. */
  briefing(streamData?: unknown[]): string[] {
    const lines: string[] = [];
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

  private async fetchQuote(svc: OfferedService): Promise<Quote | null> {
    const res = await fetch(`${this.cfg.providersBaseUrl}${svc.path}`);
    if (res.status !== 402) return null;
    const provider = res.headers.get(HEADERS.provider) as Hex | null;
    const price = res.headers.get(HEADERS.price);
    const quoteHash = res.headers.get(HEADERS.quote) as Hex | null;
    const deadline = res.headers.get(HEADERS.deadline);
    const resource = res.headers.get(HEADERS.resource);
    if (!provider || !price || !quoteHash || !deadline || !resource) return null;

    // Verify the provider's EIP-712 signature over the quote before trusting it.
    const nonce = res.headers.get(HEADERS.quoteNonce) as Hex | null;
    const expiry = res.headers.get(HEADERS.quoteExpiry);
    const sig = res.headers.get(HEADERS.quoteSig) as Hex | null;
    if (nonce && expiry && sig) {
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
      url: svc.path,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
