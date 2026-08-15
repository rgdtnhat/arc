import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const RWD = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // 18dp reward

/**
 * LP emissions: the same accrual argument as the lending side, keyed by pool.
 *
 * The tests worth having are the ones about disagreement between the books and
 * reality — a provider who pulls liquidity without checkpointing, a pool that
 * disappears, a pot that cannot cover what it promised.
 */
async function deployFixture() {
  const [deployer, alice, bob] = await hre.viem.getWalletClients();

  const reward = await hre.viem.deployContract("MockToken", ["Tessera", "TSRA", 18]);
  const amm = await hre.viem.deployContract("MockAmmPool");
  const em = await hre.viem.deployContract("TesseraLpEmissions", [amm.address, deployer.account.address]);

  await reward.write.mint([deployer.account.address, RWD(10_000_000)]);
  await reward.write.approve([em.address, RWD(10_000_000)]);
  await em.write.setRewardToken([reward.address]);
  await amm.write.setPoolCount([3n]);

  const emAs = async (w: any) => hre.viem.getContractAt("TesseraLpEmissions", em.address, { client: { wallet: w } });
  return { deployer, alice, bob, reward, amm, em, emAs };
}

describe("TesseraLpEmissions (the AMM sink that pays providers, not an address)", () => {
  it("pays a lone provider the whole stream", async () => {
    const f = await loadFixture(deployFixture);
    await f.amm.write.setShares([0n, f.alice.account.address, 1000n]);
    await f.amm.write.setTotalShares([0n, 1000n]);

    await f.em.write.fund([RWD(10_000)]);
    await f.em.write.setRate([0n, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);

    await time.increase(100);
    const due = await f.em.read.claimable([f.alice.account.address, 0n]);
    expect(due > RWD(98)).to.equal(true);
    expect(due < RWD(103)).to.equal(true);

    const a = await f.emAs(f.alice);
    await a.write.claim([[0n]]);
    expect(await f.reward.read.balanceOf([f.alice.account.address]) > RWD(98)).to.equal(true);
  });

  it("splits by share of the pool", async () => {
    const f = await loadFixture(deployFixture);
    await f.amm.write.setShares([0n, f.alice.account.address, 900n]);
    await f.amm.write.setShares([0n, f.bob.account.address, 100n]);
    await f.amm.write.setTotalShares([0n, 1000n]);

    await f.em.write.fund([RWD(10_000)]);
    await f.em.write.setRate([0n, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);
    await f.em.write.checkpoint([f.bob.account.address, 0n]);
    await time.increase(1000);

    const a = await f.em.read.claimable([f.alice.account.address, 0n]);
    const b = await f.em.read.claimable([f.bob.account.address, 0n]);
    expect(a > b * 5n).to.equal(true);
    expect(a < b * 12n).to.equal(true);
  });

  it("stops paying a provider the moment their liquidity leaves", async () => {
    /*
     * The whole reason accrual takes `min(then, now)`. Withdraw and the smaller
     * current figure applies immediately, so nobody keeps earning on money that
     * is no longer in the pool.
     */
    const f = await loadFixture(deployFixture);
    await f.amm.write.setShares([0n, f.alice.account.address, 1000n]);
    await f.amm.write.setTotalShares([0n, 1000n]);
    await f.em.write.fund([RWD(10_000)]);
    await f.em.write.setRate([0n, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);
    await time.increase(100);

    // She pulls out entirely, and never checkpoints.
    await f.amm.write.setShares([0n, f.alice.account.address, 0n]);
    const atExit = await f.em.read.claimable([f.alice.account.address, 0n]);
    await time.increase(10_000);
    expect(await f.em.read.claimable([f.alice.account.address, 0n])).to.equal(atExit);
  });

  it("under-pays rather than over-pays a provider who added without checkpointing", async () => {
    const f = await loadFixture(deployFixture);
    await f.amm.write.setShares([0n, f.alice.account.address, 100n]);
    await f.amm.write.setTotalShares([0n, 100n]);
    await f.em.write.fund([RWD(10_000)]);
    await f.em.write.setRate([0n, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);

    // She multiplies her position tenfold but never settles.
    await f.amm.write.setShares([0n, f.alice.account.address, 1000n]);
    await f.amm.write.setTotalShares([0n, 1000n]);
    await time.increase(100);

    // Accrual is on the old, smaller basis: one tenth of the stream.
    const due = await f.em.read.claimable([f.alice.account.address, 0n]);
    expect(due < RWD(20)).to.equal(true);
    expect(due > 0n).to.equal(true);
  });

  it("emits nothing for seconds when the pool was empty", async () => {
    // Carrying them forward would hand the backlog to whoever deposits first.
    const f = await loadFixture(deployFixture);
    await f.em.write.fund([RWD(10_000)]);
    await f.em.write.setRate([0n, RWD(1)]);
    await time.increase(1000);

    await f.amm.write.setShares([0n, f.alice.account.address, 1000n]);
    await f.amm.write.setTotalShares([0n, 1000n]);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);
    await time.increase(10);
    const due = await f.em.read.claimable([f.alice.account.address, 0n]);
    expect(due < RWD(30)).to.equal(true); // ~10, not ~1010
  });

  it("pays what the pot holds, and never books a debt beyond it", async () => {
    /*
     * This asserted the opposite half of the sentence — that the shortfall was
     * "a debt, not a silence". It was the honest reading of the old design and
     * the source of its unfairness: the debt booked was whatever the earliest
     * provider happened to accumulate, and every later top-up disappeared into
     * it before anybody else could be paid. Accrual is now bounded by the
     * provider's share of the balance, so the shortfall is never booked.
     */
    const f = await loadFixture(deployFixture);
    await f.amm.write.setShares([0n, f.alice.account.address, 1000n]);
    await f.amm.write.setTotalShares([0n, 1000n]);
    await f.em.write.fund([RWD(10)]); // deliberately short
    await f.em.write.setRate([0n, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);
    await time.increase(1000);

    const a = await f.emAs(f.alice);
    await a.write.claim([[0n]]);
    expect(await f.reward.read.balanceOf([f.alice.account.address])).to.equal(RWD(10));
    expect(await f.em.read.totalOwed()).to.equal(0n);
  });

  it("will not let the owner sweep what is already owed", async () => {
    const f = await loadFixture(deployFixture);
    await f.amm.write.setShares([0n, f.alice.account.address, 1000n]);
    await f.amm.write.setTotalShares([0n, 1000n]);
    await f.em.write.fund([RWD(1000)]);
    await f.em.write.setRate([0n, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);
    await time.increase(100);
    await f.em.write.checkpoint([f.alice.account.address, 0n]); // book the debt

    const owed = await f.em.read.totalOwed();
    await f.em.write.sweep([f.deployer.account.address, RWD(1000)]);
    expect(await f.reward.read.balanceOf([f.em.address]) >= owed).to.equal(true);
  });

  it("refuses a rate on a pool that does not exist", async () => {
    // Otherwise it is a stream that emits into a share lookup nobody can satisfy.
    const f = await loadFixture(deployFixture);
    await expect(f.em.write.setRate([99n, RWD(1)])).to.be.rejected;
  });

  it("treats a pool that has gone away as emitting nothing, not as a revert", async () => {
    const f = await loadFixture(deployFixture);
    await f.amm.write.setShares([0n, f.alice.account.address, 1000n]);
    await f.amm.write.setTotalShares([0n, 1000n]);
    await f.em.write.fund([RWD(1000)]);
    await f.em.write.setRate([0n, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);
    await time.increase(100);

    await f.amm.write.setBroken([0n, true]);
    // The checkpoint still succeeds — a broken pool must not lock everybody's
    // other positions behind a revert.
    await f.em.write.checkpoint([f.alice.account.address, 0n]);
    await time.increase(100);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);
  });

  it("stops while paused and does not backdate on resume", async () => {
    const f = await loadFixture(deployFixture);
    await f.amm.write.setShares([0n, f.alice.account.address, 1000n]);
    await f.amm.write.setTotalShares([0n, 1000n]);
    await f.em.write.fund([RWD(100_000)]);
    await f.em.write.setRate([0n, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);

    await f.em.write.setPaused([true]);
    const atPause = await f.em.read.claimable([f.alice.account.address, 0n]);
    await time.increase(5000);
    expect(await f.em.read.claimable([f.alice.account.address, 0n])).to.equal(atPause);
    expect(await f.em.read.totalRatePerSecond()).to.equal(0n);

    await f.em.write.setPaused([false]);
    await time.increase(100);
    const due = await f.em.read.claimable([f.alice.account.address, 0n]);
    expect(due < RWD(200)).to.equal(true);
  });

  it("stops on its own at an end date", async () => {
    const f = await loadFixture(deployFixture);
    await f.amm.write.setShares([0n, f.alice.account.address, 1000n]);
    await f.amm.write.setTotalShares([0n, 1000n]);
    await f.em.write.fund([RWD(100_000)]);

    const block = await (await hre.viem.getPublicClient()).getBlock();
    await f.em.write.setRateUntil([0n, RWD(1), BigInt(block.timestamp) + 100n]);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);

    await time.increase(1000);
    const due = await f.em.read.claimable([f.alice.account.address, 0n]);
    expect(due < RWD(150)).to.equal(true); // ~100 seconds of it, not 1000
    expect(await f.em.read.totalRatePerSecond()).to.equal(0n); // expired, so not an outflow
  });

  it("lets an appointed rate setter set rates and nothing else", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.emAs(f.alice);
    await expect(a.write.setRate([0n, RWD(1)])).to.be.rejected;

    await f.em.write.setRateSetter([f.alice.account.address]);
    await a.write.setRatesBatch([[0n, 1n], [RWD(1), RWD(2)]]);
    expect(await f.em.read.totalRatePerSecond()).to.equal(RWD(3));

    await expect(a.write.setPaused([true])).to.be.rejected;
    await expect(a.write.sweep([f.alice.account.address, 1n])).to.be.rejected;
  });

  it("lists every pool that has ever had a rate, once", async () => {
    const f = await loadFixture(deployFixture);
    await f.em.write.setRate([0n, 1n]);
    await f.em.write.setRate([1n, 1n]);
    await f.em.write.setRate([0n, 2n]);
    expect(await f.em.read.streamedPoolCount()).to.equal(2n);
  });

  it("reports runway, and calls an idle contract indefinite rather than empty", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.em.read.runwaySeconds()).to.equal(2n ** 256n - 1n);
    await f.em.write.fund([RWD(1000)]);
    await f.em.write.setRate([0n, RWD(1)]);
    const runway = await f.em.read.runwaySeconds();
    expect(runway > 990n && runway < 1010n).to.equal(true);
  });

  it("refuses a reward-token swap while anything is owed", async () => {
    const f = await loadFixture(deployFixture);
    await f.amm.write.setShares([0n, f.alice.account.address, 1000n]);
    await f.amm.write.setTotalShares([0n, 1000n]);
    await f.em.write.fund([RWD(1000)]);
    await f.em.write.setRate([0n, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);
    await time.increase(100);
    await f.em.write.checkpoint([f.alice.account.address, 0n]);

    const other = await hre.viem.deployContract("MockToken", ["Other", "OTH", 18]);
    await expect(f.em.write.setRewardToken([other.address])).to.be.rejected;
  });
});
