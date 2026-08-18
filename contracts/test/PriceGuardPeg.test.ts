import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const P = (usd: number) => BigInt(Math.round(usd * 1e8));

/**
 * A guard that cannot produce a reference used to wave the price through, and
 * the live deployment turned out to be doing exactly that on every one of its
 * four assets: two feeds disabled, two enabled with an average of zero. Wired,
 * enabled, and enforcing nothing.
 *
 * Two things fix it. A peg gives assets whose price is not a market question —
 * above all the gas token, which is the quote side of every pair and so cannot
 * be priced by the AMM without circularity — a reference that cannot go
 * missing. And `requireReference` lets an operator say they would rather refuse
 * a price than guess at one.
 */
async function deployFixture() {
  const [deployer] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const other = await hre.viem.deployContract("MockToken", ["Other", "OTH", 6]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  const amm = await hre.viem.deployContract("TesseraAMM", [deployer.account.address]);
  const guard = await hre.viem.deployContract("TesseraPriceGuard", [amm.address, pool.address]);

  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, P(1)]);
  await pool.write.addReserve([other.address, 7000, 8000, 8000, 1000, false, 6, P(10)]);
  await amm.write.createPool([[usdc.address, other.address], 30, 5000, "USDC / OTH"]);
  await pool.write.setWiring([0, guard.address]);
  return { deployer, usdc, other, pool, amm, guard };
}

describe("TesseraPriceGuard — pegged references", () => {
  it("bands a pegged asset without needing a pool to price it", async () => {
    /*
     * USDC is the reserve and the gas token, and it is the quote side of every
     * pair — asking the AMM what a dollar is worth is circular. A peg is the
     * honest reference, and it catches the fat finger just as well.
     */
    const f = await loadFixture(deployFixture);
    await f.guard.write.setPeg([f.usdc.address, P(1), 200]); // ±2%

    const [okNear] = await f.guard.read.check([f.usdc.address, P(1.01)]);
    const [okFar] = await f.guard.read.check([f.usdc.address, P(1.5)]);
    expect(okNear).to.equal(true);
    expect(okFar).to.equal(false);
  });

  it("stops the pool accepting a price outside the peg's band", async () => {
    // The guard is only worth anything if the pool actually consults it.
    const f = await loadFixture(deployFixture);
    await f.guard.write.setPeg([f.usdc.address, P(1), 200]);
    await expect(f.pool.write.setPrice([f.usdc.address, P(1.5)])).to.be.rejected;
    await f.pool.write.setPrice([f.usdc.address, P(1.01)]); // inside the band, fine
  });

  it("a pegged feed cannot fall back to waving prices through", async () => {
    /*
     * The failure this whole change is about. There is no AMM history here at
     * all, so a TWAP-only feed would compute nothing and pass everything. A peg
     * has a reference by construction, so there is no such state.
     */
    const f = await loadFixture(deployFixture);
    await f.guard.write.setPeg([f.usdc.address, P(1), 100]);
    const [ok, reference] = await f.guard.read.check([f.usdc.address, P(3)]);
    expect(ok).to.equal(false);
    expect(reference).to.equal(P(1));
  });

  it("refuses rather than guesses when a feed is told to require a reference", async () => {
    const f = await loadFixture(deployFixture);
    // A market feed with no history yet: the average is zero.
    await f.guard.write.setFeed([f.other.address, 0n, f.usdc.address, 2500, 3600, 0n]);
    const [passesOpen] = await f.guard.read.check([f.other.address, P(999)]);
    expect(passesOpen, "fails open by default, as it always has").to.equal(true);

    await f.guard.write.setRequireReference([f.other.address, true]);
    const [passesClosed] = await f.guard.read.check([f.other.address, P(999)]);
    expect(passesClosed, "and fails closed once asked to").to.equal(false);
  });

  it("leaves an unguarded asset unguarded, so existing deployments do not change", async () => {
    const f = await loadFixture(deployFixture);
    const [ok] = await f.guard.read.check([f.other.address, P(12345)]);
    expect(ok).to.equal(true);
  });

  it("reports the peg as the reference a dashboard should show", async () => {
    const f = await loadFixture(deployFixture);
    await f.guard.write.setPeg([f.usdc.address, P(1), 500]);
    const [enabled, reference, , poolPrice, , maxDev] = await f.guard.read.status([f.usdc.address]);
    expect(enabled).to.equal(true);
    expect(reference).to.equal(P(1));
    expect(poolPrice).to.equal(P(1));
    expect(maxDev).to.equal(500);
  });

  it("bounds the band, so a peg cannot be widened into meaninglessness", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.guard.write.setPeg([f.usdc.address, P(1), 9000])).to.be.rejected;
    await expect(f.guard.write.setPeg([f.usdc.address, P(1), 0])).to.be.rejected;
    await expect(f.guard.write.setPeg([f.usdc.address, 0n, 200])).to.be.rejected;
  });

  it("will not open borrowing on an asset whose mark nobody is checking", async () => {
    /*
     * Borrowing is the side of the book that lets somebody take an asset *out*
     * of the pool. Against a hand-set price with no guard on it, that is the
     * whole recipe: move the mark, borrow the float, walk away. So enabling is
     * conditional on the guard actually refusing something for that asset.
     */
    const f = await loadFixture(deployFixture);
    await expect(f.pool.write.setReserveFlag([f.other.address, 0, true])).to.be.rejected;

    await f.guard.write.setPeg([f.other.address, P(10), 500]);
    await f.pool.write.setReserveFlag([f.other.address, 0, true]);
    const r = await f.pool.read.reserves([f.other.address]);
    expect(r[1]).to.equal(true);
  });

  it("closing borrowing needs no guard, because less is always allowed", async () => {
    // Same reasoning as the freeze exemption: reducing what the pool will do
    // cannot be the dangerous direction.
    const f = await loadFixture(deployFixture);
    await f.pool.write.setReserveFlag([f.usdc.address, 0, false]);
    const r = await f.pool.read.reserves([f.usdc.address]);
    expect(r[1]).to.equal(false);
  });

  it("refuses to touch a reserve that was never listed", async () => {
    const f = await loadFixture(deployFixture);
    const [, stranger] = await hre.viem.getWalletClients();
    await expect(f.pool.write.setReserveFlag([stranger.account.address, 0, false])).to.be.rejected;
  });

  it("only the owner sets a peg or flips the requirement", async () => {
    const f = await loadFixture(deployFixture);
    const [, stranger] = await hre.viem.getWalletClients();
    const g = await hre.viem.getContractAt("TesseraPriceGuard", f.guard.address, { client: { wallet: stranger } });
    await expect(g.write.setPeg([f.usdc.address, P(1), 200])).to.be.rejected;
    await expect(g.write.setRequireReference([f.usdc.address, true])).to.be.rejected;
  });
});
