import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n;
const EUR = 108_000_000n; // $1.08
const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

async function deployFixture() {
  const [deployer, alice, bob] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin", "EURC", 6]);
  const cbtc = await hre.viem.deployContract("MockToken", ["Circle Wrapped BTC", "cirBTC", 8]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);

  await pool.write.addReserve([usdc.address, 9000, 9300, 9500, 1000, true, 6, PRICE]);
  await pool.write.addReserve([eurc.address, 8500, 8800, 9000, 1000, true, 6, EUR]);
  await pool.write.addReserve([cbtc.address, 7000, 7800, 8000, 1000, true, 8, 30_000n * PRICE]);

  const fund = async (who: any, token: any, kind: string, amount: bigint) => {
    await token.write.mint([who.account.address, amount]);
    const c = await hre.viem.getContractAt(kind, token.address, { client: { wallet: who } });
    await c.write.approve([pool.address, amount]);
  };
  const as = (who: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: who } });

  return { deployer, alice, bob, usdc, eurc, cbtc, pool, fund, as };
}

describe("TesseraPool — flash loans", () => {
  async function withLiquidity() {
    const f = await loadFixture(deployFixture);
    await f.fund(f.alice, f.usdc, "MockUSDC", USDC("100000"));
    await (await f.as(f.alice)).write.supply([f.usdc.address, USDC("100000")]);
    const borrower = await hre.viem.deployContract("MockFlashBorrower", [f.pool.address]);
    // Enough to cover the fee out of its own pocket.
    await f.usdc.write.mint([borrower.address, USDC("100")]);
    return { ...f, borrower };
  }

  it("lends and takes the fee back for the suppliers", async () => {
    const f = await withLiquidity();
    const before = await f.pool.read.supplyBalance([f.usdc.address, f.alice.account.address]);
    const fee = await f.pool.read.flashFee([USDC("50000")]);
    expect(fee > 0n).to.equal(true);

    await f.borrower.write.go([f.usdc.address, USDC("50000")]);
    expect(await f.borrower.read.lastFee()).to.equal(fee);

    // The fee is not the pool's — it belongs to the depositors whose money made
    // the loan possible, so their claim grows by it.
    const after = await f.pool.read.supplyBalance([f.usdc.address, f.alice.account.address]);
    expect(after > before).to.equal(true);
    expect(after - before >= (fee * 99n) / 100n).to.equal(true);
  });

  it("reverts when the borrower keeps the money", async () => {
    const f = await withLiquidity();
    await f.borrower.write.setMode([1]); // KeepEverything
    await expect(f.borrower.write.go([f.usdc.address, USDC("1000")])).to.be.rejected;
    expect(await f.usdc.read.balanceOf([f.pool.address])).to.equal(USDC("100000"));
  });

  it("reverts when the borrower repays the principal but not the fee", async () => {
    const f = await withLiquidity();
    await f.borrower.write.setMode([2]); // SkipFee
    // The near-miss worth pinning: a check written `balance >= before` rather
    // than `>= before + fee` would wave this through.
    await expect(f.borrower.write.go([f.usdc.address, USDC("1000")])).to.be.rejected;
  });

  it("reverts on the wrong callback return value", async () => {
    const f = await withLiquidity();
    await f.borrower.write.setMode([3]); // WrongReturn
    await expect(f.borrower.write.go([f.usdc.address, USDC("1000")])).to.be.rejected;
  });

  it("cannot be re-entered", async () => {
    const f = await withLiquidity();
    await f.borrower.write.setMode([4]); // Reenter
    await expect(f.borrower.write.go([f.usdc.address, USDC("1000")])).to.be.rejected;
  });

  it("will not lend more than it holds", async () => {
    const f = await withLiquidity();
    await expect(f.borrower.write.go([f.usdc.address, USDC("200000")])).to.be.rejected;
  });

  it("caps the fee in the bytecode", async () => {
    const f = await withLiquidity();
    expect(await f.pool.read.MAX_FLASH_FEE()).to.equal(100);
    await f.pool.write.setFlashFee([100]);
    // The fee is charged on the principal, and a principal is unbounded — so an
    // uncapped fee would be an unbounded claim on anyone who used this.
    await expect(f.pool.write.setFlashFee([101])).to.be.rejected;
  });
});

