import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * The pot is the promise.
 *
 * Accrual and funding used to be independent: a rate booked debt whether or not
 * the contract held a token, so `totalOwed` ran past the balance and the first
 * claimant after a top-up took the lot. Everybody who arrived later was
 * accruing against money already promised to somebody else.
 *
 * Every test here is about one invariant — **a holder may hold, unclaimed, at
 * most their share of what the contract actually has** — and its corollary,
 * that `totalOwed` can never exceed the balance. What that buys is the last
 * test: somebody who supplies late still gets paid.
 */

const SUPPLY = 0;
const BORROW = 1;
/** 18-decimal reward, written in whole tokens. */
const RWD = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

async function fixture() {
  const [deployer, alice, bob, carol] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockToken", ["USD Coin", "USDC", 6]);
  const reward = await hre.viem.deployContract("MockToken", ["Reward", "RWD", 18]);
  const pool = await hre.viem.deployContract("MockSharePool");
  const em = await hre.viem.deployContract("TesseraEmissions", [pool.address, deployer.account.address]);
  await reward.write.mint([deployer.account.address, RWD(10_000_000)]);
  await reward.write.approve([em.address, RWD(10_000_000)]);
  await em.write.setRewardToken([reward.address]);
  const emAs = (w: typeof alice) =>
    hre.viem.getContractAt("TesseraEmissions", em.address, { client: { wallet: w } });
  return { deployer, alice, bob, carol, usdc, reward, pool, em, emAs };
}

type Ctx = Awaited<ReturnType<typeof fixture>>;
type Who = Ctx["alice"];

/**
 * Give these holders these supply shares, in pool units, and set the total.
 *
 * Written in whole tokens and scaled by 1e6, because the share *count* is not
 * incidental here: the accrual index is `emitted × 1e18 ÷ total shares` in a
 * uint128, so a three-digit total and a one-per-second rate overflow it inside
 * a month. Real pool shares are 1e6-scaled, and these read the same as the
 * amounts somebody would actually supply.
 */
async function shares(c: Ctx, rows: [Who, number][]) {
  let total = 0n;
  for (const [who, n] of rows) {
    const units = BigInt(n) * 1_000_000n;
    await c.pool.write.setShares([c.usdc.address, who.account.address, units, 0n]);
    total += units;
  }
  await c.pool.write.setTotals([c.usdc.address, total, 0n]);
}

const claimable = (c: Ctx, who: Who, side = SUPPLY) =>
  c.em.read.claimable([who.account.address, c.usdc.address, side]);

