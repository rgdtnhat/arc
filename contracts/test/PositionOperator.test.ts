import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Acting on somebody's position because they said you could.
 *
 * `depositFor` needed no permission — paying into a stranger's position can
 * only help them. Taking one *out* is the opposite, and this is what makes it
 * safe to schedule: the holder names an operator, and two rules hold no matter
 * who that operator is.
 *
 *   1. The assets go to the **holder**. Not to the operator, ever. That is the
 *      difference between "act for me" and "take from me", and it is why an
 *      operator permission is not equivalent to handing over the position.
 *   2. Every limit the holder's own call would face still binds, because it is
 *      the same code path with the address supplied rather than assumed.
 *
 * Most of these are refusals, because a permission system is only worth what it
 * refuses.
 */

const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));


async function poolFixture() {
  const [owner, holder, operator, stranger] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const pool = await hre.viem.deployContract("TesseraPool", [owner.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, 100_000_000n]);
  await usdc.write.mint([holder.account.address, USDC("1000")]);
  await usdc.write.approve([pool.address, USDC("1000")], { account: holder.account });
  await pool.write.supply([usdc.address, USDC("500")], { account: holder.account });
  return { pool, usdc, owner, holder, operator, stranger };
}

/** `actFor(asset, user, amount, borrowing)` — false withdraws, true borrows. */
const WITHDRAW = false;
const BORROW = true;

describe("acting on a lending position for its holder", () => {
  it("refuses an operator nobody named", async () => {
    const { pool, usdc, holder, stranger } = await loadFixture(poolFixture);
    await expect(
      pool.write.actFor([usdc.address, holder.account.address, USDC("10"), WITHDRAW], { account: stranger.account }),
    ).to.be.rejected;
  });

  it("pays the holder, never the operator", async () => {
    const { pool, usdc, holder, operator } = await loadFixture(poolFixture);
    await pool.write.setPositionOperator([operator.account.address, true], { account: holder.account });
    const before = await usdc.read.balanceOf([holder.account.address]);
    const opBefore = await usdc.read.balanceOf([operator.account.address]);

    await pool.write.actFor([usdc.address, holder.account.address, USDC("100"), WITHDRAW], { account: operator.account });

    expect(await usdc.read.balanceOf([holder.account.address])).to.equal(before + USDC("100"));
    expect(
      await usdc.read.balanceOf([operator.account.address]),
      "the operator received the funds",
    ).to.equal(opBefore);
    expect(await pool.read.supplyBalance([usdc.address, holder.account.address])).to.equal(USDC("400"));
    expect(await pool.read.supplyBalance([usdc.address, operator.account.address])).to.equal(0n);
  });

  it("sends a borrow to the holder, and leaves the debt with them too", async () => {
    const { pool, usdc, owner, holder, operator } = await loadFixture(poolFixture);
    // Somebody else's deposit gives the pool something to lend.
    await usdc.write.mint([owner.account.address, USDC("1000")]);
    await usdc.write.approve([pool.address, USDC("1000")]);
    await pool.write.supply([usdc.address, USDC("500")]);
    await pool.write.setPositionOperator([operator.account.address, true], { account: holder.account });

    const before = await usdc.read.balanceOf([holder.account.address]);
    const opBefore = await usdc.read.balanceOf([operator.account.address]);
    await pool.write.actFor([usdc.address, holder.account.address, USDC("50"), BORROW], { account: operator.account });

    expect(await usdc.read.balanceOf([holder.account.address])).to.equal(before + USDC("50"));
    expect(await usdc.read.balanceOf([operator.account.address])).to.equal(opBefore);
    expect(await pool.read.borrowBalance([usdc.address, holder.account.address])).to.equal(USDC("50"));
    expect(
      await pool.read.borrowBalance([usdc.address, operator.account.address]),
      "the debt landed on the operator",
    ).to.equal(0n);
  });

  it("stops the moment the holder takes the permission back", async () => {
    const { pool, usdc, holder, operator } = await loadFixture(poolFixture);
    await pool.write.setPositionOperator([operator.account.address, true], { account: holder.account });
    await pool.write.actFor([usdc.address, holder.account.address, USDC("10"), WITHDRAW], { account: operator.account });
    await pool.write.setPositionOperator([operator.account.address, false], { account: holder.account });
    await expect(
      pool.write.actFor([usdc.address, holder.account.address, USDC("10"), WITHDRAW], { account: operator.account }),
    ).to.be.rejected;
  });

  it("cannot be granted on somebody else's behalf", async () => {
    const { pool, holder, operator, stranger } = await loadFixture(poolFixture);
    // A stranger naming an operator only ever names one of *their own*
    // position, which is worth nothing.
    await pool.write.setPositionOperator([operator.account.address, true], { account: stranger.account });
    expect(await pool.read.positionOperator([holder.account.address, operator.account.address])).to.equal(false);
    expect(await pool.read.positionOperator([stranger.account.address, operator.account.address])).to.equal(true);
  });

  it("cannot withdraw more than the holder has", async () => {
    const { pool, usdc, holder, operator } = await loadFixture(poolFixture);
    await pool.write.setPositionOperator([operator.account.address, true], { account: holder.account });
    await expect(
      pool.write.actFor([usdc.address, holder.account.address, USDC("5000"), WITHDRAW], { account: operator.account }),
    ).to.be.rejected;
  });

  it("cannot borrow the holder into an unhealthy position", async () => {
    const { pool, usdc, owner, holder, operator } = await loadFixture(poolFixture);
    await usdc.write.mint([owner.account.address, USDC("5000")]);
    await usdc.write.approve([pool.address, USDC("5000")]);
    await pool.write.supply([usdc.address, USDC("4000")]);
    await pool.write.setPositionOperator([operator.account.address, true], { account: holder.account });
    // Past what 500 of collateral supports at a 90% factor.
    await expect(
      pool.write.actFor([usdc.address, holder.account.address, USDC("490"), BORROW], { account: operator.account }),
    ).to.be.rejected;
  });

  it("cannot withdraw a holder into an unhealthy position either", async () => {
    const { pool, usdc, owner, holder, operator } = await loadFixture(poolFixture);
    await usdc.write.mint([owner.account.address, USDC("5000")]);
    await usdc.write.approve([pool.address, USDC("5000")]);
    await pool.write.supply([usdc.address, USDC("4000")]);
    await pool.write.setPositionOperator([operator.account.address, true], { account: holder.account });
    await pool.write.actFor([usdc.address, holder.account.address, USDC("400"), BORROW], { account: operator.account });
    // Pulling the collateral out from under that debt must not be possible.
    await expect(
      pool.write.actFor([usdc.address, holder.account.address, USDC("450"), WITHDRAW], { account: operator.account }),
    ).to.be.rejected;
  });

  it("still respects a freeze", async () => {
    const { pool, usdc, holder, operator } = await loadFixture(poolFixture);
    await pool.write.setPositionOperator([operator.account.address, true], { account: holder.account });
    await pool.write.setFrozenMany([[usdc.address], 2]); // FREEZE_WITHDRAW
    await expect(
      pool.write.actFor([usdc.address, holder.account.address, USDC("10"), WITHDRAW], { account: operator.account }),
    ).to.be.rejected;
  });

  it("the holder's own withdraw and borrow are unchanged", async () => {
    const { pool, usdc, holder } = await loadFixture(poolFixture);
    const before = await usdc.read.balanceOf([holder.account.address]);
    await pool.write.withdraw([usdc.address, USDC("200")], { account: holder.account });
    expect(await usdc.read.balanceOf([holder.account.address])).to.equal(before + USDC("200"));
    expect(await pool.read.supplyBalance([usdc.address, holder.account.address])).to.equal(USDC("300"));
  });
});

