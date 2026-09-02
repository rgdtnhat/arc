import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTransfers, nextWindow, tokenDates, loadHistory, EMPTY_HISTORY, HISTORY_VERSION, ZERO_ADDRESS,
  type NftHistoryState, type TransferRecord,
} from "../src/nft-history.ts";

/**
 * "When did I get this" is not a question an ERC-721 can answer.
 *
 * `ownerOf` is a snapshot; the dates live only in the `Transfer` logs. The
 * gallery sorts and filters on those dates, so the folding rules are worth
 * pinning: a wrong order here shows the wrong owner and a date that cannot be
 * explained from the chain.
 */

const ALICE = "0xA005fE9726335b49F9Cc23653Bc6a9490a7faDc4";
const BOB = "0x309e08cA592eCC41F1341d9e7A215f471479D68A";

const xfer = (o: Partial<TransferRecord>): TransferRecord => ({
  tokenId: "1", from: ZERO_ADDRESS, to: ALICE,
  blockNumber: 100, logIndex: 0, blockTime: 1_000, ...o,
});

test("a mint records both dates and the holder", () => {
  const s = applyTransfers(EMPTY_HISTORY, [xfer({ blockTime: 5_000 })]);
  assert.deepEqual(s.tokens["1"], {
    mintedAt: 5_000, mintedBlock: 100, receivedAt: 5_000, owner: ALICE.toLowerCase(),
    at: 100, atLog: 0, prevOwner: "", prevReceivedAt: 0,
  });
});

test("a listed token still reports when its seller got it", () => {
  /*
   * The bug this exists for, found on the live launchpad. Listing moves the
   * token into the market contract, so the last transfer is "seller → market"
   * and the naive `receivedAt` is the moment it went up for sale. The gallery
   * draws that token under the seller, where "Received today" is an answer
   * about the market's day rather than theirs — and it changes the sort order
   * of everything they own the instant they list one.
   */
  const MARKET = "0x2bc054693446c826ff77085e739b617b3a0d683f";
  let s = applyTransfers(EMPTY_HISTORY, [xfer({ blockTime: 1_000 })]);          // minted to Alice
  s = applyTransfers(s, [xfer({ from: ALICE, to: BOB, blockNumber: 200, blockTime: 5_000 })]);
  s = applyTransfers(s, [xfer({ from: BOB, to: MARKET, blockNumber: 300, blockTime: 9_000 })]);

  assert.equal(tokenDates(s, 1).receivedAt, 9_000, "the market did receive it then");
  assert.equal(tokenDates(s, 1, BOB).receivedAt, 5_000, "the seller's own date was lost to the listing");
  assert.equal(tokenDates(s, 1, BOB).mintedAt, 1_000);
  // Somebody who is neither the holder nor the previous one gets the plain
  // answer rather than a date belonging to somebody else.
  assert.equal(tokenDates(s, 1, ALICE).receivedAt, 9_000);
});

test("a later transfer moves 'received' and leaves 'minted' alone", () => {
  // The distinction the filter is built on: a token minted in July and bought
  // in August is new to its owner and old to the collection.
  let s = applyTransfers(EMPTY_HISTORY, [xfer({ blockTime: 5_000 })]);
  s = applyTransfers(s, [xfer({ from: ALICE, to: BOB, blockNumber: 200, blockTime: 9_000 })]);
  assert.equal(s.tokens["1"]!.mintedAt, 5_000);
  assert.equal(s.tokens["1"]!.receivedAt, 9_000);
  assert.equal(s.tokens["1"]!.owner, BOB.toLowerCase());
});

test("two transfers in one block fold in log order, not array order", () => {
  /*
   * Mint and immediate list is an ordinary pair, and they land in the same
   * block. Folding them as they arrive — or by block alone — records the
   * minter as the holder of a token the market is escrowing.
   */
  const s = applyTransfers(EMPTY_HISTORY, [
    xfer({ from: ALICE, to: BOB, blockNumber: 100, logIndex: 3, blockTime: 1_000 }),
    xfer({ from: ZERO_ADDRESS, to: ALICE, blockNumber: 100, logIndex: 1, blockTime: 1_000 }),
  ]);
  assert.equal(s.tokens["1"]!.owner, BOB.toLowerCase(), "folded out of order");
  assert.equal(s.tokens["1"]!.mintedAt, 1_000, "the mint was lost");
});

