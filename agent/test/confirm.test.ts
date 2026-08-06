import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { confirm, receiptOk, TransactionReverted } from "../src/confirm.js";

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
