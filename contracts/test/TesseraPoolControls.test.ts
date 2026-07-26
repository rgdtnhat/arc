import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n; // $1.00
const U = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

const FREEZE_SUPPLY = 1;
const FREEZE_WITHDRAW = 2;
const FREEZE_BORROW = 4;
const FREEZE_REPAY = 8;
const FREEZE_ALL = 15;

async function deployFixture() {
  const [deployer, alice, bob] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const btc = await hre.viem.deployContract("MockToken", ["Circle Wrapped BTC (mock)", "cirBTC", 8]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 1000, true, 6, PRICE]);
  await pool.write.addReserve([btc.address, 7000, 8000, 1000, true, 8, 95_000n * PRICE]);

  const asPool = (who: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: who } });
  const fund = async (token: any, who: any, amount: bigint) => {
    await token.write.mint([who.account.address, amount]);
    const t = await hre.viem.getContractAt(token.address === usdc.address ? "MockUSDC" : "MockToken", token.address, {
      client: { wallet: who },
    });
    await t.write.approve([pool.address, amount]);
  };

  // Alice supplies USDC; Bob posts cirBTC collateral and borrows against it.
  await fund(usdc, alice, U("10000"));
  await (await asPool(alice)).write.supply([usdc.address, U("10000")]);
  await fund(btc, bob, 100_000_000n); // 1 cirBTC
  await (await asPool(bob)).write.supply([btc.address, 100_000_000n]);
  await (await asPool(bob)).write.borrow([usdc.address, U("1000")]);
  await fund(usdc, bob, U("2000"));

  return { deployer, alice, bob, usdc, btc, pool, asPool, fund };
}

