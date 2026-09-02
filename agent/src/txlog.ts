import { writeJsonAtomic, readJson, sayCorrupt } from "./state-file.js";
import { randomUUID } from "node:crypto";

/**
 * Transaction history.
 *
 * ## What this is and is not
 * This is an **activity log**, not an accounting ledger. It records what the app
 * did and what the chain said about it, so a user can see their own history and
 * an operator can search across everyone's. Balances are never derived from it —
 * they come from the contracts — because a log that drifts from the chain and is
 * then trusted for money is exactly the failure mode worth designing out.
 *
 * ## Whose history is whose
 * Entries are attributed to the address that signed, and to nothing else.
 * Self-custody actions belong to the connected wallet; operator actions belong
 * to the agent wallet. A user querying their own history only ever sees entries
 * whose `actor` is their address, enforced server-side rather than by filtering
 * in the browser.
 */

/**
 * `nft` joined these when the launchpad did. It is its own category rather than
 * `defi` because the activity filter is how an operator answers "what has this
 * wallet been doing", and a mint is not a lending or swap action — folding it
 * into `defi` would make that filter quietly wrong about both.
 */
export type TxCategory = "defi" | "agentic" | "admin" | "nft";
export type TxStatus = "success" | "failed" | "pending" | "declined" | "approved";

export interface TxRecord {
  id: string;
  /** Signing address, lowercased. "operator" for admin-session actions with no wallet. */
  actor: string;
  category: TxCategory;
  /** Verb: supply, withdraw, borrow, repay, swap, deposit, add-liquidity, settle… */
  action: string;
  status: TxStatus;
  /** Human-readable amount + unit, e.g. "12.50 USDC". Display only. */
  amount?: string;
  /** Raw integer amount and its asset, for value filtering and sorting. */
  valueRaw?: string;
  valueUsd?: number;
  asset?: string;
  txHash?: string;
  /** Short explanation — the failure reason, the counterparty, the pool name. */
  detail?: string;
  at: number;
}

export interface TxFilter {
  actor?: string;
  /** Restrict to a single actor regardless of what the caller asked for. */
  forceActor?: string;
  category?: TxCategory | "all";
  status?: TxStatus | "all";
  action?: string;
  asset?: string;
  from?: number;
  to?: number;
  minUsd?: number;
  maxUsd?: number;
  /** Free-text across action, detail, asset and tx hash. */
  q?: string;
  limit?: number;
  offset?: number;
  sort?: "newest" | "oldest" | "largest" | "smallest";
}

export const TX_LIMITS = { maxStored: 5_000, maxPage: 200, maxDetail: 200 };

const lower = (s: unknown) => String(s ?? "").toLowerCase();

export class TxLog {
  private rows: TxRecord[] = [];

  constructor(private readonly file: string) {
    const { value: raw, outcome } = readJson<unknown>(file, null);
    if (outcome === "corrupt") sayCorrupt("txlog", file);
    if (Array.isArray(raw)) this.rows = raw.filter((r) => r && typeof r.id === "string");
  }

  private persist() {
    try {
      writeJsonAtomic(this.file, this.rows);
    } catch (e) {
      console.error(`[txlog] could not persist: ${String(e).slice(0, 120)}`);
    }
  }

  record(input: Omit<TxRecord, "id" | "at"> & { at?: number }): TxRecord {
    const row: TxRecord = {
      id: randomUUID(),
      actor: lower(input.actor) || "operator",
      category: input.category,
      action: String(input.action ?? "").slice(0, 40),
      status: input.status,
      amount: input.amount ? String(input.amount).slice(0, 40) : undefined,
      valueRaw: input.valueRaw ? String(input.valueRaw) : undefined,
      valueUsd: Number.isFinite(input.valueUsd as number) ? (input.valueUsd as number) : undefined,
      asset: input.asset ? String(input.asset).slice(0, 20) : undefined,
      // A hash arriving from a wallet is untrusted input; only store a real one.
      txHash: /^0x[0-9a-fA-F]{64}$/.test(String(input.txHash ?? "")) ? String(input.txHash) : undefined,
      detail: input.detail ? String(input.detail).slice(0, TX_LIMITS.maxDetail) : undefined,
      at: Number(input.at ?? Date.now()),
    };
    this.rows.unshift(row);
    if (this.rows.length > TX_LIMITS.maxStored) this.rows.length = TX_LIMITS.maxStored;
    this.persist();
    return row;
  }