async function vaultFixture() {
  const [owner, holder, operator, stranger] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const pool = await hre.viem.deployContract("TesseraPool", [owner.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, 100_000_000n]);
  const vault = await hre.viem.deployContract("TesseraVault", [
    usdc.address, pool.address, owner.account.address, 8000, 1500,
  ]);
  await usdc.write.mint([holder.account.address, USDC("1000")]);
  await usdc.write.approve([vault.address, USDC("1000")], { account: holder.account });
  await vault.write.deposit([USDC("500")], { account: holder.account });
  return { vault, usdc, holder, operator, stranger };
}

describe("acting on a vault position for its holder", () => {
  it("refuses an operator nobody named", async () => {
    const { vault, holder, stranger } = await loadFixture(vaultFixture);
    await expect(
      vault.write.withdrawFor([holder.account.address, 1000n], { account: stranger.account }),
    ).to.be.rejected;
  });

  it("pays the holder, never the operator", async () => {
    const { vault, usdc, holder, operator } = await loadFixture(vaultFixture);
    await vault.write.setPositionOperator([operator.account.address, true], { account: holder.account });
    const before = await usdc.read.balanceOf([holder.account.address]);
    const opBefore = await usdc.read.balanceOf([operator.account.address]);
    const shares = await vault.read.sharesOf([holder.account.address]);

    await vault.write.withdrawFor([holder.account.address, shares / 2n], { account: operator.account });

    expect(await usdc.read.balanceOf([holder.account.address]) > before, "the holder was not paid").to.equal(true);
    expect(
      await usdc.read.balanceOf([operator.account.address]),
      "the operator received the assets",
    ).to.equal(opBefore);
    expect(await vault.read.sharesOf([operator.account.address])).to.equal(0n);
  });

  it("stops the moment the holder takes the permission back", async () => {
    const { vault, holder, operator } = await loadFixture(vaultFixture);
    await vault.write.setPositionOperator([operator.account.address, true], { account: holder.account });
    await vault.write.withdrawFor([holder.account.address, 1000n], { account: operator.account });
    await vault.write.setPositionOperator([operator.account.address, false], { account: holder.account });
    await expect(
      vault.write.withdrawFor([holder.account.address, 1000n], { account: operator.account }),
    ).to.be.rejected;
  });
});