describe("TesseraPool — freeze, naming and visibility controls", () => {
  it("starts with nothing frozen", async () => {
    const { usdc, pool } = await loadFixture(deployFixture);
    expect(await pool.read.frozenActions([usdc.address])).to.equal(0);
  });

  it("freezes supply and borrow while leaving withdraw and repay open", async () => {
    const { alice, bob, usdc, pool, asPool, fund } = await loadFixture(deployFixture);
    // The incident case from the spec: stop new risk, let people get out.
    await pool.write.setFrozen([usdc.address, FREEZE_SUPPLY | FREEZE_BORROW]);

    await fund(usdc, alice, U("100"));
    await expect((await asPool(alice)).write.supply([usdc.address, U("100")])).to.be.rejected;
    await expect((await asPool(bob)).write.borrow([usdc.address, U("10")])).to.be.rejected;

    // Withdraw and repay still work — nobody's funds are trapped.
    await (await asPool(alice)).write.withdraw([usdc.address, U("500")]);
    await (await asPool(bob)).write.repay([usdc.address, U("500")]);
    expect(await usdc.read.balanceOf([alice.account.address]) > 0n).to.equal(true);
  });

  it("freezes every action with FREEZE_ALL", async () => {
    const { alice, bob, usdc, pool, asPool, fund } = await loadFixture(deployFixture);
    await pool.write.setFrozen([usdc.address, FREEZE_ALL]);
    await fund(usdc, alice, U("100"));
    await expect((await asPool(alice)).write.supply([usdc.address, U("100")])).to.be.rejected;
    await expect((await asPool(alice)).write.withdraw([usdc.address, U("100")])).to.be.rejected;
    await expect((await asPool(bob)).write.borrow([usdc.address, U("10")])).to.be.rejected;
    await expect((await asPool(bob)).write.repay([usdc.address, U("10")])).to.be.rejected;
  });

  it("still allows liquidation while the reserve is fully frozen", async () => {
    const { deployer, alice, bob, usdc, btc, pool, asPool, fund } = await loadFixture(deployFixture);
    // Crash the collateral so Bob's position goes underwater, then freeze
    // everything: bad debt must still be clearable or it compounds on the
    // depositors the freeze is meant to protect.
    await pool.write.setPrice([btc.address, 500n * PRICE]);
    await pool.write.setFrozen([usdc.address, FREEZE_ALL]);
    await pool.write.setFrozen([btc.address, FREEZE_ALL]);

    await fund(usdc, alice, U("500"));
    // Seized collateral lands as a pool position for the liquidator, not tokens.
    const before = await pool.read.supplyBalance([btc.address, alice.account.address]);
    const debtBefore = await pool.read.borrowBalance([usdc.address, bob.account.address]);
    await (await asPool(alice)).write.liquidate([bob.account.address, usdc.address, btc.address, U("200")]);
    expect((await pool.read.supplyBalance([btc.address, alice.account.address])) > before).to.equal(true);
    expect((await pool.read.borrowBalance([usdc.address, bob.account.address])) < debtBefore).to.equal(true);
    expect(deployer.account.address).to.be.a("string");
  });

  it("unfreezes by clearing the mask", async () => {
    const { alice, usdc, pool, asPool, fund } = await loadFixture(deployFixture);
    await pool.write.setFrozen([usdc.address, FREEZE_ALL]);
    await pool.write.setFrozen([usdc.address, 0]);
    await fund(usdc, alice, U("100"));
    await (await asPool(alice)).write.supply([usdc.address, U("100")]);
    expect(await pool.read.frozenActions([usdc.address])).to.equal(0);
  });

  it("freezes several reserves in one call", async () => {
    const { usdc, btc, pool } = await loadFixture(deployFixture);
    await pool.write.setFrozenMany([[usdc.address, btc.address], FREEZE_BORROW]);
    expect(await pool.read.frozenActions([usdc.address])).to.equal(FREEZE_BORROW);
    expect(await pool.read.frozenActions([btc.address])).to.equal(FREEZE_BORROW);
  });

  it("rejects an out-of-range mask and an unknown reserve", async () => {
    const { usdc, pool } = await loadFixture(deployFixture);
    await expect(pool.write.setFrozen([usdc.address, 16])).to.be.rejected;
    await expect(pool.write.setFrozen(["0x0000000000000000000000000000000000000001", FREEZE_ALL])).to.be.rejected;
  });

  it("renames a reserve and hides it without touching balances", async () => {
    const { alice, usdc, pool } = await loadFixture(deployFixture);
    const supplied = await pool.read.supplyBalance([usdc.address, alice.account.address]);
    await pool.write.renameReserve([usdc.address, "USD Coin — main"]);
    await pool.write.setReserveHidden([usdc.address, true]);
    const [mask, hidden, name] = await pool.read.reserveMeta([usdc.address]);
    expect(name).to.equal("USD Coin — main");
    expect(hidden).to.equal(true);
    expect(mask).to.equal(0);
    expect(await pool.read.supplyBalance([usdc.address, alice.account.address])).to.equal(supplied);
  });

  it("hiding is presentation only — a hidden reserve still transacts", async () => {
    const { alice, usdc, pool, asPool, fund } = await loadFixture(deployFixture);
    await pool.write.setReserveHidden([usdc.address, true]);
    await fund(usdc, alice, U("100"));
    await (await asPool(alice)).write.supply([usdc.address, U("100")]);
    await (await asPool(alice)).write.withdraw([usdc.address, U("100")]);
  });

  it("caps the rename length", async () => {
    const { usdc, pool } = await loadFixture(deployFixture);
    await expect(pool.write.renameReserve([usdc.address, "x".repeat(41)])).to.be.rejected;
    await pool.write.renameReserve([usdc.address, "x".repeat(40)]);
  });

  it("keeps every control owner-only", async () => {
    const { alice, usdc, pool, asPool } = await loadFixture(deployFixture);
    const a = await asPool(alice);
    await expect(a.write.setFrozen([usdc.address, FREEZE_ALL])).to.be.rejected;
    await expect(a.write.setFrozenMany([[usdc.address], FREEZE_ALL])).to.be.rejected;
    await expect(a.write.renameReserve([usdc.address, "mine"])).to.be.rejected;
    await expect(a.write.setReserveHidden([usdc.address, true])).to.be.rejected;
    await expect(a.write.setPriceFeed([usdc.address, usdc.address, 0])).to.be.rejected;
  });
});

