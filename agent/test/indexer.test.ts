import test from "node:test";
import assert from "node:assert/strict";
import { EventIndex, nextRange, actorsOf, jsonSafe, type IndexedEvent } from "../src/indexer.ts";

const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const C = "0x0000000000000000000000000000000000000abc";

const ev = (o: Partial<IndexedEvent> = {}): IndexedEvent => ({
  blockNumber: 100,
  blockTime: 1_700_000_000,
  txHash: "0x" + "a".repeat(64),
  logIndex: 0,
  contract: C,
  name: "PaymentSettled",
  actors: [A, B],
  args: { amount: "1000000" },
  ...o,
});

test("stores and reads an event back", () => {
  const ix = new EventIndex();
  ix.put(ev());
  const [got] = ix.query();
  assert.equal(got!.name, "PaymentSettled");
  assert.equal(got!.args.amount, "1000000");
  assert.deepEqual(got!.actors, [A.toLowerCase(), B.toLowerCase()]);
  ix.close();
});

test("re-indexing the same range cannot double-count", () => {
  // The normal case after any unclean stop. A log's identity is (txHash,
  // logIndex), and replaying it has to be harmless.
  const ix = new EventIndex();
  for (let i = 0; i < 3; i++) ix.put(ev());
  assert.equal(ix.count(), 1);
  ix.close();
});

test("treats two logs in one transaction as distinct", () => {
  const ix = new EventIndex();
  ix.put(ev({ logIndex: 0 }));
  ix.put(ev({ logIndex: 1 }));
  assert.equal(ix.count(), 2);
  ix.close();
});

test("finds everything involving an address, whatever the event", () => {
  const ix = new EventIndex();
  ix.put(ev({ logIndex: 0, name: "PaymentSettled", actors: [A, B] }));
  ix.put(ev({ logIndex: 1, name: "PaymentDisputed", actors: [A, B] }));
  ix.put(ev({ logIndex: 2, name: "Supply", actors: [B] }));
  assert.equal(ix.query({ actor: A }).length, 2);
  assert.equal(ix.query({ actor: B }).length, 3);
  ix.close();
});

test("an actor prefix does not match a different address", () => {
  // Substring matching on a comma-joined list is the obvious bug here.
  const ix = new EventIndex();
  const short = "0x1111111111111111111111111111111111111111";
  const longer = "0x1111111111111111111111111111111111111122";
  ix.put(ev({ logIndex: 0, actors: [longer] }));
  assert.equal(ix.query({ actor: short }).length, 0);
  assert.equal(ix.query({ actor: longer }).length, 1);
  ix.close();
});

test("filters by name, contract and time", () => {
  const ix = new EventIndex();
  ix.put(ev({ logIndex: 0, name: "PaymentSettled", blockTime: 1000 }));
  ix.put(ev({ logIndex: 1, name: "PaymentRefunded", blockTime: 2000 }));
  ix.put(ev({ logIndex: 2, name: "PaymentSettled", blockTime: 3000, contract: A }));

  assert.equal(ix.query({ name: "PaymentSettled" }).length, 2);
  assert.equal(ix.query({ contract: A }).length, 1);
  assert.equal(ix.query({ since: 2000 }).length, 2);
  ix.close();
});

test("returns newest first", () => {
  const ix = new EventIndex();
  ix.put(ev({ blockNumber: 10, logIndex: 0 }));
  ix.put(ev({ blockNumber: 30, logIndex: 1 }));
  ix.put(ev({ blockNumber: 20, logIndex: 2 }));
  assert.deepEqual(ix.query().map((e) => e.blockNumber), [30, 20, 10]);
  ix.close();
});

test("caps how much one query can ask for", () => {
  const ix = new EventIndex();
  for (let i = 0; i < 50; i++) ix.put(ev({ logIndex: i }));
  assert.equal(ix.query({ limit: 10 }).length, 10);
  assert.equal(ix.query({ limit: 100_000 }).length, 50);
  ix.close();
});

test("tallies event types", () => {
  const ix = new EventIndex();
  ix.put(ev({ logIndex: 0, name: "PaymentSettled" }));
  ix.put(ev({ logIndex: 1, name: "PaymentSettled" }));
  ix.put(ev({ logIndex: 2, name: "PaymentRefunded" }));
  assert.deepEqual(ix.tally(), [
    { name: "PaymentSettled", n: 2 },
    { name: "PaymentRefunded", n: 1 },
  ]);
  ix.close();
});

test("remembers where it got to, so a restart resumes", () => {
  const ix = new EventIndex();
  assert.equal(ix.lastBlock(), 0);
  ix.setLastBlock(1234);
  assert.equal(ix.lastBlock(), 1234);
  ix.setLastBlock(5678);
  assert.equal(ix.lastBlock(), 5678);
  ix.close();
});

test("a batch is all-or-nothing", () => {
  const ix = new EventIndex();
  // A raw bigint in args is what happens when somebody forgets `jsonSafe`;
  // JSON.stringify throws on it, part-way through the batch.
  assert.throws(() =>
    ix.putMany([ev({ logIndex: 0 }), { ...ev({ logIndex: 1 }), args: { amount: 1n } }]),
  );
  // A partial write would leave progress claiming rows that are not there.
  assert.equal(ix.count(), 0);
  ix.close();
});

// --- the scan window ---------------------------------------------------------

test("stays behind the tip, since the last block is the one most likely to move", () => {
  assert.equal(nextRange(100, 101, 2000, 1), null);
  assert.deepEqual(nextRange(100, 105, 2000, 1), { from: 101, to: 104 });
});

test("never asks for a window it has already done", () => {
  assert.equal(nextRange(500, 400), null);
  assert.equal(nextRange(500, 500), null);
});

test("chunks a long catch-up rather than asking for everything", () => {
  // A fresh index against an old chain must not open with a million-block query
  // the RPC will refuse.
  const r = nextRange(0, 1_000_000, 2_000, 1)!;
  assert.equal(r.from, 1);
  assert.equal(r.to, 2_000);
});

test("always advances when there is anything to do", () => {
  // A window that never moves silently stops indexing, which looks exactly like
  // a quiet chain.
  let last = 0;
  for (let i = 0; i < 5; i++) {
    const r = nextRange(last, 10_000, 100, 1);
    assert.ok(r, "should have work");
    assert.ok(r!.to > last, `${r!.to} did not advance past ${last}`);
    last = r!.to;
  }
});

// --- decoding helpers --------------------------------------------------------

test("picks addresses out of decoded args whatever they are called", () => {
  assert.deepEqual(actorsOf({ agent: A, provider: B, amount: 5n }), [A.toLowerCase(), B.toLowerCase()]);
  assert.deepEqual(actorsOf({ amount: 5n, memo: "hello" }), []);
});

test("does not list the same address twice", () => {
  assert.deepEqual(actorsOf({ from: A, to: A }), [A.toLowerCase()]);
});

test("stringifies bigints rather than losing them to a double", () => {
  const huge = 2n ** 200n;
  const out = jsonSafe({ amount: huge, who: A });
  assert.equal(out.amount, huge.toString());
  assert.equal(JSON.parse(JSON.stringify(out)).amount, huge.toString());
});
