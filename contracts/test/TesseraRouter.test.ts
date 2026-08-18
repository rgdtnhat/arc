import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const U = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

const FEE = 30; // 0.30%, the standard Aquarius tier
const LP_SHARE = 5000;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** Far enough ahead that no test trips the deadline by accident. */
const soon = async () => BigInt(await time.latest()) + 3600n;

/**
 * Two pools sharing USDC as the hub: USDC/EURC and USDC/cirBTC. There is
 * deliberately no direct EURC/cirBTC pool, so any EURC→cirBTC trade has to be
 * routed — which is the whole thing being tested.
 */
async function deployFixture() {
  const [deployer, alice, bob, collector] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin (mock)", "EURC", 6]);
  const btc = await hre.viem.deployContract("MockToken", ["Circle Wrapped BTC (mock)", "cirBTC", 6]);

  const amm = await hre.viem.deployContract("TesseraAMM", [collector.account.address]);
  await amm.write.createPool([[usdc.address, eurc.address], FEE, LP_SHARE, "USDC / EURC"]);
  await amm.write.createPool([[usdc.address, btc.address], FEE, LP_SHARE, "USDC / cirBTC"]);

  const router = await hre.viem.deployContract("TesseraRouter", [amm.address, [usdc.address]]);

  const kind = (t: any) => (t.address === usdc.address ? "MockUSDC" : "MockToken");
  const mint = async (token: any, who: any, amount: bigint, spender: string) => {
    await token.write.mint([who.account.address, amount]);
    const asWho = await hre.viem.getContractAt(kind(token), token.address, { client: { wallet: who } });
    await asWho.write.approve([spender, amount]);
  };

  const asAmm = (who: any) => hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: who } });
  const asRouter = (who: any) =>
    hre.viem.getContractAt("TesseraRouter", router.address, { client: { wallet: who } });

  // Alice provides balanced liquidity to both pools.
  for (const t of [usdc, eurc, btc]) await mint(t, alice, U("1000000"), amm.address);
  await (await asAmm(alice)).write.addLiquidity([0n, [U("100000"), U("100000")], 0n]);
  await (await asAmm(alice)).write.addLiquidity([1n, [U("100000"), U("100000")], 0n]);

  return { deployer, alice, bob, collector, usdc, eurc, btc, amm, router, asAmm, asRouter, mint };
}

