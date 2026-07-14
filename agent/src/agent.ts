import { keccak256, toHex, type Hex } from "viem";
import {
  HEADERS,
  formatUsdc,
  PaymentStatus,
  arcscanTx,
  type Quote,
} from "@tessera/shared";
import { TesseraClient } from "./client.js";
import {
  decideByLlm,
  decideByRules,
  passesQuality,
  type AgentTask,
  type Decision,
  type OfferedService,
} from "./decide.js";

export type Brain = "rules" | "llm";

export interface AgentConfig {
  client: TesseraClient;
  providersBaseUrl: string;
  brain?: Brain;
  anthropicApiKey?: string;
  explorer?: boolean; // link tx hashes to Arcscan in events
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
  level: "info" | "decide" | "pay" | "settle" | "refund" | "skip" | "done";
  resource?: string;
  message: string;
  txHash?: string;
  txUrl?: string;
}

export class TesseraAgent {
  private readonly cfg: AgentConfig;
  readonly ledger: LedgerEntry[] = [];

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
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
      provider: s.provider,
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
    for (const need of task.needs) {
      const candidates = services
        .filter((s) => s.tags.includes(need.tag))
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

        let entry: LedgerEntry;
        try {
          entry = await this.purchase(svc, decision);
        } catch (err) {
          entry = {
            resource: svc.resource,
            name: svc.name,
            provider: svc.provider,
            price: svc.price,
            status: "error",
            reason: (err as Error).message?.split("\n")[0] ?? String(err),
            txs: {},
          };
          this.emit({ level: "skip", resource: svc.resource, message: `Purchase failed: ${entry.reason}` });
        }
        this.ledger.push(entry);
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
    if (this.cfg.brain === "llm" && this.cfg.anthropicApiKey) {
      return decideByLlm(task, svc, remaining, this.cfg.anthropicApiKey);
    }
    return decideByRules(task, svc, remaining);
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

    // 2) Escrow the payment on Arc. The deadline is relative to chain time.
    await this.cfg.client.ensureApproval(quote.price);
    const deadline = (await this.cfg.client.chainTime()) + BigInt(quote.deadlineSeconds);
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

  private async fetchQuote(svc: OfferedService): Promise<Quote | null> {
    const res = await fetch(`${this.cfg.providersBaseUrl}${svc.path}`);
    if (res.status !== 402) return null;
    const provider = res.headers.get(HEADERS.provider) as Hex | null;
    const price = res.headers.get(HEADERS.price);
    const quoteHash = res.headers.get(HEADERS.quote) as Hex | null;
    const deadline = res.headers.get(HEADERS.deadline);
    const resource = res.headers.get(HEADERS.resource);
    if (!provider || !price || !quoteHash || !deadline || !resource) return null;
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
