import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const RWD = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // 18dp reward
const SUPPLY = 0;
const BORROW = 1;

/**
 * Emissions: an operator-funded reward on top of whatever interest the pool
 * produces.
 *
 * The interesting behaviour is not "does it pay" but what happens when the
 * bookkeeping and reality disagree — a user who withdraws without checkpointing,
 * a pot that runs dry, an operator who wants their unspent budget back.
 */
async function deployFixture() {
  const [deployer, alice, bob] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockToken", ["USD Coin", "USDC", 6]);
  const reward = await hre.viem.deployContract("MockToken", ["Reward", "RWD", 18]);
  const pool = await hre.viem.deployContract("MockSharePool");
  const em = await hre.viem.deployContract("TesseraEmissions", [pool.address, deployer.account.address]);

  await reward.write.mint([deployer.account.address, RWD(10_000_000)]);
  await reward.write.approve([em.address, RWD(10_000_000)]);
  await em.write.setRewardToken([reward.address]);

  const emAs = async (w: any) => hre.viem.getContractAt("TesseraEmissions", em.address, { client: { wallet: w } });
  return { deployer, alice, bob, usdc, reward, pool, em, emAs };
}

describe("TesseraEmissions (rewards that cannot outrun the pot)", () => {
  it("pays a lone supplier the whole stream", async () => {
    const f = await loadFixture(deployFixture);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);

    await f.em.write.fund([RWD(10_000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]); // one per second
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);

    await time.increase(100);
    const due = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
    expect(due > RWD(98)).to.equal(true);
    expect(due < RWD(103)).to.equal(true);

    const a = await f.emAs(f.alice);
    await a.write.claim([[f.usdc.address], [SUPPLY]]);
    expect(await f.reward.read.balanceOf([f.alice.account.address]) > RWD(98)).to.equal(true);
  });

  it("splits a stream by share, not by head count", async () => {
    const f = await loadFixture(deployFixture);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 750n, 0n]);
    await f.pool.write.setShares([f.usdc.address, f.bob.account.address, 250n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);

    await f.em.write.fund([RWD(10_000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await f.em.write.checkpoint([f.bob.account.address, f.usdc.address, SUPPLY]);

    await time.increase(1000);
    const a = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
    const b = await f.em.read.claimable([f.bob.account.address, f.usdc.address, SUPPLY]);
    expect(a > b * 2n).to.equal(true);
    expect(a < b * 4n).to.equal(true);
  });

  it("stops paying somebody who withdrew without checkpointing", async () => {
    /*
     * The drain this design exists to prevent: deposit, checkpoint, withdraw,
     * and keep earning on shares that are gone. Accrual takes the minimum of
     * the recorded and the current share count, so the exit registers at once
     * even though the pool never tells this contract anything.
     */
    const f = await loadFixture(deployFixture);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);

    await f.em.write.fund([RWD(10_000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(100);
    expect(await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]) > 0n).to.equal(true);

    // Everything leaves the pool; emissions is never notified.
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 0n, 0n]);
    await time.increase(10_000);

    expect(await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY])).to.equal(0n);
  });

  it("under-pays rather than over-pays a supplier who has not checkpointed", async () => {
    // The other side of the same asymmetry, and the acceptable one.
    const f = await loadFixture(deployFixture);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 100n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 100n, 0n]);

    await f.em.write.fund([RWD(100_000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);

    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);
    await time.increase(100);

    const due = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
    expect(due > 0n).to.equal(true);
    expect(due < RWD(20)).to.equal(true); // a tenth of the stream, not all of it

    // One permissionless call puts them right from here on.
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(100);
    const later = (await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY])) - due;
    expect(later > RWD(97)).to.equal(true);
  });

  it("emits nothing for seconds when nobody held a share", async () => {
    // Otherwise the first depositor after a quiet spell collects the backlog.
    const f = await loadFixture(deployFixture);
    await f.em.write.fund([RWD(10_000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await time.increase(1000);

    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(10);

    const due = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
    expect(due < RWD(20)).to.equal(true); // ten seconds, not a thousand
  });

  it("pays what the pot holds and keeps owing the rest", async () => {
    const f = await loadFixture(deployFixture);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);

    await f.em.write.fund([RWD(5)]); // deliberately thin
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(100);

    const a = await f.emAs(f.alice);
    await a.write.claim([[f.usdc.address], [SUPPLY]]);
    expect(await f.reward.read.balanceOf([f.alice.account.address])).to.equal(RWD(5));
    // The shortfall stays on the books rather than being quietly forgiven.
    expect(await f.em.read.totalOwed() > 0n).to.equal(true);

    await f.em.write.fund([RWD(1000)]);
    await a.write.claim([[f.usdc.address], [SUPPLY]]);
    expect(await f.reward.read.balanceOf([f.alice.account.address]) > RWD(90)).to.equal(true);
  });

  it("will not let the owner sweep what is already owed", async () => {
    const f = await loadFixture(deployFixture);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);

    await f.em.write.fund([RWD(1000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(100);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]); // book the debt

    const owed = await f.em.read.totalOwed();
    expect(owed > 0n).to.equal(true);
    await f.em.write.sweep([f.deployer.account.address, 2n ** 255n]);
    // Whatever was swept, the debt is still fully covered.
    expect(await f.reward.read.balanceOf([f.em.address]) >= owed).to.equal(true);

    const a = await f.emAs(f.alice);
    await a.write.claim([[f.usdc.address], [SUPPLY]]);
    expect(await f.reward.read.balanceOf([f.alice.account.address]) >= owed).to.equal(true);
  });

  it("refuses a reward-token swap while anything is owed", async () => {
    const f = await loadFixture(deployFixture);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);
    await f.em.write.fund([RWD(1000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(50);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);

    const other = await hre.viem.deployContract("MockToken", ["Other", "OTH", 18]);
    await expect(f.em.write.setRewardToken([other.address])).to.be.rejected;
  });

  it("bounds a fat-fingered rate", async () => {
    const f = await loadFixture(deployFixture);
    const max = await f.em.read.MAX_RATE_PER_SECOND();
    await expect(f.em.write.setRate([f.usdc.address, SUPPLY, max + 1n])).to.be.rejected;
    await f.em.write.setRate([f.usdc.address, SUPPLY, max]); // the boundary itself is allowed
  });

  it("only the owner may set rates, the token, or sweep", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.emAs(f.alice);
    await expect(a.write.setRate([f.usdc.address, SUPPLY, 1n])).to.be.rejected;
    await expect(a.write.setRewardToken([f.usdc.address])).to.be.rejected;
    await expect(a.write.sweep([f.alice.account.address, 1n])).to.be.rejected;
  });

  it("rejects a side that is neither supply nor borrow", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.em.write.setRate([f.usdc.address, 2, 1n])).to.be.rejected;
    await expect(f.em.write.accrue([f.usdc.address, 7])).to.be.rejected;
  });

  it("streams the borrow side independently of the supply side", async () => {
    const f = await loadFixture(deployFixture);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
    await f.pool.write.setShares([f.usdc.address, f.bob.account.address, 0n, 500n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 500n]);

    await f.em.write.fund([RWD(10_000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.setRate([f.usdc.address, BORROW, RWD(2)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await f.em.write.checkpoint([f.bob.account.address, f.usdc.address, BORROW]);
    await time.increase(100);

    const a = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
    const b = await f.em.read.claimable([f.bob.account.address, f.usdc.address, BORROW]);
    expect(b > a).to.equal(true); // the borrow stream pays double
    // Neither side leaks into the other.
    expect(await f.em.read.claimable([f.alice.account.address, f.usdc.address, BORROW])).to.equal(0n);
    expect(await f.em.read.claimable([f.bob.account.address, f.usdc.address, SUPPLY])).to.equal(0n);
  });

  it("reports runway, which is the number an operator actually needs", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.em.read.runwaySeconds()).to.equal(2n ** 256n - 1n); // nothing emitting

    await f.em.write.fund([RWD(1000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    const runway = await f.em.read.runwaySeconds();
    expect(runway > 990n).to.equal(true);
    expect(runway < 1010n).to.equal(true);
  });

  it("a claim with nothing earned reverts rather than costing gas for nothing", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.emAs(f.alice);
    await f.em.write.setRate([f.usdc.address, SUPPLY, 0n]);
    await expect(a.write.claim([[f.usdc.address], [SUPPLY]])).to.be.rejected;
  });

  it("mismatched arrays are refused rather than read past the end", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.emAs(f.alice);
    await expect(a.write.claim([[f.usdc.address], []])).to.be.rejected;
    await expect(f.em.write.checkpointMany([f.alice.account.address, [f.usdc.address], []])).to.be.rejected;
  });

  it("a rate change applies from now, not retroactively", async () => {
    const f = await loadFixture(deployFixture);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);
    await f.em.write.fund([RWD(100_000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(100);

    const atOldRate = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(10)]);
    await time.increase(10);
    const after = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
    // ~100 at the old rate plus ~100 at the new one — not 1100, which is what
    // retroactive application would produce.
    expect(after > atOldRate).to.equal(true);
    expect(after < atOldRate * 4n).to.equal(true);
  });

  it("lists every asset that has ever had a rate, once", async () => {
    const f = await loadFixture(deployFixture);
    await f.em.write.setRate([f.usdc.address, SUPPLY, 1n]);
    await f.em.write.setRate([f.usdc.address, BORROW, 1n]);
    await f.em.write.setRate([f.reward.address, SUPPLY, 1n]);
    expect(await f.em.read.streamedAssetCount()).to.equal(2n);
    expect((await f.em.read.streamedAssets([0n])).toLowerCase()).to.equal(f.usdc.address.toLowerCase());
    expect((await f.em.read.streamedAssets([1n])).toLowerCase()).to.equal(f.reward.address.toLowerCase());
  });
});
