import test from "node:test";
import assert from "node:assert/strict";

/**
 * What a session-funded swap is allowed to forward.
 *
 * Nothing in the AMM or the router takes a recipient, so a swap made with a
 * visitor's money pays out to the app wallet and is forwarded on. The amount
 * forwarded must be what *that swap* produced — never the app wallet's balance
 * of the token, which includes several hundred EURC of the app's own funds on
 * the live deployment. A first version returned the balance when a receipt
 * could not be read, which would have handed a visitor all of it.
 *
 * The rule is reproduced here rather than imported because it lives inside the
 * dashboard's closure; what is under test is the arithmetic, and getting it
 * wrong is the difference between forwarding a swap and emptying a wallet.
 */

/** The primary path: sum the transfers this wallet received in that receipt. */
function fromLogs(logs: { address: string; topics: string[]; data: string }[], token: string, me: string): bigint {
  const mine = me.toLowerCase().slice(2).padStart(64, "0");
  let sum = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    if (log.topics.length < 3) continue;
    if (log.topics[2].toLowerCase().slice(2) !== mine) continue;
    sum += BigInt(log.data);
  }
  return sum;
}

/** The fallback: what the swap *added*, never what is there. */
const fromBalances = (before: bigint, after: bigint) => (after > before ? after - before : 0n);

const APP = "0xA005fE9726335b49F9Cc23653Bc6a9490a7faDc4";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const topic = (addr: string) => "0x" + addr.toLowerCase().slice(2).padStart(64, "0");

test("forwards what the swap paid, not what the wallet holds", () => {
  // The live shape: the app already held 771 EURC of its own, and the swap
  // produced 0.045.
  const held = 771_903_944n;
  const paid = 45_350n;
  const logs = [
    // The pool paying the app wallet — the one that counts.
    { address: EURC, topics: ["0xddf2", topic("0x8b3ae0eb103653c4bce4d4dbff062ad7c9c9ada0"), topic(APP)], data: "0x" + paid.toString(16) },
    // The app paying the pool in the other token — must not be counted.
    { address: "0x3600000000000000000000000000000000000000", topics: ["0xddf2", topic(APP), topic("0x8b3ae0eb103653c4bce4d4dbff062ad7c9c9ada0")], data: "0x" + (50_000n).toString(16) },
  ];
  assert.equal(fromLogs(logs, EURC, APP), paid);
  assert.notEqual(fromLogs(logs, EURC, APP), held, "it forwarded the whole balance");
  assert.equal(fromBalances(held, held + paid), paid, "the fallback did not measure the difference");
});

test("a receipt with nothing for this wallet forwards nothing", () => {
  // A swap whose output went somewhere else entirely leaves nothing to send.
  const other = "0x1111111111111111111111111111111111111111";
  const logs = [{ address: EURC, topics: ["0xddf2", topic(APP), topic(other)], data: "0x" + (1000n).toString(16) }];
  assert.equal(fromLogs(logs, EURC, APP), 0n);
  // And a balance that did not move means the swap added nothing.
  assert.equal(fromBalances(771_903_944n, 771_903_944n), 0n);
});

test("a balance that went down forwards nothing rather than underflowing", () => {
  // bigint subtraction has no floor, so the guard is the code's, not the type's.
  assert.equal(fromBalances(100n, 40n), 0n);
});
