import { formatUsdc } from "@tessera/shared";
import type { TesseraClient } from "./client.js";
import type { Faucet, FaucetResult } from "./circle/faucet.js";
import type { LedgerEntry } from "./agent.js";

/**
 * App-Kit-style treasury / settlement workflow.
 *
 * A treasury workflow manages the agent's USDC working capital rather than a
 * single payment: it snapshots runway, tops the wallet up from the faucet when
 * it falls below a low-water mark, and produces settlement accounting over a run
 * (opening balance, spent, reclaimed, net position). It's the multi-step money
 * flow the DeFi/Agentic tracks ask for, built on the same escrow rail.
 */
export interface TreasuryConfig {
  client: TesseraClient;
  /** Refill when the balance drops below this (USDC base units). */
  lowWaterMark: bigint;
  /** Faucet used to auto-refill (Circle API, manual, or local mock). */
  faucet?: Faucet;
  onEvent?: (message: string) => void;
}

export interface TreasurySnapshot {
  address: string;
  balance: string;
  balanceUsdc: string;
  lowWaterUsdc: string;
  healthy: boolean;
  /** Estimated calls of runway at a reference call price (null if unknown). */
  runwayCalls: number | null;
}

export interface SettlementSummary {
  openingUsdc: string;
  currentUsdc: string;
  spentUsdc: string;
  reclaimedUsdc: string;
  earnedUsdc: string;
  settledCount: number;
  refundedCount: number;
  /** Net change in the agent's USDC over the run (current − opening). */
  netUsdc: string;
}

export class TesseraTreasury {
  constructor(private readonly cfg: TreasuryConfig) {}

  private emit(message: string) {
    this.cfg.onEvent?.(message);
  }

  /** Snapshot the agent's treasury health and runway. */
  async snapshot(referenceCallPrice?: bigint): Promise<TreasurySnapshot> {
    const balance = await this.cfg.client.usdcBalance();
    const runwayCalls =
      referenceCallPrice && referenceCallPrice > 0n ? Number(balance / referenceCallPrice) : null;
    return {
      address: this.cfg.client.account.address,
      balance: balance.toString(),
      balanceUsdc: formatUsdc(balance),
      lowWaterUsdc: formatUsdc(this.cfg.lowWaterMark),
      healthy: balance >= this.cfg.lowWaterMark,
      runwayCalls,
    };
  }

  /** Auto-refill from the faucet if the balance is below the low-water mark. */
  async topUpIfLow(): Promise<FaucetResult | null> {
    const balance = await this.cfg.client.usdcBalance();
    if (balance >= this.cfg.lowWaterMark) return null;
    this.emit(
      `Treasury low: ${formatUsdc(balance)} USDC < ${formatUsdc(this.cfg.lowWaterMark)} low-water mark — requesting faucet`
    );
    return this.requestFaucet();
  }

  /** Request testnet USDC from the configured faucet (or manual instructions). */
  async requestFaucet(): Promise<FaucetResult> {
    const address = this.cfg.client.account.address;
    if (!this.cfg.faucet) {
      return {
        ok: false,
        manual: true,
        address,
        url: "https://faucet.circle.com/",
        message: `No faucet configured — top up ${address} at https://faucet.circle.com/`,
      };
    }
    const result = await this.cfg.faucet.request(address);
    this.emit(result.message);
    return result;
  }

  /** Settlement accounting for a completed run, from the agent's ledger. */
  static settlement(
    ledger: LedgerEntry[],
    openingBalance: bigint,
    currentBalance: bigint,
    earned = 0n
  ): SettlementSummary {
    const settled = ledger.filter((e) => e.status === "settled");
    const refunded = ledger.filter((e) => e.status === "refunded");
    const spent = settled.reduce((a, e) => a + e.price, 0n);
    const reclaimed = refunded.reduce((a, e) => a + e.price, 0n);
    return {
      openingUsdc: formatUsdc(openingBalance),
      currentUsdc: formatUsdc(currentBalance),
      spentUsdc: formatUsdc(spent),
      reclaimedUsdc: formatUsdc(reclaimed),
      earnedUsdc: formatUsdc(earned),
      settledCount: settled.length,
      refundedCount: refunded.length,
      netUsdc: formatUsdc(currentBalance - openingBalance),
    };
  }
}
