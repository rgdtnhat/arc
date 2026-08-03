import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const P = (usd: number) => BigInt(Math.round(usd * 1e8)); // PRICE_SCALE
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const BTC = (n: number) => BigInt(Math.round(n * 1e8));
const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * The two ways to steal from a lending pool by moving a price, and what stops
 * them.
 *
 * These are written as the attacks rather than as feature checks, because the
 * feature only matters if the attack fails. Each case sets up a position, moves
 * exactly one price source the way an attacker would, and asserts the money does
 * not move.
 */
async function deployFixture() {
  const [deployer, attacker, victim, lp] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const cbtc = await hre.viem.deployContract("MockToken", ["cirBTC (mock)", "cirBTC", 8]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);

  // Two independent sources for cirBTC: an owner-set mark and a feed.
  const btcFeed = await hre.viem.deployContract("MockAggregator", [8, P(30_000)]);
  const usdcFeed = await hre.viem.deployContract("MockAggregator", [8, P(1)]);
  const oracle = await hre.viem.deployContract("TesseraOracle", [
    deployer.account.address,
    "0x0000000000000000000000000000000000000000", // no TWAP source in these cases
  ]);

  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, P(1)]);
  await pool.write.addReserve([cbtc.address, 7000, 8000, 8000, 1000, false, 8, P(30_000)]);

  // cirBTC: manual + feed, may move 10% per update at most, sources may differ
  // by 5% before the asset is considered unreliable.
  await oracle.write.configureAsset([
    cbtc.address, P(30_000), btcFeed.address, 3600, 1000, 0, 500, 7 * DAY,
  ]);
  // USDC gets two sources as well. With only one there is nothing for the
  // "mark debt at the highest source" rule to hold on to — a single compromised
  // input is a single point of failure whichever direction it moves, which is
  // exactly why the oracle reports a lone source as reliable-but-uncorroborated.
  await oracle.write.configureAsset([
    usdc.address, P(1), usdcFeed.address, 3600, 200, 0, 500, 7 * DAY,
  ]);

  for (const who of [attacker, victim, lp]) {
    await usdc.write.mint([who.account.address, USDC(1_000_000)]);
    await cbtc.write.mint([who.account.address, BTC(20)]);
    const u = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    const c = await hre.viem.getContractAt("MockToken", cbtc.address, { client: { wallet: who } });
    await u.write.approve([pool.address, USDC(1_000_000)]);
    await c.write.approve([pool.address, BTC(20)]);
  }

  const as = (who: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: who } });
  const arm = () => pool.write.setRiskOracle([oracle.address]);

  // Liquidity to borrow against.
  await (await as(lp)).write.supply([usdc.address, USDC(500_000)]);

  return { deployer, attacker, victim, lp, usdc, cbtc, pool, oracle, btcFeed, usdcFeed, as, arm };
}

describe("Oracle manipulation — inflating a collateral price", () => {
  it("does not increase borrowing power when one source is inflated", async () => {
    const { attacker, cbtc, usdc, pool, btcFeed, as, arm } = await loadFixture(deployFixture);
    await arm();
    await (await as(attacker)).write.supply([cbtc.address, BTC(1)]);

    const [, , limitBefore] = (await pool.read.accountData([attacker.account.address])) as readonly [
      bigint, bigint, bigint, bigint,
    ];

    // The attack: push the feed to ten times the real price. One source is now
    // lying; the manual mark still says 30,000.
    await btcFeed.write.set([P(300_000), BigInt(await time.latest())]);

    const [, , limitAfter] = (await pool.read.accountData([attacker.account.address])) as readonly [
      bigint, bigint, bigint, bigint,
    ];
    // Collateral is marked at the LOWEST source, so the inflated one is ignored.
    expect(limitAfter).to.equal(limitBefore);
    void usdc;
  });

  it("refuses the over-borrow the inflated mark was supposed to justify", async () => {
    const { attacker, cbtc, usdc, pool, btcFeed, as, arm } = await loadFixture(deployFixture);
    await arm();
    await (await as(attacker)).write.supply([cbtc.address, BTC(1)]);
    await btcFeed.write.set([P(300_000), BigInt(await time.latest())]);

    // At the honest price 1 cirBTC backs at most 21,000 USDC (30,000 × 70%).
    // At the inflated one it would back 210,000 — which is the theft.
    await expect((await as(attacker)).write.borrow([usdc.address, USDC(100_000)])).to.be.rejected;
  });

  it("still allows the borrow the honest price supports", async () => {
    // The protection must not cost an honest borrower anything.
    const { attacker, cbtc, usdc, pool, as, arm } = await loadFixture(deployFixture);
    await arm();
    await (await as(attacker)).write.supply([cbtc.address, BTC(1)]);
    await (await as(attacker)).write.borrow([usdc.address, USDC(15_000)]);
    expect(await pool.read.borrowBalance([usdc.address, attacker.account.address])).to.equal(USDC(15_000));
  });

  it("is what changes the outcome — without the oracle the theft goes through", async () => {
    // The same sequence against the unprotected pool, to show the protection is
    // load-bearing rather than incidental. Here the pool reads its own single
    // price, which the owner moves.
    const { attacker, cbtc, usdc, pool, as } = await loadFixture(deployFixture);
    // riskOracle deliberately NOT armed.
    await (await as(attacker)).write.supply([cbtc.address, BTC(1)]);
    await pool.write.setPrice([cbtc.address, P(300_000)]);
    await (await as(attacker)).write.borrow([usdc.address, USDC(100_000)]);
    expect(await pool.read.borrowBalance([usdc.address, attacker.account.address])).to.equal(USDC(100_000));
  });
});

