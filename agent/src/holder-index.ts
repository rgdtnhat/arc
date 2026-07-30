/**
 * A persistent, incremental index of which addresses have touched a contract.
 *
 * The previous approach — sweep the contract's whole history on demand — cannot
 * work here, and the reason is worth stating because it is not obvious from any
 * single call site. Every RPC request in this process goes through one global
 * pacing gate (~5.5/s) shared with the dashboard's own polling, the agent, and
 * the providers. A full sweep of an 800k-block deployment is ~90 windowed
 * `eth_getLogs` calls per venue; four venues plus their deployment-block
 * searches is well over 400 requests. Competing for that budget against a live
 * app, the sweep is starved indefinitely — which is exactly the "Reading
 * holders from the chain…" that never finished.
 *
 * So: index once, persist it, and only ever scan forward from where we stopped.
 *
 *  - Progress is written to disk after every window, so a restart resumes
 *    instead of starting over, and a crash costs one window.
 *  - Work is done in bounded bursts with a pause between them, so indexing
 *    never starves the requests a user is actually waiting on.
 *  - Partial results are usable immediately: the address set only ever grows,
 *    and balances are always read live, so a half-built index shows fewer
 *    holders but never a wrong number.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AbiEvent } from "viem";
import type { Hex, PublicClient } from "viem";
import { findDeploymentBlock } from "./deploy-block.js";

/** Arc caps `eth_getLogs` at a 10,000-block span. */
const WINDOW = BigInt(process.env.ARC_LOG_WINDOW ?? "9000");
/** Windows per burst, then yield so live requests get the pacing gate back. */
const BURST = Number(process.env.ARC_INDEX_BURST ?? "6");
/** Pause between bursts. */
const BREATH_MS = Number(process.env.ARC_INDEX_BREATH_MS ?? "1500");

export interface IndexState {
  /** Lowercased addresses seen so far. Grows only. */
  addresses: string[];
  /** Everything at or below this block has been scanned. */
  scannedTo: string;
  /** The contract's creation block — the floor we started from. */
  from: string;
  /** Head of chain when the index last caught up. */
  head: string;
  /** True once `scannedTo` has reached the head at least once. */
  complete: boolean;
  /** Windows that errored and were skipped; they leave holes in the set. */
  gaps: number;
}

const blank = (): IndexState => ({
  addresses: [], scannedTo: "0", from: "0", head: "0", complete: false, gaps: 0,
});

export interface IndexProgress {
  /** 0-1, by blocks covered. */
  ratio: number;
  complete: boolean;
  known: number;
  gaps: number;
}

/**
 * One index per (contract, event, field). Backed by a single JSON file so an
 * operator can inspect or delete it without touching the database-shaped parts
 * of the app.
 */
