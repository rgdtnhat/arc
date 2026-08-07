import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";

const T = (n: number) => BigInt(n) * 10n ** 18n;
const HUNDRED_BILLION = 100_000_000_000n * 10n ** 18n;
const WEEK = 7 * 24 * 3600;
const SUPPLY = 0;
const BORROW = 1;

/**
 * The gauge is a vote with money attached, so most of what matters is what it
 * refuses: weight bought after voting opened, the same tokens voting twice from
 * two addresses, a bribe claimed before the denominator stopped moving, a
 * market that keeps last week's rate after losing its place.
 *
 * It writes to the real emissions contracts rather than a recording mock,
 * because the thing being tested is whether the result actually lands.
 */
async function deployFixture() {
  const [admin, alice, bob, carol] = await hre.viem.getWalletClients();

  const treasury = await hre.viem.deployContract("MockFundSink", [admin.account.address]);
  const token = await hre.viem.deployContract("TesseraToken", [admin.account.address]);
  const usdc = await hre.viem.deployContract("MockToken", ["USD Coin", "USDC", 6]);
  const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin", "EURC", 6]);

  const pool = await hre.viem.deployContract("MockSharePool");
  const amm = await hre.viem.deployContract("MockAmmPool");
  await amm.write.setPoolCount([3n]);

  const lending = await hre.viem.deployContract("TesseraEmissions", [pool.address, admin.account.address]);
  const lp = await hre.viem.deployContract("TesseraLpEmissions", [amm.address, admin.account.address]);
  await lending.write.setRewardToken([token.address]);
  await lp.write.setRewardToken([token.address]);

  const gauge = await hre.viem.deployContract("TesseraGauge", [token.address, admin.account.address, BigInt(WEEK)]);
  await gauge.write.setEmissions([lending.address, lp.address]);
  await lending.write.setRateSetter([gauge.address]);
  await lp.write.setRateSetter([gauge.address]);

  // A thousand tokens circulate; the rest sits in the lock.
  await token.write.transfer([alice.account.address, T(600)]);
  await token.write.transfer([bob.account.address, T(300)]);
  await token.write.transfer([carol.account.address, T(100)]);
  await token.write.transfer([treasury.address, HUNDRED_BILLION - T(1000)]);

  const as = async (name: string, address: `0x${string}`, w: any) =>
    hre.viem.getContractAt(name as never, address, { client: { wallet: w } });
  for (const who of [alice, bob, carol]) {
    const t = await as("TesseraToken", token.address, who);
    await (t as any).write.delegate([who.account.address]);
  }
  await mine(1);

  // Four markets: two lending reserves, two AMM pools.
  await gauge.write.addLendingMarket([usdc.address, SUPPLY, "USDC supply"]);
  await gauge.write.addLendingMarket([eurc.address, SUPPLY, "EURC supply"]);
  await gauge.write.addAmmMarket([0n, [usdc.address, eurc.address], "USDC/EURC"]);
  await gauge.write.addAmmMarket([1n, [usdc.address], "USDC/cirBTC"]);
  await gauge.write.setBudget([T(10), T(4)]); // per second, per venue

  const gaugeAs = async (w: any) => hre.viem.getContractAt("TesseraGauge", gauge.address, { client: { wallet: w } });
  return { admin, alice, bob, carol, token, usdc, eurc, pool, amm, lending, lp, gauge, gaugeAs, treasury };
}