describe("Oracle manipulation — deflating a price", () => {
  it("does not shrink a liability when the debt asset's source is deflated", async () => {
    const { victim, cbtc, usdc, pool, oracle, as, arm } = await loadFixture(deployFixture);
    await arm();
    await (await as(victim)).write.supply([cbtc.address, BTC(1)]);
    await (await as(victim)).write.borrow([usdc.address, USDC(15_000)]);

    const [, borrowBefore] = (await pool.read.accountData([victim.account.address])) as readonly [
      bigint, bigint, bigint, bigint,
    ];

    // Walk the USDC mark down as far as the rate limit allows in one step.
    await oracle.write.setPrice([usdc.address, P(0.98)]);

    const [, borrowAfter] = (await pool.read.accountData([victim.account.address])) as readonly [
      bigint, bigint, bigint, bigint,
    ];
    // Debt is marked at the HIGHEST source, so a deflated one cannot make a
    // liability look smaller than it is.
    expect(borrowAfter).to.equal(borrowBefore);
  });

  it("refuses to liquidate on a mark the sources disagree about", async () => {
    const { deployer, victim, cbtc, usdc, pool, btcFeed, as, arm } = await loadFixture(deployFixture);
    await arm();
    await (await as(victim)).write.supply([cbtc.address, BTC(1)]);
    await (await as(victim)).write.borrow([usdc.address, USDC(18_000)]);

    // The attack: crash one source so the victim looks underwater, then seize.
    await btcFeed.write.set([P(5_000), BigInt(await time.latest())]);

    // The sources now disagree by far more than 5%, so the pool stops rather
    // than guessing which one is telling the truth.
    await expect(
      (await as(deployer)).write.startLiquidationAuction([
        victim.account.address, usdc.address, cbtc.address, 5000,
      ]),
    ).to.be.rejected;
  });

  it("lets liquidation resume once the sources agree again", async () => {
    // The freeze must be temporary, or a divergence becomes a way to make bad
    // debt permanent.
    const { deployer, victim, cbtc, usdc, pool, btcFeed, oracle, as, arm } = await loadFixture(deployFixture);
    await arm();
    await (await as(victim)).write.supply([cbtc.address, BTC(1)]);
    await (await as(victim)).write.borrow([usdc.address, USDC(18_000)]);

    await btcFeed.write.set([P(5_000), BigInt(await time.latest())]);
    expect((await oracle.read.reliable([cbtc.address]))[0]).to.equal(false);

    // Both sources now say the collateral really did fall — walked down within
    // the rate limit, which is what an honest re-mark looks like.
    await btcFeed.write.set([P(22_000), BigInt(await time.latest())]);
    for (let i = 0; i < 4; i++) {
      const cur = (await oracle.read.configOf([cbtc.address]))[1] as bigint;
      const next = cur > P(22_000) ? (cur * 9000n) / 10_000n : P(22_000);
      await oracle.write.setPrice([cbtc.address, next < P(22_000) ? P(22_000) : next]);
    }
    expect((await oracle.read.reliable([cbtc.address]))[0]).to.equal(true);

    let opened = false;
    for (let pct = 500; pct <= 9500 && !opened; pct += 100) {
      try {
        await (await as(deployer)).write.startLiquidationAuction([
          victim.account.address, usdc.address, cbtc.address, pct,
        ]);
        opened = true;
      } catch { /* out of band at this size */ }
    }
    expect(opened, "liquidation should work again once sources agree").to.equal(true);
  });

  it("freezes new borrowing while sources disagree", async () => {
    const { attacker, cbtc, usdc, btcFeed, as, arm } = await loadFixture(deployFixture);
    await arm();
    await (await as(attacker)).write.supply([cbtc.address, BTC(2)]);
    await btcFeed.write.set([P(5_000), BigInt(await time.latest())]);
    await expect((await as(attacker)).write.borrow([usdc.address, USDC(100)])).to.be.rejected;
  });

  it("never traps a position: repaying works while prices are divergent", async () => {
    // The freeze covers taking on risk, not getting out of it. A borrower who
    // cannot repay during an oracle incident is one the incident bankrupts.
    const { victim, cbtc, usdc, pool, btcFeed, as, arm } = await loadFixture(deployFixture);
    await arm();
    await (await as(victim)).write.supply([cbtc.address, BTC(1)]);
    await (await as(victim)).write.borrow([usdc.address, USDC(10_000)]);
    await btcFeed.write.set([P(5_000), BigInt(await time.latest())]);

    // Repay the balance the pool actually reports after accrual, not the
    // amount originally borrowed — a few wei of interest lands between the two.
    await (await as(victim)).write.repay([usdc.address, USDC(10_100)]);
    expect(await pool.read.borrowBalance([usdc.address, victim.account.address])).to.equal(0n);
    // And supplying more is fine too — it only ever reduces risk.
    await (await as(victim)).write.supply([cbtc.address, BTC(1)]);
  });
});

