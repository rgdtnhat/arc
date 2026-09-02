/**
 * A message written into the transaction that carries the payment.
 *
 * ## Why this can exist at all
 * An ERC-20 `transfer` has no memo field, and every scheme for adding one
 * costs something: a second transaction, a wrapper contract, an off-chain
 * index. But Solidity's ABI decoder ignores calldata beyond what a function's
 * arguments need — so bytes appended after an encoded `transfer(to, amount)`
 * change nothing about what the call does, and travel with it into the
 * transaction's input, where an explorer shows them and the recipient can read
 * them. One transaction, no extra contract, and the payment is exactly the
 * payment it would have been.
 *
 * ## Why it is checked before it is sent
 * "Solidity ignores it" is a statement about Solidity, and not every address
 * on a chain is a Solidity contract — Arc's USDC is the gas token, at a
 * reserved address, and owes nobody that behaviour. So the caller simulates
 * the call *with* the memo attached and only broadcasts if the simulation
 * succeeds; otherwise the plain transfer goes out and the receipt says the
 * memo did not. The memo is the least important thing in the transaction and
 * must never be the reason a payment fails.
 *
 * ## Why it is bounded
 * Calldata is paid for in gas, per byte, by whoever sends it. A memo is a
 * sentence — a reference, an invoice number, a thank-you — and a limit is what
 * keeps it from becoming a way to write a file into somebody's fee budget.
 */

/** Bytes, not characters: the limit is a gas cost, and UTF-8 is variable width. */
export const MEMO_MAX_BYTES = 180;

/**
 * The memo as hex, ready to append to encoded calldata.
 *
 * Returns "" for an empty memo, so a caller can concatenate unconditionally
 * and get an unchanged call. Truncation is at a byte boundary and may cut a
 * multi-byte character in half; the alternative is silently dropping a whole
 * memo for being one byte long, and a clipped sentence is the better failure.
 */
export function memoHex(memo: unknown): string {
  const text = String(memo ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const bytes = new TextEncoder().encode(text).slice(0, MEMO_MAX_BYTES);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Read a memo back out of a transaction's input.
 *
 * `argBytes` is how many bytes the function's own arguments occupy — 64 for
 * `transfer(address,uint256)`, 96 for `spend(bytes32,address,uint256)`. Anything
 * past the selector and those arguments is the memo.
 */
export function memoFromInput(input: string, argBytes: number): string {
  const hex = String(input ?? "").replace(/^0x/, "");
  const start = 8 + argBytes * 2;
  if (hex.length <= start) return "";
  const tail = hex.slice(start);
  // An odd trailing nibble is not a byte and not a memo; ignore it rather than
  // decoding half of one.
  const even = tail.slice(0, tail.length - (tail.length % 2));
  const bytes = new Uint8Array((even.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}
