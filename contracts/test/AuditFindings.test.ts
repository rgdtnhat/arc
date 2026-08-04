import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex } from "viem";

const P = (usd: number) => BigInt(Math.round(usd * 1e8));
const U = (n: number) => BigInt(Math.round(n * 1e6));
const BTC = (n: number) => BigInt(Math.round(n * 1e8));
const H = (s: string) => keccak256(toHex(s));
const DAY = 24 * 3600;

/**
 * Findings from the audit pass, each written as the thing that should not be
 * possible. These fail against the code as first written.
 */

describe("AUDIT: a delivered payment can be rejected by anybody", () => {
  async function fx() {
    const [guardian, agent, provider, attacker] = await hre.viem.getWalletClients();
    const usdc = await hre.viem.deployContract("MockUSDC");
    const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);
    const policy = await hre.viem.deployContract("TesseraSpendPolicy", [
      guardian.account.address,
      agent.account.address,
      { periodSeconds: DAY, periodCap: U(500), perCounterpartyCap: 0n, allowlistOnly: false, expiresAt: 0n },
    ]);
    await policy.write.setEscrow([escrow.address]);
    await usdc.write.mint([guardian.account.address, U(10_000)]);
    await usdc.write.approve([policy.address, U(10_000)]);
    await policy.write.fund([usdc.address, U(5_000)]);
    const as = (w: any) => hre.viem.getContractAt("TesseraSpendPolicy", policy.address, { client: { wallet: w } });
    const esc = (w: any) => hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: w } });
    return { guardian, agent, provider, attacker, usdc, escrow, policy, as, esc };
  }

  it("a stranger cannot reject a delivery the agent wanted", async () => {
    const { agent, provider, attacker, escrow, policy, as, esc } = await loadFixture(fx);
    const deadline = BigInt(await time.latest()) + 3600n;
    await (await as(agent)).write.openPayment([
      (await escrow.read.usdc()), provider.account.address, U(100), deadline, H("q"),
    ]);
    await (await esc(provider)).write.fulfill([1n, H("r")]);

    /*
     * The policy is the buyer of record, so when it calls `escrow.refund` the
     * escrow sees its own agent rejecting a delivery. Leaving that entry point
     * open to anyone hands a stranger the ability to destroy a purchase the
     * agent wanted, burn the policy's bond to the treasury, and slash an
     * innocent provider's stake — repeatable for the price of gas.
     */
    await expect(
      (await as(attacker)).write.refundPayment([await escrow.read.usdc(), 1n]),
    ).to.be.rejected;

    // And the payment is untouched.
    const p = (await escrow.read.getPayment([1n])) as readonly [string, string, bigint, bigint, string, string, number];
    expect(p[6]).to.equal(2); // still Fulfilled
    void policy;
  });

  it("but anyone may still reclaim one that genuinely timed out", async () => {
    // The permissionless path has a reason to exist: a payment nobody delivered
    // should be recoverable even if the agent key is the thing that went wrong.
    const { agent, provider, attacker, escrow, policy, as } = await loadFixture(fx);
    const deadline = BigInt(await time.latest()) + 60n;
    await (await as(agent)).write.openPayment([
      await escrow.read.usdc(), provider.account.address, U(100), deadline, H("q"),
    ]);
    await time.increaseTo(deadline + 1n);
    await (await as(attacker)).write.refundPayment([await escrow.read.usdc(), 1n]);
    expect(await policy.read.remainingThisPeriod([await escrow.read.usdc()])).to.equal(U(500));
  });

  it("the agent itself can still reject a bad delivery", async () => {
    const { agent, provider, escrow, as, esc } = await loadFixture(fx);
    const deadline = BigInt(await time.latest()) + 3600n;
    await (await as(agent)).write.openPayment([
      await escrow.read.usdc(), provider.account.address, U(100), deadline, H("q"),
    ]);
    await (await esc(provider)).write.fulfill([1n, H("r")]);
    await (await as(agent)).write.refundPayment([await escrow.read.usdc(), 1n]);
    const p = (await escrow.read.getPayment([1n])) as readonly [string, string, bigint, bigint, string, string, number];
    expect(p[6]).to.equal(4); // Refunded
  });
});

