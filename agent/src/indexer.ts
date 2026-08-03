import { DatabaseSync } from "node:sqlite";
import type { Hex, PublicClient, Abi } from "viem";

/**
 * A local index of what has happened on chain.
 *
 * Every read in the app was on-demand: an HTTP request arrives, the process
 * queries the RPC, answers, and forgets. That works for "what is the balance
 * now" and not at all for "what did this provider earn last week" or "show me
 * every dispute" — those need history, and reconstructing history from logs at
 * request time is a scan the RPC may simply refuse. On a node that prunes, the
 * answer does not exist to be fetched.
 *
 * So this tails the chain once and keeps what it sees.
 *
 * ## What it is not
 * Not a source of truth. The chain is. Everything here is a cache of events
 * already emitted, and anything that moves money still reads the contracts
 * directly — an indexer that a balance check depended on would turn a lagging
 * tail into a wrong answer rather than a stale one.
 *
 * ## Restartable by construction
 * Progress is stored alongside the rows, so a restart resumes from the last
 * block it finished rather than from the deployment. Writes are idempotent on
 * `(txHash, logIndex)`, so re-scanning a range — which happens after any
 * unclean shutdown — cannot double-count. That pair is the natural key of a log
 * and the only thing that stays stable across a reorg replay.
 */

