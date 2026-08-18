import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Acting on somebody's vault position because they said you could.
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
