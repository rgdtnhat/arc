import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const TSRA = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/**
 * Almost every test here is about refusing to answer. A TWAP that returns a
 * number is easy; the hard part is that the live pool holds about two dollars,
 * and a confident-looking price drawn from two dollars of depth is worse than
 * an openly hand-set parameter, because nobody thinks to check it.
 */
async function deployFixture() {
  const [owner, lp, trader] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockToken", ["USD Coin", "USDC", 6]);
  const tsra = await hre.viem.deployContract("MockToken", ["Tessera", "TSRA", 18]);
  const amm = await hre.viem.deployContract("TesseraAMM", [owner.account.address]);

  const [a, b] = usdc.address.toLowerCase() < tsra.address.toLowerCase()
    ? [usdc.address, tsra.address]
    : [tsra.address, usdc.address];
  await amm.write.createPool([[a, b], 30, 8000, "USDC / TSRA"]);

  for (const who of [lp, trader]) {
    await usdc.write.mint([who.account.address, USDC(1_000_000)]);
    await tsra.write.mint([who.account.address, TSRA(1_000_000)]);
    for (const t of [usdc, tsra]) {
      const c = await hre.viem.getContractAt("MockToken", t.address, { client: { wallet: who } });
      await c.write.approve([amm.address, 2n ** 255n]);
    }
  }

  const oracle = await hre.viem.deployContract("TesseraTwapOracle", [
    amm.address, 0n, tsra.address, usdc.address, owner.account.address,
  ]);

  const asLp = await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: lp } });
  const asTrader = await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: trader } });
  /** Seed the pool with `usd` dollars a side, at one dollar per TSRA. */
  const seed = async (usd: number) => {
    const amounts = a.toLowerCase() === usdc.address.toLowerCase()
      ? [USDC(usd), TSRA(usd)]
      : [TSRA(usd), USDC(usd)];
    await asLp.write.addLiquidity([0n, amounts, 0n]);
  };
  return { owner, lp, trader, usdc, tsra, amm, oracle, seed, asTrader, asLp };
}

describe("TesseraTwapOracle (a price that admits how much to trust it)", () => {
  it("will not price a pool nobody has traded", async () => {
    const f = await loadFixture(deployFixture);
    const [, , , ok] = await f.oracle.read.consult([600n]);
    expect(ok).to.equal(false);
  });

  it("refuses a thin pool even with a perfectly good average", async () => {
    /*
     * The whole reason this contract exists. Two dollars of depth produces a
     * flawless-looking TWAP that costs a rounding error to move.
     */
    const f = await loadFixture(deployFixture);
    await f.seed(2);
    await f.oracle.write.update();
    await time.increase(3600);
    await f.oracle.write.update();

    const [price, window, poolDepth, ok] = await f.oracle.read.consult([600n]);
    expect(window > 0n).to.equal(true);
    expect(price > 0n).to.equal(true); // the average is fine
    expect(poolDepth).to.equal(USDC(2));
    expect(ok).to.equal(false); // and still not worth listening to
  });

  it("prices a pool deep enough to bother manipulating", async () => {
    const f = await loadFixture(deployFixture);
    await f.seed(100_000);
    await f.oracle.write.update();
    await time.increase(3600);
    await f.oracle.write.update();

    const [price, , poolDepth, ok] = await f.oracle.read.consult([600n]);
    expect(ok).to.equal(true);
    expect(poolDepth >= USDC(25_000)).to.equal(true);
    // A dollar a token, at 6 vs 18 decimals: 1e6 quote units per 1e18 token
    // units, scaled by 1e18, is 1e6.
    expect(price).to.equal(10n ** 6n);
  });

  it("reports the depth and the window even when it declines", async () => {
    // A caller diagnosing a refusal needs to know whether it was too thin or
    // too fresh, and by how much.
    const f = await loadFixture(deployFixture);
    await f.seed(2);
    await f.oracle.write.update();
    await time.increase(3600);
    await f.oracle.write.update();
    const [, window, poolDepth, ok] = await f.oracle.read.consult([600n]);
    expect(ok).to.equal(false);
    expect(window >= 3600n).to.equal(true);
    expect(poolDepth).to.equal(USDC(2));
  });

  it("will not answer for a window longer than it has history for", async () => {
    const f = await loadFixture(deployFixture);
    await f.seed(100_000);
    await f.oracle.write.update();
    await time.increase(600);
    await f.oracle.write.update();

    const [, , , ok] = await f.oracle.read.consult([7n * 24n * 3600n]);
    expect(ok).to.equal(false);
  });

  it("cannot have its ring stuffed to shorten the usable window", async () => {
    /*
     * If readings could be written back to back, an attacker fills the ring in
     * one block and every window collapses to seconds — which is spot, with
     * extra steps.
     */
    const f = await loadFixture(deployFixture);
    await f.seed(100_000);
    await f.oracle.write.update();
    await expect(f.oracle.write.update()).to.be.rejected;
    await time.increase(301);
    await f.oracle.write.update();
    expect(await f.oracle.read.count()).to.equal(2n);
  });

  it("averages a spike away instead of following it", async () => {
    /*
     * The point of time-weighting. A trade that moves the pool for a moment
     * near the end of a long window moves the average by a fraction of that.
     */
    const f = await loadFixture(deployFixture);
    await f.seed(100_000);
    await f.oracle.write.update();
    await time.increase(6 * 3600);
    await f.oracle.write.update();
    const [calm] = await f.oracle.read.consult([3600n]);

    // Buy a fifth of the TSRA side, then read a moment later.
    await f.asTrader.write.swap([0n, f.usdc.address, f.tsra.address, USDC(20_000), 0n]);
    await time.increase(60);
    const [after] = await f.oracle.read.consult([3600n]);

    const moved = Number(after - calm) / Number(calm);
    expect(moved).to.be.greaterThan(0); // it did notice
    expect(moved).to.be.lessThan(0.05); // but a 20% trade did not carry it
  });

  it("anybody may advance the feed", async () => {
    // A feed only one address can update is a feed that stops when that
    // address does, which this codebase has already paid for once.
    const f = await loadFixture(deployFixture);
    await f.seed(100_000);
    const asTrader = await hre.viem.getContractAt("TesseraTwapOracle", f.oracle.address, {
      client: { wallet: f.trader },
    });
    await asTrader.write.update();
    expect(await f.oracle.read.count()).to.equal(1n);
  });

  it("only the owner moves the bars", async () => {
    const f = await loadFixture(deployFixture);
    const asTrader = await hre.viem.getContractAt("TesseraTwapOracle", f.oracle.address, {
      client: { wallet: f.trader },
    });
    await expect(asTrader.write.setConfig([0n, 1n])).to.be.rejected;
    await f.oracle.write.setConfig([USDC(1), 60n]);
    expect(await f.oracle.read.minDepth()).to.equal(USDC(1));
  });

  it("keeps only its most recent readings, and stays usable at the wrap", async () => {
    const f = await loadFixture(deployFixture);
    await f.seed(100_000);
    for (let i = 0; i < 26; i++) {
      await f.oracle.write.update();
      await time.increase(400);
    }
    expect(await f.oracle.read.count()).to.equal(24n);
    const [, , , ok] = await f.oracle.read.consult([600n]);
    expect(ok).to.equal(true);
  });
});
