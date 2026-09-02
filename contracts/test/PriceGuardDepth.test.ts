import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const P = (usd: number) => BigInt(Math.round(usd * 1e8));
const U = (n: number) => BigInt(Math.round(n * 1e6));

/**
 * The YieldBlox attack, and the floor that stops it.
 *
 * February 2026: a Stellar lending pool lost $10.2m when a trader moved a
 * thinly-traded asset's price with one large order, the oracle reported the
 * inflated number, and the attacker borrowed against it. The post-mortem named
 * liquidity checks on single-source feeds as the missing safeguard.
 *
 * A TWAP does not fix this on its own. Averaging over time raises the *cost* of
 * holding a false price but not the *feasibility*: against a pool with almost
 * nothing in it, holding a skewed quote for the whole window is cheap relative
 * to what can then be borrowed. These cases pin down that the guard refuses to
 * read a price out of a pool too thin to have set one honestly.
 */
async function deployFixture() {
  const [deployer, lp] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const thin = await hre.viem.deployContract("MockToken", ["Thin Coin", "THIN", 6]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  const amm = await hre.viem.deployContract("TesseraAMM", [deployer.account.address]);
  const guard = await hre.viem.deployContract("TesseraPriceGuard", [amm.address, pool.address]);

  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, P(1)]);
  await pool.write.addReserve([thin.address, 7000, 8000, 8000, 1000, false, 6, P(10)]);
  await amm.write.createPool([[usdc.address, thin.address], 30, 5000, "USDC / THIN"]);

  const seed = async (usdcAmt: bigint, thinAmt: bigint) => {
    await usdc.write.mint([lp.account.address, usdcAmt]);
    await thin.write.mint([lp.account.address, thinAmt]);
    const u = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: lp } });
    const t = await hre.viem.getContractAt("MockToken", thin.address, { client: { wallet: lp } });
    await u.write.approve([amm.address, usdcAmt]);
    await t.write.approve([amm.address, thinAmt]);
    const a = await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: lp } });
    await a.write.addLiquidity([0n, [usdcAmt, thinAmt], 0n]);
  };

  return { deployer, lp, usdc, thin, pool, amm, guard, seed };
}

describe("PriceGuard depth floor (the safeguard YieldBlox was missing)", () => {
  it("reads a price from a pool with real depth", async () => {
    const f = await loadFixture(deployFixture);
    await f.seed(U(50_000), U(5_000)); // 50k USDC of depth
    await f.guard.write.setFeed([f.thin.address, 0n, f.usdc.address, 2500, 60, U(1_000)]);
    await time.increase(120);

    const [held, required, ok] = await f.guard.read.feedLiquidity([f.thin.address]);
    expect(ok).to.equal(true);
    expect(held > required).to.equal(true);
    const [price] = await f.guard.read.twapUsd([f.thin.address]);
    expect(price > 0n).to.equal(true);
  });

  it("refuses to read a price out of a pool too thin to have set one honestly", async () => {
    const f = await loadFixture(deployFixture);
    await f.seed(U(50), U(5)); // 50 USDC — anyone can move this
    await f.guard.write.setFeed([f.thin.address, 0n, f.usdc.address, 2500, 60, U(1_000)]);
    await time.increase(120);

    const [, , ok] = await f.guard.read.feedLiquidity([f.thin.address]);
    expect(ok).to.equal(false);
    const [price] = await f.guard.read.twapUsd([f.thin.address]);
    expect(price).to.equal(0n, "a thin pool must report no price, not a cheap one");
  });

  it("fails to the safe side: a thin pool stops guarding, it does not start dictating", async () => {
    const f = await loadFixture(deployFixture);
    await f.seed(U(50), U(5));
    await f.guard.write.setFeed([f.thin.address, 0n, f.usdc.address, 2500, 60, U(1_000)]);
    await time.increase(120);

    // With no usable reading the guard answers ok, so the operator can still
    // correct a genuinely wrong mark. The alternative — refusing every update
    // whenever the pool is quiet — is a guard that bricks the thing it guards.
    const [ok, reference] = await f.guard.read.check([f.thin.address, P(10)]);
    expect(ok).to.equal(true);
    expect(reference).to.equal(0n, "nothing was compared against");
  });

  it("still catches a bad manual price once the pool is deep enough to trust", async () => {
    const f = await loadFixture(deployFixture);
    await f.seed(U(50_000), U(5_000)); // ~$10 per THIN
    await f.guard.write.setFeed([f.thin.address, 0n, f.usdc.address, 2500, 60, U(1_000)]);
    await time.increase(120);

    // A decimal slip: $100 instead of $10.
    const [ok, , deviationBps] = await f.guard.read.check([f.thin.address, P(100)]);
    expect(ok).to.equal(false);
    expect(deviationBps > 2500n).to.equal(true);
  });

  it("treats a floor of zero as unchecked, so existing feeds keep working", async () => {
    const f = await loadFixture(deployFixture);
    await f.seed(U(50), U(5));
    await f.guard.write.setFeed([f.thin.address, 0n, f.usdc.address, 2500, 60, 0n]);
    await time.increase(120);
    const [price] = await f.guard.read.twapUsd([f.thin.address]);
    expect(price > 0n).to.equal(true);
  });

  it("lets the floor be raised later without resetting the averaging window", async () => {
    const f = await loadFixture(deployFixture);
    await f.seed(U(50), U(5));
    await f.guard.write.setFeed([f.thin.address, 0n, f.usdc.address, 2500, 60, 0n]);
    await time.increase(120);
    expect((await f.guard.read.twapUsd([f.thin.address]))[0] > 0n).to.equal(true);

    // Raising the floor must take effect immediately — a pool that has become
    // thin is a live risk, not something to wait a window for.
    await f.guard.write.setMinLiquidity([f.thin.address, U(1_000)]);
    expect((await f.guard.read.twapUsd([f.thin.address]))[0]).to.equal(0n);
  });

  it("only the owner may move the floor", async () => {
    const f = await loadFixture(deployFixture);
    await f.seed(U(50_000), U(5_000));
    await f.guard.write.setFeed([f.thin.address, 0n, f.usdc.address, 2500, 60, U(1_000)]);
    const asLp = await hre.viem.getContractAt("TesseraPriceGuard", f.guard.address, {
      client: { wallet: f.lp },
    });
    // Otherwise an attacker lowers the floor first and manipulates second.
    await expect(asLp.write.setMinLiquidity([f.thin.address, 0n])).to.be.rejected;
  });

  it("refuses a floor on an asset with no feed", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.guard.write.setMinLiquidity([f.thin.address, U(1)])).to.be.rejectedWith("no feed");
  });

  it("reports depth so an operator can see the margin before it bites", async () => {
    const f = await loadFixture(deployFixture);
    await f.seed(U(2_000), U(200));
    await f.guard.write.setFeed([f.thin.address, 0n, f.usdc.address, 2500, 60, U(1_000)]);
    const [held, required, ok] = await f.guard.read.feedLiquidity([f.thin.address]);
    expect(required).to.equal(U(1_000));
    expect(held >= U(1_900)).to.equal(true);
    expect(ok).to.equal(true);
  });
});