describe("TesseraOracle — bounding how fast a price can move", () => {
  it("rejects a jump larger than the configured step", async () => {
    const { oracle, cbtc } = await loadFixture(deployFixture);
    // 10% is the limit for cirBTC; 30,000 → 40,000 is 33%.
    await expect(oracle.write.setPrice([cbtc.address, P(40_000)])).to.be.rejected;
    await oracle.write.setPrice([cbtc.address, P(32_000)]); // ~6.7%, fine
    expect((await oracle.read.configOf([cbtc.address]))[1]).to.equal(P(32_000));
  });

  it("rejects a jump down as firmly as a jump up", async () => {
    const { oracle, cbtc } = await loadFixture(deployFixture);
    await expect(oracle.write.setPrice([cbtc.address, P(20_000)])).to.be.rejected;
  });

  it("makes walking a price to a useful level take many steps", async () => {
    // The rate limit does not prevent a determined walk. It makes it slow and
    // visible, which is what turns a theft into an incident somebody can catch.
    const { oracle, cbtc } = await loadFixture(deployFixture);
    let steps = 0;
    let cur = P(30_000);
    while (cur < P(300_000) && steps < 100) {
      cur = (cur * 11_000n) / 10_000n; // the full 10% allowed
      await oracle.write.setPrice([cbtc.address, cur]);
      steps++;
    }
    expect(steps > 20, `took only ${steps} steps to 10x the price`).to.equal(true);
  });

  it("enforces a minimum interval between updates when configured", async () => {
    const { deployer, oracle } = await loadFixture(deployFixture);
    const asset = "0x00000000000000000000000000000000000000aa";
    await oracle.write.configureAsset([asset, P(100), "0x0000000000000000000000000000000000000000", 0, 1000, 3600, 500, 7 * DAY]);
    await expect(oracle.write.setPrice([asset, P(105)])).to.be.rejected;
    await time.increase(3601);
    await oracle.write.setPrice([asset, P(105)]);
    void deployer;
  });

  it("caps the configurable step, so no config makes the limit meaningless", async () => {
    const { oracle } = await loadFixture(deployFixture);
    const asset = "0x00000000000000000000000000000000000000bb";
    const ceiling = await oracle.read.MAX_MOVE_CEILING();
    await expect(
      oracle.write.configureAsset([asset, P(100), "0x0000000000000000000000000000000000000000", 0, ceiling + 1, 0, 500, 7 * DAY]),
    ).to.be.rejected;
  });
});

