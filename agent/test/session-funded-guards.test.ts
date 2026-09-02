import test from "node:test";
import assert from "node:assert/strict";

/**
 * The rules a session-funded run enforces at the moment it spends.
 *
 * These are the second line, not the first — the form gate checks the same
 * things when a task is saved. They are reproduced here because the first line
 * has a gap the second closes: an operator skips the gate's ownership check, so
 * only the runner can say "this task spends the wallet it belongs to and no
 * other". A defence that exists only at save time is one edit away from not
 * existing.
 */

/** The runner's rule, extracted: whose wallet may a task spend from? */
function mayspend(taskOwner: string | null, sessionOwners: string[]): string | null {
  if (!sessionOwners.length) return "no session";
  const first = sessionOwners[0].toLowerCase();
  if (sessionOwners.some((o) => o.toLowerCase() !== first)) return "mixed wallets";
  if (!taskOwner) return "no owner";
  if (taskOwner.toLowerCase() !== first) return "wrong wallet";
  return null;
}

const A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const B = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";

test("a task spends only the wallet it belongs to", () => {
  assert.equal(mayspend(A, [A]), null, "its own wallet was refused");
  assert.equal(mayspend(A, [A.toLowerCase()]), null, "case cost it the match");
  assert.equal(mayspend(A, [B]), "wrong wallet", "it spent somebody else's session");
});

test("a task with no owner cannot spend anybody's session", () => {
  // This is the operator case. Scheduling against a visitor's delegation is a
  // feature, but the task has to be stamped as *theirs* — otherwise it does not
  // appear in their list and they cannot pause or stop the thing spending their
  // wallet. The gate now stamps it; the runner refuses if that did not happen.
  assert.equal(mayspend(null, [A]), "no owner");
});

test("one task cannot pool two people's money", () => {
  // Adding liquidity names one session per pool asset. Two of them belonging to
  // two different wallets would be a position only one of them could see,
  // funded by both.
  assert.equal(mayspend(A, [A, B]), "mixed wallets");
  assert.equal(mayspend(A, [A, A]), null);
});

/**
 * What a scheduled swap is allowed to forward, when the receipt is unreadable.
 *
 * The primary path reads the swap's own transfer logs. The fallback is the
 * balance *delta*, and two scheduled swaps into the same token can overlap —
 * the second would see a difference that includes the first's proceeds. The
 * quote is the most this trade could have produced, so it caps the fallback.
 */
const fallback = (before: bigint, after: bigint, expected: bigint) => {
  const delta = after > before ? after - before : 0n;
  return expected > 0n && delta > expected ? expected : delta;
};

test("the proceeds fallback cannot forward another run's swap", () => {
  // Ours produced 45; a concurrent one landed 900 in the same wallet.
  assert.equal(fallback(1000n, 1000n + 45n + 900n, 45n), 45n);
  // Underperforming is honoured — the floor is the trade's, not the quote's.
  assert.equal(fallback(1000n, 1040n, 45n), 40n);
  // No quote to cap with falls back to the delta, as before.
  assert.equal(fallback(1000n, 1045n, 0n), 45n);
  // A balance that did not move forwards nothing.
  assert.equal(fallback(1000n, 1000n, 45n), 0n);
});

/**
 * A slippage floor priced at run time.
 *
 * A scheduled add or exit cannot carry a floor written when the task was: the
 * pool's ratio moves, so the number means something different every week. The
 * expectation is simulated at the moment it runs and the floor is a haircut.
 */
const floorFrom = (expected: bigint, bps: number) => (expected * BigInt(10_000 - bps)) / 10_000n;

test("the floor is a bounded haircut off what the pool would pay right now", () => {
  assert.equal(floorFrom(1_000_000n, 100), 990_000n, "1% off a million");
  assert.equal(floorFrom(1_000_000n, 1000), 900_000n, "the 10% ceiling");
  assert.equal(floorFrom(1_000_000n, 10), 999_000n, "the 0.1% floor");
  // Zero expected means the simulation could not price it; the caller passes
  // zero through rather than inventing a floor it cannot justify.
  assert.equal(floorFrom(0n, 100), 0n);
});
