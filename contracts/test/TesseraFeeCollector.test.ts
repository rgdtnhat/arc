import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n;
const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

async function deployFixture() {
  const [deployer, agentWallet] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 1000, true, 6, PRICE]);
  const vault = await hre.viem.deployContract("TesseraVault", [
    usdc.address,
    pool.address,
    deployer.account.address,
    8000,
    1500,
  ]);
  const swap = await hre.viem.deployContract("TesseraSwap", [pool.address, deployer.account.address, 30, 5000]);

  const collector = await hre.viem.deployContract("TesseraFeeCollector", [
    usdc.address,
    agentWallet.account.address,
    pool.address,
    vault.address,
    swap.address,
  ]);
  // The collector must own the swap desk to be able to seed it.
  await swap.write.transferOwnership([collector.address]);

  // Fund the collector with 100 USDC of "collected fees".
  await usdc.write.mint([collector.address, USDC("100")]);

  return { deployer, agentWallet, usdc, pool, vault, swap, collector };
}

describe("TesseraFeeCollector (fee allocation)", () => {
  it("defaults to a 20/20/20/20/20 split and a weekly cadence", async () => {
    const { collector } = await loadFixture(deployFixture);
    const s = await collector.read.shares();
    expect(s[0]).to.equal(2000); // agent
    expect(s[1]).to.equal(2000); // lending
    expect(s[2]).to.equal(2000); // vault
    expect(s[3]).to.equal(2000); // swap
    expect(s[4]).to.equal(2000); // retained
    expect(await collector.read.interval()).to.equal(7 * 24 * 3600);
  });

  it("allocates fees across agent, lending, vault, swap and retains the rest", async () => {
    const { agentWallet, usdc, pool, vault, swap, collector } = await loadFixture(deployFixture);
    await collector.write.allocateNow();

    // 20 USDC to the agent wallet.
    expect(await usdc.read.balanceOf([agentWallet.account.address])).to.equal(USDC("20"));
    // 20 USDC supplied to the pool as the app's own position.
    expect(await pool.read.supplyBalance([usdc.address, collector.address])).to.equal(USDC("20"));
    // 20 USDC deposited into the vault (collector holds shares).
    expect((await vault.read.sharesOf([collector.address])) > 0n).to.equal(true);
    // 20 USDC seeded into swap inventory.
    expect(await usdc.read.balanceOf([swap.address])).to.equal(USDC("20"));
    // ~20 USDC retained here.
    expect(await usdc.read.balanceOf([collector.address])).to.equal(USDC("20"));
  });

  it("rate-limits the permissionless allocate() to the configured interval", async () => {
    const { usdc, collector } = await loadFixture(deployFixture);
    // Freshly constructed: the interval has not elapsed yet.
    await expect(collector.write.allocate()).to.be.rejected;
    await time.increase(7 * 24 * 3600 + 1);
    await usdc.write.mint([collector.address, USDC("10")]);
    await collector.write.allocate(); // now permitted
    // Immediately again → too soon.
    await expect(collector.write.allocate()).to.be.rejected;
  });

  it("lets the owner retune the split, but only to exactly 100%", async () => {
    const { collector } = await loadFixture(deployFixture);
    await collector.write.setShares([5000, 2500, 2500, 0, 0]);
    const s = await collector.read.shares();
    expect(s[0]).to.equal(5000);
    expect(s[3]).to.equal(0);
    // Anything that doesn't total 100% is rejected.
    await expect(collector.write.setShares([5000, 2500, 2500, 0, 100])).to.be.rejected;
    await expect(collector.write.setShares([1000, 1000, 1000, 1000, 1000])).to.be.rejected;
  });

  it("accepts any cadence from a second to a year, and rejects the rest", async () => {
    const { collector } = await loadFixture(deployFixture);
    await collector.write.setInterval([1]); // every second
    expect(await collector.read.interval()).to.equal(1);
    await collector.write.setInterval([365 * 24 * 3600]); // yearly
    await expect(collector.write.setInterval([0])).to.be.rejected;
    await expect(collector.write.setInterval([365 * 24 * 3600 + 1])).to.be.rejected;
  });

  it("keeps funds safe when a sink is unset (retains instead of losing them)", async () => {
    const { deployer, usdc, collector } = await loadFixture(deployFixture);
    // Clear every sink; nothing can be delivered.
    await collector.write.setSinks([
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
    ]);
    await collector.write.allocateNow();
    // The whole balance is still here — nothing was burned.
    expect(await usdc.read.balanceOf([collector.address])).to.equal(USDC("100"));
    expect(deployer.account.address).to.be.a("string");
  });

  it("restricts admin functions to the owner", async () => {
    const { agentWallet, collector } = await loadFixture(deployFixture);
    const asOther = await hre.viem.getContractAt("TesseraFeeCollector", collector.address, {
      client: { wallet: agentWallet },
    });
    await expect(asOther.write.setShares([5000, 5000, 0, 0, 0])).to.be.rejected;
    await expect(asOther.write.setInterval([60])).to.be.rejected;
    await expect(asOther.write.allocateNow()).to.be.rejected;
  });
});