describe("AUDIT: a lender with no debt is trapped by an oracle divergence", () => {
  async function fx() {
    const [deployer, lender, borrower] = await hre.viem.getWalletClients();
    const usdc = await hre.viem.deployContract("MockUSDC");
    const cbtc = await hre.viem.deployContract("MockToken", ["cirBTC", "cirBTC", 8]);
    const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
    const feed = await hre.viem.deployContract("MockAggregator", [8, P(30_000)]);
    const oracle = await hre.viem.deployContract("TesseraOracle", [
      deployer.account.address,
      "0x0000000000000000000000000000000000000000",
    ]);
    await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, P(1)]);
    await pool.write.addReserve([cbtc.address, 7000, 8000, 8000, 1000, false, 8, P(30_000)]);
    await oracle.write.configureAsset([cbtc.address, P(30_000), feed.address, 3600, 1000, 0, 500, 7 * DAY]);
    await oracle.write.configureAsset([
      usdc.address, P(1), "0x0000000000000000000000000000000000000000", 0, 200, 0, 500, 7 * DAY,
    ]);
    await pool.write.setRiskOracle([oracle.address]);

    for (const w of [lender, borrower]) {
      await usdc.write.mint([w.account.address, U(500_000)]);
      await cbtc.write.mint([w.account.address, BTC(10)]);
      const u = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: w } });
      const c = await hre.viem.getContractAt("MockToken", cbtc.address, { client: { wallet: w } });
      await u.write.approve([pool.address, U(500_000)]);
      await c.write.approve([pool.address, BTC(10)]);
    }
    const as = (w: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: w } });
    return { deployer, lender, borrower, usdc, cbtc, pool, oracle, feed, as };
  }

  it("a pure depositor can withdraw while sources disagree", async () => {
    const { lender, usdc, feed, as } = await loadFixture(fx);
    await (await as(lender)).write.supply([usdc.address, U(10_000)]);

    // A price nobody can agree on has nothing to do with a depositor who has
    // never borrowed. Blocking their exit is trapping funds during exactly the
    // incident that makes people want them back.
    await feed.write.set([P(5_000), BigInt(await time.latest())]);

    await (await as(lender)).write.withdraw([usdc.address, U(10_000)]);
  });

  it("a borrower's collateral withdrawal is still blocked", async () => {
    // The gate has to keep binding where it matters: pulling collateral out
    // while leveraged raises leverage exactly as borrowing does.
    const { borrower, usdc, cbtc, feed, as } = await loadFixture(fx);
    await (await as(borrower)).write.supply([cbtc.address, BTC(1)]);
    await (await as(borrower)).write.supply([usdc.address, U(50_000)]);
    await (await as(borrower)).write.borrow([usdc.address, U(1_000)]);

    await feed.write.set([P(5_000), BigInt(await time.latest())]);
    await expect((await as(borrower)).write.withdraw([cbtc.address, BTC(1)])).to.be.rejected;
  });

  it("and a borrower can always repay their way out", async () => {
    const { borrower, usdc, cbtc, pool, feed, as } = await loadFixture(fx);
    await (await as(borrower)).write.supply([cbtc.address, BTC(1)]);
    await (await as(borrower)).write.supply([usdc.address, U(50_000)]);
    await (await as(borrower)).write.borrow([usdc.address, U(1_000)]);
    await feed.write.set([P(5_000), BigInt(await time.latest())]);

    await (await as(borrower)).write.repay([usdc.address, U(1_100)]);
    expect(await pool.read.borrowBalance([usdc.address, borrower.account.address])).to.equal(0n);
    // Debt cleared, so the exit reopens.
    await (await as(borrower)).write.withdraw([cbtc.address, BTC(1)]);
  });
});