describe("TesseraOracle — what counts as a source", () => {
  it("drops a manual price once it goes stale", async () => {
    const { oracle } = await loadFixture(deployFixture);
    const asset = "0x00000000000000000000000000000000000000cc";
    await oracle.write.configureAsset([asset, P(100), "0x0000000000000000000000000000000000000000", 0, 1000, 0, 500, 3600]);
    expect((await oracle.read.spread([asset]))[3]).to.equal(1n);
    await time.increase(3601);
    // An old price is not a price. With nothing left, the asset is unusable
    // rather than quoted at a number nobody has confirmed for an hour.
    expect((await oracle.read.spread([asset]))[3]).to.equal(0n);
    expect((await oracle.read.reliable([asset]))[0]).to.equal(false);
  });

  it("drops a feed answer that is stale, negative, or from an unfinished round", async () => {
    const { oracle, cbtc, btcFeed } = await loadFixture(deployFixture);
    expect((await oracle.read.spread([cbtc.address]))[3]).to.equal(2n);

    await btcFeed.write.set([P(30_000), BigInt(await time.latest()) - 7200n]); // stale
    expect((await oracle.read.spread([cbtc.address]))[3]).to.equal(1n);

    await btcFeed.write.set([-1n, BigInt(await time.latest())]); // negative
    expect((await oracle.read.spread([cbtc.address]))[3]).to.equal(1n);

    await btcFeed.write.set([P(30_000), BigInt(await time.latest())]);
    await btcFeed.write.setStaleRound([9n, 3n]); // answer carried from an old round
    expect((await oracle.read.spread([cbtc.address]))[3]).to.equal(1n);
  });

  it("treats a single source as reliable — there is nothing to disagree with", async () => {
    // Worth being explicit that this is a limitation, not a guarantee: one
    // source cannot be cross-checked, so it is trusted for want of anything to
    // compare it against. Its only protections are the move limit and the age
    // cut-off. Two sources is what makes the directional pricing mean anything.
    const { oracle } = await loadFixture(deployFixture);
    const lone = "0x00000000000000000000000000000000000000f1";
    await oracle.write.configureAsset([
      lone, P(100), "0x0000000000000000000000000000000000000000", 0, 1000, 0, 500, 7 * DAY,
    ]);
    const [ok] = await oracle.read.reliable([lone]);
    expect(ok).to.equal(true);
    expect((await oracle.read.spread([lone]))[3]).to.equal(1n);
  });

  it("reverts rather than quoting an asset it cannot price", async () => {
    const { oracle } = await loadFixture(deployFixture);
    const unknown = "0x00000000000000000000000000000000000000dd";
    await expect(oracle.read.riskPrice([unknown, false])).to.be.rejected;
    await expect(oracle.read.price([unknown])).to.be.rejected;
  });

  it("ignores an unconfigured asset rather than calling the pool unreliable", async () => {
    // Adding a reserve to the pool must not become an outage until somebody
    // remembers to configure the oracle for it.
    const { oracle } = await loadFixture(deployFixture);
    const unknown = "0x00000000000000000000000000000000000000ee";
    const [bad] = await oracle.read.anyUnreliable([[unknown]]);
    expect(bad).to.equal("0x0000000000000000000000000000000000000000");
  });

  it("quotes collateral low and debt high, and they differ when sources do", async () => {
    const { oracle, cbtc, btcFeed } = await loadFixture(deployFixture);
    await btcFeed.write.set([P(31_000), BigInt(await time.latest())]);
    expect(await oracle.read.riskPrice([cbtc.address, false])).to.equal(P(30_000)); // collateral
    expect(await oracle.read.riskPrice([cbtc.address, true])).to.equal(P(31_000)); // debt
  });

  it("strictRiskPrice refuses to answer while sources disagree", async () => {
    const { oracle, cbtc, btcFeed } = await loadFixture(deployFixture);
    await btcFeed.write.set([P(60_000), BigInt(await time.latest())]);
    await expect(oracle.read.strictRiskPrice([cbtc.address, false])).to.be.rejected;
    // The non-strict form still answers, conservatively.
    expect(await oracle.read.riskPrice([cbtc.address, false])).to.equal(P(30_000));
  });
});

describe("TesseraPool without an oracle keeps working", () => {
  it("prices from its own reserve when riskOracle is unset", async () => {
    const { attacker, cbtc, usdc, pool, as } = await loadFixture(deployFixture);
    await (await as(attacker)).write.supply([cbtc.address, BTC(1)]);
    await (await as(attacker)).write.borrow([usdc.address, USDC(15_000)]);
    expect(await pool.read.borrowBalance([usdc.address, attacker.account.address])).to.equal(USDC(15_000));
  });

  it("can be disarmed, so a bad oracle config cannot brick the pool", async () => {
    const { attacker, cbtc, usdc, pool, btcFeed, as, arm } = await loadFixture(deployFixture);
    await arm();
    await (await as(attacker)).write.supply([cbtc.address, BTC(2)]);
    await btcFeed.write.set([P(5_000), BigInt(await time.latest())]);
    await expect((await as(attacker)).write.borrow([usdc.address, USDC(100)])).to.be.rejected;

    await pool.write.setRiskOracle(["0x0000000000000000000000000000000000000000"]);
    await (await as(attacker)).write.borrow([usdc.address, USDC(100)]);
  });
});
