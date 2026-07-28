import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const U = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

const SWAP_FEE = 30; // 0.30%
const LP_SHARE = 5000; // 50% of the fee stays with liquidity providers

async function deployFixture() {
  const [deployer, alice, bob, collector] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin (mock)", "EURC", 6]);
  const btc = await hre.viem.deployContract("MockToken", ["Circle Wrapped BTC (mock)", "cirBTC", 6]);

  const amm = await hre.viem.deployContract("TesseraAMM", [collector.account.address]);
  await amm.write.createPool([[usdc.address, eurc.address], SWAP_FEE, LP_SHARE, "USDC / EURC"]);

  const mint = async (token: any, who: any, amount: bigint) => {
    await token.write.mint([who.account.address, amount]);
    const asWho = await hre.viem.getContractAt(
      token.address === usdc.address ? "MockUSDC" : "MockToken",
      token.address,
      { client: { wallet: who } },
    );
    await asWho.write.approve([amm.address, amount]);
  };

  const asAmm = (who: any) => hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: who } });

  // Alice seeds the pool with a balanced 10k/10k position.
  await mint(usdc, alice, U("100000"));
  await mint(eurc, alice, U("100000"));
  await (await asAmm(alice)).write.addLiquidity([0n, [U("10000"), U("10000")], 0n]);

  return { deployer, alice, bob, collector, usdc, eurc, btc, amm, asAmm, mint };
}

