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

/* ---- who may decide a drop -------------------------------------------- */

import { canDecideDrops } from "../src/pool.ts";

/**
 * The launchpad's Approve and Reject buttons never appeared for the one person
 * who could press them.
 *
 * The page decided by comparing the launchpad's owner against the address it
 * was acting as. In an operator session that is the **app wallet**; the
 * launchpad is owned by the **deployer**, because that is the key that deployed
 * it. Two different addresses, so the comparison was false, always — while
 * `/api/nft/decide` signed with the deployer key and worked the whole time. The
 * feature was there and only the buttons were missing, which is the shape of
 * bug that reads as "the admin can't decide anything".
 */

const APP_WALLET = "0xA005fE9726335b49F9Cc23653Bc6a9490a7faDc4";
const DEPLOYER = "0x309e08cA592eCC41F1341d9e7A215f471479D68A";

test("an operator whose owner key owns the launchpad may decide", () => {
  const r = canDecideDrops({ operator: true, signer: DEPLOYER, launchpadOwner: DEPLOYER });
  assert.equal(r.ok, true);
  assert.equal(r.why, null);
});

test("the app wallet is not the launchpad's owner, and that is the whole bug", () => {
  /*
   * The exact live pairing: acting as the app wallet, launchpad owned by the
   * deployer. The old comparison asked this question and answered "no"; the
   * right question is what the *server* signs with, which is the deployer.
   */
  const wrong = canDecideDrops({ operator: true, signer: APP_WALLET, launchpadOwner: DEPLOYER });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why ?? "", /owned by 0x309e08cA/);

  const right = canDecideDrops({ operator: true, signer: DEPLOYER, launchpadOwner: DEPLOYER });
  assert.equal(right.ok, true);
});

test("checksum casing does not decide who is admin", () => {
  const r = canDecideDrops({
    operator: true, signer: DEPLOYER.toLowerCase(), launchpadOwner: DEPLOYER.toUpperCase(),
  });
  assert.equal(r.ok, true, "a checksummed address failed to match itself");
});

test("each refusal says which of the three parts is missing", () => {
  // Not signed in.
  const anon = canDecideDrops({ operator: false, signer: DEPLOYER, launchpadOwner: DEPLOYER });
  assert.equal(anon.ok, false);
  assert.match(anon.why ?? "", /Sign in as operator/);

  // Signed in, but this process cannot sign an owner action.
  const noKey = canDecideDrops({ operator: true, signer: null, launchpadOwner: DEPLOYER });
  assert.equal(noKey.ok, false);
  assert.match(noKey.why ?? "", /DEPLOYER_PRIVATE_KEY/);

  // Signed in, holding a key, wrong key.
  const wrongKey = canDecideDrops({ operator: true, signer: APP_WALLET, launchpadOwner: DEPLOYER });
  assert.match(wrongKey.why ?? "", /Decisions have to come from the owner/);

  /*
   * Every refusal names something to do about it. "The buttons are gone" is
   * what this replaced, and it is the one answer nobody can act on.
   */
  for (const r of [anon, noKey, wrongKey]) assert.ok((r.why ?? "").length > 30);
});

test("an unreadable owner is a refusal, not an approval", () => {
  // Failing open here would show Approve to anybody the moment a read failed.
  const r = canDecideDrops({ operator: true, signer: DEPLOYER, launchpadOwner: null });
  assert.equal(r.ok, false);
});