describe("AUDIT: an oracle that goes silent must not brick the pool", () => {
  async function fx() {
    const [deployer, borrower] = await hre.viem.getWalletClients();
    const usdc = await hre.viem.deployContract("MockUSDC");
    const cbtc = await hre.viem.deployContract("MockToken", ["cirBTC", "cirBTC", 8]);
    const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
    const oracle = await hre.viem.deployContract("TesseraOracle", [
      deployer.account.address,
      "0x0000000000000000000000000000000000000000",
    ]);
    await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, P(1)]);
    await pool.write.addReserve([cbtc.address, 7000, 8000, 8000, 1000, false, 8, P(30_000)]);
    // A one-hour age limit, so "everybody stopped updating" is reachable.
    await oracle.write.configureAsset([
      cbtc.address, P(30_000), "0x0000000000000000000000000000000000000000", 0, 1000, 0, 500, 3600,
    ]);
    await oracle.write.configureAsset([
      usdc.address, P(1), "0x0000000000000000000000000000000000000000", 0, 200, 0, 500, 3600,
    ]);
    await pool.write.setRiskOracle([oracle.address]);

    for (const w of [deployer, borrower]) {
      await usdc.write.mint([w.account.address, U(500_000)]);
      await cbtc.write.mint([w.account.address, BTC(10)]);
      const u = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: w } });
      const c = await hre.viem.getContractAt("MockToken", cbtc.address, { client: { wallet: w } });
      await u.write.approve([pool.address, U(500_000)]);
      await c.write.approve([pool.address, BTC(10)]);
    }
    const as = (w: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: w } });
    await (await as(deployer)).write.supply([usdc.address, U(100_000)]);
    return { deployer, borrower, usdc, cbtc, pool, oracle, as };
  }

  it("a borrower can still repay after every source has aged out", async () => {
    // Every price stale is not a divergence — there is simply nothing to price
    // with. Whatever else that stops, it must not stop somebody closing a debt.
    const { borrower, usdc, cbtc, pool, oracle, as } = await loadFixture(fx);
    await (await as(borrower)).write.supply([cbtc.address, BTC(1)]);
    await (await as(borrower)).write.borrow([usdc.address, U(1_000)]);

    await time.increase(3601);
    expect((await oracle.read.reliable([cbtc.address]))[0]).to.equal(false);

    await (await as(borrower)).write.repay([usdc.address, U(1_100)]);
    expect(await pool.read.borrowBalance([usdc.address, borrower.account.address])).to.equal(0n);
  });

  it("and once the debt is gone the collateral comes out", async () => {
    const { borrower, usdc, cbtc, as } = await loadFixture(fx);
    await (await as(borrower)).write.supply([cbtc.address, BTC(1)]);
    await (await as(borrower)).write.borrow([usdc.address, U(1_000)]);
    await time.increase(3601);
    await (await as(borrower)).write.repay([usdc.address, U(1_100)]);
    await (await as(borrower)).write.withdraw([cbtc.address, BTC(1)]);
  });

  it("supplying more is always allowed — it only ever reduces risk", async () => {
    const { borrower, cbtc, as } = await loadFixture(fx);
    await time.increase(3601);
    await (await as(borrower)).write.supply([cbtc.address, BTC(1)]);
  });

  it("the owner can disarm the oracle to recover, and the pool keeps working", async () => {
    // The escape hatch has to actually work, or a misconfigured oracle is a
    // permanent outage rather than a temporary one.
    const { borrower, usdc, cbtc, pool, as } = await loadFixture(fx);
    await (await as(borrower)).write.supply([cbtc.address, BTC(1)]);
    await time.increase(3601);
    await expect((await as(borrower)).write.borrow([usdc.address, U(100)])).to.be.rejected;

    await pool.write.setRiskOracle(["0x0000000000000000000000000000000000000000"]);
    await (await as(borrower)).write.borrow([usdc.address, U(100)]);
  });
});
