import fs from "node:fs";
import type { Hex } from "viem";

/**
 * Personal trust memory — the agent's address book (LOBSTR-contacts-style).
 * On-chain reputation is global; this is the agent's OWN experience with each
 * provider, persisted across runs. A provider that burned *this* agent gets a
 * personal trust penalty on top of whatever its global record says.
 */
export interface Contact {
  provider: Hex;
  name: string;
  dealings: number;
  settled: number;
  refunded: number;
  lastOutcome: "settled" | "refunded" | "skipped";
  lastSeen: number;
}

export class TrustMemory {
  private contacts = new Map<Hex, Contact>();

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Contact[];
        for (const c of raw) this.contacts.set(c.provider, c);
      } catch {
        // corrupt memory file — start fresh
      }
    }
  }

  record(provider: Hex, name: string, outcome: "settled" | "refunded" | "skipped"): void {
    const c = this.contacts.get(provider) ?? {
      provider,
      name,
      dealings: 0,
      settled: 0,
      refunded: 0,
      lastOutcome: outcome,
      lastSeen: 0,
    };
    c.name = name;
    c.dealings += 1;
    if (outcome === "settled") c.settled += 1;
    if (outcome === "refunded") c.refunded += 1;
    c.lastOutcome = outcome;
    c.lastSeen = Date.now();
    this.contacts.set(provider, c);
    this.persist();
  }

  /**
   * Personal trust penalty in [0, 0.45]: each time this agent personally got
   * refunded by the provider costs 0.15 trust — three strikes ≈ never again.
   */
  penalty(provider: Hex): number {
    const c = this.contacts.get(provider);
    if (!c) return 0;
    return Math.min(0.45, c.refunded * 0.15);
  }

  list(): Contact[] {
    return [...this.contacts.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  private persist(): void {
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.list(), null, 2));
    } catch {
      // memory persistence is best-effort
    }
  }
}