describe("TesseraPool — e-mode for correlated assets", () => {
  async function withEmode() {
    const f = await loadFixture(deployFixture);
    // USDC and EURC track each other; cirBTC does not.
    await f.pool.write.setEmodeCategory([1, 9500, 9700, 9800, true, "Stablecoins"]);
    await f.pool.write.setEmodeAsset([f.usdc.address, 1]);
    await f.pool.write.setEmodeAsset([f.eurc.address, 1]);

    await f.fund(f.alice, f.usdc, "MockUSDC", USDC("100000"));
    await f.fund(f.alice, f.eurc, "MockToken", USDC("100000"));
    await (await f.as(f.alice)).write.supply([f.usdc.address, USDC("100000")]);
    await (await f.as(f.alice)).write.supply([f.eurc.address, USDC("100000")]);
    return f;
  }

  it("lifts the borrow limit while every position is inside one category", async () => {
    const f = await withEmode();
    await f.fund(f.bob, f.eurc, "MockToken", USDC("1000"));
    await (await f.as(f.bob)).write.supply([f.eurc.address, USDC("1000")]);

    expect(await f.pool.read.emodeCategoryOf([f.bob.account.address])).to.equal(1);

    // Plain factors: 1000 EURC at $1.08 x 85%. E-mode: the same at 95%.
    const [borrowLimit] = await f.pool.read.accountLimits([f.bob.account.address]);
    const plain = (USDC("1000") * EUR * 8500n) / 10n ** 6n / 10_000n;
    const boosted = (USDC("1000") * EUR * 9500n) / 10n ** 6n / 10_000n;
    expect(borrowLimit).to.equal(boosted);
    expect(borrowLimit > plain).to.equal(true);

    // And it is real: a draw the plain factors would have refused goes through.
    await (await f.as(f.bob)).write.borrow([f.usdc.address, USDC("950")]);
  });

  it("falls back the moment a position moves outside the category", async () => {
    const f = await withEmode();
    await f.fund(f.bob, f.eurc, "MockToken", USDC("1000"));
    await f.fund(f.bob, f.cbtc, "MockToken", 10n ** 6n); // 0.01 cirBTC
    await (await f.as(f.bob)).write.supply([f.eurc.address, USDC("1000")]);

    // cirBTC is not in the category. The premise of the boosted factors — that
    // these assets move together — no longer holds for this account.
    await (await f.as(f.bob)).write.supply([f.cbtc.address, 10n ** 6n]);
    expect(await f.pool.read.emodeCategoryOf([f.bob.account.address])).to.equal(0);

    const [plainLimit] = await f.pool.read.accountLimits([f.bob.account.address]);
    const eurcPlain = (USDC("1000") * EUR * 8500n) / 10n ** 6n / 10_000n;
    const btcPlain = (10n ** 6n * 30_000n * PRICE * 7000n) / 10n ** 8n / 10_000n;
    expect(plainLimit).to.equal(eurcPlain + btcPlain);
  });

  it("needs no opt-in and cannot be left switched on by mistake", async () => {
    const f = await withEmode();
    await f.fund(f.bob, f.eurc, "MockToken", USDC("500"));
    // No toggle anywhere: qualifying is a property of the positions held.
    expect(await f.pool.read.emodeCategoryOf([f.bob.account.address])).to.equal(0);
    await (await f.as(f.bob)).write.supply([f.eurc.address, USDC("500")]);
    expect(await f.pool.read.emodeCategoryOf([f.bob.account.address])).to.equal(1);
    await (await f.as(f.bob)).write.withdraw([f.eurc.address, USDC("500")]);
    expect(await f.pool.read.emodeCategoryOf([f.bob.account.address])).to.equal(0);
  });

  it("stops applying once the category is disabled", async () => {
    const f = await withEmode();
    await f.fund(f.bob, f.eurc, "MockToken", USDC("1000"));
    await (await f.as(f.bob)).write.supply([f.eurc.address, USDC("1000")]);
    const [boosted] = await f.pool.read.accountLimits([f.bob.account.address]);

    await f.pool.write.setEmodeCategory([1, 9500, 9700, 9800, false, "Stablecoins"]);
    expect(await f.pool.read.emodeCategoryOf([f.bob.account.address])).to.equal(0);
    const [plain] = await f.pool.read.accountLimits([f.bob.account.address]);
    expect(plain < boosted).to.equal(true);
  });

  it("enforces the borrow/liquidation gap on category factors too", async () => {
    const f = await loadFixture(deployFixture);
    // cFactor must sit strictly below liqFactor here for the same reason it
    // does per-asset: otherwise a fully-drawn e-mode borrower sits exactly on
    // the seizure line.
    await expect(f.pool.write.setEmodeCategory([2, 9700, 9700, 9800, true, "bad"])).to.be.rejected;
    await expect(f.pool.write.setEmodeCategory([2, 9800, 9700, 9800, true, "bad"])).to.be.rejected;
    await expect(f.pool.write.setEmodeCategory([0, 9500, 9700, 9800, true, "zero id"])).to.be.rejected;
  });

  it("keeps the dashboard's numbers and the liquidation numbers the same", async () => {
    const f = await withEmode();
    await f.fund(f.bob, f.eurc, "MockToken", USDC("1000"));
    await (await f.as(f.bob)).write.supply([f.eurc.address, USDC("1000")]);
    await (await f.as(f.bob)).write.borrow([f.usdc.address, USDC("500")]);

    // `accountData` used to run its own copy of the liquidity loop. Two loops
    // are two chances to disagree, and the one shown on a dashboard disagreeing
    // with the one that decides seizure is the worst place for that.
    const [, , limitFromData] = await f.pool.read.accountData([f.bob.account.address]);
    const [limitFromLimits] = await f.pool.read.accountLimits([f.bob.account.address]);
    expect(limitFromData).to.equal(limitFromLimits);
  });
});

