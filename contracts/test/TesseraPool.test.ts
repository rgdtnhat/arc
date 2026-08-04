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
  const cbtc = await hre.viem.deployContract("MockToken", ["Circle Wrapped Bitcoin (mock)", "cirBTC", 8]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);

  // USDC: borrowable, 90% collateral / 95% liability factor, 10% reserve fee.
  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, PRICE]);
  // cirBTC: collateral only, 70% collateral factor.
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

  return { deployer, alice, bob, liquidator, publicClient, usdc, cbtc, pool, fundAndApprove, as };
}

describe("TesseraPool (lending & borrowing)", () => {
  it("supplies and lets another account borrow against collateral", async () => {
    const { alice, bob, usdc, cbtc, pool, fundAndApprove, as } = await loadFixture(deployFixture);

    // Alice supplies 1000 USDC of liquidity.
    await fundAndApprove(alice, USDC("1000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("1000")]);
    expect(await usdc.read.balanceOf([pool.address])).to.equal(USDC("1000"));

    // Bob supplies 1 cirBTC ($30k) as collateral and borrows 500 USDC.
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([cbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("500")]);

    expect(await usdc.read.balanceOf([bob.account.address])).to.equal(USDC("500"));
    expect(await pool.read.borrowBalance([usdc.address, bob.account.address])).to.equal(USDC("500"));
  });

  it("enforces the collateral factor on borrows", async () => {
    const { alice, bob, usdc, cbtc, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("100000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("100000")]);

    await fundAndApprove(bob, 0n, BTC("1")); // $30k, 70% CF → $21k borrow limit
    await (await as(bob)).write.supply([cbtc.address, BTC("1")]);

    // 22,000 USDC would exceed the ~21,000 limit (USDC lFactor 95% → ~21k usable).
    await expect((await as(bob)).write.borrow([usdc.address, USDC("22000")])).to.be.rejected;
    // 18,000 is comfortably within the limit.
    await (await as(bob)).write.borrow([usdc.address, USDC("18000")]);
  });

  it("accrues interest: borrower owes more, supplier earns, treasury takes a cut", async () => {
    const { deployer, alice, bob, usdc, cbtc, pool, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("1000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("1000")]);
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([cbtc.address, BTC("1")]);
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
    const { alice, bob, usdc, cbtc, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("100000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("100000")]);
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([cbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("18000")]);

    // Withdrawing the collateral out from under an open loan must fail.
    await expect((await as(bob)).write.withdraw([cbtc.address, BTC("1")])).to.be.rejected;
  });

  it("liquidates an unhealthy position and rewards the liquidator", async () => {
    const { alice, bob, liquidator, usdc, cbtc, pool, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("100000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("100000")]);
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([cbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("19000")]); // near the $21k limit

    // BTC crashes to $22k → Bob's 70%×$22k = $15.4k limit now sits below his debt.
    await pool.write.setPrice([cbtc.address, 22_000n * PRICE]);

    const acct = await pool.read.accountData([bob.account.address]);
    expect(acct[3] < WAD).to.equal(true); // healthFactor < 1 → liquidatable

    // Liquidator repays 5,000 USDC of Bob's debt and seizes cirBTC at a 10% bonus.
    await fundAndApprove(liquidator, USDC("5000"), 0n);
    await (await as(liquidator)).write.liquidate([
      bob.account.address,
      usdc.address,
      cbtc.address,
      USDC("5000"),
    ]);

    // Bob's debt shrank by ~5,000 (plus a sliver of accrued interest); the
    // liquidator now holds seized cirBTC collateral in the pool.
    const debtAfter = await pool.read.borrowBalance([usdc.address, bob.account.address]);
    expect(debtAfter >= USDC("14000") && debtAfter < USDC("14001")).to.equal(true);
    expect((await pool.read.supplyBalance([cbtc.address, liquidator.account.address])) > 0n).to.equal(true);
  });

  it("won't liquidate a healthy position", async () => {
    const { alice, bob, liquidator, usdc, cbtc, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("100000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("100000")]);
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([cbtc.address, BTC("1")]);
    await (await as(bob)).write.borrow([usdc.address, USDC("5000")]); // very safe

    await fundAndApprove(liquidator, USDC("5000"), 0n);
    await expect(
      (await as(liquidator)).write.liquidate([bob.account.address, usdc.address, cbtc.address, USDC("1000")])
    ).to.be.rejected;
  });

  it("reports utilization and a non-zero borrow APR", async () => {
    const { alice, bob, usdc, cbtc, pool, fundAndApprove, as } = await loadFixture(deployFixture);
    await fundAndApprove(alice, USDC("1000"), 0n);
    await (await as(alice)).write.supply([usdc.address, USDC("1000")]);
    await fundAndApprove(bob, 0n, BTC("1"));
    await (await as(bob)).write.supply([cbtc.address, BTC("1")]);
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

describe("TesseraPool (borrowing stops before liquidation starts)", () => {
  /**
   * The bug these pin: `borrow()` reverted on `!_healthy` and `liquidate()`
   * reverted on `_healthy` — one line answering both questions. Drawing the last
   * dollar of available credit therefore landed a borrower exactly on the
   * seizure boundary, solvent by a wei and liquidatable one block of interest
   * later. Two risk parameters existed per asset but never formed a buffer.
   *
   * Now `cFactor` caps borrowing and `liqFactor` triggers seizure, with
   * `cFactor < liqFactor` enforced, so borrowing to the limit is an ordinary
   * thing to do rather than a mistake.
   */

  /** Alice posts BTC collateral; Bob supplies the USDC she borrows. */
  async function withCollateral() {
    const fx = await loadFixture(deployFixture);
    await fx.fundAndApprove(fx.alice, 0n, BTC("0.1"));
    await fx.fundAndApprove(fx.bob, USDC("100000"), 0n);
    await (await fx.as(fx.alice)).write.supply([fx.cbtc.address, BTC("0.1")]);
    await (await fx.as(fx.bob)).write.supply([fx.usdc.address, USDC("100000")]);
    return fx;
  }

  it("the borrow limit sits strictly below the liquidation threshold", async () => {
    const fx = await withCollateral();
    const [borrowLimit, liqLimit] = await fx.pool.read.accountLimits([fx.alice.account.address]);
    expect(liqLimit > borrowLimit).to.equal(
      true,
      `liquidation ${liqLimit} must exceed borrow limit ${borrowLimit}`,
    );
    // 7000 vs 8000 bps against the same collateral.
    expect((borrowLimit * 8000n) / 7000n).to.equal(liqLimit);
  });

  it("a borrower at their exact limit is not liquidatable", async () => {
    const fx = await withCollateral();
    const [, , limit] = await fx.pool.read.accountData([fx.alice.account.address]);
    // PRICE_SCALE is 1e8 and USDC is 6dp, so USD -> USDC units is /100. A debt
    // also weighs BPS/lFactor against the limit, so the true cap is scaled by
    // USDC's 9500 liability factor. One unit short of it, to stay inside.
    const draw = (limit * 9500n) / (10_000n * 100n) - 1n;
    await (await fx.as(fx.alice)).write.borrow([fx.usdc.address, draw]);

    const [, , , health] = await fx.pool.read.accountData([fx.alice.account.address]);
    expect(health > WAD).to.equal(true, `fully drawn should still be above 1.0, got ${health}`);

    // And the pool refuses to seize.
    await fx.fundAndApprove(fx.liquidator, USDC("1000"), 0n);
    await expect(
      (await fx.as(fx.liquidator)).write.liquidate([
        fx.alice.account.address, fx.usdc.address, fx.cbtc.address, draw / 2n,
      ]),
    ).to.be.rejectedWith("Healthy");
  });

  it("health measures distance to liquidation, not to the borrow cap", async () => {
    // Read off the borrow limit, a fully-drawn position showed 1.00 while still
    // solvent — the number a borrower watches hit 1 at the moment they were
    // *allowed* to borrow rather than the moment they could be seized.
    const fx = await withCollateral();
    const [, , limit] = await fx.pool.read.accountData([fx.alice.account.address]);
    await (await fx.as(fx.alice)).write.borrow([
      fx.usdc.address, (limit * 9500n) / (10_000n * 100n) - 1n,
    ]);

    const [, , , health] = await fx.pool.read.accountData([fx.alice.account.address]);
    // liqFactor/cFactor = 8000/7000, so the buffer is ~14% before USDC's own
    // liability weighting is applied.
    expect(health > (WAD * 110n) / 100n).to.equal(true, `expected a real buffer, got ${health}`);
  });

  it("refuses a reserve whose factors leave no buffer", async () => {
    const { pool } = await loadFixture(deployFixture);
    const other = await hre.viem.deployContract("MockToken", ["X", "X", 6]);
    // cFactor == liqFactor collapses the two lines back into one.
    await expect(
      pool.write.addReserve([other.address, 8000, 8000, 9000, 1000, true, 6, PRICE]),
    ).to.be.rejectedWith("BadRiskParams");
    // ...and above it is worse still.
    await expect(
      pool.write.addReserve([other.address, 9000, 8000, 9000, 1000, true, 6, PRICE]),
    ).to.be.rejectedWith("BadRiskParams");
  });

  it("lets an operator retune risk without redeploying the pool", async () => {
    // The lever the live pool never had: an asset whose real risk changes could
    // only be answered by redeploying and migrating every supplier.
    const fx = await withCollateral();
    const [before] = await fx.pool.read.accountLimits([fx.alice.account.address]);

    await fx.pool.write.setRiskParams([fx.cbtc.address, 5000, 6500, 8000]);
    const [after, afterLiq] = await fx.pool.read.accountLimits([fx.alice.account.address]);

    expect(after < before).to.equal(true, "tightening cFactor must reduce borrowing power");
    expect(afterLiq > after).to.equal(true, "the buffer survives a retune");
  });

  it("only the owner can retune risk", async () => {
    const { pool, cbtc, bob } = await loadFixture(deployFixture);
    const asBob = await hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: bob } });
    // `onlyOwner` reverts with the custom error NotOwner(), not a string.
    await expect(asBob.write.setRiskParams([cbtc.address, 5000, 6500, 8000])).to.be.rejected;
  });
});
