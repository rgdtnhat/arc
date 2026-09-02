import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n; // $1.00 in 1e8 scale
const BTC_PRICE = 30_000n * 10n ** 8n;
const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));
const BTC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e8));
const MAX = (1n << 256n) - 1n;

/**
 * Caps are the one risk control that bounds the pool in absolute terms rather
 * than by ratio. What matters in these tests is the asymmetry: a cap must stop
 * *new* exposure without ever trapping the exposure already there.
 */
async function deployFixture() {
  const [deployer, alice, bob] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const cbtc = await hre.viem.deployContract("MockToken", ["Circle Wrapped Bitcoin (mock)", "cirBTC", 8]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);

  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, PRICE]);
  await pool.write.addReserve([cbtc.address, 7000, 8000, 8000, 1000, false, 8, BTC_PRICE]);

  async function fundAndApprove(who: any, u: bigint, b: bigint) {
    if (u > 0n) {
      await usdc.write.mint([who.account.address, u]);
      const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
      await c.write.approve([pool.address, u]);
    }
    if (b > 0n) {
      await cbtc.write.mint([who.account.address, b]);
      const c = await hre.viem.getContractAt("MockToken", cbtc.address, { client: { wallet: who } });
      await c.write.approve([pool.address, b]);
    }
  }
  const as = (who: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: who } });

  await fundAndApprove(alice, USDC("100000"), BTC("10"));
  await fundAndApprove(bob, USDC("100000"), BTC("10"));

  return { deployer, alice, bob, usdc, cbtc, pool, fundAndApprove, as };
}