describe("TesseraPool — TWAP sanity band on manual prices", () => {
  async function withGuard() {
    const f = await loadFixture(deployFixture);
    const [, , , lp] = await hre.viem.getWalletClients();
    const amm = await hre.viem.deployContract("TesseraAMM", [f.deployer.account.address]);
    await amm.write.createPool([[f.usdc.address, f.eurc.address], 10, 5000, "USDC / EURC"]);

    for (const [t, kind] of [[f.usdc, "MockUSDC"], [f.eurc, "MockToken"]] as const) {
      await t.write.mint([lp.account.address, USDC("500000")]);
      const c = await hre.viem.getContractAt(kind, t.address, { client: { wallet: lp } });
      await c.write.approve([amm.address, USDC("500000")]);
    }
    // 108 USDC per 100 EURC — the pool agrees with the $1.08 mark.
    await (await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: lp } })).write.addLiquidity([
      0n,
      [USDC("108000"), USDC("100000")],
      0n,
    ]);

    const guard = await hre.viem.deployContract("TesseraPriceGuard", [amm.address, f.pool.address]);
    await guard.write.setFeed([f.eurc.address, 0n, f.usdc.address, 500, 600, 0n]); // ±5%, 10-min window, no depth floor
    await f.pool.write.setWiring([0, guard.address]);
    return { ...f, amm, guard, lp };
  }

  it("lets a price inside the band through", async () => {
    const f = await withGuard();
    await time.increase(900);
    await f.amm.write.sync([0n]);
    const [ref, window] = await f.guard.read.twapUsd([f.eurc.address]);
    expect(window >= 600n).to.equal(true);
    expect(ref > 100_000_000n && ref < 116_000_000n).to.equal(true);

    await f.pool.write.setPrice([f.eurc.address, 109_000_000n]); // ~1% off
    expect(await f.pool.read.price([f.eurc.address])).to.equal(109_000_000n);
  });

  it("rejects a fat-fingered decimal", async () => {
    const f = await withGuard();
    await time.increase(900);
    await f.amm.write.sync([0n]);
    // $10.80 instead of $1.08 — the mistake that silently rewrites every borrow
    // limit and liquidation threshold in the pool.
    await expect(f.pool.write.setPrice([f.eurc.address, 1_080_000_000n])).to.be.rejected;
    // …and the same mistake in the other direction.
    await expect(f.pool.write.setPrice([f.eurc.address, 10_800_000n])).to.be.rejected;
  });

  it("does not block updates while the window is too young to trust", async () => {
    const f = await withGuard();
    // A guard that bricks price updates whenever the AMM is quiet would mean a
    // thin pool could stop an operator correcting a genuinely wrong price.
    const [ok] = await f.guard.read.check([f.eurc.address, 1_080_000_000n]);
    expect(ok).to.equal(true);
    await f.pool.write.setPrice([f.eurc.address, 1_080_000_000n]);
  });

  it("can be removed, so a drained pool cannot freeze a price forever", async () => {
    const f = await withGuard();
    await time.increase(900);
    await f.amm.write.sync([0n]);
    await expect(f.pool.write.setPrice([f.eurc.address, 1_080_000_000n])).to.be.rejected;
    await f.pool.write.setWiring([0, "0x0000000000000000000000000000000000000000"]);
    await f.pool.write.setPrice([f.eurc.address, 1_080_000_000n]);
  });

  it("leaves unguarded assets alone", async () => {
    const f = await withGuard();
    await time.increase(900);
    // cirBTC has no feed configured, so nothing changes for it.
    await f.pool.write.setPrice([f.cbtc.address, 12_345n * PRICE]);
    expect(await f.pool.read.price([f.cbtc.address])).to.equal(12_345n * PRICE);
  });

  it("reports the comparison for a dashboard", async () => {
    const f = await withGuard();
    await time.increase(900);
    await f.amm.write.sync([0n]);
    const [enabled, reference, window, poolPrice, deviationBps, maxDev] = await f.guard.read.status([f.eurc.address]);
    expect(enabled).to.equal(true);
    expect(reference > 0n).to.equal(true);
    expect(window >= 600n).to.equal(true);
    expect(poolPrice).to.equal(EUR);
    expect(deviationBps < 500n).to.equal(true);
    expect(maxDev).to.equal(500);
  });
});

