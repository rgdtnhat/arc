import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const P = (usd: number) => BigInt(Math.round(usd * 1e8));
const HOUR = 3600;
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * A rate limit is only worth having if it survives the attack the naive version
 * fails: waiting for a window boundary and taking two windows back to back.
 * These are written around that.
 */
async function deployFixture() {
  const [deployer, whale, thief] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  const limiter = await hre.viem.deployContract("TesseraRateLimiter", [pool.address]);

  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, P(1)]);

  for (const w of [whale, thief]) await usdc.write.mint([w.account.address, USDC(1_000_000)]);

  const poolAs = async (w: any) =>
    hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: w } });
  const usdcAs = async (w: any) =>
    hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: w } });

  // Seed real liquidity so withdrawals have something to take.
  const uw = await usdcAs(whale);
  await uw.write.approve([pool.address, USDC(1_000_000)]);
  const pw = await poolAs(whale);
  await pw.write.supply([usdc.address, USDC(500_000)]);

  return { deployer, whale, thief, usdc, pool, limiter, poolAs, usdcAs };
}

describe("TesseraRateLimiter (bounding the speed, not just the size)", () => {
  it("is inert until an asset is actually configured", async () => {
    const f = await loadFixture(deployFixture);
    await f.pool.write.setRateLimiter([f.limiter.address]);

    // Wired but unconfigured: metering an asset nobody tuned must not throttle it.
    const pw = await f.poolAs(f.whale);
    await pw.write.withdraw([f.usdc.address, USDC(100_000)]);
    expect(await f.limiter.read.available([f.usdc.address])).to.equal((1n << 256n) - 1n);
  });

  it("lets a full bucket through and stops the next block cold", async () => {
    const f = await loadFixture(deployFixture);
    await f.limiter.write.setLimit([f.usdc.address, USDC(10_000), BigInt(HOUR)]);
    await f.pool.write.setRateLimiter([f.limiter.address]);

    const pw = await f.poolAs(f.whale);
    await pw.write.withdraw([f.usdc.address, USDC(10_000)]);
    await expect(pw.write.withdraw([f.usdc.address, USDC(1_000)])).to.be.rejectedWith("RateLimited");
  });

  it("refills continuously, so a block is a delay and not a lockout", async () => {
    const f = await loadFixture(deployFixture);
    await f.limiter.write.setLimit([f.usdc.address, USDC(10_000), BigInt(HOUR)]);
    await f.pool.write.setRateLimiter([f.limiter.address]);

    const pw = await f.poolAs(f.whale);
    await pw.write.withdraw([f.usdc.address, USDC(10_000)]);

    // Half a period later, half the bucket is back — nobody had to intervene.
    await time.increase(HOUR / 2);
    const avail = await f.limiter.read.available([f.usdc.address]);
    expect(avail >= USDC(4_900) && avail <= USDC(5_100)).to.equal(true);
    await pw.write.withdraw([f.usdc.address, USDC(4_500)]);
  });

  it("does not hand out two periods at a boundary — the hole a resetting window has", async () => {
    const f = await loadFixture(deployFixture);
    await f.limiter.write.setLimit([f.usdc.address, USDC(10_000), BigInt(HOUR)]);
    await f.pool.write.setRateLimiter([f.limiter.address]);

    const pw = await f.poolAs(f.whale);
    // Drain the bucket right at the end of a notional window...
    await time.increase(HOUR);
    await pw.write.withdraw([f.usdc.address, USDC(10_000)]);
    // ...and immediately try for the "next window". A counter that reset here
    // would allow 20,000 in two consecutive blocks.
    await expect(pw.write.withdraw([f.usdc.address, USDC(10_000)])).to.be.rejectedWith("RateLimited");
  });

  it("never lets the bucket overfill, however long it sits idle", async () => {
    const f = await loadFixture(deployFixture);
    await f.limiter.write.setLimit([f.usdc.address, USDC(10_000), BigInt(HOUR)]);
    await time.increase(HOUR * 50);
    expect(await f.limiter.read.available([f.usdc.address])).to.equal(USDC(10_000));
  });

  it("meters borrowing as well as withdrawing — both take cash out", async () => {
    const f = await loadFixture(deployFixture);
    await f.limiter.write.setLimit([f.usdc.address, USDC(5_000), BigInt(HOUR)]);
    await f.pool.write.setRateLimiter([f.limiter.address]);

    const ut = await f.usdcAs(f.thief);
    await ut.write.approve([f.pool.address, USDC(100_000)]);
    const pt = await f.poolAs(f.thief);
    await pt.write.supply([f.usdc.address, USDC(100_000)]);

    await pt.write.borrow([f.usdc.address, USDC(5_000)]);
    // Not a token amount: the bucket refills every second, and at 5,000/hour a
    // single block is worth ~1.4 USDC of budget. The assertion has to ask for
    // more than the refill, or it is testing the clock rather than the limit.
    await expect(pt.write.borrow([f.usdc.address, USDC(1_000)])).to.be.rejectedWith("RateLimited");
  });

  it("does not meter money coming back in", async () => {
    const f = await loadFixture(deployFixture);
    await f.limiter.write.setLimit([f.usdc.address, USDC(5_000), BigInt(HOUR)]);
    await f.pool.write.setRateLimiter([f.limiter.address]);

    const ut = await f.usdcAs(f.thief);
    await ut.write.approve([f.pool.address, USDC(100_000)]);
    const pt = await f.poolAs(f.thief);
    // Supply is inflow: it should not consume a drop of outflow budget.
    await pt.write.supply([f.usdc.address, USDC(100_000)]);
    expect(await f.limiter.read.available([f.usdc.address])).to.equal(USDC(5_000));
  });

  it("can be unhooked in one transaction when the limit is the problem", async () => {
    const f = await loadFixture(deployFixture);
    await f.limiter.write.setLimit([f.usdc.address, USDC(1), BigInt(HOUR)]);
    await f.pool.write.setRateLimiter([f.limiter.address]);

    const pw = await f.poolAs(f.whale);
    await expect(pw.write.withdraw([f.usdc.address, USDC(1_000)])).to.be.rejectedWith("RateLimited");

    // The escape hatch. A guard that could not be removed would be a way to
    // freeze the pool permanently by configuring one asset badly.
    await f.pool.write.setRateLimiter([ZERO]);
    await pw.write.withdraw([f.usdc.address, USDC(1_000)]);
  });

  it("only the pool may spend budget", async () => {
    const f = await loadFixture(deployFixture);
    await f.limiter.write.setLimit([f.usdc.address, USDC(10_000), BigInt(HOUR)]);
    const asThief = await hre.viem.getContractAt("TesseraRateLimiter", f.limiter.address, {
      client: { wallet: f.thief },
    });
    // Otherwise the limiter is a denial-of-service tool: burn the budget, and
    // nobody can withdraw until it refills.
    await expect(asThief.write.consume([f.usdc.address, USDC(10_000)])).to.be.rejectedWith("NotConsumer");
  });

  it("refuses a period so short it is a per-transaction cap, or so long it is a freeze", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.limiter.write.setLimit([f.usdc.address, USDC(1), 60n])).to.be.rejectedWith("BadPeriod");
    await expect(
      f.limiter.write.setLimit([f.usdc.address, USDC(1), BigInt(8 * 24 * HOUR)]),
    ).to.be.rejectedWith("BadPeriod");
  });

  it("does not charge budget for a transaction that was going to revert anyway", async () => {
    const f = await loadFixture(deployFixture);
    await f.limiter.write.setLimit([f.usdc.address, USDC(10_000), BigInt(HOUR)]);
    await f.pool.write.setRateLimiter([f.limiter.address]);

    const pt = await f.poolAs(f.thief);
    // No position, so this fails on balance long before it reaches the meter.
    await expect(pt.write.withdraw([f.usdc.address, USDC(500)])).to.be.rejected;
    expect(await f.limiter.read.available([f.usdc.address])).to.equal(USDC(10_000));
  });

  it("starts full, so switching the limiter on is not itself an outage", async () => {
    const f = await loadFixture(deployFixture);
    await f.limiter.write.setLimit([f.usdc.address, USDC(10_000), BigInt(HOUR)]);
    expect(await f.limiter.read.available([f.usdc.address])).to.equal(USDC(10_000));
    expect(await f.limiter.read.wouldPass([f.usdc.address, USDC(10_000)])).to.equal(true);
  });
});