export interface IndexedEvent {
  blockNumber: number;
  blockTime: number;
  txHash: string;
  logIndex: number;
  contract: string;
  name: string;
  /** Indexed participants, lower-cased, so a query can find "anything involving X". */
  actors: string[];
  /** The decoded args, JSON. Numbers are strings — these are bigints on chain. */
  args: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  txHash      TEXT NOT NULL,
  logIndex    INTEGER NOT NULL,
  blockNumber INTEGER NOT NULL,
  blockTime   INTEGER NOT NULL,
  contract    TEXT NOT NULL,
  name        TEXT NOT NULL,
  actors      TEXT NOT NULL,
  args        TEXT NOT NULL,
  PRIMARY KEY (txHash, logIndex)
);
CREATE INDEX IF NOT EXISTS idx_events_block ON events(blockNumber);
CREATE INDEX IF NOT EXISTS idx_events_name  ON events(name);
CREATE TABLE IF NOT EXISTS progress (
  key       TEXT PRIMARY KEY,
  lastBlock INTEGER NOT NULL
);
`;

export class EventIndex {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  /**
   * @dev `INSERT OR IGNORE` rather than a check-then-write. Re-scanning a range
   *      is normal — it is what happens after any unclean stop — and the log's
   *      own identity is what makes replaying it harmless.
   */
  put(e: IndexedEvent) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events
         (txHash, logIndex, blockNumber, blockTime, contract, name, actors, args)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.txHash,
        e.logIndex,
        e.blockNumber,
        e.blockTime,
        e.contract.toLowerCase(),
        e.name,
        e.actors.map((a) => a.toLowerCase()).join(","),
        JSON.stringify(e.args),
      );
  }

  putMany(events: IndexedEvent[]) {
    // One transaction for a batch: a partial write followed by a crash would
    // leave progress ahead of the rows it claims to have stored.
    this.db.exec("BEGIN");
    try {
      for (const e of events) this.put(e);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  lastBlock(key = "default"): number {
    const row = this.db.prepare("SELECT lastBlock FROM progress WHERE key = ?").get(key) as
      | { lastBlock: number }
      | undefined;
    return row?.lastBlock ?? 0;
  }

  setLastBlock(n: number, key = "default") {
    this.db
      .prepare("INSERT INTO progress (key, lastBlock) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET lastBlock = ?")
      .run(key, n, n);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  }

  /**
   * Query the index.
   *
   * `actor` matches an address appearing anywhere in the event's participants,
   * which is what makes "everything involving this provider" a single question
   * rather than one query per event type.
   */
  query(opts: {
    actor?: string;
    name?: string;
    contract?: string;
    since?: number;
    limit?: number;
  } = {}): IndexedEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.name) { where.push("name = ?"); params.push(opts.name); }
    if (opts.contract) { where.push("contract = ?"); params.push(opts.contract.toLowerCase()); }
    if (opts.since !== undefined) { where.push("blockTime >= ?"); params.push(opts.since); }
    if (opts.actor) {
      // Comma-delimited with sentinels either side, so matching "0xab" cannot
      // hit an address that merely starts with it.
      where.push("(',' || actors || ',') LIKE ?");
      params.push(`%,${opts.actor.toLowerCase()},%`);
    }
    const sql =
      `SELECT * FROM events${where.length ? " WHERE " + where.join(" AND ") : ""}` +
      ` ORDER BY blockNumber DESC, logIndex DESC LIMIT ?`;
    params.push(Math.min(opts.limit ?? 100, 1000));

    return (this.db.prepare(sql).all(...(params as never[])) as any[]).map((r) => ({
      blockNumber: r.blockNumber,
      blockTime: r.blockTime,
      txHash: r.txHash,
      logIndex: r.logIndex,
      contract: r.contract,
      name: r.name,
      actors: r.actors ? String(r.actors).split(",").filter(Boolean) : [],
      args: JSON.parse(r.args),
    }));
  }

  /** How many of each event type, for a summary pane. */
  tally(since?: number): { name: string; n: number }[] {
    const sql = since
      ? "SELECT name, COUNT(*) AS n FROM events WHERE blockTime >= ? GROUP BY name ORDER BY n DESC"
      : "SELECT name, COUNT(*) AS n FROM events GROUP BY name ORDER BY n DESC";
    const rows = since
      ? (this.db.prepare(sql).all(since) as any[])
      : (this.db.prepare(sql).all() as any[]);
    return rows.map((r) => ({ name: r.name, n: r.n }));
  }
}

/** Addresses out of a decoded log's args — whatever the event happens to call them. */
export function actorsOf(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of Object.values(args)) {
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) out.push(v.toLowerCase());
  }
  return [...new Set(out)];
}

/** bigints are not JSON. Stringify rather than lose precision to a double. */
export function jsonSafe(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}

/**
 * How far to scan next, given where we are and where the chain is.
 *
 * Kept pure and separate because the interesting failures are here rather than
 * in the RPC call: a window that outruns the head asks for blocks that do not
 * exist, and one that never advances silently stops indexing.
 */
export function nextRange(
  lastIndexed: number,
  head: number,
  maxSpan = 2_000,
  confirmations = 1,
): { from: number; to: number } | null {
  // Stay a little behind the tip. The last block is the one most likely to be
  // replaced, and re-indexing it later costs a rescan rather than a wrong row.
  const safeHead = head - confirmations;
  if (safeHead <= lastIndexed) return null;
  const from = lastIndexed + 1;
  const to = Math.min(safeHead, from + maxSpan - 1);
  return { from, to };
}

/**
 * Pull one window of logs into the index and record the progress.
 *
 * Progress is written only after the rows are committed, so a crash between the
 * two re-scans a window rather than skipping it.
 */
export async function indexOnce(args: {
  client: PublicClient;
  index: EventIndex;
  contracts: { address: Hex; abi: Abi; label: string }[];
  maxSpan?: number;
  confirmations?: number;
}): Promise<{ scanned: number; stored: number; from: number; to: number } | null> {
  const head = Number(await args.client.getBlockNumber());
  const range = nextRange(args.index.lastBlock(), head, args.maxSpan, args.confirmations);
  if (!range) return null;

  const times = new Map<number, number>();
  const batch: IndexedEvent[] = [];

  for (const c of args.contracts) {
    const logs = await args.client.getLogs({
      address: c.address,
      fromBlock: BigInt(range.from),
      toBlock: BigInt(range.to),
    });
    for (const log of logs as any[]) {
      let decoded: { eventName?: string; args?: Record<string, unknown> } = {};
      try {
        const { decodeEventLog } = await import("viem");
        decoded = decodeEventLog({ abi: c.abi, data: log.data, topics: log.topics }) as never;
      } catch {
        // An event this ABI does not describe. Skipping is right: the point is a
        // readable history, and an undecodable blob is not one.
        continue;
      }
      const bn = Number(log.blockNumber);
      if (!times.has(bn)) {
        const b = await args.client.getBlock({ blockNumber: log.blockNumber });
        times.set(bn, Number(b.timestamp));
      }
      const a = jsonSafe(decoded.args ?? {});
      batch.push({
        blockNumber: bn,
        blockTime: times.get(bn)!,
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex),
        contract: c.address,
        name: decoded.eventName ?? "unknown",
        actors: actorsOf(a),
        args: a,
      });
    }
  }

  args.index.putMany(batch);
  args.index.setLastBlock(range.to);
  return { scanned: range.to - range.from + 1, stored: batch.length, from: range.from, to: range.to };
}
