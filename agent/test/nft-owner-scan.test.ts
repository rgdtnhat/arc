import test from "node:test";
import assert from "node:assert/strict";
import { groupByOwner, heldBy } from "../src/nft-owners.ts";

/**
 * One sweep of `ownerOf`, read by two panes.
 *
 * `/api/nft/mine` answers two questions — what the reader holds, and what the
 * market holds on their behalf while it is listed — and used to read every
 * token's owner once per question. Deriving both from a single sweep is only
 * safe if the grouping is exactly as strict as the filter it replaces, so these
 * pin the three ways it could quietly be laxer: attributing a token nobody
 * could read an owner for, missing a match because one side was checksummed,
 * and letting one token appear under two holders — which on this pane would
 * draw the same NFT as both held and listed.
 */

test("a token whose owner could not be read belongs to nobody", () => {
  /*
   * `ownerOf` reverts for a burned token, and a paced RPC can simply fail. Both
   * arrive here as null, and neither is a claim about who holds it — attributing
   * them to the zero address would draw burned tokens into somebody's gallery.
   */
  const ids = [1n, 2n, 3n, 4n];
  const owners = ["0xAbC0000000000000000000000000000000000001", null, undefined, ""];
  const byOwner = groupByOwner(ids, owners);
  assert.deepEqual([...byOwner.keys()], ["0xabc0000000000000000000000000000000000001"]);
  assert.deepEqual(byOwner.get("0xabc0000000000000000000000000000000000001"), [1n]);
  // And nothing was invented for the reads that failed.
  assert.equal([...byOwner.values()].flat().length, 1);
});

test("a checksummed address and a lower-cased one are the same holder", () => {
  /*
   * `ownerOf` answers in EIP-55 checksum case and the query string carries
   * whatever the browser pasted. The old filter lower-cased both sides; a
   * grouping that did not would show a full wallet as empty.
   */
  const held = "0xDEADBEEF00000000000000000000000000000001";
  const byOwner = groupByOwner([7n, 9n], [held, held.toLowerCase()]);
  assert.equal(byOwner.size, 1);
  assert.deepEqual(heldBy(byOwner, held.toUpperCase().replace("0X", "0x")), [7n, 9n]);
  assert.deepEqual(heldBy(byOwner, held.toLowerCase()), [7n, 9n]);
});

test("an address that holds nothing gets an empty list, not undefined", () => {
  // The route feeds this straight into the hydrator; a missing key must read as
  // "holds none" rather than throw on the way to drawing an empty gallery.
  assert.deepEqual(heldBy(groupByOwner([], []), "0x0000000000000000000000000000000000000009"), []);
});

test("no token is filed under two holders", () => {
  /*
   * The held list and the listed list are now derived from one map rather than
   * from two independent scans, so a token appearing in both would draw the
   * same NFT twice — once as held and once as on sale, with two sets of
   * buttons. One id, one owner, whatever the case of the answers.
   */
  const a = "0xAAaa000000000000000000000000000000000001";
  const b = "0xbbbb000000000000000000000000000000000002";
  const byOwner = groupByOwner([1n, 2n, 3n], [a, b, a.toLowerCase()]);
  const all = [...byOwner.values()].flat();
  assert.equal(all.length, new Set(all.map(String)).size, "a token id is filed under two owners");
  assert.deepEqual(heldBy(byOwner, a), [1n, 3n]);
  assert.deepEqual(heldBy(byOwner, b), [2n]);
});

test("an owner with no answer at that index is skipped, not shifted", () => {
  /*
   * `owners[i]` is the answer for `ids[i]` — the two arrays are read by
   * position. Compacting the failures out of one and not the other would file
   * every later token under the wrong wallet, which is the kind of wrong that
   * shows somebody else's NFTs in your gallery.
   */
  const owners = [null, "0x1111111111111111111111111111111111111111", null,
    "0x2222222222222222222222222222222222222222"];
  const byOwner = groupByOwner([10n, 11n, 12n, 13n], owners);
  assert.deepEqual(heldBy(byOwner, "0x1111111111111111111111111111111111111111"), [11n]);
  assert.deepEqual(heldBy(byOwner, "0x2222222222222222222222222222222222222222"), [13n]);
});
