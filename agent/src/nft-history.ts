import type { Hex, PublicClient } from "viem";

/**
 * When each NFT was minted, and when its current owner got it.
 *
 * The launchpad is a minimal ERC-721: `ownerOf` says who holds a token *now*
 * and nothing at all says when that started. A gallery that can only sort by
 * token id is sorting by "the order the contract happened to number things",
 * which is not a question anybody asks — "what did I get most recently" is.
 *
 * Those dates exist in exactly one place: the `Transfer` logs. So this tails
 * them, folds them into a small record, and keeps it.
 *
 * ## Why not the event index
 * `EventIndex` already tails contracts, but on a single shared progress cursor
 * seeded from the *earliest* contract's creation block. Adding a contract
 * deployed months later to that list indexes it from wherever the cursor
 * happens to be — which on a caught-up host is the head, so every event it has
 * already emitted is missed, silently and permanently. Getting that right means
 * per-contract cursors and a rescan path, and this needs one contract and one
 * event. A separate cursor is the smaller, more honest thing.
 *
 * ## Trust
 * Not a source of truth about ownership. `ownerOf` is, and the gallery still
 * reads it — this only answers "when". A history that lagged would otherwise
 * show a token you have sold.
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** ERC-721 `Transfer(address indexed,address indexed,uint256 indexed)`. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface TokenHistory {
  /** Block time of the mint, or 0 if the mint was never seen. */
  mintedAt: number;
  mintedBlock: number;
  /** Block time of the most recent transfer — when the current holder got it. */
  receivedAt: number;
  /** Who held it as of `lastBlock`, lower-cased. */
  owner: string;
  /**
   * Where the transfer that produced this record sat: block number, then log
   * index within it.
   *
   * This is what makes a re-fold a no-op. Re-scanning a window is normal — it
   * is what happens after any unclean stop — and without a position to compare
   * against, folding the same transfer twice shifts the current holder into
   * `prevOwner` and invents a hop that never happened. The log's own position
   * is the only identity that stays stable across a replay.
   */
  at: number;
  atLog: number;
  /**
   * The holder before that, and when *they* got it.
   *
   * Kept for one reason, and it is not history for its own sake: listing a
   * token moves it into the market contract, so the last transfer of a token
   * on sale is "seller → market" and its `receivedAt` is the moment it was
   * listed. The gallery shows that token under the seller, where "Received
   * today" would be an answer about the market's day rather than theirs. One
   * hop back is exactly the escrow hop, and enough.
   */
  prevOwner: string;
  prevReceivedAt: number;
}

export interface NftHistoryState {
  /** The shape of the records below. See `HISTORY_VERSION`. */
  version: number;
  /** The last block folded in. Scanning resumes from the next one. */
  lastBlock: number;
  /** Keyed by decimal token id. */
  tokens: Record<string, TokenHistory>;
}

/**
 * Bump this whenever `TokenHistory` gains or changes a field.
 *
 * A cursor makes stale records permanent: the scan resumes from `lastBlock`, so
 * the transfers that would have filled a new field are behind it and never read
 * again. That is not theoretical — `prevOwner` was added and every token
 * already in the file kept reporting the listing date as the seller's, with no
 * sign anything was wrong. A version mismatch throws the file away and rescans,
 * which costs a handful of `eth_getLogs` and is the only answer that converges.
 */
export const HISTORY_VERSION = 1;

export const EMPTY_HISTORY: NftHistoryState = { version: HISTORY_VERSION, lastBlock: 0, tokens: {} };

/** Read a stored record, or start again if it was written by an older shape. */
export function loadHistory(raw: unknown): { state: NftHistoryState; reset: boolean } {
  const d = raw as Partial<NftHistoryState> | null;
  if (!d || typeof d !== "object" || d.version !== HISTORY_VERSION || typeof d.lastBlock !== "number") {
    return { state: { ...EMPTY_HISTORY, tokens: {} }, reset: Boolean(d && Object.keys(d).length) };
  }
  return { state: { version: HISTORY_VERSION, lastBlock: d.lastBlock, tokens: d.tokens ?? {} }, reset: false };
}

export interface TransferRecord {
  tokenId: string;
  from: string;
  to: string;
  blockNumber: number;
  logIndex: number;
  blockTime: number;
}

/**
 * Fold transfers into the state. Pure, so the ordering rules are testable.
 *
 * Sorted by `(blockNumber, logIndex)` before folding, because two transfers of
 * the same token in one block are ordinary — a mint and an immediate list, for
 * instance — and folding them out of order records the wrong owner and the
 * wrong date. Log order within a block is the chain's own ordering and the only
 * correct one.
 *
 * A mint keeps the *first* one it sees. Tokens are not re-minted, but a rescan
 * of an already-folded window is normal after an unclean stop, and the whole
 * point of storing `mintedAt` is that it does not move.
 */
