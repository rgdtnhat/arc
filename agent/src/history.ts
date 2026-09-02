import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * Archive of retired pool / vault / swap / collector contracts, and the user
 * balances they still hold.
 *
 * ## Why the record is an index, not the ledger
 * It would be simpler to treat this file as the authority on who is owed what.
 * It would also be wrong. A JSON file drifts from the chain — a withdrawal that
 * lands after a snapshot, a partial migration, a restore from an old backup —
 * and it drifts on exactly the numbers you would use to give people their money
 * back. So a record here is a **worklist**: it names the contract and the
 * holders, and every figure in it is a snapshot with a timestamp attached.
 * Before anything is paid out or migrated, balances are re-read from the old
 * contract and *that* number is used. `stale` marks a record whose snapshot has
 * not been refreshed since it was taken.
 *
 * ## What migration actually does
 * There is no function in any of these contracts that lets an operator move a
 * user's position — that primitive is a rug pull with better branding. A
 * migration therefore *pays in on the user's behalf* via `supplyFor` /
 * `depositFor` / `addLiquidityFor`, out of the operator's own funds. The user's
 * claim on the old contract is untouched by that, which is the honest outcome:
 * they end up able to withdraw from either.
 */
/**
 * `swap` is the retired inventory desk. It stays in the union so archives
 * recorded before the desk was removed still load and can still be settled —
 * dropping it would make those records unreadable, which is the opposite of
 * what an archive is for. New archives use `router`.
 */
export type ArchiveKind = "pool" | "vault" | "swap" | "router" | "collector" | "amm";

export interface HolderBalance {
  /** Holder address, lowercased. */
  address: string;
  /**
   * Per-asset balances, raw integer strings keyed by lowercased token address.
   * A vault reports its share balance under the vault's asset.
   */
  balances: Record<string, string>;
  /** Vault/AMM share count, when the position is share-based. */
  shares?: string;
  /** Set once funds have been returned or migrated for this holder. */
  settled?: { at: number; method: "returned" | "migrated"; txHash?: string; note?: string };
}

export interface ArchiveRecord {
  id: string;
  kind: ArchiveKind;
  /** The retired contract. */
  address: string;
  label: string;
  /** Assets the contract dealt in, lowercased addresses → symbol/decimals. */
  assets: { address: string; symbol: string; decimals: number }[];
  holders: HolderBalance[];
  /** When the balances above were last read from chain. */
  snapshotAt: number;
  /** Block the snapshot was taken at, so a refresh can be reasoned about. */
  snapshotBlock?: string;
  createdAt: number;
  note: string;
  /** Set when this record's contract is the one the app is currently using. */
  active?: boolean;
}

const lower = (s: string) => String(s || "").toLowerCase();
const isAddress = (s: unknown) => /^0x[0-9a-fA-F]{40}$/.test(String(s ?? ""));

/** Sum a holder's balances per asset across a list of holders. */
export function totalsOf(holders: HolderBalance[]): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const h of holders) {
    for (const [asset, raw] of Object.entries(h.balances || {})) {
      let v = 0n;
      try { v = BigInt(raw); } catch { v = 0n; }
      out[asset] = (out[asset] ?? 0n) + v;
    }
  }
  return out;
}

/** Merge holder lists, summing per-asset balances for addresses that repeat. */
export function mergeHolders(lists: HolderBalance[][]): HolderBalance[] {
  const byAddress = new Map<string, HolderBalance>();
  for (const list of lists) {
    for (const h of list) {
      const key = lower(h.address);
      const cur = byAddress.get(key);
      if (!cur) {
        byAddress.set(key, {
          address: key,
          balances: { ...h.balances },
          ...(h.shares ? { shares: h.shares } : {}),
          ...(h.settled ? { settled: h.settled } : {}),
        });
        continue;
      }
      for (const [asset, raw] of Object.entries(h.balances || {})) {
        const a = BigInt(cur.balances[asset] ?? "0");
        let b = 0n;
        try { b = BigInt(raw); } catch { b = 0n; }
        cur.balances[asset] = (a + b).toString();
      }
      if (h.shares) cur.shares = (BigInt(cur.shares ?? "0") + BigInt(h.shares)).toString();
      // A holder is only settled if they were settled everywhere; otherwise the
      // merged record must still show work outstanding.
      if (!h.settled) delete cur.settled;
    }
  }
  return [...byAddress.values()];
}

export interface ArchiveInput {
  kind: ArchiveKind;
  address: string;
  label?: string;
  note?: string;
  assets?: { address: string; symbol: string; decimals: number }[];
  holders?: HolderBalance[];
  snapshotAt?: number;
  snapshotBlock?: string;
  active?: boolean;
}

export const ARCHIVE_LIMITS = { maxRecords: 100, maxHolders: 5_000, maxLabel: 60, maxNote: 280 };