export class HolderIndex {
  private state = new Map<string, IndexState>();
  private running = new Set<string>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, IndexState>;
      for (const [k, v] of Object.entries(raw)) this.state.set(k, v);
    } catch {
      // No index yet, or it is unreadable. Either way we rebuild from the chain;
      // the index is a cache, never the source of truth.
    }
  }

  private key(contract: Hex, tag: string) {
    return `${contract.toLowerCase()}:${tag}`;
  }

  /** Debounced write — a burst touches the state repeatedly. */
  private save() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.state), null, 0));
      } catch {
        // A read-only volume shouldn't take the app down; the index simply
        // rebuilds next boot.
      }
    }, 2000);
    this.saveTimer.unref?.();
  }

  /** What is known right now, without waiting for anything. */
  known(contract: Hex, tag: string): { addresses: string[]; progress: IndexProgress } {
    const st = this.state.get(this.key(contract, tag)) ?? blank();
    const from = BigInt(st.from);
    const head = BigInt(st.head);
    const done = BigInt(st.scannedTo);
    const span = head > from ? head - from : 0n;
    const ratio = st.complete ? 1 : span === 0n ? 0 : Number(((done > from ? done - from : 0n) * 1000n) / span) / 1000;
    return {
      addresses: st.addresses,
      progress: { ratio: Math.max(0, Math.min(1, ratio)), complete: st.complete, known: st.addresses.length, gaps: st.gaps },
    };
  }

  /**
   * Bring the index forward. Returns immediately if a run is already going.
   *
   * Deliberately not awaited by request handlers — callers read `known()` and
   * poll. Awaiting it is only for a warm-up that wants to block.
   */
  async advance(
    pub: PublicClient,
    contract: Hex,
    tag: string,
    event: AbiEvent,
    field: string,
  ): Promise<void> {
    const key = this.key(contract, tag);
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      const head = await pub.getBlockNumber();
      let st = this.state.get(key);
      if (!st) {
        const created = await findDeploymentBlock(pub, contract, head).catch(() => null);
        const from = created ?? 0n;
        st = { ...blank(), from: from.toString(), scannedTo: (from - 1n < 0n ? 0n : from - 1n).toString() };
        this.state.set(key, st);
      }
      st.head = head.toString();

      let cursor = BigInt(st.scannedTo) + 1n;
      const seen = new Set(st.addresses);
      let sinceBreath = 0;

      while (cursor <= head) {
        const to = cursor + WINDOW - 1n > head ? head : cursor + WINDOW - 1n;
        // A refused window used to be recorded straight away as a permanent hole
        // in the address set — which is what "14 block ranges could not be read"
        // was reporting. Nearly all of those are transient: the shared pacing
        // gate gets throttled, or the node declines that particular span. So
        // retry with backoff, halving the span each attempt — a smaller range is
        // cheaper for the node to serve and narrows what is lost if it still
        // fails. Only a range that fails at the smallest span is a real gap.
        let recovered = false;
        let span = to - cursor + 1n;
        for (let attempt = 0; attempt < 4 && !recovered; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
          let sub = cursor;
          let ok = true;
          while (sub <= to) {
            const subTo = sub + span - 1n > to ? to : sub + span - 1n;
            try {
              const logs = await pub.getLogs({ address: contract, event, fromBlock: sub, toBlock: subTo });
              for (const l of logs) {
                const v = (l.args as Record<string, unknown>)[field];
                if (typeof v === "string") seen.add(v.toLowerCase());
              }
            } catch {
              ok = false;
              break;
            }
            sub = subTo + 1n;
          }
          if (ok) recovered = true;
          else span = span > 1n ? span / 2n : 1n;
        }
        if (!recovered) st.gaps += 1;
        // Record progress per window so a restart resumes here, not at the start.
        st.scannedTo = to.toString();
        st.addresses = [...seen];
        this.save();
        cursor = to + 1n;

        if (++sinceBreath >= BURST && cursor <= head) {
          sinceBreath = 0;
          // Hand the pacing gate back to whatever a user is waiting on.
          await new Promise((r) => setTimeout(r, BREATH_MS));
        }
      }

      st.complete = true;
      st.head = head.toString();
      this.save();
    } finally {
      this.running.delete(key);
    }
  }

  /** Forget one contract's index, forcing a rebuild. */
  reset(contract: Hex, tag: string) {
    this.state.delete(this.key(contract, tag));
    this.save();
  }
}

/**
 * Merge freshly-indexed addresses with ones we already know about.
 *
 * The app's own wallets and the connected viewer can be read directly — no log
 * scan needed — so a table is never empty while the index builds. Exported for
 * testing because "seeded addresses must not duplicate indexed ones" is exactly
 * the kind of thing that silently double-counts a holder's share.
 */
export function mergeAddresses(indexed: readonly string[], seeds: readonly (string | undefined)[]): string[] {
  const out = new Set(indexed.map((a) => a.toLowerCase()));
  for (const s of seeds) if (s) out.add(s.toLowerCase());
  return [...out];
}