test("re-folding an already-scanned window changes nothing", () => {
  /*
   * Rescans are normal after an unclean stop, and folding blindly is worse than
   * it looks: it does not merely repeat a date, it shifts the current holder
   * into `prevOwner` and invents a hop that never happened — so a token whose
   * window was rescanned would report the wrong "received" for its seller.
   */
  const chain = [
    xfer({ blockTime: 1_000 }),
    xfer({ from: ALICE, to: BOB, blockNumber: 200, blockTime: 5_000 }),
  ];
  const a = applyTransfers(EMPTY_HISTORY, chain);
  const b = applyTransfers(a, chain);
  assert.deepEqual(a.tokens, b.tokens);
  assert.equal(b.tokens["1"]!.prevOwner, ALICE.toLowerCase());
  assert.equal(b.tokens["1"]!.prevReceivedAt, 1_000);
});

test("a transfer older than the record is ignored, not applied backwards", () => {
  // Windows are scanned in order, but a replay after a reorg is not guaranteed
  // to be — and applying an older transfer over a newer one moves the token
  // back to a wallet that no longer holds it.
  let s = applyTransfers(EMPTY_HISTORY, [xfer({ from: ALICE, to: BOB, blockNumber: 200, blockTime: 5_000 })]);
  s = applyTransfers(s, [xfer({ blockNumber: 100, blockTime: 1_000 })]);
  assert.equal(s.tokens["1"]!.owner, BOB.toLowerCase());
});

test("a burn is recorded rather than dropped", () => {
  const s = applyTransfers(applyTransfers(EMPTY_HISTORY, [xfer({})]), [
    xfer({ from: ALICE, to: ZERO_ADDRESS, blockNumber: 300, blockTime: 20_000 }),
  ]);
  assert.equal(s.tokens["1"]!.owner, ZERO_ADDRESS);
});

test("the cursor never goes backwards", () => {
  const s: NftHistoryState = { version: HISTORY_VERSION, lastBlock: 500, tokens: {} };
  assert.equal(applyTransfers(s, [xfer({ blockNumber: 100 })]).lastBlock, 500);
});

test("windows stop short of the tip and stop entirely when caught up", () => {
  /*
   * The two ways a scanner breaks quietly: asking for blocks past the head,
   * and never advancing. The tip is held back by a confirmation because it is
   * the block most likely to be replaced.
   */
  assert.deepEqual(nextWindow(0, 100, 20), { from: 1, to: 20 });
  assert.deepEqual(nextWindow(80, 100, 20), { from: 81, to: 99 }, "did not stop short of the head");
  assert.equal(nextWindow(99, 100, 20), null, "kept scanning a chain it had caught up with");
  assert.equal(nextWindow(200, 100, 20), null, "asked for blocks past the head");
});

test("an unknown date is null rather than 1970", () => {
  // A token whose mint predates the scan has no date. Zero would sort as the
  // first of January 1970 and read as a real answer.
  const s = applyTransfers(EMPTY_HISTORY, [
    xfer({ from: ALICE, to: BOB, blockNumber: 200, blockTime: 9_000 }),
  ]);
  assert.deepEqual(tokenDates(s, 1), { mintedAt: null, receivedAt: 9_000 });
  assert.deepEqual(tokenDates(s, 99), { mintedAt: null, receivedAt: null });
});

test("a record from an older shape is thrown away rather than carried", () => {
  /*
   * The trap a cursor sets. The scan resumes from `lastBlock`, so a field added
   * to `TokenHistory` is filled only by transfers that have not been read yet —
   * every token already in the file keeps whatever the old shape recorded, and
   * nothing says so. `prevOwner` was added exactly that way, and the gallery
   * went on reporting a listing date as the seller's own with no visible fault.
   */
  const old = { lastBlock: 59_400_000, tokens: { "1": { mintedAt: 1, receivedAt: 2, owner: "0xabc" } } };
  const a = loadHistory(old);
  assert.equal(a.state.lastBlock, 0, "kept a cursor past the blocks it needs to re-read");
  assert.deepEqual(a.state.tokens, {});
  assert.equal(a.reset, true, "reset silently");

  // A current file is used as it is, and a missing one is not a "reset".
  const good = { version: HISTORY_VERSION, lastBlock: 12, tokens: {} };
  assert.deepEqual(loadHistory(good), { state: good, reset: false });
  assert.equal(loadHistory(null).reset, false);
  assert.equal(loadHistory(EMPTY_HISTORY).reset, false);
});