describe("TesseraEmissions — a holder's share of the pot", () => {
  it("stops accruing at the holder's share, however long they wait", async () => {
    const f = await loadFixture(fixture);
    await shares(f, [[f.alice, 1000]]);
    await f.em.write.fund([RWD(100)]);
    // A rate far above what the pot can sustain: unbounded accrual would book
    // 86,400 a day against a pot of 100.
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);

    await time.increase(30 * 24 * 3600);
    // Alice is the only holder, so her share is the whole pot and not a wei
    // more, whatever the rate says.
    expect(await claimable(f, f.alice)).to.equal(RWD(100));

    await time.increase(365 * 24 * 3600);
    expect(await claimable(f, f.alice)).to.equal(RWD(100));
  });

  it("splits the pot by shares, not by who checkpointed first", async () => {
    const f = await loadFixture(fixture);
    await shares(f, [[f.alice, 750], [f.bob, 250]]);
    await f.em.write.fund([RWD(100)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    for (const who of [f.alice, f.bob]) {
      await f.em.write.checkpoint([who.account.address, f.usdc.address, SUPPLY]);
    }
    await time.increase(30 * 24 * 3600);

    // 3:1 in shares, so 75/25 of the pot — even though Alice could have
    // checkpointed first and taken all of it under the old rule.
    expect(await claimable(f, f.alice)).to.equal(RWD(75));
    expect(await claimable(f, f.bob)).to.equal(RWD(25));
  });

  it("never books more than it holds", async () => {
    const f = await loadFixture(fixture);
    await shares(f, [[f.alice, 1000], [f.bob, 1000], [f.carol, 1000]]);
    await f.em.write.fund([RWD(90)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(5)]);
    for (const who of [f.alice, f.bob, f.carol]) {
      await f.em.write.checkpoint([who.account.address, f.usdc.address, SUPPLY]);
    }
    await time.increase(90 * 24 * 3600);
    for (const who of [f.alice, f.bob, f.carol]) {
      await f.em.write.checkpoint([who.account.address, f.usdc.address, SUPPLY]);
    }

    // The invariant the whole change exists for.
    const owed = await f.em.read.totalOwed();
    const held = await f.reward.read.balanceOf([f.em.address]);
    expect(owed <= held).to.equal(true);
    expect(owed).to.equal(RWD(90));
  });

  it("a top-up raises everybody's ceiling, in proportion", async () => {
    const f = await loadFixture(fixture);
    await shares(f, [[f.alice, 1000], [f.bob, 1000]]);
    await f.em.write.fund([RWD(50)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    for (const who of [f.alice, f.bob]) {
      await f.em.write.checkpoint([who.account.address, f.usdc.address, SUPPLY]);
    }
    await time.increase(30 * 24 * 3600);
    expect(await claimable(f, f.alice)).to.equal(RWD(25));

    await f.em.write.fund([RWD(50)]);
    // The pot doubled, so the ceiling did. Nothing else had to happen.
    expect(await claimable(f, f.alice)).to.equal(RWD(50));
  });

  it("gives a late arrival a real share of every top-up", async () => {
    /*
     * The point of the whole change, as a scenario.
     *
     * Alice holds alone while a wildly over-set rate runs for a month, then
     * Carol arrives. Under unbounded accrual Alice's balance would be many
     * times the pot — 2.6 million against 100 — and *every* future top-up would
     * disappear into her first claim. Carol would never be paid anything.
     *
     * What is fair is not that Carol gets a share of what accrued before she
     * arrived; it is that Alice's claim stops at what the pot can actually
     * back, so the next top-up is shared with whoever holds then.
     */
    const f = await loadFixture(fixture);
    await shares(f, [[f.alice, 1000]]);
    await f.em.write.fund([RWD(100)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(30 * 24 * 3600);

    // A month at one per second is 2.6 million. She stops at the pot.
    expect(await claimable(f, f.alice)).to.equal(RWD(100));
    const alice = await f.emAs(f.alice);
    await alice.write.claim([[f.usdc.address], [SUPPLY]]);
    expect(await f.em.read.totalOwed()).to.equal(0n);

    // Carol joins with an equal stake, and the pot is topped up.
    await shares(f, [[f.alice, 1000], [f.carol, 1000]]);
    await f.em.write.checkpoint([f.carol.account.address, f.usdc.address, SUPPLY]);
    await f.em.write.fund([RWD(100)]);
    await time.increase(7 * 24 * 3600);

    // Half each — Alice's month of history buys her nothing extra here.
    expect(await claimable(f, f.carol)).to.equal(RWD(50));
    expect(await claimable(f, f.alice)).to.equal(RWD(50));

    const carol = await f.emAs(f.carol);
    await carol.write.claim([[f.usdc.address], [SUPPLY]]);
    expect(await f.reward.read.balanceOf([f.carol.account.address])).to.equal(RWD(50));
  });

  it("cannot be owed more than it holds, whatever order holders arrive in", async () => {
    // The invariant, against a moving share distribution: book one holder at
    // their share of the whole pot, then add two more and settle everybody.
    const f = await loadFixture(fixture);
    await shares(f, [[f.alice, 1000]]);
    await f.em.write.fund([RWD(100)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(10 * 24 * 3600);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);

    await shares(f, [[f.alice, 1000], [f.bob, 1000], [f.carol, 1000]]);
    for (const who of [f.bob, f.carol]) {
      await f.em.write.checkpoint([who.account.address, f.usdc.address, SUPPLY]);
    }
    await time.increase(10 * 24 * 3600);
    for (const who of [f.alice, f.bob, f.carol]) {
      await f.em.write.checkpoint([who.account.address, f.usdc.address, SUPPLY]);
    }

    const owed = await f.em.read.totalOwed();
    const held = await f.reward.read.balanceOf([f.em.address]);
    expect(owed <= held).to.equal(true, `owed ${owed} against a balance of ${held}`);
  });

  it("an empty pot accrues nothing at all", async () => {
    const f = await loadFixture(fixture);
    await shares(f, [[f.alice, 1000]]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(30 * 24 * 3600);
    // No fiction: an unfunded rate books nothing, rather than a number nobody
    // can be paid.
    expect(await claimable(f, f.alice)).to.equal(0n);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    expect(await f.em.read.totalOwed()).to.equal(0n);
  });

  it("the preview and the settlement agree exactly", async () => {
    const f = await loadFixture(fixture);
    await shares(f, [[f.alice, 1000], [f.bob, 500]]);
    await f.em.write.fund([RWD(60)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(2)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await time.increase(10 * 24 * 3600);

    const preview = await claimable(f, f.alice);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    const settled = await f.em.read.claimable([f.alice.account.address, f.usdc.address, SUPPLY]);
    expect(settled).to.equal(preview);
  });

  it("shares the pot between streams by their rates", async () => {
    const f = await loadFixture(fixture);
    await shares(f, [[f.alice, 1000]]);
    await f.pool.write.setShares([f.usdc.address, f.alice.account.address, 1_000_000_000n, 1_000_000_000n]);
    await f.pool.write.setTotals([f.usdc.address, 1_000_000_000n, 1_000_000_000n]);
    await f.em.write.fund([RWD(100)]);
    // Supply at 3, borrow at 1: the supply side is owed three quarters of the
    // pot because it draws from it three times as fast.
    await f.em.write.setRates([f.usdc.address, RWD(3), RWD(1)]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, BORROW]);
    await time.increase(60 * 24 * 3600);

    expect(await claimable(f, f.alice, SUPPLY)).to.equal(RWD(75));
    expect(await claimable(f, f.alice, BORROW)).to.equal(RWD(25));
  });

  it("keeps what a holder earned when the pot shrinks under them", async () => {
    // Somebody else claiming lowers the pot and therefore the ceiling. That
    // must stop further accrual, never claw back a booked balance.
    const f = await loadFixture(fixture);
    await shares(f, [[f.alice, 1000], [f.bob, 1000]]);
    await f.em.write.fund([RWD(100)]);
    await f.em.write.setRate([f.usdc.address, SUPPLY, RWD(1)]);
    for (const who of [f.alice, f.bob]) {
      await f.em.write.checkpoint([who.account.address, f.usdc.address, SUPPLY]);
    }
    await time.increase(30 * 24 * 3600);
    await f.em.write.checkpoint([f.alice.account.address, f.usdc.address, SUPPLY]);
    const before = await claimable(f, f.alice);

    const bob = await f.emAs(f.bob);
    await bob.write.claim([[f.usdc.address], [SUPPLY]]);
    await time.increase(30 * 24 * 3600);
    expect(await claimable(f, f.alice)).to.equal(before, "an accrued balance was reduced");
  });
});
