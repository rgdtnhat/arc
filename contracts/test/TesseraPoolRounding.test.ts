import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * No assets move without the shares that account for them.
 *
 * Every share conversion in the pool floors, which is the right direction on
 * the way in and the wrong one on the way out. Once interest has accrued a
 * share is worth more than a unit of the asset, so a small enough withdrawal
 * divides to *zero* shares — and paid out anyway, against a balance it never
 * reduced, as many times as anybody cared to ask. `supply` already refused a
 * deposit that minted nothing; the exit, the borrow and the repayment did not.
 *
 * The sums are under one unit of the asset per call, so this was never worth
 * the gas. That is not the same as it being true.
 */

const PRICE = 10n ** 8n;
const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

async function fixture() {
  const [deployer, alice, bob] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, PRICE]);

  const fund = async (who: any, amount: bigint) => {
    await usdc.write.mint([who.account.address, amount]);
    const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    await c.write.approve([pool.address, amount]);
  };
  const as = (who: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: who } });
  return { deployer, alice, bob, usdc, pool, fund, as };
}

/** Supply, borrow, and let interest run so a share is worth more than a unit. */
async function withAccruedInterest() {
  const f = await loadFixture(fixture);
  await f.fund(f.alice, USDC("1000"));
  await (await f.as(f.alice)).write.supply([f.usdc.address, USDC("1000")]);
  await (await f.as(f.alice)).write.borrow([f.usdc.address, USDC("400")]);
  await time.increase(180 * 24 * 3600);
  // There is no public `accrue`; interest is booked by the next operation, so
  // a second depositor both settles the index and gives Bob a position.
  await f.fund(f.bob, USDC("500"));
  await (await f.as(f.bob)).write.supply([f.usdc.address, USDC("500")]);
  return f;
}

it("a share is worth more than a unit once interest has run", async () => {
  const f = await withAccruedInterest();
  const r = await f.pool.read.reserves([f.usdc.address]);
  const [supplyShares, supplyAssets] = [r[8], r[9]];
  // This is the precondition for everything below: assets outpace shares, so
  // `amount * shares / assets` can floor to nothing.
  expect(supplyAssets > supplyShares).to.equal(true);
});

it("refuses a withdrawal too small to burn a share", async () => {
  const f = await withAccruedInterest();
  const before = await f.pool.read.supplyBalance([f.usdc.address, f.alice.account.address]);
  await expect((await f.as(f.alice)).write.withdraw([f.usdc.address, 1n])).to.be.rejected;
  // Nothing moved, in either direction.
  const after = await f.pool.read.supplyBalance([f.usdc.address, f.alice.account.address]);
  expect(after).to.equal(before);
});

it("a withdrawal that does burn shares still works", async () => {
  const f = await withAccruedInterest();
  const before = await f.pool.read.supplyBalance([f.usdc.address, f.alice.account.address]);
  await (await f.as(f.alice)).write.withdraw([f.usdc.address, USDC("100")]);
  const after = await f.pool.read.supplyBalance([f.usdc.address, f.alice.account.address]);
  expect(before - after >= USDC("100")).to.equal(true);
});

it("a withdrawal cannot be repeated against a balance it never reduces", async () => {
  /*
   * The shape of the defect, as an attacker would have run it: the same call,
   * over and over, each one paying out and leaving the position intact.
   */
  const f = await withAccruedInterest();
  const start = await f.pool.read.supplyBalance([f.usdc.address, f.alice.account.address]);
  const alice = await f.as(f.alice);
  for (let i = 0; i < 3; i++) {
    await expect(alice.write.withdraw([f.usdc.address, 1n])).to.be.rejected;
  }
  expect(await f.pool.read.supplyBalance([f.usdc.address, f.alice.account.address])).to.equal(start);
});

it("refuses a borrow too small to owe a share", async () => {
  const f = await withAccruedInterest();
  const r = await f.pool.read.reserves([f.usdc.address]);
  const [borrowShares, borrowAssets] = [r[10], r[11]];
  expect(borrowAssets > borrowShares).to.equal(true, "no borrow-side interest to floor against");
  // Debt that rounds to nothing is a loan nobody has to repay.
  await expect((await f.as(f.bob)).write.borrow([f.usdc.address, 1n])).to.be.rejected;
  expect(await f.pool.read.borrowBalance([f.usdc.address, f.bob.account.address])).to.equal(0n);
});

it("refuses a repayment too small to clear a share of debt", async () => {
  /*
   * This one took the payer's money, left their debt alone, and wrote down what
   * every *other* borrower owed — `totalBorrowAssets` fell while the shares
   * against it did not.
   */
  const f = await withAccruedInterest();
  // Funded and approved first: a revert for want of an allowance would prove
  // nothing about the guard being tested.
  await f.fund(f.alice, USDC("10"));
  const before = await f.pool.read.reserves([f.usdc.address]);
  await expect((await f.as(f.alice)).write.repay([f.usdc.address, 1n])).to.be.rejected;
  const after = await f.pool.read.reserves([f.usdc.address]);
  expect(after[11]).to.equal(before[11], "total borrowed assets moved without shares moving");
});

it("a repayment that does clear debt still works", async () => {
  const f = await withAccruedInterest();
  await f.fund(f.alice, USDC("50"));
  const before = await f.pool.read.borrowBalance([f.usdc.address, f.alice.account.address]);
  await (await f.as(f.alice)).write.repay([f.usdc.address, USDC("50")]);
  const after = await f.pool.read.borrowBalance([f.usdc.address, f.alice.account.address]);
  expect(before - after >= USDC("49")).to.equal(true);
});