describe("TesseraAMM (multi-asset liquidity pools)", () => {
  it("mints first-deposit shares and burns the minimum liquidity", async () => {
    const { alice, amm } = await loadFixture(deployFixture);
    const [assets, balances, , , totalShares] = await amm.read.poolInfo([0n]);
    expect(assets.length).to.equal(2);
    expect(balances[0]).to.equal(U("10000"));
    expect(balances[1]).to.equal(U("10000"));

    const aliceShares = await amm.read.sharesOf([0n, alice.account.address]);
    const burned = await amm.read.sharesOf([0n, "0x0000000000000000000000000000000000000000"]);
    const min = await amm.read.MINIMUM_LIQUIDITY();
    expect(burned).to.equal(min);
    expect(aliceShares + burned).to.equal(totalShares);
  });

  it("prices swaps on the constant product of the two involved balances", async () => {
    const { usdc, eurc, amm } = await loadFixture(deployFixture);
    const amountIn = U("1000");
    const [out, lpFee, appFee] = await amm.read.quote([0n, usdc.address, eurc.address, amountIn]);

    const fee = (amountIn * BigInt(SWAP_FEE)) / 10_000n;
    const net = amountIn - fee;
    const expected = (U("10000") * net) / (U("10000") + net);
    expect(out).to.equal(expected);
    expect(lpFee + appFee).to.equal(fee);
    // 50/50 split, with the odd wei rounding to the LPs rather than the app.
    expect(appFee).to.equal(fee / 2n);
    expect(lpFee >= appFee).to.equal(true);
  });

  it("never lets the app round a wei away from liquidity providers", async () => {
    const { deployer, usdc, eurc, amm } = await loadFixture(deployFixture);
    const asOwner = await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: deployer } });
    await asOwner.write.configurePool([0n, 300, 5000]); // 3% fee so odd totals are easy to hit
    // 33 units in → fee = 0 (rounds down) up to a fee of 1 wei at the right size.
    for (const raw of [333n, 3333n, 33333n, 777n]) {
      const [, lpFee, appFee] = await amm.read.quote([0n, usdc.address, eurc.address, raw]);
      const fee = (raw * 300n) / 10_000n;
      expect(lpFee + appFee).to.equal(fee);
      expect(lpFee >= appFee).to.equal(true);
    }
  });

  it("executes a swap, pays the app collector, and grows the invariant by the LP fee", async () => {
    const { bob, collector, usdc, eurc, amm, asAmm, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("1000"));

    const [, balancesBefore] = await amm.read.poolInfo([0n]);
    const kBefore = balancesBefore[0] * balancesBefore[1];

    const [expectedOut, lpFee, appFee] = await amm.read.quote([0n, usdc.address, eurc.address, U("1000")]);
    await (await asAmm(bob)).write.swap([0n, usdc.address, eurc.address, U("1000"), expectedOut]);

    expect(await eurc.read.balanceOf([bob.account.address])).to.equal(expectedOut);
    expect(await usdc.read.balanceOf([collector.account.address])).to.equal(appFee);

    const [, balancesAfter] = await amm.read.poolInfo([0n]);
    const kAfter = balancesAfter[0] * balancesAfter[1];
    expect(kAfter > kBefore).to.equal(true); // fees accrue to the pool, never leak
    expect(lpFee > 0n).to.equal(true);

    // Bookkeeping matches the tokens actually held by the contract.
    expect(await usdc.read.balanceOf([amm.address])).to.equal(balancesAfter[0]);
    expect(await eurc.read.balanceOf([amm.address])).to.equal(balancesAfter[1]);
  });

  it("makes each LP share redeemable for more after swap fees accrue", async () => {
    const { alice, bob, usdc, eurc, amm, asAmm, mint } = await loadFixture(deployFixture);
    const shares = await amm.read.sharesOf([0n, alice.account.address]);

    // Snapshot what Alice's shares are worth before any trading.
    const [, before] = await amm.read.poolInfo([0n]);
    const totalBefore = (await amm.read.poolInfo([0n]))[4];
    const valueBefore = ((before[0] + before[1]) * shares) / totalBefore;

    // Bob trades back and forth, paying fees in both directions.
    await mint(usdc, bob, U("2000"));
    await mint(eurc, bob, U("2000"));
    await (await asAmm(bob)).write.swap([0n, usdc.address, eurc.address, U("2000"), 0n]);
    await (await asAmm(bob)).write.swap([0n, eurc.address, usdc.address, U("2000"), 0n]);

    const [, after] = await amm.read.poolInfo([0n]);
    const totalAfter = (await amm.read.poolInfo([0n]))[4];
    const valueAfter = ((after[0] + after[1]) * shares) / totalAfter;
    expect(valueAfter > valueBefore).to.equal(true);
  });

  it("returns a proportional slice of every asset on withdrawal", async () => {
    const { alice, usdc, eurc, amm, asAmm } = await loadFixture(deployFixture);
    const shares = await amm.read.sharesOf([0n, alice.account.address]);
    const usdcBefore = await usdc.read.balanceOf([alice.account.address]);
    const eurcBefore = await eurc.read.balanceOf([alice.account.address]);

    await (await asAmm(alice)).write.removeLiquidity([0n, shares / 2n, [0n, 0n]]);

    const usdcOut = (await usdc.read.balanceOf([alice.account.address])) - usdcBefore;
    const eurcOut = (await eurc.read.balanceOf([alice.account.address])) - eurcBefore;
    // Half of Alice's stake ≈ half the pool (minus the tiny burned minimum).
    expect(usdcOut > U("4999") && usdcOut <= U("5000")).to.equal(true);
    expect(eurcOut).to.equal(usdcOut); // balanced pool → symmetric payout
    expect(await amm.read.sharesOf([0n, alice.account.address])).to.equal(shares - shares / 2n);
  });

  it("mints the minimum ratio so an unbalanced deposit cannot mint free value", async () => {
    const { bob, amm, asAmm, usdc, eurc, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("1000"));
    await mint(eurc, bob, U("1000"));

    const totalBefore = (await amm.read.poolInfo([0n]))[4];
    // 1000 USDC but only 100 EURC into a balanced pool → credited at the 100 side.
    await (await asAmm(bob)).write.addLiquidity([0n, [U("1000"), U("100")], 0n]);
    const bobShares = await amm.read.sharesOf([0n, bob.account.address]);
    expect(bobShares).to.equal((U("100") * totalBefore) / U("10000"));

    // Withdrawing everything must not return more value than was contributed.
    const usdcBefore = await usdc.read.balanceOf([bob.account.address]);
    const eurcBefore = await eurc.read.balanceOf([bob.account.address]);
    await (await asAmm(bob)).write.removeLiquidity([0n, bobShares, [0n, 0n]]);
    const usdcOut = (await usdc.read.balanceOf([bob.account.address])) - usdcBefore;
    const eurcOut = (await eurc.read.balanceOf([bob.account.address])) - eurcBefore;
    expect(usdcOut + eurcOut < U("1100")).to.equal(true); // he donated the excess, gained nothing
  });

  it("supports pools with more than two assets", async () => {
    const { deployer, alice, bob, usdc, eurc, btc, amm, asAmm, mint } = await loadFixture(deployFixture);
    const asOwner = await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: deployer } });
    await asOwner.write.createPool([[usdc.address, eurc.address, btc.address], SWAP_FEE, LP_SHARE, "Tri-asset"]);

    await mint(btc, alice, U("100000"));
    await (await asAmm(alice)).write.addLiquidity([1n, [U("5000"), U("5000"), U("5000")], 0n]);

    // A swap only moves the two legs involved; the third balance is untouched.
    await mint(usdc, bob, U("500"));
    const [, before] = await amm.read.poolInfo([1n]);
    const [expectedOut] = await amm.read.quote([1n, usdc.address, btc.address, U("500")]);
    await (await asAmm(bob)).write.swap([1n, usdc.address, btc.address, U("500"), expectedOut]);
    const [, after] = await amm.read.poolInfo([1n]);
    expect(after[1]).to.equal(before[1]); // EURC leg unchanged
    expect(after[2]).to.equal(before[2] - expectedOut);
    expect(await btc.read.balanceOf([bob.account.address])).to.equal(expectedOut);
  });

  it("enforces the pool asset-count bounds the operator sets", async () => {
    const { deployer, usdc, eurc, btc, amm } = await loadFixture(deployFixture);
    const asOwner = await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: deployer } });
    await expect(asOwner.write.createPool([[usdc.address], SWAP_FEE, LP_SHARE, "solo"])).to.be.rejected;
    await expect(asOwner.write.createPool([[usdc.address, usdc.address], SWAP_FEE, LP_SHARE, "dupe"])).to.be.rejected;

    await asOwner.write.setMaxAssetsPerPool([2]);
    await expect(
      asOwner.write.createPool([[usdc.address, eurc.address, btc.address], SWAP_FEE, LP_SHARE, "too many"]),
    ).to.be.rejected;
    await expect(asOwner.write.setMaxAssetsPerPool([9])).to.be.rejected;
    await expect(asOwner.write.setMaxAssetsPerPool([1])).to.be.rejected;
  });

  it("will not let the operator push the LP fee share below 50%", async () => {
    const { deployer, usdc, eurc, amm } = await loadFixture(deployFixture);
    const asOwner = await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: deployer } });
    expect(await amm.read.MIN_LP_SHARE()).to.equal(5000);
    await expect(asOwner.write.configurePool([0n, SWAP_FEE, 4999])).to.be.rejected;
    await expect(asOwner.write.createPool([[usdc.address, eurc.address], SWAP_FEE, 0, "greedy"])).to.be.rejected;
    await expect(asOwner.write.configurePool([0n, 501, 5000])).to.be.rejected; // fee ceiling
    // Raising the LP share above the floor is fine.
    await asOwner.write.configurePool([0n, SWAP_FEE, 8000]);
    expect((await amm.read.poolInfo([0n]))[3]).to.equal(8000);
  });

  it("configures many pools in one call", async () => {
    const { deployer, usdc, eurc, btc, amm } = await loadFixture(deployFixture);
    const asOwner = await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: deployer } });
    await asOwner.write.createPool([[usdc.address, btc.address], SWAP_FEE, LP_SHARE, "USDC / cirBTC"]);
    await asOwner.write.createPool([[eurc.address, btc.address], SWAP_FEE, LP_SHARE, "EURC / cirBTC"]);

    await asOwner.write.configurePools([[0n, 1n, 2n], 10, 7000]);
    for (const id of [0n, 1n, 2n]) {
      const info = await amm.read.poolInfo([id]);
      expect(info[2]).to.equal(10);
      expect(info[3]).to.equal(7000);
    }
  });

  it("freezes swaps and deposits but never traps liquidity", async () => {
    const { deployer, alice, bob, usdc, eurc, amm, asAmm, mint } = await loadFixture(deployFixture);
    const asOwner = await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: deployer } });
    await asOwner.write.setFrozen([0n, true]);

    await mint(usdc, bob, U("100"));
    await expect((await asAmm(bob)).write.swap([0n, usdc.address, eurc.address, U("100"), 0n])).to.be.rejected;
    await expect((await asAmm(bob)).write.addLiquidity([0n, [U("100"), U("100")], 0n])).to.be.rejected;

    // Withdrawal still works — a kill-switch must not hold funds hostage.
    const shares = await amm.read.sharesOf([0n, alice.account.address]);
    const before = await usdc.read.balanceOf([alice.account.address]);
    await (await asAmm(alice)).write.removeLiquidity([0n, shares, [0n, 0n]]);
    expect((await usdc.read.balanceOf([alice.account.address])) > before).to.equal(true);

    await asOwner.write.setFrozen([0n, false]);
    await (await asAmm(bob)).write.swap([0n, usdc.address, eurc.address, U("100"), 0n]);
  });

  it("guards slippage on swaps and on both sides of liquidity", async () => {
    const { alice, bob, usdc, eurc, amm, asAmm, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("1000"));
    const [out] = await amm.read.quote([0n, usdc.address, eurc.address, U("1000")]);
    await expect((await asAmm(bob)).write.swap([0n, usdc.address, eurc.address, U("1000"), out + 1n])).to.be.rejected;

    await mint(eurc, bob, U("1000"));
    await expect(
      (await asAmm(bob)).write.addLiquidity([0n, [U("1000"), U("1000")], U("999999999999")]),
    ).to.be.rejected;

    const shares = await amm.read.sharesOf([0n, alice.account.address]);
    await expect(
      (await asAmm(alice)).write.removeLiquidity([0n, shares, [U("999999"), U("999999")]]),
    ).to.be.rejected;
  });

  it("rejects nonsense swaps", async () => {
    const { bob, usdc, eurc, btc, amm, asAmm, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("100"));
    await expect(amm.read.quote([0n, usdc.address, usdc.address, U("100")])).to.be.rejected; // same token
    await expect(amm.read.quote([0n, usdc.address, eurc.address, 0n])).to.be.rejected; // zero in
    await expect(amm.read.quote([0n, usdc.address, btc.address, U("100")])).to.be.rejected; // not in pool
    await expect(amm.read.quote([9n, usdc.address, eurc.address, U("100")])).to.be.rejected; // no such pool
  });

  it("keeps admin functions owner-only", async () => {
    const { alice, usdc, eurc, amm, asAmm } = await loadFixture(deployFixture);
    const a = await asAmm(alice);
    await expect(a.write.createPool([[usdc.address, eurc.address], SWAP_FEE, LP_SHARE, "nope"])).to.be.rejected;
    await expect(a.write.configurePool([0n, 10, 9000])).to.be.rejected;
    await expect(a.write.configurePools([[0n], 10, 9000])).to.be.rejected;
    await expect(a.write.setFrozen([0n, true])).to.be.rejected;
    await expect(a.write.renamePool([0n, "hijacked"])).to.be.rejected;
    await expect(a.write.setMaxAssetsPerPool([8])).to.be.rejected;
    await expect(a.write.setAppFeeCollector([alice.account.address])).to.be.rejected;
    await expect(a.write.transferOwnership([alice.account.address])).to.be.rejected;
  });

  it("renames a pool without touching its balances", async () => {
    const { deployer, amm } = await loadFixture(deployFixture);
    const asOwner = await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: deployer } });
    await asOwner.write.renamePool([0n, "Stable pair"]);
    const info = await amm.read.poolInfo([0n]);
    expect(info[6]).to.equal("Stable pair");
    expect(info[1][0]).to.equal(U("10000"));
  });

  it("cannot be drained by a swap larger than the pool", async () => {
    const { bob, usdc, eurc, amm, asAmm, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("1000000"));
    const [out] = await amm.read.quote([0n, usdc.address, eurc.address, U("1000000")]);
    expect(out < U("10000")).to.equal(true); // strictly less than the whole reserve
    await (await asAmm(bob)).write.swap([0n, usdc.address, eurc.address, U("1000000"), 0n]);
    const [, balances] = await amm.read.poolInfo([0n]);
    expect(balances[1] > 0n).to.equal(true); // output leg never fully drains
    expect(await eurc.read.balanceOf([amm.address])).to.equal(balances[1]);
  });

  it("lets fees be funded back into a pool without minting shares", async () => {
    const { alice, bob, usdc, amm, asAmm, mint } = await loadFixture(deployFixture);
    const totalBefore = (await amm.read.poolInfo([0n]))[4];
    const aliceShares = await amm.read.sharesOf([0n, alice.account.address]);

    await mint(usdc, bob, U("500"));
    await (await asAmm(bob)).write.fund([0n, usdc.address, U("500")]);

    const [, balances, , , totalAfter] = await amm.read.poolInfo([0n]);
    expect(balances[0]).to.equal(U("10500"));
    expect(totalAfter).to.equal(totalBefore); // no shares minted
    expect(await amm.read.sharesOf([0n, bob.account.address])).to.equal(0n);
    expect(await amm.read.sharesOf([0n, alice.account.address])).to.equal(aliceShares);

    // Alice's unchanged shares are now redeemable for the donated value.
    const before = await usdc.read.balanceOf([alice.account.address]);
    await (await asAmm(alice)).write.removeLiquidity([0n, aliceShares, [0n, 0n]]);
    expect((await usdc.read.balanceOf([alice.account.address])) - before > U("10000")).to.equal(true);
  });

  it("rejects funding a pool that does not hold the asset", async () => {
    const { bob, btc, amm, asAmm, mint } = await loadFixture(deployFixture);
    await mint(btc, bob, U("100"));
    await expect((await asAmm(bob)).write.fund([0n, btc.address, U("100")])).to.be.rejected;
  });

  it("keeps the burned minimum-liquidity shares unredeemable", async () => {
    const { alice, amm, asAmm } = await loadFixture(deployFixture);
    const shares = await amm.read.sharesOf([0n, alice.account.address]);
    await (await asAmm(alice)).write.removeLiquidity([0n, shares, [0n, 0n]]);
    const info = await amm.read.poolInfo([0n]);
    expect(info[4]).to.equal(await amm.read.MINIMUM_LIQUIDITY()); // only the burn remains
    expect(info[1][0] > 0n).to.equal(true); // dust stays behind, pool is never zeroed
  });

  // --- direction: does the caller get the asset they asked for? ---------------
  //
  // The existing swap tests assert amounts. These assert *identity*: the right
  // token arrives, the right token leaves, nothing else in the pool moves, and
  // the two directions are independent. A transposed tokenIn/tokenOut would keep
  // every amount plausible while handing back the wrong asset.

  it("gives the caller tokenOut and takes tokenIn, in both directions", async () => {
    const { bob, usdc, eurc, amm, asAmm, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("2000"));
    await mint(eurc, bob, U("2000"));

    // USDC -> EURC
    let usdcBefore = await usdc.read.balanceOf([bob.account.address]);
    let eurcBefore = await eurc.read.balanceOf([bob.account.address]);
    const [expectOut] = await amm.read.quote([0n, usdc.address, eurc.address, U("1000")]);
    await (await asAmm(bob)).write.swap([0n, usdc.address, eurc.address, U("1000"), 0n]);
    expect(usdcBefore - (await usdc.read.balanceOf([bob.account.address]))).to.equal(U("1000"));
    expect((await eurc.read.balanceOf([bob.account.address])) - eurcBefore).to.equal(expectOut);

    // EURC -> USDC: the opposite token must move the opposite way.
    usdcBefore = await usdc.read.balanceOf([bob.account.address]);
    eurcBefore = await eurc.read.balanceOf([bob.account.address]);
    const [expectBack] = await amm.read.quote([0n, eurc.address, usdc.address, U("500")]);
    await (await asAmm(bob)).write.swap([0n, eurc.address, usdc.address, U("500"), 0n]);
    expect(eurcBefore - (await eurc.read.balanceOf([bob.account.address]))).to.equal(U("500"));
    expect((await usdc.read.balanceOf([bob.account.address])) - usdcBefore).to.equal(expectBack);
  });

  it("leaves the pool's other assets untouched in a three-asset pool", async () => {
    const { alice, bob, usdc, eurc, btc, amm, asAmm, mint } = await loadFixture(deployFixture);
    await amm.write.createPool([[usdc.address, eurc.address, btc.address], SWAP_FEE, LP_SHARE, "tri"]);
    await mint(btc, alice, U("100000"));
    await (await asAmm(alice)).write.addLiquidity([1n, [U("5000"), U("5000"), U("5000")], 0n]);

    const before: any = await amm.read.poolInfo([1n]);
    const eurcReserveBefore = before[1][1] as bigint;

    await mint(usdc, bob, U("1000"));
    const btcBefore = await btc.read.balanceOf([bob.account.address]);
    const eurcBefore = await eurc.read.balanceOf([bob.account.address]);
    // Swap USDC -> cirBTC. EURC is in the pool but not in this trade.
    await (await asAmm(bob)).write.swap([1n, usdc.address, btc.address, U("1000"), 0n]);

    expect((await btc.read.balanceOf([bob.account.address])) > btcBefore).to.equal(true);
    expect(await eurc.read.balanceOf([bob.account.address])).to.equal(eurcBefore);
    const after: any = await amm.read.poolInfo([1n]);
    expect(after[1][1]).to.equal(eurcReserveBefore); // EURC reserve unmoved
  });

  it("refuses to swap an asset for itself", async () => {
    const { bob, usdc, asAmm, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("100"));
    await expect(
      (await asAmm(bob)).write.swap([0n, usdc.address, usdc.address, U("100"), 0n])
    ).to.be.rejected;
  });

  it("refuses a token that is not in the pool", async () => {
    const { bob, usdc, btc, asAmm, mint } = await loadFixture(deployFixture);
    await mint(usdc, bob, U("100"));
    // btc is not an asset of pool 0.
    await expect(
      (await asAmm(bob)).write.swap([0n, usdc.address, btc.address, U("100"), 0n])
    ).to.be.rejected;
  });
});