export class ArchiveStore {
  private records: ArchiveRecord[] = [];

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(raw)) this.records = raw.filter((r) => r && typeof r.id === "string");
    } catch {
      /* first run */
    }
  }

  private persist() {
    try {
      writeFileSync(this.file, JSON.stringify(this.records, null, 2) + "\n");
    } catch (e) {
      console.error(`[history] could not persist: ${String(e).slice(0, 120)}`);
    }
  }

  private normaliseHolders(holders: HolderBalance[] | undefined): HolderBalance[] {
    return (holders ?? [])
      .filter((h) => isAddress(h.address))
      .slice(0, ARCHIVE_LIMITS.maxHolders)
      .map((h) => ({
        address: lower(h.address),
        balances: Object.fromEntries(
          Object.entries(h.balances ?? {})
            .filter(([k]) => isAddress(k))
            .map(([k, v]) => [lower(k), String(v ?? "0")]),
        ),
        ...(h.shares ? { shares: String(h.shares) } : {}),
        ...(h.settled ? { settled: h.settled } : {}),
      }));
  }

  add(input: ArchiveInput): { ok: true; record: ArchiveRecord } | { ok: false; error: string } {
    if (!isAddress(input.address)) return { ok: false, error: "That doesn't look like a contract address." };
    const kinds: ArchiveKind[] = ["pool", "vault", "swap", "router", "collector", "amm"];
    if (!kinds.includes(input.kind)) return { ok: false, error: "Unknown contract kind." };
    // Recording the same contract twice would give two half-truths about one
    // set of balances, and settling one would leave the other looking unpaid.
    if (this.records.some((r) => r.kind === input.kind && lower(r.address) === lower(input.address))) {
      return { ok: false, error: "That contract is already in the history." };
    }
    const rec: ArchiveRecord = {
      id: randomUUID(),
      kind: input.kind,
      address: lower(input.address),
      label: String(input.label ?? "").slice(0, ARCHIVE_LIMITS.maxLabel) || `${input.kind} ${input.address.slice(0, 8)}…`,
      assets: (input.assets ?? [])
        .filter((a) => isAddress(a.address))
        .map((a) => ({ address: lower(a.address), symbol: String(a.symbol ?? ""), decimals: Number(a.decimals ?? 6) })),
      holders: this.normaliseHolders(input.holders),
      snapshotAt: Number(input.snapshotAt ?? Date.now()),
      snapshotBlock: input.snapshotBlock,
      createdAt: Date.now(),
      note: String(input.note ?? "").slice(0, ARCHIVE_LIMITS.maxNote),
      active: !!input.active,
    };
    this.records.unshift(rec);
    if (this.records.length > ARCHIVE_LIMITS.maxRecords) this.records.length = ARCHIVE_LIMITS.maxRecords;
    this.persist();
    return { ok: true, record: rec };
  }

  get(id: string): ArchiveRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  all(): ArchiveRecord[] {
    return [...this.records];
  }

  /** Replace a record's holder snapshot with freshly read balances. */
  refresh(id: string, holders: HolderBalance[], block?: string): { ok: boolean; error?: string } {
    const r = this.get(id);
    if (!r) return { ok: false, error: "No such record." };
    // Settlement marks are the operator's own bookkeeping and must survive a
    // re-read, or a refresh would silently re-open work that was already done.
    const settledBy = new Map(r.holders.filter((h) => h.settled).map((h) => [h.address, h.settled!]));
    r.holders = this.normaliseHolders(holders).map((h) =>
      settledBy.has(h.address) ? { ...h, settled: settledBy.get(h.address) } : h,
    );
    r.snapshotAt = Date.now();
    if (block) r.snapshotBlock = block;
    this.persist();
    return { ok: true };
  }

  /** Mark holders as paid out or migrated. */
  markSettled(
    id: string,
    addresses: string[],
    method: "returned" | "migrated",
    txHash?: string,
    note?: string,
  ): { ok: boolean; marked: number; error?: string } {
    const r = this.get(id);
    if (!r) return { ok: false, marked: 0, error: "No such record." };
    const want = new Set(addresses.map(lower));
    let marked = 0;
    for (const h of r.holders) {
      if (!want.has(h.address)) continue;
      h.settled = { at: Date.now(), method, txHash, note };
      marked++;
    }
    if (marked) this.persist();
    return { ok: true, marked };
  }

  update(id: string, patch: { label?: string; note?: string; active?: boolean }): { ok: boolean; error?: string } {
    const r = this.get(id);
    if (!r) return { ok: false, error: "No such record." };
    if (patch.label !== undefined) r.label = String(patch.label).slice(0, ARCHIVE_LIMITS.maxLabel);
    if (patch.note !== undefined) r.note = String(patch.note).slice(0, ARCHIVE_LIMITS.maxNote);
    if (patch.active !== undefined) r.active = !!patch.active;
    this.persist();
    return { ok: true };
  }

  remove(ids: string[]): number {
    const set = new Set(ids);
    const before = this.records.length;
    this.records = this.records.filter((r) => !set.has(r.id));
    if (this.records.length !== before) this.persist();
    return before - this.records.length;
  }

  clear(): number {
    const n = this.records.length;
    this.records = [];
    this.persist();
    return n;
  }

  /**
   * Merge several records of the same kind into one, summing each holder's
   * balances. The sources are removed; the merged record keeps the newest
   * snapshot time, because a merged figure is only as fresh as its oldest part —
   * and the oldest part is what would mislead you.
   */
  merge(ids: string[], label?: string): { ok: true; record: ArchiveRecord } | { ok: false; error: string } {
    const parts = ids.map((id) => this.get(id)).filter((r): r is ArchiveRecord => !!r);
    if (parts.length < 2) return { ok: false, error: "Pick at least two records to merge." };
    const kind = parts[0].kind;
    if (parts.some((p) => p.kind !== kind)) {
      return { ok: false, error: "Only records of the same kind can be merged." };
    }
    const assets = new Map<string, { address: string; symbol: string; decimals: number }>();
    for (const p of parts) for (const a of p.assets) assets.set(a.address, a);
    const merged: ArchiveRecord = {
      id: randomUUID(),
      kind,
      // Keep the newest contract address as the record's identity; the others
      // are named in the note so nothing about the merge is lost.
      address: parts[0].address,
      label: String(label ?? `Merged ${kind} × ${parts.length}`).slice(0, ARCHIVE_LIMITS.maxLabel),
      assets: [...assets.values()],
      holders: mergeHolders(parts.map((p) => p.holders)),
      snapshotAt: Math.min(...parts.map((p) => p.snapshotAt)),
      createdAt: Date.now(),
      note: `Merged from: ${parts.map((p) => `${p.label} (${p.address})`).join("; ")}`.slice(0, ARCHIVE_LIMITS.maxNote),
      active: false,
    };
    this.records = this.records.filter((r) => !ids.includes(r.id));
    this.records.unshift(merged);
    this.persist();
    return { ok: true, record: merged };
  }

  /**
   * Split a record: the named holders move to a new record, the rest stay.
   * Balances are moved whole — splitting a *partial* balance is done by editing
   * the amounts on the new record afterwards, which keeps this operation
   * arithmetic-free and therefore incapable of losing a rounding wei.
   */
  split(
    id: string,
    addresses: string[],
    label?: string,
  ): { ok: true; record: ArchiveRecord } | { ok: false; error: string } {
    const src = this.get(id);
    if (!src) return { ok: false, error: "No such record." };
    const want = new Set(addresses.map(lower));
    const moving = src.holders.filter((h) => want.has(h.address));
    if (!moving.length) return { ok: false, error: "None of those holders are in this record." };
    if (moving.length === src.holders.length) {
      return { ok: false, error: "That would move every holder — nothing would be left to split from." };
    }
    const out: ArchiveRecord = {
      id: randomUUID(),
      kind: src.kind,
      address: src.address,
      label: String(label ?? `${src.label} (split)`).slice(0, ARCHIVE_LIMITS.maxLabel),
      assets: [...src.assets],
      holders: moving,
      snapshotAt: src.snapshotAt,
      snapshotBlock: src.snapshotBlock,
      createdAt: Date.now(),
      note: `Split from ${src.label} (${src.address})`.slice(0, ARCHIVE_LIMITS.maxNote),
      active: false,
    };
    src.holders = src.holders.filter((h) => !want.has(h.address));
    this.records.unshift(out);
    this.persist();
    return { ok: true, record: out };
  }

  /**
   * Swap which record is flagged active. Purely a bookkeeping flag: it records
   * that the operator has repointed the app at this contract, and does not by
   * itself change any deployment.
   */
  setActive(id: string): { ok: boolean; error?: string } {
    const r = this.get(id);
    if (!r) return { ok: false, error: "No such record." };
    for (const other of this.records) if (other.kind === r.kind) other.active = other.id === id;
    this.persist();
    return { ok: true };
  }

  /** A record plus derived figures the UI needs, without recomputing in three places. */
  summary(r: ArchiveRecord, staleAfterMs = 15 * 60_000) {
    const outstanding = r.holders.filter((h) => !h.settled);
    return {
      ...r,
      holderCount: r.holders.length,
      outstandingCount: outstanding.length,
      settledCount: r.holders.length - outstanding.length,
      totals: Object.fromEntries(Object.entries(totalsOf(outstanding)).map(([k, v]) => [k, v.toString()])),
      // A snapshot that hasn't been refreshed recently must be flagged: acting
      // on stale balances is exactly how people get paid the wrong amount.
      stale: Date.now() - r.snapshotAt > staleAfterMs,
    };
  }
}
