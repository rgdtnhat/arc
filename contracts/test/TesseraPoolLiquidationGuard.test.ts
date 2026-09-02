import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * A seizure is priced by the same oracle a withdrawal is, and refused on the
 * same evidence.
 *
 * `startAuction` already said why: "mark a price down, declare somebody
 * liquidatable, buy their collateral at the discount. Seizing on evidence the
 * pool does not believe is exactly what the divergence check exists to stop."
 * That reasoning was applied to the auction and not to `liquidate` — the direct
 * call, one transaction, no auction to wait out. A borrower solvent at the true
 * price could be seized at a stale one, and the collateral taken was valued by
 * the same unbelieved number.
 *
 * `borrow` refuses on unreliable prices, and so does a `withdraw` by anybody
 * who owes anything. This closes the third door.
 */

const P = (n: number) => BigInt(Math.round(n * 1e8));
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const BTC = (n: number) => BigInt(Math.round(n * 1e8));
const DAY = 24 * 3600;
/** The chain's clock, so a feed reading is never stale on arrival. */
const now = async () =>
  Number((await (await hre.viem.getPublicClient()).getBlock()).timestamp);

async function deployFixture() {
  const [deployer, liquidator, victim, lp] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const cbtc = await hre.viem.deployContract("MockToken", ["cirBTC (mock)", "cirBTC", 8]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);

  const btcFeed = await hre.viem.deployContract("MockAggregator", [8, P(30_000)]);
  const usdcFeed = await hre.viem.deployContract("MockAggregator", [8, P(1)]);
  const oracle = await hre.viem.deployContract("TesseraOracle", [
    deployer.account.address, "0x0000000000000000000000000000000000000000",
  ]);

  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, P(1)]);
  await pool.write.addReserve([cbtc.address, 7000, 8000, 8000, 1000, false, 8, P(30_000)]);
  await oracle.write.configureAsset([cbtc.address, P(30_000), btcFeed.address, 3600, 5000, 0, 500, 7 * DAY]);
  await oracle.write.configureAsset([usdc.address, P(1), usdcFeed.address, 3600, 200, 0, 500, 7 * DAY]);

  for (const who of [liquidator, victim, lp]) {
    await usdc.write.mint([who.account.address, USDC(1_000_000)]);
    await cbtc.write.mint([who.account.address, BTC(20)]);
    await (await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } }))
      .write.approve([pool.address, USDC(1_000_000)]);
    await (await hre.viem.getContractAt("MockToken", cbtc.address, { client: { wallet: who } }))
      .write.approve([pool.address, BTC(20)]);
  }

  const as = (who: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: who } });
  const arm = () => pool.write.setWiring([1, oracle.address]);
  await (await as(lp)).write.supply([usdc.address, USDC(500_000)]);
  return { deployer, liquidator, victim, lp, usdc, cbtc, pool, oracle, btcFeed, as, arm };
}

/** A borrower under water on the pool's own mark, with the oracle armed. */
async function underwater() {
  const f = await loadFixture(deployFixture);
  await (await f.as(f.victim)).write.supply([f.cbtc.address, BTC(1)]);
  await (await f.as(f.victim)).write.borrow([f.usdc.address, USDC(15_000)]);
  // The mark drops; both sources agree, so the pool believes it.
  await f.pool.write.setPrice([f.cbtc.address, P(18_000)]);
  await f.oracle.write.setPrice([f.cbtc.address, P(18_000)]);
  await f.btcFeed.write.set([P(18_000), BigInt(await now())]);
  await f.arm();
  // Health below 1.0 is the seizure line — `accountData` reports distance to
  // liquidation, not to the borrow cap.
  const [, , , health] = await f.pool.read.accountData([f.victim.account.address]);
  expect(health < 10n ** 18n).to.equal(true, "the borrower is not actually seizable");
  return f;
}

/** Push the two sources apart, past the 5% divergence bar. */
async function makeUnreliable(f: Awaited<ReturnType<typeof underwater>>) {
  await f.btcFeed.write.set([P(9_000), BigInt(await now())]);
}

it("liquidates normally when the pool believes its prices", async () => {
  const f = await underwater();
  const before = await f.pool.read.supplyBalance([f.cbtc.address, f.liquidator.account.address]);
  await (await f.as(f.liquidator)).write.liquidate([
    f.victim.account.address, f.usdc.address, f.cbtc.address, USDC(1_000),
  ]);
  const after = await f.pool.read.supplyBalance([f.cbtc.address, f.liquidator.account.address]);
  expect(after > before).to.equal(true, "no collateral was seized");
});

it("refuses to seize on prices it does not believe", async () => {
  const f = await underwater();
  await makeUnreliable(f);
  await expect((await f.as(f.liquidator)).write.liquidate([
    f.victim.account.address, f.usdc.address, f.cbtc.address, USDC(1_000),
  ])).to.be.rejected;
  // Untouched — not partly seized and then reverted.
  expect(await f.pool.read.supplyBalance([f.cbtc.address, f.liquidator.account.address])).to.equal(0n);
  expect(await f.pool.read.supplyBalance([f.cbtc.address, f.victim.account.address])).to.equal(BTC(1));
});

it("refuses the auction on the same evidence, as it always did", async () => {
  const f = await underwater();
  await makeUnreliable(f);
  await expect((await f.as(f.liquidator)).write.startAuction([
    f.victim.account.address, f.usdc.address, f.cbtc.address, 5000,
  ])).to.be.rejected;
});

it("the borrower can still repay while seizure is refused", async () => {
  // Failing closed must not trap somebody in a position they are trying to fix.
  const f = await underwater();
  await makeUnreliable(f);
  const before = await f.pool.read.borrowBalance([f.usdc.address, f.victim.account.address]);
  await (await f.as(f.victim)).write.repay([f.usdc.address, USDC(1_000)]);
  const after = await f.pool.read.borrowBalance([f.usdc.address, f.victim.account.address]);
  expect(before - after >= USDC(999)).to.equal(true);
});

it("seizure resumes once the sources agree again", async () => {
  // The refusal is a pause, not a brick.
  const f = await underwater();
  await makeUnreliable(f);
  await expect((await f.as(f.liquidator)).write.liquidate([
    f.victim.account.address, f.usdc.address, f.cbtc.address, USDC(1_000),
  ])).to.be.rejected;

  await f.btcFeed.write.set([P(18_000), BigInt(await now())]);
  await (await f.as(f.liquidator)).write.liquidate([
    f.victim.account.address, f.usdc.address, f.cbtc.address, USDC(1_000),
  ]);
  expect(await f.pool.read.supplyBalance([f.cbtc.address, f.liquidator.account.address]) > 0n).to.equal(true);
});
