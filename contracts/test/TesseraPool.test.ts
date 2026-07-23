import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const WAD = 10n ** 18n;
const PRICE = 10n ** 8n; // $1.00 in 1e8 scale
const BTC_PRICE = 30_000n * 10n ** 8n; // $30,000
const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6)); // 6 decimals
const BTC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e8)); // 8 decimals

async function deployFixture() {
  const [deployer, alice, bob, liquidator] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const wbtc = await hre.viem.deployContract("MockToken", ["Mock BTC", "wBTC", 8]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);

  // USDC: borrowable, 90% collateral / 95% liability factor, 10% reserve fee.
  await pool.write.addReserve([usdc.address, 9000, 9500, 1000, true, 6, PRICE]);
  // wBTC: collateral only, 70% collateral factor.
  await pool.write.addReserve([wbtc.address, 7000, 8000, 1000, false, 8, BTC_PRICE]);

  async function fundAndApprove(who: any, u: bigint, b: bigint) {
    if (u > 0n) {
      await usdc.write.mint([who.account.address, u]);
      const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
      await c.write.approve([pool.address, u]);
    }
    if (b > 0n) {
      await wbtc.write.mint([who.account.address, b]);
      const c = await hre.viem.getContractAt("MockToken", wbtc.address, { client: { wallet: who } });
      await c.write.approve([pool.address, b]);
    }
  }
  const as = (who: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: who } });

  return { deployer, alice, bob, liquidator, publicClient, usdc, wbtc, pool, fundAndApprove, as };
}

describe("TesseraPool (Blend-inspired lending)", () => {
  it("supplies and lets another account borrow against collateral", async () => {
    const { alice, bob, usdc, wbtc, pool, fundAndApprove, as } = await loadFixture(deployFixture);

    // Alice supplies 1000 USDC of liquidity.
    await fundAndApprove(alice, USDC("1000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("1000")]);
    expect(await usdc.read.balanceOf([pool.address])).to.equal(USDC("1000"));

    // Bob supplies 1 wBTC ($30k) as collateral and borrows 500 USDC.
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([wbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("500")]);

    expect(await usdc.read.balanceOf([bob.account.address])).to.equal(USDC("500"));
    expect(await pool.read.borrowBalance([usdc.address, bob.account.address])).to.equal(USDC("500"));
  });

  it("enforces the collateral factor on borrows", async () => {
    const { alice, bob, usdc, wbtc, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("100000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("100000")]);

    await fundAndApprove(bob, 0n, BTC("1")); // $30k, 70% CF → $21k borrow limit
    await (await as(bob)).write.supply([wbtc.address, BTC("1")]);

    // 22,000 USDC would exceed the ~21,000 limit (USDC lFactor 95% → ~21k usable).
    await expect((await as(bob)).write.borrow([usdc.address, USDC("22000")])).to.be.rejected;
    // 18,000 is comfortably within the limit.
    await (await as(bob)).write.borrow([usdc.address, USDC("18000")]);
  });

  it("accrues interest: borrower owes more, supplier earns, treasury takes a cut", async () => {
    const { deployer, alice, bob, usdc, wbtc, pool, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("1000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("1000")]);
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([wbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("800")]); // 80% utilization

    const debt0 = await pool.read.borrowBalance([usdc.address, bob.account.address]);
    const supply0 = await pool.read.supplyBalance([usdc.address, alice.account.address]);

    await time.increase(365 * 24 * 3600); // one year
    // Poke accrual with a no-op-ish interaction.
    await fundAndApprove(bob, USDC("1"), 0n);
    await (await as(bob)).write.repay([usdc.address, USDC("1")]);

    const debt1 = await pool.read.borrowBalance([usdc.address, bob.account.address]);
    const supply1 = await pool.read.supplyBalance([usdc.address, alice.account.address]);
    const treasuryBal = await pool.read.supplyBalance([usdc.address, deployer.account.address]);

    // At 80% utilization the borrow APR is ~5%; a year of it should grow the debt.
    expect(debt1 > debt0 - USDC("1")).to.equal(true); // net of the 1 USDC repaid
    expect(supply1 > supply0).to.equal(true); // supplier earned interest
    expect(treasuryBal > 0n).to.equal(true); // protocol reserve fee accrued
  });

  it("blocks withdrawals that would make the account insolvent", async () => {
    const { alice, bob, usdc, wbtc, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("100000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("100000")]);
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([wbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("18000")]);

    // Withdrawing the collateral out from under an open loan must fail.
    await expect((await as(bob)).write.withdraw([wbtc.address, BTC("1")])).to.be.rejected;
  });

  it("liquidates an unhealthy position and rewards the liquidator", async () => {
    const { alice, bob, liquidator, usdc, wbtc, pool, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("100000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("100000")]);
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([wbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("19000")]); // near the $21k limit

    // BTC crashes to $22k → Bob's 70%×$22k = $15.4k limit now sits below his debt.
    await pool.write.setPrice([wbtc.address, 22_000n * PRICE]);

    const acct = await pool.read.accountData([bob.account.address]);
    expect(acct[3] < WAD).to.equal(true); // healthFactor < 1 → liquidatable

    // Liquidator repays 5,000 USDC of Bob's debt and seizes wBTC at a 10% bonus.
    await fundAndApprove(liquidator, USDC("5000"), 0n);
    await (await as(liquidator)).write.liquidate([
      bob.account.address,
      usdc.address,
      wbtc.address,
      USDC("5000"),
    ]);

    // Bob's debt shrank by ~5,000 (plus a sliver of accrued interest); the
    // liquidator now holds seized wBTC collateral in the pool.
    const debtAfter = await pool.read.borrowBalance([usdc.address, bob.account.address]);
    expect(debtAfter >= USDC("14000") && debtAfter < USDC("14001")).to.equal(true);
    expect((await pool.read.supplyBalance([wbtc.address, liquidator.account.address])) > 0n).to.equal(true);
  });

  it("won't liquidate a healthy position", async () => {
    const { alice, bob, liquidator, usdc, wbtc, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("100000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("100000")]);
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([wbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("5000")]); // very safe

    await fundAndApprove(liquidator, USDC("5000"), 0n);
    await expect(
      (await as(liquidator)).write.liquidate([bob.account.address, usdc.address, wbtc.address, USDC("1000")])
    ).to.be.rejected;
  });

  it("reports utilization and a non-zero borrow APR", async () => {
    const { alice, bob, usdc, wbtc, pool, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("1000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("1000")]);
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([wbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("500")]);

    const [cash, borrows, util, borrowApr, supplyApr] = await pool.read.reserveData([usdc.address]);
    expect(cash).to.equal(USDC("500"));
    expect(borrows).to.equal(USDC("500"));
    expect(util).to.equal(WAD / 2n); // 50%
    expect(borrowApr > 0n).to.equal(true);
    expect(supplyApr > 0n).to.equal(true);
    expect(supplyApr < borrowApr).to.equal(true);
  });
});