describe("TesseraAMM — time-weighted price accumulators", () => {
  async function ammFixture() {
    const [deployer, lp, trader] = await hre.viem.getWalletClients();
    const usdc = await hre.viem.deployContract("MockUSDC");
    const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin", "EURC", 6]);
    const amm = await hre.viem.deployContract("TesseraAMM", [deployer.account.address]);
    await amm.write.createPool([[usdc.address, eurc.address], 30, 5000, "USDC / EURC"]);
    for (const [t, kind, who] of [
      [usdc, "MockUSDC", lp],
      [eurc, "MockToken", lp],
      [usdc, "MockUSDC", trader],
    ] as const) {
      await t.write.mint([who.account.address, USDC("500000")]);
      const c = await hre.viem.getContractAt(kind, t.address, { client: { wallet: who } });
      await c.write.approve([amm.address, USDC("500000")]);
    }
    await (await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: lp } })).write.addLiquidity([
      0n,
      [USDC("100000"), USDC("100000")],
      0n,
    ]);
    return { deployer, lp, trader, usdc, eurc, amm };
  }

  it("advances with time, and the average matches the balanced price", async () => {
    const f = await loadFixture(ammFixture);
    const [c0] = await f.amm.read.observe([0n, f.usdc.address]);
    await time.increase(3600);
    await f.amm.write.sync([0n]);
    const [c1] = await f.amm.read.observe([0n, f.usdc.address]);
    const unit = await f.amm.read.PRICE_UNIT();
    const avg = (c1 - c0) / 3600n;
    // A 1:1 pool averages 1.0 over the window.
    expect(avg > (unit * 99n) / 100n && avg < (unit * 101n) / 100n).to.equal(true);
  });

  it("credits elapsed time at the price that was standing, not the new one", async () => {
    const f = await loadFixture(ammFixture);
    const [c0] = await f.amm.read.observe([0n, f.usdc.address]);
    await time.increase(3600);

    // A large trade moves spot a long way. It must not retroactively re-price
    // the hour it was not present for.
    await (
      await hre.viem.getContractAt("TesseraAMM", f.amm.address, { client: { wallet: f.trader } })
    ).write.swap([0n, f.usdc.address, f.eurc.address, USDC("50000"), 0n]);

    const [c1, , spot] = await f.amm.read.observe([0n, f.usdc.address]);
    const unit = await f.amm.read.PRICE_UNIT();
    const avg = (c1 - c0) / 3600n;
    expect(avg > (unit * 99n) / 100n && avg < (unit * 101n) / 100n).to.equal(true);

    // Spot, by contrast, has moved hard — which is exactly why it is not what
    // the guard reads.
    expect(spot < (unit * 60n) / 100n).to.equal(true);
  });

  it("can be advanced by anyone, so a quiet pool does not go stale", async () => {
    const f = await loadFixture(ammFixture);
    const before = await f.amm.read.observedAt([0n]);
    await time.increase(1200);
    await (
      await hre.viem.getContractAt("TesseraAMM", f.amm.address, { client: { wallet: f.trader } })
    ).write.sync([0n]);
    expect((await f.amm.read.observedAt([0n])) > before).to.equal(true);
  });
});
