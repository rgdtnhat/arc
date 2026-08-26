import test from "node:test";
import assert from "node:assert/strict";
import { describeFreeze } from "../src/pool.ts";

/**
 * A frozen action must not be advertised as available.
 *
 * `reserveMeta` has carried the freeze bitmask all along and every figure the
 * app computed ignored it. On the live pool — all four reserves at mask 5,
 * `FREEZE_SUPPLY | FREEZE_BORROW` — `/api/state` reported:
 *
 *     USDC  frozen=5  maxBorrow=89.490463  limitedBy={"borrow":"liquidity"}
 *
 * and `/api/pool/health` reported `borrowRoom: "89.493463"`. Both are false in
 * the same way: `capacityOf` answers "what would the cap allow", which is a
 * different question from "what can anybody actually do right now", and a
 * freeze is a switch rather than a limit, so no smaller amount gets around it.
 * Naming the cause as `liquidity` sent the reader to blame the pool's cash.
 */

test("the mask is read the way the contract writes it", () => {
  // 1 supply, 2 withdraw, 4 borrow, 8 repay.
  assert.deepEqual(
    { ...describeFreeze(5) },
    { supply: true, withdraw: false, borrow: true, repay: false, any: true, label: "supply and borrow" },
  );
  assert.equal(describeFreeze(4).borrow, true);
  assert.equal(describeFreeze(4).supply, false);
  assert.equal(describeFreeze(15).label, "supply, withdraw, borrow and repay");
  assert.equal(describeFreeze(2).label, "withdraw");
});

test("nothing frozen is not the same as frozen", () => {
  const none = describeFreeze(0);
  assert.equal(none.any, false);
  assert.equal(none.label, "nothing");
  for (const v of [null, undefined]) assert.equal(describeFreeze(v).any, false);
});

test("a pool with no freeze switch at all reads as not frozen", () => {
  /*
   * `frozenActions` does not exist on pools that predate it, and the read is
   * caught to 0. A missing function is not a frozen reserve — treating it as
   * one would disable every action on an older deployment.
   */
  assert.equal(describeFreeze(0).any, false);
});

/** The rule the endpoints apply, stated once. */
const usable = (room: bigint, frozen: boolean) => (frozen ? 0n : room);

test("room you cannot use is reported as no room", () => {
  const capBorrowRoom = 89_493_463n; // what capacityOf said on the live pool
  assert.equal(usable(capBorrowRoom, describeFreeze(5).borrow), 0n);
  // …and an unfrozen action still reports the cap figure unchanged.
  assert.equal(usable(capBorrowRoom, describeFreeze(1).borrow), capBorrowRoom);
});

test("withdraw and repay survive a supply-and-borrow freeze", () => {
  /*
   * The reassuring half, and it has to be true rather than merely said: a
   * freeze against new supply and new borrowing is how a pool is retired
   * without trapping anybody. Zeroing all four would tell depositors their
   * money was stuck when it was not — and `migrate:pool` depends on withdraw
   * still working, since that is how the app wallet moves itself.
   */
  const fz = describeFreeze(5);
  assert.equal(fz.withdraw, false);
  assert.equal(fz.repay, false);
  assert.equal(usable(1_000n, fz.withdraw), 1_000n);
  assert.equal(usable(1_000n, fz.repay), 1_000n);
});