describe("TesseraRouter (swaps backed by AMM liquidity)", () => {
  it("holds nothing before or after a swap", async () => {
    const { bob, usdc, eurc, router, asRouter, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("1000"), router.address);

    for (const t of [usdc, eurc]) expect(await t.read.balanceOf([router.address])).to.equal(0n);
    await (await asRouter(bob)).write.swap([usdc.address, eurc.address, U("1000"), 0n, await soon()]);
    // The point of a router: no inventory to fund, none to strand, none to
    // withdraw. Anything left here after a fill would be somebody's money.
    for (const t of [usdc, eurc]) expect(await t.read.balanceOf([router.address])).to.equal(0n);
  });

  it("fills a direct pair through the one pool that holds it", async () => {
    const { bob, usdc, eurc, amm, router, asRouter, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("1000"), router.address);

    const [out, poolIds, path] = await router.read.estimate([usdc.address, eurc.address, U("1000")]);
    expect(poolIds.length).to.equal(1);
    expect(poolIds[0]).to.equal(0n);
    expect(path.map((p) => p.toLowerCase())).to.deep.equal([
      usdc.address.toLowerCase(),
      eurc.address.toLowerCase(),
    ]);

    // The router's estimate is the pool's own quote — it adds no spread.
    const [poolOut] = await amm.read.quote([0n, usdc.address, eurc.address, U("1000")]);
    expect(out).to.equal(poolOut);

    await (await asRouter(bob)).write.swap([usdc.address, eurc.address, U("1000"), out, await soon()]);
    expect(await eurc.read.balanceOf([bob.account.address])).to.equal(out);
  });

  it("routes a pair with no direct pool through the hub token", async () => {
    const { bob, eurc, btc, usdc, router, asRouter, mint } = await loadFixture(deployFixture);
    await mint(eurc, bob, U("1000"), router.address);

    // No EURC/cirBTC pool exists, so a single-pool venue would simply refuse.
    expect(await router.read.MAX_HOPS()).to.equal(3n);
    const [out, poolIds, path] = await router.read.estimate([eurc.address, btc.address, U("1000")]);
    expect(out > 0n, "a two-hop route was found").to.equal(true);
    expect(poolIds.length).to.equal(2);
    expect(path.map((p) => p.toLowerCase())).to.deep.equal([
      eurc.address.toLowerCase(),
      usdc.address.toLowerCase(),
      btc.address.toLowerCase(),
    ]);

    await (await asRouter(bob)).write.swap([eurc.address, btc.address, U("1000"), out, await soon()]);
    expect(await btc.read.balanceOf([bob.account.address])).to.equal(out);
    // Two hops means two fees, so the output is meaningfully below parity even
    // though both pools are balanced. Worth asserting: a route that looked free
    // would mean a fee was being skipped somewhere.
    expect(out < U("999")).to.equal(true);
  });

  it("rejects a fill below the caller's minimum output", async () => {
    const { bob, usdc, eurc, router, asRouter, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("1000"), router.address);
    const [out] = await router.read.estimate([usdc.address, eurc.address, U("1000")]);
    await expect(
      (await asRouter(bob)).write.swap([usdc.address, eurc.address, U("1000"), out + 1n, await soon()]),
    ).to.be.rejected;
  });

  it("refuses a swap whose deadline has passed", async () => {
    const { bob, usdc, eurc, router, asRouter, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("1000"), router.address);
    const stale = BigInt(await time.latest()) - 1n;
    // The guard that stops a transaction sitting in the mempool from being
    // filled later at whatever price the pool has drifted to.
    await expect(
      (await asRouter(bob)).write.swap([usdc.address, eurc.address, U("1000"), 0n, stale]),
    ).to.be.rejected;
  });

  it("reports no route rather than reverting when nothing can fill it", async () => {
    const { usdc, router } = await loadFixture(deployFixture);
    const orphan = await hre.viem.deployContract("MockToken", ["Orphan", "ORP", 6]);
    // `estimate` is a view a caller uses to decide; it must answer, not throw.
    const [out, poolIds] = await router.read.estimate([usdc.address, orphan.address, U("100")]);
    expect(out).to.equal(0n);
    expect(poolIds.length).to.equal(0);
  });

  it("reverts a swap for a pair with no route", async () => {
    const { bob, usdc, router, asRouter, mint } = await loadFixture(deployFixture);
    const orphan = await hre.viem.deployContract("MockToken", ["Orphan", "ORP", 6]);
    await mint(usdc, bob, U("100"), router.address);
    await expect(
      (await asRouter(bob)).write.swap([usdc.address, orphan.address, U("100"), 0n, await soon()]),
    ).to.be.rejected;
  });

  it("executes an explicit route the caller chose", async () => {
    const { bob, eurc, btc, usdc, router, asRouter, mint } = await loadFixture(deployFixture);
    await mint(eurc, bob, U("500"), router.address);
    const path = [eurc.address, usdc.address, btc.address];
    const expected = await router.read.estimateChained([[0n, 1n], path, U("500")]);
    expect(expected > 0n).to.equal(true);
    await (await asRouter(bob)).write.swapChained([[0n, 1n], path, U("500"), expected, await soon()]);
    expect(await btc.read.balanceOf([bob.account.address])).to.equal(expected);
  });

  it("rejects a malformed route", async () => {
    const { bob, usdc, eurc, router, asRouter, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("100"), router.address);
    const r = await asRouter(bob);
    const d = await soon();
    // One pool too few for the path length.
    await expect(r.write.swapChained([[0n], [usdc.address, usdc.address, eurc.address], U("100"), 0n, d])).to.be.rejected;
    // The same token twice in a row is not a hop.
    await expect(r.write.swapChained([[0n, 1n], [usdc.address, usdc.address, eurc.address], U("100"), 0n, d])).to.be.rejected;
    // A zero address in the path.
    await expect(r.write.swapChained([[0n], [usdc.address, ZERO], U("100"), 0n, d])).to.be.rejected;
  });

  it("leaves no standing approval to the AMM", async () => {
    const { bob, usdc, eurc, amm, router, asRouter, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("1000"), router.address);
    await (await asRouter(bob)).write.swap([usdc.address, eurc.address, U("1000"), 0n, await soon()]);
    // A router that leaves a live allowance to a pool is one pool bug away from
    // being drained of whatever passes through it next.
    for (const t of [usdc, eurc]) {
      expect(await t.read.allowance([router.address, amm.address])).to.equal(0n);
    }
  });

  it("prefers the pool that pays out more when a pair has two", async () => {
    const { deployer, bob, usdc, eurc, amm, router, asAmm, asRouter, mint } = await loadFixture(deployFixture);
    // A second USDC/EURC pool, deeper than the first, at the cheapest tier.
    await amm.write.createPool([[usdc.address, eurc.address], 10, LP_SHARE, "USDC / EURC (stable)"]);
    for (const t of [usdc, eurc]) await mint(t, deployer, U("1000000"), amm.address);
    await (await asAmm(deployer)).write.addLiquidity([2n, [U("500000"), U("500000")], 0n]);

    const [out, poolIds] = await router.read.estimate([usdc.address, eurc.address, U("10000")]);
    expect(poolIds[0]).to.equal(2n);
    const [shallow] = await amm.read.quote([0n, usdc.address, eurc.address, U("10000")]);
    expect(out > shallow, "the deeper, cheaper pool wins").to.equal(true);

    await mint(usdc, bob, U("10000"), router.address);
    await (await asRouter(bob)).write.swap([usdc.address, eurc.address, U("10000"), out, await soon()]);
    expect(await eurc.read.balanceOf([bob.account.address])).to.equal(out);
  });

  it("ignores a frozen pool", async () => {
    const { usdc, eurc, amm, router } = await loadFixture(deployFixture);
    const before = await router.read.estimate([usdc.address, eurc.address, U("100")]);
    expect(before[0] > 0n).to.equal(true);
    await amm.write.setFrozen([[0n], true]);
    // A frozen pool cannot fill, so offering its price would be a quote for a
    // trade that reverts.
    const after = await router.read.estimate([usdc.address, eurc.address, U("100")]);
    expect(after[0]).to.equal(0n);
  });

  it("only lets the owner repoint it or sweep it", async () => {
    const { bob, usdc, amm, router, asRouter } = await loadFixture(deployFixture);
    const r = await asRouter(bob);
    await expect(r.write.setAmm([amm.address])).to.be.rejected;
    await expect(r.write.setHubTokens([[usdc.address]])).to.be.rejected;
    await expect(r.write.sweep([usdc.address, bob.account.address])).to.be.rejected;
    await expect(r.write.transferOwnership([bob.account.address])).to.be.rejected;
  });

  it("sweeps a stray transfer back out", async () => {
    const { deployer, bob, usdc, router, mint } = await loadFixture(deployFixture);
    // Someone sends tokens straight to the router, which has no reason to hold
    // any. There are no user balances here, so recovering them takes nothing
    // from anyone.
    await mint(usdc, bob, U("50"), router.address);
    const asBob = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: bob } });
    await asBob.write.transfer([router.address, U("50")]);
    expect(await usdc.read.balanceOf([router.address])).to.equal(U("50"));

    const before = await usdc.read.balanceOf([deployer.account.address]);
    await router.write.sweep([usdc.address, deployer.account.address]);
    expect(await usdc.read.balanceOf([router.address])).to.equal(0n);
    expect(await usdc.read.balanceOf([deployer.account.address])).to.equal(before + U("50"));
  });
});
