import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { confirm, receiptOk, TransactionReverted, ConfirmationUnknown } from "../src/confirm.js";

const HASH = ("0x" + "ab".repeat(32)) as Hex;

const waiter = (status: string | number) => ({
  waitForTransactionReceipt: async (_a: { hash: Hex }) => ({ status, logs: [] }),
});

test("a reverted receipt is not a success", () => {
  assert.equal(receiptOk({ status: "reverted" }), false);
  assert.equal(receiptOk({ status: "0x0" }), false);
  assert.equal(receiptOk({ status: 0 }), false);
});

test("a successful receipt is recognised in every shape viem or raw RPC returns", () => {
  assert.equal(receiptOk({ status: "success" }), true);
  assert.equal(receiptOk({ status: "0x1" }), true);
  assert.equal(receiptOk({ status: "1" }), true);
  assert.equal(receiptOk({ status: 1 }), true);
});

test("an unknown status fails closed rather than passing as success", () => {
  // The whole point of this module is that a green tick must be earned. A
  // status nobody recognises is exactly where a false pass does most damage.
  assert.equal(receiptOk({ status: "pending" }), false);
  assert.equal(receiptOk({ status: "" }), false);
  assert.equal(receiptOk(null), false);
  assert.equal(receiptOk(undefined), false);
});

test("confirm returns the receipt when the transaction succeeded", async () => {
  const r = await confirm(waiter("success"), HASH);
  assert.equal(r.status, "success");
});

test("confirm throws TransactionReverted when the transaction reverted", async () => {
  await assert.rejects(
    () => confirm(waiter("reverted"), HASH, "supply"),
    (e: unknown) => {
      assert.ok(e instanceof TransactionReverted);
      assert.equal(e.txHash, HASH);
      // The message has to name the action and say plainly that nothing
      // happened — "reverted" alone reads like a warning, not a failure.
      assert.match(e.message, /supply/);
      assert.match(e.message, /nothing changed on chain/);
      return true;
    },
  );
});

test("confirm carries the hash through so a failure is still checkable", async () => {
  const e = await confirm(waiter(0), HASH).then(
    () => null,
    (err: unknown) => err as TransactionReverted,
  );
  assert.ok(e);
  assert.match(e.message, new RegExp(HASH));
});

/*
 * Sent, and then the chain stopped answering.
 *
 * A different outcome from a revert, and the difference decides whether money
 * moves twice. A revert is *known*: the transaction landed and undid itself, so
 * a caller that pulled a visitor's funds to make the call still holds them and
 * can safely hand them back. An unreadable receipt is *unknown* — the call was
 * signed and broadcast and may be mined already. Refunding on that hands the
 * visitor their money back on top of the position they now hold, and the app
 * wallet covers the difference.
 *
 * The same rule the RPC transport follows in the other direction, where a write
 * is never retried on a timeout because the first one may have landed.
 */

test("a receipt that cannot be read is unknown, not failed", async () => {
  const hash = ("0x" + "a".repeat(64)) as `0x${string}`;
  const pub = {
    waitForTransactionReceipt: async () => { throw new Error("Couldn't reach the Arc network"); },
  };
  await assert.rejects(
    () => confirm(pub as never, hash, "deposit"),
    (e: Error) => {
      assert.ok(e instanceof ConfirmationUnknown, `got ${e.name}, which a caller would refund on`);
      assert.equal((e as ConfirmationUnknown).txHash, hash, "the hash was lost, so nobody can go and look");
      assert.match(e.message, /unknown/);
      return true;
    },
  );
});

test("a revert stays a revert, because that one is safe to undo", async () => {
  // The distinction is the whole point: this outcome is known, the transaction
  // changed nothing, and a caller holding pulled funds should refund them.
  const hash = ("0x" + "b".repeat(64)) as `0x${string}`;
  const pub = { waitForTransactionReceipt: async () => ({ status: "reverted" }) };
  await assert.rejects(
    () => confirm(pub as never, hash, "deposit"),
    (e: Error) => {
      assert.equal(e instanceof ConfirmationUnknown, false, "a revert was reported as an unknown outcome");
      assert.ok(e instanceof TransactionReverted);
      return true;
    },
  );
});

test("a mined success is still just a success", async () => {
  const pub = { waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 1n }) };
  const r = await confirm(pub as never, ("0x" + "c".repeat(64)) as `0x${string}`);
  assert.equal(r.status, "success");
});