export function applyTransfers(state: NftHistoryState, transfers: TransferRecord[]): NftHistoryState {
  const tokens: Record<string, TokenHistory> = { ...state.tokens };
  const ordered = [...transfers].sort((a, b) =>
    a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  for (const t of ordered) {
    const prev = tokens[t.tokenId];
    // Already folded. Not an error and not worth a warning: a rescan is the
    // normal path back from an unclean stop.
    if (prev && (t.blockNumber < prev.at || (t.blockNumber === prev.at && t.logIndex <= prev.atLog))) {
      continue;
    }
    const minted = t.from.toLowerCase() === ZERO_ADDRESS;
    tokens[t.tokenId] = {
      mintedAt: prev?.mintedAt || (minted ? t.blockTime : 0),
      mintedBlock: prev?.mintedBlock || (minted ? t.blockNumber : 0),
      receivedAt: t.blockTime,
      owner: t.to.toLowerCase(),
      at: t.blockNumber,
      atLog: t.logIndex,
      prevOwner: prev?.owner ?? "",
      prevReceivedAt: prev?.receivedAt ?? 0,
    };
  }
  const highest = ordered.length ? ordered[ordered.length - 1]!.blockNumber : state.lastBlock;
  return { version: HISTORY_VERSION, lastBlock: Math.max(state.lastBlock, highest), tokens };
}

/**
 * The next window to ask for, or null when there is nothing new.
 *
 * Kept separate from the fetching because this is where the interesting
 * mistakes live: a window that outruns the head asks for blocks that do not
 * exist, and one that never advances stops the scan without saying so.
 *
 * `confirmations` holds back from the very tip, whose block is the one most
 * likely to be replaced — re-scanning costs a window, a wrong `receivedAt`
 * costs a date nobody can explain.
 */
export function nextWindow(
  lastBlock: number,
  head: number,
  span: number,
  confirmations = 1,
): { from: number; to: number } | null {
  const safeHead = head - confirmations;
  if (safeHead <= lastBlock) return null;
  const from = lastBlock + 1;
  return { from, to: Math.min(safeHead, from + span - 1) };
}

/**
 * Advance the history by up to `windows` windows.
 *
 * Bounded per call so a host that is a week behind catches up over several
 * ticks instead of holding one request open through a hundred `eth_getLogs`.
 * Progress is only ever the block a window actually finished, so a throw
 * half-way re-scans rather than skips.
 */
export async function scanNftHistory(args: {
  client: PublicClient;
  address: Hex;
  state: NftHistoryState;
  /** Where to start when the state is empty — the contract's creation block. */
  startBlock: number;
  span?: number;
  windows?: number;
  confirmations?: number;
}): Promise<{ state: NftHistoryState; scanned: number; found: number; caughtUp: boolean }> {
  const span = Math.max(1, args.span ?? 20_000);
  const budget = Math.max(1, args.windows ?? 3);
  const confirmations = args.confirmations ?? 1;

  let state = args.state.lastBlock > 0
    ? args.state
    : { ...args.state, lastBlock: Math.max(0, args.startBlock - 1) };

  const head = Number(await args.client.getBlockNumber());
  const times = new Map<number, number>();
  let scanned = 0;
  let found = 0;

  for (let i = 0; i < budget; i++) {
    const w = nextWindow(state.lastBlock, head, span, confirmations);
    if (!w) return { state, scanned, found, caughtUp: true };
    const logs = await args.client.getLogs({
      address: args.address,
      fromBlock: BigInt(w.from),
      toBlock: BigInt(w.to),
    });
    const transfers: TransferRecord[] = [];
    for (const log of logs as unknown as {
      topics: string[]; blockNumber: bigint; logIndex: number;
    }[]) {
      // Topic-matched rather than ABI-decoded: three indexed parameters means
      // the whole event is in the topics, so there is nothing to decode and no
      // ABI to keep in step.
      if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 4) continue;
      const bn = Number(log.blockNumber);
      if (!times.has(bn)) {
        const b = await args.client.getBlock({ blockNumber: log.blockNumber });
        times.set(bn, Number(b.timestamp));
      }
      transfers.push({
        from: "0x" + log.topics[1]!.slice(26),
        to: "0x" + log.topics[2]!.slice(26),
        tokenId: BigInt(log.topics[3]!).toString(),
        blockNumber: bn,
        logIndex: Number(log.logIndex),
        blockTime: times.get(bn)!,
      });
    }
    found += transfers.length;
    scanned += w.to - w.from + 1;
    // The window's own end, not the last log's block: a window with no logs in
    // it still advances, or an empty stretch is rescanned forever.
    state = { ...applyTransfers(state, transfers), lastBlock: w.to };
  }
  return { state, scanned, found, caughtUp: nextWindow(state.lastBlock, head, span, confirmations) === null };
}

/**
 * What the gallery sorts by, for one token. Unknown dates are null, not zero —
 * zero is the first of January 1970 and reads as an answer.
 *
 * `forOwner` is the wallet the row is being drawn for. It matters only when
 * that wallet is not the current holder, which happens for exactly one reason:
 * the token is listed, so the market contract holds it. Then the date worth
 * showing is when *they* received it, one hop back, rather than the moment they
 * put it up for sale.
 */
export function tokenDates(
  state: NftHistoryState,
  tokenId: number,
  forOwner?: string,
): { mintedAt: number | null; receivedAt: number | null } {
  const h = state.tokens[String(tokenId)];
  if (!h) return { mintedAt: null, receivedAt: null };
  const who = String(forOwner ?? "").toLowerCase();
  const usePrev = Boolean(who) && h.owner !== who && h.prevOwner === who;
  const received = usePrev ? h.prevReceivedAt : h.receivedAt;
  return {
    mintedAt: h.mintedAt > 0 ? h.mintedAt : null,
    receivedAt: received > 0 ? received : null,
  };
}
