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

  it("rejects a side that is none of the three", async () => {
    // Supply, borrow and backstop. Anything past those is a typo, and a typo
    // that silently opened a fourth stream would emit into nothing.
    const f = await loadFixture(deployFixture);
    await expect(f.em.write.setRate([f.usdc.address, 3, 1n])).to.be.rejected;
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

  it("stops emitting while paused, without disturbing what was already earned", async () => {
    /*
     * The property an operator reaching for this switch during an incident
     * needs: the emission actually stops, and the balance people have already
     * earned is untouched — including still being claimable.
     */
    const f = await loadFixture(deployFixture);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);
    await f.em.write.fund([RWD(100_000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(100);

    await f.em.write.setPaused([true]);
    const atPause = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
    expect(atPause > RWD(99)).to.equal(true);

    await time.increase(1000);
    expect(await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY])).to.equal(atPause);

    // Paused rewards are not frozen rewards: the claim still pays.
    const a = await f.emAs(f.alice);
    await a.write.claim([[f.usdc.address], [SUPPLY]]);
    expect(await f.reward.read.balanceOf([f.alice.account.address]) >= atPause).to.equal(true);
  });

  it("does not pay out the paused seconds when it resumes", async () => {
    // A pause that settles up on resume is a deferral, and would mean an
    // operator who paused for a week owes a week of emissions afterwards.
    const f = await loadFixture(deployFixture);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
    await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);
    await f.em.write.fund([RWD(100_000)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);

    await f.em.write.setPaused([true]);
    await time.increase(5000);
    await f.em.write.setPaused([false]);
    await time.increase(100);

    const due = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
    expect(due < RWD(200)).to.equal(true); // ~100, not ~5100
  });

  it("keeps the rates across a pause, so resuming needs no reconstruction", async () => {
    const f = await loadFixture(deployFixture);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(3)]);
    await f.em.write.setPaused([true]);
    expect(await f.em.read.totalRatePerSecond()).to.equal(0n); // paused is stopped, not slow
    await f.em.write.setPaused([false]);
    expect(await f.em.read.totalRatePerSecond()).to.equal(RWD(3));
  });

  it("only the owner may pause", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.emAs(f.alice);
    await expect(a.write.setPaused([true])).to.be.rejected;
  });

  it("lets an appointed rate setter set rates and nothing else", async () => {
    /*
     * This is the gauge's seat: it writes the vote result and cannot touch the
     * reward token, the pot, or the pause.
     */
    const f = await loadFixture(deployFixture);
    const a = await f.emAs(f.alice);
    await expect(a.write.setRate([f.usdc.address, SUPPLY, RWD(1)])).to.be.rejected;

    await f.em.write.setRateSetter([f.alice.account.address]);
    await a.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    expect(await f.em.read.totalRatePerSecond()).to.equal(RWD(1));

    await expect(a.write.setPaused([true])).to.be.rejected;
    await expect(a.write.setRewardToken([f.usdc.address])).to.be.rejected;
    await expect(a.write.sweep([f.alice.account.address, 1n])).to.be.rejected;
    await expect(a.write.setRateSetter([f.bob.account.address])).to.be.rejected;
  });

  it("sets a batch of streams in one call, which is what the gauge writes", async () => {
    const f = await loadFixture(deployFixture);
    await f.em.write.setRatesBatch([[f.usdc.address, f.usdc.address], [SUPPLY, BORROW], [RWD(1), RWD(2)]]);
    expect(await f.em.read.totalRatePerSecond()).to.equal(RWD(3));
    await expect(
      f.em.write.setRatesBatch([[f.usdc.address], [SUPPLY, BORROW], [RWD(1)]]),
    ).to.be.rejected;
  });

  it("sets both sides of a market at once", async () => {
    // `setRates` used to route through `this.setRate`, which made the contract
    // its own caller and failed the owner check every single time.
    const f = await loadFixture(deployFixture);
    await f.em.write.setRates([f.usdc.address, RWD(1), RWD(2)]);
    expect(await f.em.read.totalRatePerSecond()).to.equal(RWD(3));
  });

  describe("the backstop side", () => {
    it("pays a backstop depositor from its own stream", async () => {
      /*
       * A backstop depositor is not a supplier with extra steps: when a
       * position goes underwater faster than it can be liquidated, their pot
       * absorbs the write-off before any supplier is touched. Paying them from
       * the same stream as the supply side would price first-loss at zero.
       */
      const f = await loadFixture(deployFixture);
      const BACKSTOP = 2;
      await f.pool.write.setBackstop([f.usdc.address, f.alice.account.address, 1000n, 1000n]);

      await f.em.write.fund([RWD(10_000)]);
      await f.em.write.setRate([f.usdc.address, BACKSTOP, RWD(1)]);
      await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, BACKSTOP]);
      await time.increase(100);

      const due = await f.em.read.claimable([f.alice.account.address, f.usdc.address, BACKSTOP]);
      expect(due > RWD(98)).to.equal(true);
      const a = await f.emAs(f.alice);
      await a.write.claim([[f.usdc.address], [BACKSTOP]]);
      expect(await f.reward.read.balanceOf([f.alice.account.address]) > RWD(98)).to.equal(true);
    });

    it("keeps the three sides completely separate", async () => {
      const f = await loadFixture(deployFixture);
      const BACKSTOP = 2;
      await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
      await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);
      await f.pool.write.setBackstop([f.usdc.address, f.bob.account.address, 1000n, 1000n]);

      await f.em.write.fund([RWD(100_000)]);
      // The backstop earns more for the same shares — that is the whole point.
      await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
      await f.em.write.setRate([f.usdc.address, BACKSTOP, RWD(3)]);
      await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
      await f.em.write.checkpoint([f.bob.account.address, f.usdc.address, BACKSTOP]);
      await time.increase(1000);

      const supplier = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
      const backer = await f.em.read.claimable([f.bob.account.address, f.usdc.address, BACKSTOP]);
      expect(backer > supplier * 2n).to.equal(true);
      // And neither leaks into the other's side.
      expect(await f.em.read.claimable([f.alice.account.address, f.usdc.address, BACKSTOP])).to.equal(0n);
      expect(await f.em.read.claimable([f.bob.account.address, f.usdc.address, SUPPLY])).to.equal(0n);
    });

    it("stops paying somebody who has pulled their backstop", async () => {
      const f = await loadFixture(deployFixture);
      const BACKSTOP = 2;
      await f.pool.write.setBackstop([f.usdc.address, f.alice.account.address, 1000n, 1000n]);
      await f.em.write.fund([RWD(10_000)]);
      await f.em.write.setRate([f.usdc.address, BACKSTOP, RWD(1)]);
      await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, BACKSTOP]);
      await time.increase(100);

      await f.pool.write.setBackstop([f.usdc.address, f.alice.account.address, 0n, 1000n]);
      const atExit = await f.em.read.claimable([f.alice.account.address, f.usdc.address, BACKSTOP]);
      await time.increase(10_000);
      expect(await f.em.read.claimable([f.alice.account.address, f.usdc.address, BACKSTOP])).to.equal(atExit);
    });

    it("counts all three sides in the totals an operator reads", async () => {
      const f = await loadFixture(deployFixture);
      await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
      await f.em.write.setRate([f.usdc.address, BORROW, RWD(2)]);
      await f.em.write.setRate([f.usdc.address, 2, RWD(4)]);
      expect(await f.em.read.totalRatePerSecond()).to.equal(RWD(7));
    });
  });

  describe("carrying a balance across a redeployment", () => {
    /*
     * This contract has been redeployed three times — for a pause, a corrected
     * pool address, a third side — and each time the balances people had
     * earned stayed behind on a contract with an empty pot. Every one was
     * defensible alone; the pattern was not.
     */
    async function withPrior() {
      const f = await loadFixture(deployFixture);
      // Alice earns on the old contract.
      await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1000n, 0n]);
      await f.pool.write.setTotals([f.usdc.address, 1000n, 0n]);
      await f.em.write.fund([RWD(10_000)]);
      await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
      await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
      await time.increase(100);
      const owed = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);

      const next = await hre.viem.deployContract("TesseraEmissions", [f.pool.address, f.deployer.account.address]);
      await next.write.setRewardToken([f.reward.address]);
      await next.write.setPrior([f.em.address]);
      return { ...f, next, owed };
    }

    it("credits what the old contract says is owed", async () => {
      const f = await withPrior();
      await f.next.write.migrate([f.alice.account.address, f.usdc.address, SUPPLY]);
      const carried = await f.next.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
      expect(carried >= f.owed).to.equal(true);
      expect(await f.next.read.totalOwed() >= f.owed).to.equal(true);
    });

    it("pays a migrated balance out of the same pot, like any other", async () => {
      // A migrated claim is a real claim, not an IOU with different rules.
      const f = await withPrior();
      await f.next.write.migrate([f.alice.account.address, f.usdc.address, SUPPLY]);
      await f.reward.write.approve([f.next.address, RWD(10_000)]);
      await f.next.write.fund([RWD(1000)]);

      const before = await f.reward.read.balanceOf([f.alice.account.address]);
      const a = await hre.viem.getContractAt("TesseraEmissions", f.next.address, { client: { wallet: f.alice } });
      await a.write.claim([[f.usdc.address], [SUPPLY]]);
      expect(await f.reward.read.balanceOf([f.alice.account.address]) > before).to.equal(true);
    });

    it("cannot be carried twice", async () => {
      const f = await withPrior();
      await f.next.write.migrate([f.alice.account.address, f.usdc.address, SUPPLY]);
      const after = await f.next.read.totalMigrated();
      await f.next.write.migrate([f.alice.account.address, f.usdc.address, SUPPLY]);
      expect(await f.next.read.totalMigrated()).to.equal(after);
    });

    it("can be triggered by anybody, for anybody", async () => {
      // A migration only the earner can trigger is one most people never hear
      // about.
      const f = await withPrior();
      const bob = await hre.viem.getContractAt("TesseraEmissions", f.next.address, { client: { wallet: f.bob } });
      await bob.write.migrate([f.alice.account.address, f.usdc.address, SUPPLY]);
      expect(await f.next.read.totalMigrated() > 0n).to.equal(true);
    });

    it("refuses to have its prior repointed", async () => {
      // A pointer an owner could move is a pointer they could aim at a
      // contract reporting whatever balance they like.
      const f = await withPrior();
      await expect(f.next.write.setPrior([f.em.address])).to.be.rejected;
    });

    it("does nothing at all without a prior", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.em.write.migrate([f.alice.account.address, f.usdc.address, SUPPLY])).to.be.rejected;
    });

    it("carries several streams in one transaction", async () => {
      const f = await withPrior();
      await f.next.write.migrateMany([
        f.alice.account.address, [f.usdc.address, f.usdc.address], [SUPPLY, BORROW],
      ]);
      expect(await f.next.read.totalMigrated() > 0n).to.equal(true);
    });
  });
});
