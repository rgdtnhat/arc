import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const U = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));
const PRICE = 10n ** 8n;
const MAXU = (1n << 256n) - 1n;

async function deployFixture() {
  const [deployer, alice, bob] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin", "EURC", 6]);
  const amm = await hre.viem.deployContract("TesseraAMM", [deployer.account.address]);
  await amm.write.createPool([[usdc.address, eurc.address], 30, 5000, "USDC / EURC"]);

  for (const [t, kind, who] of [
    [usdc, "MockUSDC", alice],
    [eurc, "MockToken", alice],
    [usdc, "MockUSDC", bob],
    [eurc, "MockToken", bob],
  ] as const) {
    await t.write.mint([who.account.address, U("200000")]);
    const c = await hre.viem.getContractAt(kind, t.address, { client: { wallet: who } });
    await c.write.approve([amm.address, U("200000")]);
  }

  const asAmm = (who: any) => hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: who } });
  await (await asAmm(alice)).write.addLiquidity([0n, [U("50000"), U("50000")], 0n]);

  const lp = await hre.viem.deployContract("TesseraLpToken", [
    amm.address,
    0n,
    "Tessera LP USDC/EURC",
    "tLP-USDC-EURC",
  ]);
  const asLp = (who: any) => hre.viem.getContractAt("TesseraLpToken", lp.address, { client: { wallet: who } });

  return { deployer, alice, bob, usdc, eurc, amm, lp, asAmm, asLp };
}

describe("TesseraAMM — share transfers", () => {
  it("moves a position between holders", async () => {
    const { alice, bob, amm, asAmm } = await loadFixture(deployFixture);
    const shares = await amm.read.sharesOf([0n, alice.account.address]);
    await (await asAmm(alice)).write.transferShares([0n, bob.account.address, shares / 2n]);
    expect(await amm.read.sharesOf([0n, bob.account.address])).to.equal(shares / 2n);
    expect(await amm.read.sharesOf([0n, alice.account.address])).to.equal(shares - shares / 2n);
  });

  it("refuses to move more than the holder has", async () => {
    const { alice, bob, amm, asAmm } = await loadFixture(deployFixture);
    const shares = await amm.read.sharesOf([0n, alice.account.address]);
    await expect((await asAmm(alice)).write.transferShares([0n, bob.account.address, shares + 1n])).to.be.rejected;
  });

  it("requires an allowance to move somebody else's", async () => {
    const { alice, bob, amm, asAmm } = await loadFixture(deployFixture);
    const b = await asAmm(bob);
    await expect(
      b.write.transferSharesFrom([0n, alice.account.address, bob.account.address, 1n]),
    ).to.be.rejected;

    await (await asAmm(alice)).write.approveShares([0n, bob.account.address, 100n]);
    await b.write.transferSharesFrom([0n, alice.account.address, bob.account.address, 60n]);
    expect(await amm.read.shareAllowance([0n, alice.account.address, bob.account.address])).to.equal(40n);
    // And the allowance is a limit, not a suggestion.
    await expect(
      b.write.transferSharesFrom([0n, alice.account.address, bob.account.address, 41n]),
    ).to.be.rejected;
  });

  it("leaves an infinite approval alone", async () => {
    const { alice, bob, amm, asAmm } = await loadFixture(deployFixture);
    await (await asAmm(alice)).write.approveShares([0n, bob.account.address, MAXU]);
    await (await asAmm(bob)).write.transferSharesFrom([0n, alice.account.address, bob.account.address, 500n]);
    // The ERC-20 convention, so a long-lived wrapper does not rewrite storage
    // on every wrap.
    expect(await amm.read.shareAllowance([0n, alice.account.address, bob.account.address])).to.equal(MAXU);
  });

  it("will not send a position to nowhere", async () => {
    const { alice, asAmm } = await loadFixture(deployFixture);
    await expect(
      (await asAmm(alice)).write.transferShares([0n, "0x0000000000000000000000000000000000000000", 1n]),
    ).to.be.rejected;
  });
});

