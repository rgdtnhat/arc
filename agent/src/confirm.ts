import type { Hex } from "viem";

/**
 * Wait for a transaction and refuse to call a revert a success.
 *
 * `waitForTransactionReceipt` resolves for *every* mined transaction. A revert
 * is still a receipt — it carries `status: "reverted"` and returns normally.
 * So every write in this codebase awaited the receipt, ignored the status, and
 * handed the hash back to its caller, which replied `{ ok: true, txHash }`.
 * The app said the supply had gone through; the explorer said it had failed.
 * Both were reporting the same transaction.
 *
 * `simulateContract` catches most reverts before a transaction is sent, which
 * is why this survived so long — but not all of them. State moves between the
 * simulation and the block; gas runs out; approvals skip simulation entirely;
 * and a chain reorg can land a transaction against different state than the
 * one it was simulated on. Whenever any of those happens the old code reported
 * a green tick.
 *
 * A revert throws here so the failure travels back up the same path an RPC
 * error already does, and the UI's existing error handling shows it.
 */
export class TransactionReverted extends Error {
  readonly txHash: Hex;
  constructor(txHash: Hex, what?: string) {
    super(
      `${what ? what + ": " : ""}the transaction was mined but reverted — ` +
        `nothing changed on chain (${txHash})`,
    );
    this.name = "TransactionReverted";
    this.txHash = txHash;
  }
}

/** Minimal shape of the receipt this module cares about. */
export type MinimalReceipt = { status: string | number; [k: string]: unknown };

type Waiter = { waitForTransactionReceipt: (args: { hash: Hex }) => Promise<MinimalReceipt> };

/** True when a receipt reports the transaction succeeded. */
export function receiptOk(receipt: { status: string | number } | null | undefined): boolean {
  if (!receipt) return false;
  const s = receipt.status;
  // viem normalises to "success" | "reverted"; raw RPC gives 0x1 / 0x0. Accept
  // both, and treat anything unrecognised as a failure rather than a pass —
  // an unknown status is exactly the case where a false green tick is worst.
  if (typeof s === "number") return s === 1;
  const t = String(s).toLowerCase();
  return t === "success" || t === "0x1" || t === "1";
}

/**
 * Await `hash` and return its receipt, throwing `TransactionReverted` when the
 * transaction failed. `what` names the action for the error message.
 */
export async function confirm<T extends MinimalReceipt>(
  pub: { waitForTransactionReceipt: (args: { hash: Hex }) => Promise<T> },
  hash: Hex,
  what?: string,
): Promise<T> {
  const receipt = await (pub as unknown as Waiter).waitForTransactionReceipt({ hash });
  if (!receiptOk(receipt as { status: string | number })) throw new TransactionReverted(hash, what);
  return receipt as unknown as T;
}