describe("TesseraGauge (holders choose where the emissions land)", () => {
  it("records a vote against the caller's snapshot weight", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    await a.write.vote([[0n, 2n], [T(400), T(200)]]);

    expect(await f.gauge.read.marketVotes([0n, 0n])).to.equal(T(400));
    expect(await f.gauge.read.marketVotes([0n, 2n])).to.equal(T(200));
    expect(await f.gauge.read.totalVotes([0n])).to.equal(T(600));
  });

  it("refuses to let anyone vote with more than they hold", async () => {
    const f = await loadFixture(deployFixture);
    const c = await f.gaugeAs(f.carol); // 100 tokens
    await expect(c.write.vote([[0n], [T(500)]])).to.be.rejected;
  });

  it("lets a voter hold weight back, because abstaining in part is a real choice", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    await a.write.vote([[0n], [T(100)]]); // of 600
    expect(await f.gauge.read.totalVotes([0n])).to.equal(T(100));
    expect(await f.gauge.read.availableWeight([f.alice.account.address])).to.equal(T(500));
  });

  it("replaces a re-vote rather than stacking it", async () => {
    /*
     * A vote is a position, not a queue of instructions. Stacking would let
     * somebody vote their weight once per call and would make it impossible to
     * say what anybody has actually voted for.
     */
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    await a.write.vote([[0n], [T(600)]]);
    await a.write.vote([[1n], [T(600)]]);

    expect(await f.gauge.read.marketVotes([0n, 0n])).to.equal(0n);
    expect(await f.gauge.read.marketVotes([0n, 1n])).to.equal(T(600));
    expect(await f.gauge.read.totalVotes([0n])).to.equal(T(600));
  });

  it("gives nothing to weight acquired after voting opened", async () => {
    /*
     * The attack a live-balance gauge allows: watch which market is winning,
     * buy tokens, swing it, sell. The snapshot is the block before the epoch's
     * first vote, already final when anyone learns the contest exists.
     */
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    await a.write.vote([[0n], [T(600)]]); // fixes the snapshot

    const t = await hre.viem.getContractAt("TesseraToken", f.token.address, { client: { wallet: f.alice } });
    await t.write.transfer([f.carol.account.address, T(500)]);
    await mine(1);

    const c = await f.gaugeAs(f.carol);
    await expect(c.write.vote([[1n], [T(600)]])).to.be.rejected; // she had 100 at the snapshot
    await c.write.vote([[1n], [T(100)]]);
    expect(await f.gauge.read.marketVotes([0n, 1n])).to.equal(T(100));
  });

  it("cannot be voted twice by passing one pot of tokens between addresses", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    await a.write.vote([[0n], [T(600)]]);

    // Alice hands everything to bob, who has already-snapshotted weight of 300.
    const t = await hre.viem.getContractAt("TesseraToken", f.token.address, { client: { wallet: f.alice } });
    await t.write.transfer([f.bob.account.address, T(600)]);
    await mine(1);

    const b = await f.gaugeAs(f.bob);
    await expect(b.write.vote([[1n], [T(900)]])).to.be.rejected;
    await b.write.vote([[1n], [T(300)]]); // only what he held at the snapshot
    expect(await f.gauge.read.totalVotes([0n])).to.equal(T(900)); // not 1500
  });

  it("gives no weight to tokens that were never delegated", async () => {
    const f = await loadFixture(deployFixture);
    const [, , , , dave] = await hre.viem.getWalletClients();
    const t = await hre.viem.getContractAt("TesseraToken", f.token.address, { client: { wallet: f.alice } });
    await t.write.transfer([dave.account.address, T(500)]);
    await mine(1);

    const d = await hre.viem.getContractAt("TesseraGauge", f.gauge.address, { client: { wallet: dave } });
    await expect(d.write.vote([[0n], [T(100)]])).to.be.rejected;
  });

  it("lets a voter take their weight back off the board", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    await a.write.vote([[0n, 1n], [T(300), T(300)]]);
    await a.write.clearVote();
    expect(await f.gauge.read.totalVotes([0n])).to.equal(0n);
    expect(await f.gauge.read.marketVotes([0n, 0n])).to.equal(0n);
    expect(await f.gauge.read.availableWeight([f.alice.account.address])).to.equal(T(600));
  });

  it("refuses a repeated market in one vote", async () => {
    // Otherwise the same id double-counts against the caller's power and
    // unwinds twice on the next vote.
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    await expect(a.write.vote([[0n, 0n], [T(100), T(100)]])).to.be.rejected;
  });

  it("keeps a losing market out of the reward zone", async () => {
    const f = await loadFixture(deployFixture);
    await f.gauge.write.setRewardZoneSize([2]);
    const a = await f.gaugeAs(f.alice);
    const b = await f.gaugeAs(f.bob);
    const c = await f.gaugeAs(f.carol);
    await a.write.vote([[0n], [T(600)]]); // USDC supply
    await b.write.vote([[2n], [T(300)]]); // USDC/EURC
    await c.write.vote([[1n], [T(100)]]); // EURC supply — last

    const zone = await f.gauge.read.rewardZone([0n]);
    expect(zone.map(Number)).to.deep.equal([0, 2]);
    expect(await f.gauge.read.zoneVotes([0n])).to.equal(T(900));
  });

  it("splits each venue's budget only among that venue's winners", async () => {
    /*
     * One shared pot would make a vote for a lending reserve a vote against
     * every AMM pool, which is not the question anybody is being asked.
     */
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    const b = await f.gaugeAs(f.bob);
    await a.write.vote([[0n, 1n], [T(450), T(150)]]); // lending 3:1
    await b.write.vote([[2n], [T(300)]]); // the only AMM market

    const rates = await f.gauge.read.ratesFor([0n]);
    expect(rates[0]).to.equal(T(10) * 450n / 600n); // 7.5/s
    expect(rates[1]).to.equal(T(10) * 150n / 600n); // 2.5/s
    expect(rates[2]).to.equal(T(4)); // the whole AMM budget
    expect(rates[3]).to.equal(0n);
  });

  it("writes the result to both emissions contracts once the epoch closes", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    const b = await f.gaugeAs(f.bob);
    await a.write.vote([[0n], [T(600)]]);
    await b.write.vote([[2n], [T(300)]]);

    await expect(f.gauge.write.applyEpoch([0n])).to.be.rejected; // still open
    await time.increase(WEEK + 1);
    await f.gauge.write.applyEpoch([0n]);

    expect(await f.lending.read.totalRatePerSecond()).to.equal(T(10));
    expect(await f.lp.read.totalRatePerSecond()).to.equal(T(4));
  });

  it("zeroes a market that has fallen out of the zone", async () => {
    /*
     * The bug this is here for: applying only the winners leaves last epoch's
     * rate running on a market nobody voted for, forever.
     */
    const f = await loadFixture(deployFixture);
    await f.gauge.write.setRewardZoneSize([1]);
    const a = await f.gaugeAs(f.alice);
    await a.write.vote([[0n], [T(600)]]);
    await time.increase(WEEK + 1);
    await f.gauge.write.applyEpoch([0n]);
    expect(await f.lending.read.totalRatePerSecond()).to.equal(T(10));

    // Next epoch the other reserve wins instead.
    const b = await f.gaugeAs(f.bob);
    await b.write.vote([[1n], [T(300)]]);
    await time.increase(WEEK + 1);
    await f.gauge.write.applyEpoch([1n]);

    const usdcStream = await f.lending.read.streams([f.usdc.address, SUPPLY]);
    const eurcStream = await f.lending.read.streams([f.eurc.address, SUPPLY]);
    expect(usdcStream[0]).to.equal(0n);
    expect(eurcStream[0]).to.equal(T(10));
  });

  it("applies a closed epoch exactly once, and never goes backwards", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    await a.write.vote([[0n], [T(600)]]);
    await time.increase(WEEK + 1);
    await f.gauge.write.applyEpoch([0n]);
    await expect(f.gauge.write.applyEpoch([0n])).to.be.rejected;
  });

  it("refuses to apply an epoch nobody voted in", async () => {
    // Otherwise a silent week would zero every stream on the strength of no
    // opinion at all.
    const f = await loadFixture(deployFixture);
    await time.increase(WEEK + 1);
    await expect(f.gauge.write.applyEpoch([0n])).to.be.rejected;
  });

  it("lets anyone apply the result, not only the admin", async () => {
    // A result only the admin can enact is advisory without saying so.
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    await a.write.vote([[0n], [T(600)]]);
    await time.increase(WEEK + 1);
    const c = await f.gaugeAs(f.carol);
    await c.write.applyEpoch([0n]);
    expect(await f.lending.read.totalRatePerSecond()).to.equal(T(10));
  });

  it("only the admin sets the budget, the zone, or the markets", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.gaugeAs(f.alice);
    await expect(a.write.setBudget([T(1), T(1)])).to.be.rejected;
    await expect(a.write.setRewardZoneSize([1])).to.be.rejected;
    await expect(a.write.addAmmMarket([2n, [f.usdc.address], "sneaky"])).to.be.rejected;
    await expect(a.write.setEmissions([f.lending.address, f.lp.address])).to.be.rejected;
  });

  it("refuses a vote on a retired market", async () => {
    const f = await loadFixture(deployFixture);
    await f.gauge.write.setMarketActive([1n, false]);
    const a = await f.gaugeAs(f.alice);
    await expect(a.write.vote([[1n], [T(100)]])).to.be.rejected;
  });

  describe("bribes", () => {
    it("splits a bribe among a market's voters in proportion to their weight", async () => {
      const f = await loadFixture(deployFixture);
      const bribeToken = await hre.viem.deployContract("MockToken", ["Bribe", "BRB", 18]);
      await bribeToken.write.mint([f.admin.account.address, T(1000)]);
      await bribeToken.write.approve([f.gauge.address, T(1000)]);

      const a = await f.gaugeAs(f.alice);
      const c = await f.gaugeAs(f.carol);
      await a.write.vote([[1n], [T(300)]]);
      await c.write.vote([[1n], [T(100)]]);
      await f.gauge.write.addBribe([0n, 1n, bribeToken.address, T(400)]);

      await time.increase(WEEK + 1);
      await a.write.claimBribes([0n, 1n]);
      await c.write.claimBribes([0n, 1n]);

      expect(await bribeToken.read.balanceOf([f.alice.account.address])).to.equal(T(300));
      expect(await bribeToken.read.balanceOf([f.carol.account.address])).to.equal(T(100));
    });

    it("pays nothing to somebody who voted for a different market", async () => {
      const f = await loadFixture(deployFixture);
      const bribeToken = await hre.viem.deployContract("MockToken", ["Bribe", "BRB", 18]);
      await bribeToken.write.mint([f.admin.account.address, T(100)]);
      await bribeToken.write.approve([f.gauge.address, T(100)]);

      const a = await f.gaugeAs(f.alice);
      const b = await f.gaugeAs(f.bob);
      await a.write.vote([[1n], [T(300)]]);
      await b.write.vote([[0n], [T(300)]]);
      await f.gauge.write.addBribe([0n, 1n, bribeToken.address, T(100)]);

      await time.increase(WEEK + 1);
      await expect(b.write.claimBribes([0n, 1n])).to.be.rejected;
    });

    it("cannot be claimed while the denominator is still moving", async () => {
      /*
       * Claiming mid-epoch would let a voter take their share, move their
       * weight to another market, and claim there too.
       */
      const f = await loadFixture(deployFixture);
      const bribeToken = await hre.viem.deployContract("MockToken", ["Bribe", "BRB", 18]);
      await bribeToken.write.mint([f.admin.account.address, T(100)]);
      await bribeToken.write.approve([f.gauge.address, T(100)]);

      const a = await f.gaugeAs(f.alice);
      await a.write.vote([[1n], [T(300)]]);
      await f.gauge.write.addBribe([0n, 1n, bribeToken.address, T(100)]);
      await expect(a.write.claimBribes([0n, 1n])).to.be.rejected;
    });

    it("cannot be claimed twice", async () => {
      const f = await loadFixture(deployFixture);
      const bribeToken = await hre.viem.deployContract("MockToken", ["Bribe", "BRB", 18]);
      await bribeToken.write.mint([f.admin.account.address, T(100)]);
      await bribeToken.write.approve([f.gauge.address, T(100)]);

      const a = await f.gaugeAs(f.alice);
      await a.write.vote([[1n], [T(300)]]);
      await f.gauge.write.addBribe([0n, 1n, bribeToken.address, T(100)]);
      await time.increase(WEEK + 1);
      await a.write.claimBribes([0n, 1n]);
      await expect(a.write.claimBribes([0n, 1n])).to.be.rejected;
    });

    it("refuses a bribe on an epoch that has already closed", async () => {
      // Paying for votes already cast is buying a result rather than asking
      // for one, and the point of a public bribe is that voters see it first.
      const f = await loadFixture(deployFixture);
      const bribeToken = await hre.viem.deployContract("MockToken", ["Bribe", "BRB", 18]);
      await bribeToken.write.mint([f.admin.account.address, T(100)]);
      await bribeToken.write.approve([f.gauge.address, T(100)]);
      await time.increase(WEEK + 1);
      await expect(f.gauge.write.addBribe([0n, 1n, bribeToken.address, T(100)])).to.be.rejected;
    });

    it("survives a market being retired after it was bribed", async () => {
      // A market that could be pulled out from under a bribe would make
      // bribing it a donation to the admin.
      const f = await loadFixture(deployFixture);
      const bribeToken = await hre.viem.deployContract("MockToken", ["Bribe", "BRB", 18]);
      await bribeToken.write.mint([f.admin.account.address, T(100)]);
      await bribeToken.write.approve([f.gauge.address, T(100)]);

      const a = await f.gaugeAs(f.alice);
      await a.write.vote([[1n], [T(300)]]);
      await f.gauge.write.addBribe([0n, 1n, bribeToken.address, T(100)]);
      await f.gauge.write.setMarketActive([1n, false]);

      await time.increase(WEEK + 1);
      await a.write.claimBribes([0n, 1n]);
      expect(await bribeToken.read.balanceOf([f.alice.account.address])).to.equal(T(100));
    });

    it("reports a share before it is taken and zero after", async () => {
      const f = await loadFixture(deployFixture);
      const bribeToken = await hre.viem.deployContract("MockToken", ["Bribe", "BRB", 18]);
      await bribeToken.write.mint([f.admin.account.address, T(100)]);
      await bribeToken.write.approve([f.gauge.address, T(100)]);

      const a = await f.gaugeAs(f.alice);
      await a.write.vote([[1n], [T(300)]]);
      await f.gauge.write.addBribe([0n, 1n, bribeToken.address, T(100)]);
      expect(await f.gauge.read.bribeShare([0n, 1n, 0n, f.alice.account.address])).to.equal(T(100));

      await time.increase(WEEK + 1);
      await a.write.claimBribes([0n, 1n]);
      expect(await f.gauge.read.bribeShare([0n, 1n, 0n, f.alice.account.address])).to.equal(0n);
    });
  });

  describe("the asset register", () => {
    it("keeps an unregistered market out of the reward zone without silencing its vote", async () => {
      /*
       * The attack a register exists to stop: mint a token, pair it with
       * something real, vote your own market into the zone, and collect the
       * emissions with the votes those emissions paid for.
       *
       * Votes on an ineligible market still count as signal. They just do not
       * move money, which is the distinction between a register and a gag.
       */
      const f = await loadFixture(deployFixture);
      const reg = await hre.viem.deployContract("TesseraAssetRegistry", [f.admin.account.address]);
      await reg.write.setStatus([f.usdc.address, 1, "the unit everything is priced in"]);
      await f.gauge.write.setRegistry([reg.address]);

      const a = await f.gaugeAs(f.alice);
      const b = await f.gaugeAs(f.bob);
      await a.write.vote([[1n], [T(600)]]); // EURC, not on the register
      await b.write.vote([[0n], [T(300)]]); // USDC, on it

      expect(await f.gauge.read.eligible([0n])).to.equal(true);
      expect(await f.gauge.read.eligible([1n])).to.equal(false);
      expect(await f.gauge.read.marketVotes([0n, 1n])).to.equal(T(600)); // the vote is recorded
      expect((await f.gauge.read.rewardZone([0n])).map(Number)).to.deep.equal([0]); // it just is not paid

      const rates = await f.gauge.read.ratesFor([0n]);
      expect(rates[0]).to.equal(T(10)); // the whole lending budget, to the eligible one
      expect(rates[1]).to.equal(0n);
    });

    it("stops paying a market whose asset is revoked", async () => {
      const f = await loadFixture(deployFixture);
      const reg = await hre.viem.deployContract("TesseraAssetRegistry", [f.admin.account.address]);
      await reg.write.setStatus([f.usdc.address, 1, "listed"]);
      await reg.write.setStatus([f.eurc.address, 1, "listed"]);
      await f.gauge.write.setRegistry([reg.address]);

      const a = await f.gaugeAs(f.alice);
      await a.write.vote([[1n], [T(600)]]);
      expect(await f.gauge.read.eligible([1n])).to.equal(true);

      await reg.write.setStatus([f.eurc.address, 2, "issuer went quiet"]);
      expect(await f.gauge.read.eligible([1n])).to.equal(false);
      expect((await f.gauge.read.rewardZone([0n])).length).to.equal(0);
    });

    it("needs every asset of a pair, not just one", async () => {
      // Otherwise pairing a real asset with anything at all is enough.
      const f = await loadFixture(deployFixture);
      const reg = await hre.viem.deployContract("TesseraAssetRegistry", [f.admin.account.address]);
      await reg.write.setStatus([f.usdc.address, 1, "listed"]);
      await f.gauge.write.setRegistry([reg.address]);
      // Market 2 is USDC/EURC; only USDC is on the register.
      expect(await f.gauge.read.eligible([2n])).to.equal(false);
      await reg.write.setStatus([f.eurc.address, 1, "listed"]);
      expect(await f.gauge.read.eligible([2n])).to.equal(true);
    });

    it("treats every market as eligible when no register is set", async () => {
      // A deployment that has decided nothing must not behave as though it
      // decided "no".
      const f = await loadFixture(deployFixture);
      for (const id of [0n, 1n, 2n, 3n]) expect(await f.gauge.read.eligible([id])).to.equal(true);
    });

    it("only the owner changes the register", async () => {
      const f = await loadFixture(deployFixture);
      const reg = await hre.viem.deployContract("TesseraAssetRegistry", [f.admin.account.address]);
      const asAlice = await hre.viem.getContractAt("TesseraAssetRegistry", reg.address, { client: { wallet: f.alice } });
      await expect(asAlice.write.setStatus([f.usdc.address, 1, "mine now"])).to.be.rejected;
      const g = await f.gaugeAs(f.alice);
      await expect(g.write.setRegistry([reg.address])).to.be.rejected;
    });
  });

  describe("head count and the delegate directory", () => {
    it("counts voters as well as weight", async () => {
      /*
       * One address with the whole supply and a thousand holders agreeing
       * produce the same tally and very different head counts, and a voter
       * deserves to see which of the two they are looking at.
       */
      const f = await loadFixture(deployFixture);
      const a = await f.gaugeAs(f.alice);
      const b = await f.gaugeAs(f.bob);
      await a.write.vote([[0n], [T(600)]]);
      await b.write.vote([[0n], [T(300)]]);
      expect(await f.gauge.read.marketVoters([0n, 0n])).to.equal(2n);
    });

    it("takes a voter off the head count when they withdraw", async () => {
      const f = await loadFixture(deployFixture);
      const a = await f.gaugeAs(f.alice);
      await a.write.vote([[0n], [T(600)]]);
      expect(await f.gauge.read.marketVoters([0n, 0n])).to.equal(1n);
      await a.write.clearVote();
      expect(await f.gauge.read.marketVoters([0n, 0n])).to.equal(0n);
    });

    it("does not double-count somebody who changes their mind", async () => {
      const f = await loadFixture(deployFixture);
      const a = await f.gaugeAs(f.alice);
      await a.write.vote([[0n], [T(600)]]);
      await a.write.vote([[0n], [T(500)]]);
      expect(await f.gauge.read.marketVoters([0n, 0n])).to.equal(1n);
    });

    it("lets anyone list themselves as a delegate, and nobody else vouch for them", async () => {
      /*
       * A curated list of "trusted community members" is a list whose trust
       * comes from whoever curates it. What makes an open one safe is that
       * appearing on it confers nothing.
       */
      const f = await loadFixture(deployFixture);
      const a = await f.gaugeAs(f.alice);
      await a.write.registerDelegate(["Alice", "I read every emissions thread so you do not have to."]);
      expect(await f.gauge.read.delegateCount()).to.equal(1n);
      const d = await f.gauge.read.delegates([0n]);
      expect(d[0].toLowerCase()).to.equal(f.alice.account.address.toLowerCase());
      expect(d[3]).to.equal(true);
    });

    it("updates an existing entry rather than making a second one", async () => {
      const f = await loadFixture(deployFixture);
      const a = await f.gaugeAs(f.alice);
      await a.write.registerDelegate(["Alice", "first"]);
      await a.write.registerDelegate(["Alice v2", "second"]);
      expect(await f.gauge.read.delegateCount()).to.equal(1n);
      expect((await f.gauge.read.delegates([0n]))[1]).to.equal("Alice v2");
    });

    it("lets a delegate step down without touching anybody's delegation", async () => {
      // Their delegators' weight is theirs to move; withdrawing from the
      // directory must not decide it for them.
      const f = await loadFixture(deployFixture);
      const a = await f.gaugeAs(f.alice);
      await a.write.registerDelegate(["Alice", "here"]);
      await a.write.setDelegateActive([false]);
      expect((await f.gauge.read.delegates([0n]))[3]).to.equal(false);
      expect(await f.token.read.getVotes([f.alice.account.address])).to.equal(T(600));
    });

    it("bounds the text, so the directory cannot be filled with prose", async () => {
      const f = await loadFixture(deployFixture);
      const a = await f.gaugeAs(f.alice);
      await expect(a.write.registerDelegate(["", "no name"])).to.be.rejected;
      await expect(a.write.registerDelegate(["Alice", "x".repeat(281)])).to.be.rejected;
    });
  });
});