describe("TesseraPool — Chainlink-compatible price oracle", () => {
  async function oracleFixture() {
    const base = await deployFixture();
    const feed = await hre.viem.deployContract("MockAggregator", [8, 100_000_000n]); // $1.00, 8 dp
    return { ...base, feed };
  }

  it("uses the manual price while no feed is configured", async () => {
    const { usdc, pool } = await loadFixture(oracleFixture);
    expect(await pool.read.price([usdc.address])).to.equal(PRICE);
    expect(await pool.read.priceOk([usdc.address])).to.equal(true);
  });

  it("prefers a configured feed over the manual price", async () => {
    const { usdc, pool, feed } = await loadFixture(oracleFixture);
    await feed.write.set([102_000_000n, BigInt(await time.latest())]); // $1.02
    await pool.write.setPriceFeed([usdc.address, feed.address, 3600]);
    expect(await pool.read.price([usdc.address])).to.equal(102_000_000n);
    // The manual price is now irrelevant — setting it changes nothing.
    await pool.write.setPrice([usdc.address, 50_000_000n]);
    expect(await pool.read.price([usdc.address])).to.equal(102_000_000n);
  });

  it("rescales feeds that do not report 8 decimals", async () => {
    const { usdc, pool } = await loadFixture(oracleFixture);
    const f18 = await hre.viem.deployContract("MockAggregator", [18, 10n ** 18n]); // $1.00, 18 dp
    await pool.write.setPriceFeed([usdc.address, f18.address, 3600]);
    expect(await pool.read.price([usdc.address])).to.equal(PRICE);

    const f6 = await hre.viem.deployContract("MockAggregator", [6, 2_500_000n]); // $2.50, 6 dp
    await pool.write.setPriceFeed([usdc.address, f6.address, 3600]);
    expect(await pool.read.price([usdc.address])).to.equal(250_000_000n);
  });

  it("refuses a stale answer rather than falling back to the manual price", async () => {
    const { usdc, pool, feed } = await loadFixture(oracleFixture);
    await pool.write.setPriceFeed([usdc.address, feed.address, 3600]);
    expect(await pool.read.priceOk([usdc.address])).to.equal(true);
    await time.increase(3601);
    // Falling back here is what lets someone borrow against a mispriced asset,
    // so the market pauses instead.
    expect(await pool.read.priceOk([usdc.address])).to.equal(false);
    await expect(pool.read.price([usdc.address])).to.be.rejected;
  });

  it("refuses a non-positive answer", async () => {
    const { usdc, pool, feed } = await loadFixture(oracleFixture);
    await pool.write.setPriceFeed([usdc.address, feed.address, 3600]);
    await feed.write.set([0n, BigInt(await time.latest())]);
    expect(await pool.read.priceOk([usdc.address])).to.equal(false);
    await feed.write.set([-1n, BigInt(await time.latest())]);
    expect(await pool.read.priceOk([usdc.address])).to.equal(false);
  });

  it("refuses an answer carried over from an earlier round", async () => {
    const { usdc, pool, feed } = await loadFixture(oracleFixture);
    await pool.write.setPriceFeed([usdc.address, feed.address, 3600]);
    await feed.write.setStaleRound([9, 4]); // answeredInRound < roundId
    expect(await pool.read.priceOk([usdc.address])).to.equal(false);
  });

  it("refuses an unfinished round (updatedAt == 0)", async () => {
    const { usdc, pool, feed } = await loadFixture(oracleFixture);
    await pool.write.setPriceFeed([usdc.address, feed.address, 3600]);
    await feed.write.set([100_000_000n, 0n]);
    expect(await pool.read.priceOk([usdc.address])).to.equal(false);
  });

  it("survives a feed that reverts outright", async () => {
    const { usdc, pool, feed } = await loadFixture(oracleFixture);
    await pool.write.setPriceFeed([usdc.address, feed.address, 3600]);
    await feed.write.setReverting([true]);
    // priceOk must answer false, not revert — the UI depends on being able to ask.
    expect(await pool.read.priceOk([usdc.address])).to.equal(false);
    await expect(pool.read.price([usdc.address])).to.be.rejected;
  });

  it("rejects a bad feed at configuration time, not at withdrawal time", async () => {
    const { usdc, pool, feed } = await loadFixture(oracleFixture);
    await feed.write.setReverting([true]);
    await expect(pool.write.setPriceFeed([usdc.address, feed.address, 3600])).to.be.rejected;
  });

  it("clearing the feed restores the manual price", async () => {
    const { usdc, pool, feed } = await loadFixture(oracleFixture);
    await pool.write.setPriceFeed([usdc.address, feed.address, 3600]);
    await time.increase(3601);
    expect(await pool.read.priceOk([usdc.address])).to.equal(false);
    await pool.write.setPriceFeed([usdc.address, "0x0000000000000000000000000000000000000000", 0]);
    expect(await pool.read.price([usdc.address])).to.equal(PRICE);
  });

  it("a stale feed halts borrowing rather than pricing it wrongly", async () => {
    const { bob, usdc, btc, pool, asPool, feed } = await loadFixture(oracleFixture);
    const btcFeed = await hre.viem.deployContract("MockAggregator", [8, 95_000n * PRICE]);
    await pool.write.setPriceFeed([btc.address, btcFeed.address, 3600]);
    await (await asPool(bob)).write.borrow([usdc.address, U("100")]); // fine while fresh
    await time.increase(3601);
    await expect((await asPool(bob)).write.borrow([usdc.address, U("100")])).to.be.rejected;
    expect(feed.address).to.be.a("string");
  });

  it("the swap desk quotes from the same oracle the pool uses", async () => {
    const { deployer, usdc, btc, pool, feed } = await loadFixture(oracleFixture);
    const swap = await hre.viem.deployContract("TesseraSwap", [pool.address, deployer.account.address, 30, 5000]);
    await feed.write.set([200_000_000n, BigInt(await time.latest())]); // USDC "worth" $2
    await pool.write.setPriceFeed([usdc.address, feed.address, 3600]);
    const [p] = await swap.read.priceOf([usdc.address]);
    expect(p).to.equal(200_000_000n);
    // And a dead feed stops the desk quoting rather than quoting at a stale rate.
    await feed.write.setReverting([true]);
    await expect(swap.read.quote([usdc.address, btc.address, U("1")])).to.be.rejected;
  });
});