describe("TesseraPool caps (bounding exposure in absolute terms)", () => {
  it("reports everything as uncapped by default", async () => {
    const { pool, usdc } = await loadFixture(deployFixture);
    const [supplyRoom, borrowRoom] = await pool.read.capacityOf([usdc.address]);
    expect(supplyRoom).to.equal(MAX);
    // Borrow room is still clipped to the cash on hand, which is nothing yet.
    expect(borrowRoom).to.equal(0n);
    expect(await pool.read.supplyCap([usdc.address])).to.equal(0n);
    expect(await pool.read.borrowCap([usdc.address])).to.equal(0n);
  });

  it("lets a supply land exactly on the cap, and stops the next unit", async () => {
    const { alice, usdc, pool, as } = await loadFixture(deployFixture);
    await pool.write.setCaps([usdc.address, USDC("1000"), 0n]);

    await (await as(alice)).write.supply([usdc.address, USDC("1000")]);
    expect((await pool.read.capacityOf([usdc.address]))[0]).to.equal(0n);

    await expect((await as(alice)).write.supply([usdc.address, 1n])).to.be.rejected;
  });

  it("counts every supplier against one shared cap", async () => {
    const { alice, bob, usdc, pool, as } = await loadFixture(deployFixture);
    await pool.write.setCaps([usdc.address, USDC("1000"), 0n]);

    await (await as(alice)).write.supply([usdc.address, USDC("600")]);
    // Bob's 600 would take the reserve to 1200, past the line.
    await expect((await as(bob)).write.supply([usdc.address, USDC("600")])).to.be.rejected;
    // 400 fits exactly.
    await (await as(bob)).write.supply([usdc.address, USDC("400")]);
    expect((await pool.read.capacityOf([usdc.address]))[0]).to.equal(0n);
  });

  it("stops borrowing at the borrow cap even with cash to spare", async () => {
    const { alice, bob, usdc, cbtc, pool, as } = await loadFixture(deployFixture);
    await (await as(alice)).write.supply([usdc.address, USDC("50000")]);
    await pool.write.setCaps([usdc.address, 0n, USDC("1000")]);

    // Bob has plenty of collateral; the cap is what binds, not his health.
    await (await as(bob)).write.supply([cbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("1000")]);
    await expect((await as(bob)).write.borrow([usdc.address, USDC("1")])).to.be.rejected;

    const [, borrowRoom] = await pool.read.capacityOf([usdc.address]);
    expect(borrowRoom).to.equal(0n);
  });

  it("reports borrow room as the smaller of the cap and the cash", async () => {
    const { alice, usdc, pool, as } = await loadFixture(deployFixture);
    await (await as(alice)).write.supply([usdc.address, USDC("500")]);
    // Cap far above the cash on hand.
    await pool.write.setCaps([usdc.address, 0n, USDC("100000")]);
    expect((await pool.read.capacityOf([usdc.address]))[1]).to.equal(USDC("500"));

    // Cap below the cash on hand.
    await pool.write.setCaps([usdc.address, 0n, USDC("120")]);
    expect((await pool.read.capacityOf([usdc.address]))[1]).to.equal(USDC("120"));
  });

  it("never traps an existing position when a cap is set below current usage", async () => {
    const { alice, bob, usdc, cbtc, pool, as } = await loadFixture(deployFixture);
    await (await as(alice)).write.supply([usdc.address, USDC("50000")]);
    await (await as(bob)).write.supply([cbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("10000")]);

    // Wind the reserve down: both caps now sit well under what is outstanding.
    await pool.write.setCaps([usdc.address, USDC("1000"), USDC("500")]);
    expect((await pool.read.capacityOf([usdc.address]))[0]).to.equal(0n);
    expect((await pool.read.capacityOf([usdc.address]))[1]).to.equal(0n);

    // Nothing new gets in...
    await expect((await as(alice)).write.supply([usdc.address, USDC("1")])).to.be.rejected;
    await expect((await as(bob)).write.borrow([usdc.address, USDC("1")])).to.be.rejected;

    // ...but everyone already inside can still get out.
    await (await as(alice)).write.withdraw([usdc.address, USDC("5000")]);
    const bobUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: bob } });
    await bobUsdc.write.approve([pool.address, USDC("10000")]);
    await (await as(bob)).write.repay([usdc.address, USDC("5000")]);
    await (await as(bob)).write.withdraw([cbtc.address, BTC("0.1")]);
  });

  it("frees room again as the reserve shrinks", async () => {
    const { alice, usdc, pool, as } = await loadFixture(deployFixture);
    await pool.write.setCaps([usdc.address, USDC("1000"), 0n]);
    await (await as(alice)).write.supply([usdc.address, USDC("1000")]);
    await expect((await as(alice)).write.supply([usdc.address, USDC("1")])).to.be.rejected;

    await (await as(alice)).write.withdraw([usdc.address, USDC("400")]);
    expect((await pool.read.capacityOf([usdc.address]))[0]).to.equal(USDC("400"));
    await (await as(alice)).write.supply([usdc.address, USDC("400")]);
  });

  it("caps each reserve on its own", async () => {
    const { alice, usdc, cbtc, pool, as } = await loadFixture(deployFixture);
    await pool.write.setCaps([usdc.address, USDC("100"), 0n]);
    await expect((await as(alice)).write.supply([usdc.address, USDC("200")])).to.be.rejected;
    // cirBTC was never capped.
    await (await as(alice)).write.supply([cbtc.address, BTC("5")]);
    expect((await pool.read.capacityOf([cbtc.address]))[0]).to.equal(MAX);
  });

  it("clearing a cap restores unlimited room", async () => {
    const { alice, usdc, pool, as } = await loadFixture(deployFixture);
    await pool.write.setCaps([usdc.address, USDC("100"), 0n]);
    await expect((await as(alice)).write.supply([usdc.address, USDC("200")])).to.be.rejected;
    await pool.write.setCaps([usdc.address, 0n, 0n]);
    await (await as(alice)).write.supply([usdc.address, USDC("200")]);
    expect((await pool.read.capacityOf([usdc.address]))[0]).to.equal(MAX);
  });

  it("only the owner may set caps, and only on a real reserve", async () => {
    const { alice, bob, usdc, pool, as } = await loadFixture(deployFixture);
    await expect((await as(alice)).write.setCaps([usdc.address, USDC("1"), 0n])).to.be.rejected;
    await expect(pool.write.setCaps([bob.account.address, USDC("1"), 0n])).to.be.rejected;
  });

  it("lets interest push a reserve past its cap rather than reverting accrual", async () => {
    const { alice, bob, usdc, cbtc, pool, as } = await loadFixture(deployFixture);
    await (await as(alice)).write.supply([usdc.address, USDC("10000")]);
    await (await as(bob)).write.supply([cbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("8000")]);

    // Pin the caps to exactly where the reserve sits right now.
    const before = await pool.read.capacityOf([usdc.address]);
    expect(before[0]).to.equal(MAX);
    await pool.write.setCaps([usdc.address, USDC("10000"), USDC("8000")]);

    // A year of interest at high utilization takes both totals past their caps.
    await hre.network.provider.send("evm_increaseTime", [365 * 24 * 3600]);
    await hre.network.provider.send("evm_mine");

    // Accrual still succeeds — repaying is exactly what a capped reserve wants.
    const bobUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: bob } });
    await bobUsdc.write.approve([pool.address, USDC("20000")]);
    await (await as(bob)).write.repay([usdc.address, USDC("1000")]);

    // And the reserve is genuinely over its supply cap now, reported as zero room.
    expect((await pool.read.capacityOf([usdc.address]))[0]).to.equal(0n);
  });
});