describe("TesseraLpToken (a liquidity position as an ordinary token)", () => {
  async function wrapped() {
    const f = await loadFixture(deployFixture);
    const shares = await f.amm.read.sharesOf([0n, f.alice.account.address]);
    await (await f.asAmm(f.alice)).write.approveShares([0n, f.lp.address, MAXU]);
    await (await f.asLp(f.alice)).write.wrap([shares / 2n]);
    return { ...f, wrappedShares: shares / 2n };
  }

  it("mints one token per share, and is fully backed", async () => {
    const f = await wrapped();
    expect(await f.lp.read.balanceOf([f.alice.account.address])).to.equal(f.wrappedShares);
    expect(await f.lp.read.totalSupply()).to.equal(f.wrappedShares);
    // There is no exchange rate to drift: the yield lives in the share itself.
    expect(await f.lp.read.backing()).to.equal(await f.lp.read.totalSupply());
  });

  it("gives the position back on unwrap", async () => {
    const f = await wrapped();
    const before = await f.amm.read.sharesOf([0n, f.alice.account.address]);
    await (await f.asLp(f.alice)).write.unwrap([f.wrappedShares]);
    expect(await f.amm.read.sharesOf([0n, f.alice.account.address])).to.equal(before + f.wrappedShares);
    expect(await f.lp.read.totalSupply()).to.equal(0n);
    expect(await f.lp.read.backing()).to.equal(0n);
  });

  it("cannot be redeemed twice", async () => {
    const f = await wrapped();
    const l = await f.asLp(f.alice);
    await l.write.unwrap([f.wrappedShares]);
    await expect(l.write.unwrap([1n])).to.be.rejected;
  });

  it("cannot be unwrapped by someone who does not hold it", async () => {
    const f = await wrapped();
    await expect((await f.asLp(f.bob)).write.unwrap([1n])).to.be.rejected;
  });

  it("behaves as an ERC-20 so the lending pool can hold it", async () => {
    const f = await wrapped();
    const l = await f.asLp(f.alice);
    await l.write.transfer([f.bob.account.address, 1000n]);
    expect(await f.lp.read.balanceOf([f.bob.account.address])).to.equal(1000n);

    await l.write.approve([f.bob.account.address, 500n]);
    await (await f.asLp(f.bob)).write.transferFrom([f.alice.account.address, f.bob.account.address, 500n]);
    expect(await f.lp.read.balanceOf([f.bob.account.address])).to.equal(1500n);
    expect(await f.lp.read.allowance([f.alice.account.address, f.bob.account.address])).to.equal(0n);
  });

  it("keeps earning while it is wrapped", async () => {
    const f = await wrapped();
    const [, perShareBefore] = await f.lp.read.sharePriceHint();

    // Bob trades back and forth, paying fees both ways. Those fees stay in the
    // pool, so every share — wrapped or not — becomes a claim on more.
    const b = await f.asAmm(f.bob);
    await b.write.swap([0n, f.usdc.address, f.eurc.address, U("5000"), 0n]);
    await b.write.swap([0n, f.eurc.address, f.usdc.address, U("5000"), 0n]);

    const [, perShareAfter] = await f.lp.read.sharePriceHint();
    const before = perShareBefore[0]! + perShareBefore[1]!;
    const after = perShareAfter[0]! + perShareAfter[1]!;
    expect(after > before, "a wrapped share is worth more after fees").to.equal(true);
    // The token count did not change — the yield is in the share, not a rebase.
    expect(await f.lp.read.balanceOf([f.alice.account.address])).to.equal(f.wrappedShares);
  });

  it("reports what a share is a claim on, without pretending to price it", async () => {
    const f = await wrapped();
    const [assets, perShare, totalShares] = await f.lp.read.sharePriceHint();
    expect(assets.length).to.equal(2);
    expect(totalShares > 0n).to.equal(true);
    const scale = await f.lp.read.SHARE_SCALE();
    const [, balances] = await f.amm.read.poolInfo([0n]);
    // One share redeems for balance/totalShares of each side.
    expect(perShare[0]).to.equal((balances[0]! * scale) / totalShares);
    expect(perShare[1]).to.equal((balances[1]! * scale) / totalShares);
  });

  it("works as collateral in the lending pool with no pool changes", async () => {
    const f = await wrapped();
    const [deployer] = await hre.viem.getWalletClients();
    const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
    await pool.write.addReserve([f.usdc.address, 9000, 9300, 9500, 1000, true, 6, PRICE]);

    // The wrapper is just an ERC-20, so it is listed the same way anything else
    // is. Conservative factors: redeeming it is a two-step withdrawal into two
    // assets whose prices can move in between.
    const [, perShare] = await f.lp.read.sharePriceHint();
    const scale = await f.lp.read.SHARE_SCALE();
    const perShareUsd = ((perShare[0]! + perShare[1]!) * PRICE) / scale / 10n ** 6n;
    await pool.write.addReserve([f.lp.address, 5000, 6000, 8000, 1000, false, 0, perShareUsd]);

    // Somebody has to have lent USDC for there to be anything to borrow.
    await f.usdc.write.mint([f.bob.account.address, U("50000")]);
    const bobUsdc = await hre.viem.getContractAt("MockUSDC", f.usdc.address, { client: { wallet: f.bob } });
    await bobUsdc.write.approve([pool.address, U("50000")]);
    await (await hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: f.bob } })).write.supply([
      f.usdc.address,
      U("50000"),
    ]);

    // Alice posts her wrapped liquidity and borrows against it — without ever
    // taking the liquidity out of the pool, which is the whole point.
    const aliceLp = await f.asLp(f.alice);
    await aliceLp.write.approve([pool.address, f.wrappedShares]);
    const alicePool = await hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: f.alice } });
    await alicePool.write.supply([f.lp.address, f.wrappedShares]);

    const [borrowLimit] = await pool.read.accountLimits([f.alice.account.address]);
    expect(borrowLimit > 0n, "the LP position backs a borrow limit").to.equal(true);

    await alicePool.write.borrow([f.usdc.address, U("1000")]);
    expect(await f.usdc.read.balanceOf([f.alice.account.address]) > 0n).to.equal(true);

    // And the position is still earning: the shares are in the wrapper, which
    // is in the lending pool, but they are still the AMM's shares.
    expect(await f.lp.read.backing()).to.equal(await f.lp.read.totalSupply());
  });
});
