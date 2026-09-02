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

/**
 * Broadcast, and then the chain stopped answering.
 *
 * A different thing from a revert, and the difference decides whether money
 * moves. A revert is a *known* outcome: the transaction landed and undid
 * itself, so anything it was going to spend is still where it was, and a caller
 * that pulled funds to make the call can safely hand them back. This is the
 * unknown outcome — the transaction was signed and sent, and then the receipt
 * could not be read. It may be mined already, it may be mined in a minute.
 *
 * Treating that as a failure is how a caller pays twice. The session-funded
 * flows pull a visitor's money, make a call with it, and refund on failure; if
 * a vault deposit lands but its receipt times out, refunding hands the visitor
 * their money back on top of the position they now hold, and the app wallet
 * covers the difference. It is the same rule the RPC transport already follows
 * in the other direction — writes are never retried on a timeout, because the
 * first one may have landed — and it has to hold on the way out too.
 *
 * Carries the hash, because the one useful thing to do with an unknown outcome
 * is go and look at it.
 */
export class ConfirmationUnknown extends Error {
  readonly txHash: Hex;
  constructor(txHash: Hex, cause: unknown, what?: string) {
    super(
      `${what ? what + ": " : ""}the transaction was sent but the network stopped answering, so ` +
        `whether it landed is unknown — check ${txHash} before retrying ` +
        `(${String((cause as { shortMessage?: string; message?: string })?.shortMessage ?? (cause as Error)?.message ?? cause).slice(0, 120)})`,
    );
    this.name = "ConfirmationUnknown";
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
  let receipt: MinimalReceipt;
  try {
    receipt = await (pub as unknown as Waiter).waitForTransactionReceipt({ hash });
  } catch (e) {
    // Not a failure — an unknown. See ConfirmationUnknown: the caller must not
    // undo anything on the strength of this.
    throw new ConfirmationUnknown(hash, e, what);
  }
  if (!receiptOk(receipt as { status: string | number })) throw new TransactionReverted(hash, what);
  return receipt as unknown as T;
}