  /** Update a pending entry once the chain answers. */
  settle(id: string, status: TxStatus, patch: Partial<Pick<TxRecord, "txHash" | "detail">> = {}): boolean {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return false;
    row.status = status;
    if (patch.txHash && /^0x[0-9a-fA-F]{64}$/.test(patch.txHash)) row.txHash = patch.txHash;
    if (patch.detail) row.detail = patch.detail.slice(0, TX_LIMITS.maxDetail);
    this.persist();
    return true;
  }

  /**
   * Query with filters. `forceActor` is applied last and cannot be overridden,
   * which is what keeps a non-operator from reading someone else's history by
   * passing a different `actor` in the query string.
   */
  query(f: TxFilter): { rows: TxRecord[]; total: number } {
    const q = lower(f.q).trim();
    let out = this.rows.filter((r) => {
      if (f.forceActor && r.actor !== lower(f.forceActor)) return false;
      if (!f.forceActor && f.actor && f.actor !== "all" && r.actor !== lower(f.actor)) return false;
      if (f.category && f.category !== "all" && r.category !== f.category) return false;
      if (f.status && f.status !== "all" && r.status !== f.status) return false;
      if (f.action && f.action !== "all" && r.action !== f.action) return false;
      if (f.asset && f.asset !== "all" && lower(r.asset) !== lower(f.asset)) return false;
      if (f.from !== undefined && r.at < f.from) return false;
      if (f.to !== undefined && r.at > f.to) return false;
      if (f.minUsd !== undefined && !(Number(r.valueUsd ?? 0) >= f.minUsd)) return false;
      if (f.maxUsd !== undefined && !(Number(r.valueUsd ?? 0) <= f.maxUsd)) return false;
      if (q) {
        const hay = [r.action, r.detail, r.asset, r.txHash, r.actor, r.amount].map(lower).join(" ");
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const total = out.length;
    const by = f.sort ?? "newest";
    out =
      by === "oldest" ? out.slice().sort((a, b) => a.at - b.at)
      : by === "largest" ? out.slice().sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
      : by === "smallest" ? out.slice().sort((a, b) => (a.valueUsd ?? 0) - (b.valueUsd ?? 0))
      : out.slice().sort((a, b) => b.at - a.at);

    const limit = Math.min(Math.max(1, Number(f.limit ?? 50)), TX_LIMITS.maxPage);
    const offset = Math.max(0, Number(f.offset ?? 0));
    return { rows: out.slice(offset, offset + limit), total };
  }

  /** Distinct values for the filter dropdowns, from what is actually stored. */
  facets(forceActor?: string) {
    const rows = forceActor ? this.rows.filter((r) => r.actor === lower(forceActor)) : this.rows;
    const uniq = (pick: (r: TxRecord) => string | undefined) =>
      [...new Set(rows.map(pick).filter((v): v is string => !!v))].sort();
    return {
      actors: forceActor ? [] : uniq((r) => r.actor),
      actions: uniq((r) => r.action),
      assets: uniq((r) => r.asset),
      categories: uniq((r) => r.category),
      statuses: uniq((r) => r.status),
      total: rows.length,
    };
  }

  /** Totals for the header of the history window. */
  summary(f: TxFilter) {
    const { rows } = this.query({ ...f, limit: TX_LIMITS.maxPage, offset: 0 });
    const all = this.query({ ...f, limit: TX_LIMITS.maxStored, offset: 0 }).rows;
    const count = (s: TxStatus) => all.filter((r) => r.status === s).length;
    return {
      shown: rows.length,
      total: all.length,
      success: count("success"),
      failed: count("failed"),
      pending: count("pending"),
      declined: count("declined"),
      approved: count("approved"),
      volumeUsd: all.reduce((n, r) => n + (r.valueUsd ?? 0), 0),
      defi: all.filter((r) => r.category === "defi").length,
      agentic: all.filter((r) => r.category === "agentic").length,
      admin: all.filter((r) => r.category === "admin").length,
    };
  }

  all(): TxRecord[] {
    return [...this.rows];
  }

  remove(ids: string[]): number {
    const set = new Set(ids);
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !set.has(r.id));
    if (this.rows.length !== before) this.persist();
    return before - this.rows.length;
  }
}

/** CSV for the export button. Quoted so a comma in a detail can't shift columns. */
export function toCsv(rows: TxRecord[]): string {
  const head = ["time", "actor", "category", "action", "status", "amount", "asset", "valueUsd", "txHash", "detail"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [
    head.join(","),
    ...rows.map((r) =>
      [
        new Date(r.at).toISOString(),
        r.actor,
        r.category,
        r.action,
        r.status,
        r.amount ?? "",
        r.asset ?? "",
        r.valueUsd ?? "",
        r.txHash ?? "",
        r.detail ?? "",
      ]
        .map(esc)
        .join(","),
    ),
  ].join("\n");
}
