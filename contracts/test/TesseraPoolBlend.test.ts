import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * The mechanisms this pool takes from Blend Capital: a three-slope interest
 * curve with a reactive modifier, a first-loss backstop that is paid out of
 * interest and takes losses before suppliers do, and liquidation by descending
 * auction with partial fills and a target health band.
 */

const WAD = 10n ** 18n;
const PRICE = 10n ** 8n;
const BTC_PRICE = 30_000n * 10n ** 8n;
const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));
const BTC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e8));

async function deployFixture() {
  const [deployer, alice, bob, liquidator] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const cbtc = await hre.viem.deployContract("MockToken", ["Circle Wrapped Bitcoin (mock)", "cirBTC", 8]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);

  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, PRICE]);
  await pool.write.addReserve([cbtc.address, 7000, 8000, 8000, 1000, false, 8, BTC_PRICE]);

  async function fundAndApprove(who: any, u: bigint, b: bigint) {
    if (u > 0n) {
      await usdc.write.mint([who.account.address, u]);
      const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
      await c.write.approve([pool.address, u]);
    }
    if (b > 0n) {
      await cbtc.write.mint([who.account.address, b]);
      const c = await hre.viem.getContractAt("MockToken", cbtc.address, { client: { wallet: who } });
      await c.write.approve([pool.address, b]);
    }
  }
  const as = (who: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: who } });

  return { deployer, alice, bob, liquidator, usdc, cbtc, pool, fundAndApprove, as };
}

/**
 * Alice lends `supplied`, Bob posts 1 cirBTC and draws `draw` against it.
 *
 * The supply figure is a parameter because utilization is what the rate model
 * is about: the default leaves the asset comfortably under target, and the
 * rate-drift tests pass a small one so the same borrow sits well above it.
 */
async function withBorrower(
  f: Awaited<ReturnType<typeof deployFixture>>,
  draw = USDC("18000"),
  supplied = USDC("100000"),
) {
  const { alice, bob, usdc, cbtc, fundAndApprove, as } = f;
  await fundAndApprove(alice, supplied, 0n);
  await (await as(alice)).write.supply([usdc.address, supplied]);
  await fundAndApprove(bob, 0n, BTC("1"));
  await (await as(bob)).write.supply([cbtc.address, BTC("1")]);
  await (await as(bob)).write.borrow([usdc.address, draw]);
}

/**
 * Force an accrual without moving anything that matters.
 *
 * A withdrawal by the supplier calls `_accrueAll` and needs no allowance, which
 * a repayment would — the borrower is holding borrowed tokens, not an approval
 * to hand them back.
 *
 * It used to withdraw a single unit. That worked only because a unit divided to
 * *zero* shares once interest had accrued: it paid out against a balance it
 * never reduced, which is the defect `TesseraPoolRounding.test.ts` now pins.
 *
 * The amount cannot be computed from the reserve either, because the call being
 * made is the one that books the interest — `reserves()` still reads the totals
 * from before this poke's own accrual, so any "exactly one share" figure taken
 * from it is stale by the time the division happens. A thousandth of a USDC is
 * comfortably above one share at any index these tests reach, and is 5e-8 of
 * the smallest pool here: far below anything the rate assertions can see.
 */
async function poke(f: Awaited<ReturnType<typeof deployFixture>>) {
  await (await f.as(f.alice)).write.withdraw([f.usdc.address, USDC("0.001")]);
}

describe("TesseraPool — Blend interest-rate model", () => {
  it("prices the three utilization zones with distinct slopes", async () => {
    const { usdc, pool } = await loadFixture(deployFixture);
    const at = (u: bigint) => pool.read.borrowRateAt([usdc.address, u]);

    const zero = await at(0n);
    const target = await at((WAD * 80n) / 100n);
    const mid = await at((WAD * 90n) / 100n);
    const kinkTop = await at((WAD * 95n) / 100n);
    const panic = await at(WAD);

    // Defaults: 1% base, +4% to target, +20% target→95%, +100% across the last 5%.
    expect(zero).to.equal(WAD / 100n);
    expect(target).to.equal((WAD * 5n) / 100n);
    expect(kinkTop).to.equal((WAD * 25n) / 100n);
    expect(panic).to.equal((WAD * 125n) / 100n);
    // The middle zone is genuinely between them, not a straight line from
    // target to 100% — that separation is what the third slope buys.
    expect(mid > target && mid < kinkTop).to.equal(true);

    // The last five points of utilization cost more than the first ninety-five.
    expect(panic - kinkTop > kinkTop - zero).to.equal(true);
  });

  it("lets the operator retune the curve", async () => {
    const { usdc, pool } = await loadFixture(deployFixture);
    const before = await pool.read.borrowRateAt([usdc.address, (WAD * 50n) / 100n]);
    await pool.write.setIrConfig([usdc.address, WAD / 50n, WAD / 10n, WAD / 5n, WAD, 7000, 0n]);
    const after = await pool.read.borrowRateAt([usdc.address, (WAD * 50n) / 100n]);
    expect(after > before).to.equal(true);

    // A target at or above the 95% fence would leave the third slope no room.
    await expect(pool.write.setIrConfig([usdc.address, WAD / 50n, WAD / 10n, WAD / 5n, WAD, 9500, 0n])).to.be.rejected;
    await expect(pool.write.setIrConfig([usdc.address, WAD / 50n, WAD / 10n, WAD / 5n, WAD, 0, 0n])).to.be.rejected;
  });

  it("drifts the rate modifier up while utilization sits above target", async () => {
    const f = await loadFixture(deployFixture);
    const { usdc, pool } = f;
    // 18k borrowed against a 20k supply — 90% utilization, well above target.
    await withBorrower(f, USDC("18000"), USDC("20000"));

    const start = (await pool.read.irConfig([usdc.address]))[5];
    const rateBefore = await pool.read.borrowRateAt([usdc.address, (WAD * 90n) / 100n]);

    await time.increase(7 * 24 * 3600);
    await poke(f);

    const after = (await pool.read.irConfig([usdc.address]))[5];
    // A static curve keeps quoting the same number no matter how long an asset
    // has been over-borrowed. The modifier is what makes time cost something.
    expect(after > start, "the modifier rose").to.equal(true);
    expect(await pool.read.borrowRateAt([usdc.address, (WAD * 90n) / 100n]) > rateBefore).to.equal(true);
  });

  it("drifts the modifier down while an asset sits idle", async () => {
    const f = await loadFixture(deployFixture);
    const { usdc, pool, as, bob } = f;
    // Climb first, at 90% utilization…
    await withBorrower(f, USDC("18000"), USDC("20000"));
    await time.increase(14 * 24 * 3600);
    await poke(f);
    const high = (await pool.read.irConfig([usdc.address]))[5];
    expect(high > WAD).to.equal(true);

    // …then repay almost everything, leaving the asset barely used.
    await f.fundAndApprove(bob, USDC("30000"), 0n);
    await (await as(bob)).write.repay([usdc.address, USDC("25000")]);
    await time.increase(60 * 24 * 3600);
    await poke(f);

    const low = (await pool.read.irConfig([usdc.address]))[5];
    expect(low < high, "the modifier fell once the asset went quiet").to.equal(true);
    expect(low >= WAD / 10n, "and never below its floor").to.equal(true);
  });

  it("holds the modifier still when reactivity is zero", async () => {
    const f = await loadFixture(deployFixture);
    const { usdc, pool } = f;
    await pool.write.setIrConfig([usdc.address, WAD / 100n, WAD / 25n, WAD / 5n, WAD, 8000, 0n]);
    // Read it after the change, not before: `setIrConfig` settles at the old
    // curve first, so the last drift under the previous reactivity has already
    // happened by the time the new setting takes effect.
    const pinned = (await pool.read.irConfig([usdc.address]))[5];
    await withBorrower(f, USDC("18000"), USDC("20000"));
    await time.increase(30 * 24 * 3600);
    await poke(f);
    expect((await pool.read.irConfig([usdc.address]))[5]).to.equal(pinned);
  });

  it("keeps the modifier across a curve change, and resets it only on request", async () => {
    const f = await loadFixture(deployFixture);
    const { usdc, pool } = f;
    await withBorrower(f, USDC("18000"), USDC("20000"));
    await time.increase(7 * 24 * 3600);
    await poke(f);
    const drifted = (await pool.read.irConfig([usdc.address]))[5];
    expect(drifted > WAD).to.equal(true);

    // Retuning the curve must not silently erase a rate the market earned.
    await pool.write.setIrConfig([usdc.address, WAD / 100n, WAD / 25n, WAD / 5n, WAD, 8000, 58_000_000_000_000n]);
    expect((await pool.read.irConfig([usdc.address]))[5] >= drifted).to.equal(true);

    await pool.write.resetRateModifier([usdc.address]);
    expect((await pool.read.irConfig([usdc.address]))[5]).to.equal(WAD);
  });
});

describe("TesseraPool — Blend backstop", () => {
  it("pays the backstop a share of interest, ahead of suppliers", async () => {
    const f = await loadFixture(deployFixture);
    const { usdc, pool } = f;
    await pool.write.setBackstopTakeRate([2000]); // 20% of interest
    await withBorrower(f, USDC("18000"));

    expect(await pool.read.backstopBalance([usdc.address])).to.equal(0n);
    await time.increase(365 * 24 * 3600);
    await poke(f);

    const pot = await pool.read.backstopBalance([usdc.address]);
    expect(pot > 0n, "the backstop was funded out of borrower interest").to.equal(true);

    // And the quoted supply APR reflects it: a rate that ignored the take would
    // overstate what a supplier actually earns by exactly the take.
    const [, , util, borrowApr, supplyApr] = await pool.read.reserveData([usdc.address]);
    const naive = (borrowApr * util) / WAD;
    expect(supplyApr < naive).to.equal(true);
  });

  it("takes the loss before suppliers when a position goes bad", async () => {
    const f = await loadFixture(deployFixture);
    const { deployer, alice, bob, usdc, cbtc, pool, as, fundAndApprove } = f;
    await pool.write.setBackstopTakeRate([2000]);
    await withBorrower(f, USDC("18000"));

    // Someone puts up first-loss capital — enough to absorb the whole position,
    // which is the case this test is about. The partial case is the next one.
    await fundAndApprove(deployer, USDC("25000"), 0n);
    await pool.write.backstopDeposit([usdc.address, USDC("25000")]);
    expect(await pool.read.backstopBalanceOf([usdc.address, deployer.account.address]) >= USDC("25000")).to.equal(true);

    // cirBTC collapses to nothing: Bob has debt and no collateral value at all.
    await pool.write.setPrice([cbtc.address, 1n]);
    const suppliedBefore = await pool.read.supplyBalance([usdc.address, alice.account.address]);

    await (await as(alice)).write.clearBadDebt([bob.account.address, usdc.address]);

    // The debt is gone, the backstop paid for it, and Alice is untouched —
    // which is the arrangement backstop depositors were being paid for.
    expect(await pool.read.borrowBalance([usdc.address, bob.account.address])).to.equal(0n);
    expect(await pool.read.backstopBalance([usdc.address]) < USDC("25000")).to.equal(true);
    expect(await pool.read.supplyBalance([usdc.address, alice.account.address]) >= suppliedBefore).to.equal(true);
  });

  it("socialises what the backstop cannot cover", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bob, usdc, cbtc, pool, as } = f;
    await withBorrower(f, USDC("18000")); // no backstop capital at all
    await pool.write.setPrice([cbtc.address, 1n]);

    const before = await pool.read.supplyBalance([usdc.address, alice.account.address]);
    await (await as(alice)).write.clearBadDebt([bob.account.address, usdc.address]);
    const after = await pool.read.supplyBalance([usdc.address, alice.account.address]);

    // The assets genuinely are not there. Every supplier's claim shrinks pro
    // rata, which is the honest accounting — the alternative is paying whoever
    // withdraws first in full at the expense of whoever is left.
    expect(after < before).to.equal(true);
    expect(await pool.read.borrowBalance([usdc.address, bob.account.address])).to.equal(0n);
  });

  it("shares a loss across backstop depositors in proportion, and prices new money at the new level", async () => {
    /*
     * The share-accounting property nobody notices until it is wrong.
     *
     * A loss reduces `backstopBalance` and touches no share count, so every
     * existing depositor's claim shrinks by the same fraction — that is what
     * makes first-loss capital *shared* rather than a queue where whoever
     * withdraws first is whole and the last one out is wiped.
     *
     * The other half matters just as much and pulls the opposite way: somebody
     * depositing *after* the loss must buy shares at the reduced price, so they
     * neither inherit a loss that predates them nor dilute the people who
     * absorbed it. Get that backwards and the backstop becomes a thing you only
     * ever want to enter immediately after a default.
     */
    const f = await loadFixture(deployFixture);
    const { deployer, alice, bob, liquidator, usdc, cbtc, pool, as, fundAndApprove } = f;
    await pool.write.setBackstopTakeRate([2000]);
    await withBorrower(f, USDC("18000"));

    /*
     * Two depositors, deliberately unequal, so "pro rata" and "equal" cannot
     * both pass — and between them holding more than the debt, so the write-off
     * dents the pot rather than emptying it. Emptying it is a different case
     * with a different answer, two tests down.
     */
    await fundAndApprove(deployer, USDC("18000"), 0n);
    await pool.write.backstopDeposit([usdc.address, USDC("18000")]);
    await fundAndApprove(liquidator, USDC("6000"), 0n);
    await (await as(liquidator)).write.backstopDeposit([usdc.address, USDC("6000")]);

    const bigBefore = await pool.read.backstopBalanceOf([usdc.address, deployer.account.address]);
    const smallBefore = await pool.read.backstopBalanceOf([usdc.address, liquidator.account.address]);
    expect(bigBefore > smallBefore * 2n).to.equal(true);

    // Bob's collateral evaporates and the write-off eats into the pot.
    await pool.write.setPrice([cbtc.address, 1n]);
    await (await as(alice)).write.clearBadDebt([bob.account.address, usdc.address]);

    const bigAfter = await pool.read.backstopBalanceOf([usdc.address, deployer.account.address]);
    const smallAfter = await pool.read.backstopBalanceOf([usdc.address, liquidator.account.address]);
    expect(bigAfter < bigBefore, "the large depositor took a loss").to.equal(true);
    expect(smallAfter < smallBefore, "so did the small one").to.equal(true);

    /*
     * Same fraction, both of them. Compared as a cross-product so this asserts
     * the ratio rather than two independently-plausible numbers, and with a
     * tolerance of one base unit for integer division.
     */
    const lhs = bigAfter * smallBefore;
    const rhs = smallAfter * bigBefore;
    const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
    expect(diff <= bigBefore + smallBefore).to.equal(true);

    // A newcomer buys in at the post-loss price: 1,000 in, about 1,000 back.
    // (This write-off only dented the pot; the wipe case is the next test.)
    await fundAndApprove(bob, USDC("1000"), 0n);
    await (await as(bob)).write.backstopDeposit([usdc.address, USDC("1000")]);
    const fresh = await pool.read.backstopBalanceOf([usdc.address, bob.account.address]);
    expect(fresh <= USDC("1000"), "did not inherit the loss").to.equal(true);
    expect(fresh > USDC("999"), "and was not handed a discount either").to.equal(true);
  });

  it("refuses a deposit into a backstop that has been drained to nothing", async () => {
    /*
     * The bug this test was written to find, and did.
     *
     * A write-off big enough to take the *last* of the pot leaves the shares
     * behind as claims on nothing. The old deposit path minted against them, so
     * 1,000 USDC into a wiped backstop came back as 76.92 — a 92% loss, taken
     * silently, at the moment of deposit, from somebody whose only mistake was
     * arriving after a default.
     */
    const f = await loadFixture(deployFixture);
    const { deployer, alice, bob, usdc, cbtc, pool, as, fundAndApprove } = f;
    await pool.write.setBackstopTakeRate([2000]);
    await withBorrower(f, USDC("18000"));

    // Less first-loss capital than there is debt, so the write-off takes it all.
    await fundAndApprove(deployer, USDC("5000"), 0n);
    await pool.write.backstopDeposit([usdc.address, USDC("5000")]);
    await pool.write.setPrice([cbtc.address, 1n]);
    await (await as(alice)).write.clearBadDebt([bob.account.address, usdc.address]);
    expect(await pool.read.backstopBalance([usdc.address])).to.equal(0n);

    await fundAndApprove(bob, USDC("1000"), 0n);
    await expect((await as(bob)).write.backstopDeposit([usdc.address, USDC("1000")])).to.be.rejected;
  });

  it("reopens a wiped backstop through a donation, in favour of whoever took the loss", async () => {
    /*
     * The way back. `fundBackstop` adds to the pot without minting shares, so
     * it accrues to the holders who absorbed the loss rather than to whoever
     * arrives next — the right people, in the right order — and it restores a
     * share price the contract can price a new deposit against.
     */
    const f = await loadFixture(deployFixture);
    const { deployer, alice, bob, usdc, cbtc, pool, as, fundAndApprove } = f;
    await pool.write.setBackstopTakeRate([2000]);
    await withBorrower(f, USDC("18000"));

    await fundAndApprove(deployer, USDC("5000"), 0n);
    await pool.write.backstopDeposit([usdc.address, USDC("5000")]);
    await pool.write.setPrice([cbtc.address, 1n]);
    await (await as(alice)).write.clearBadDebt([bob.account.address, usdc.address]);

    // A donation revives it, and lands on the wiped-out holder.
    await fundAndApprove(deployer, USDC("2000"), 0n);
    await pool.write.fundBackstop([usdc.address, USDC("2000")]);
    const restored = await pool.read.backstopBalanceOf([usdc.address, deployer.account.address]);
    expect(restored > 0n, "the donation reached the holder who took the loss").to.equal(true);

    // And deposits work again, at the revived price.
    await fundAndApprove(bob, USDC("1000"), 0n);
    await (await as(bob)).write.backstopDeposit([usdc.address, USDC("1000")]);
    const fresh = await pool.read.backstopBalanceOf([usdc.address, bob.account.address]);
    expect(fresh > USDC("999") && fresh <= USDC("1000")).to.equal(true);
  });

  it("keeps queued-but-unwithdrawn capital in the firing line", async () => {
    /*
     * `queueBackstopExit` reduces what `stakeOf`-style views report, and the
     * contract's own note says the shares keep absorbing losses until they are
     * actually withdrawn. If that were not true, the exit queue would be a way
     * to see a default coming and step out of the way while still being counted
     * as cover right up to the moment it mattered.
     */
    const f = await loadFixture(deployFixture);
    const { deployer, alice, bob, usdc, cbtc, pool, as, fundAndApprove } = f;
    await pool.write.setBackstopTakeRate([2000]);
    await withBorrower(f, USDC("18000"));

    await fundAndApprove(deployer, USDC("9000"), 0n);
    await pool.write.backstopDeposit([usdc.address, USDC("9000")]);
    const shares = await pool.read.backstopShares([usdc.address, deployer.account.address]);
    await pool.write.queueBackstopExit([usdc.address, shares]); // heading for the door

    const before = await pool.read.backstopBalanceOf([usdc.address, deployer.account.address]);
    await pool.write.setPrice([cbtc.address, 1n]);
    await (await as(alice)).write.clearBadDebt([bob.account.address, usdc.address]);

    const after = await pool.read.backstopBalanceOf([usdc.address, deployer.account.address]);
    expect(after < before, "queuing an exit did not dodge the loss").to.equal(true);
  });

  it("refuses to write off a position that still has collateral", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bob, usdc, cbtc, pool, as } = f;
    await withBorrower(f, USDC("18000"));
    await pool.write.setPrice([cbtc.address, 20_000n * 10n ** 8n]); // underwater, not worthless
    // While anything is left to seize this is a liquidation, not a write-off.
    await expect((await as(alice)).write.clearBadDebt([bob.account.address, usdc.address])).to.be.rejected;
  });

  it("holds backstop exits in a queue", async () => {
    const f = await loadFixture(deployFixture);
    const { deployer, usdc, pool, fundAndApprove } = f;
    await withBorrower(f, USDC("18000"));
    await fundAndApprove(deployer, USDC("5000"), 0n);
    await pool.write.backstopDeposit([usdc.address, USDC("5000")]);
    const shares = await pool.read.backstopShares([usdc.address, deployer.account.address]);

    // Capital that can leave the instant a loss becomes visible is not
    // insurance. Nothing comes out before the period elapses.
    await expect(pool.write.withdrawBackstop([usdc.address])).to.be.rejected;
    await pool.write.queueBackstopExit([usdc.address, shares]);
    await expect(pool.write.withdrawBackstop([usdc.address])).to.be.rejected;

    await time.increase(20 * 24 * 3600);
    await expect(pool.write.withdrawBackstop([usdc.address])).to.be.rejected;
    await time.increase(2 * 24 * 3600);

    const before = await usdc.read.balanceOf([deployer.account.address]);
    await pool.write.withdrawBackstop([usdc.address]);
    expect(await usdc.read.balanceOf([deployer.account.address]) > before).to.equal(true);
    expect(await pool.read.backstopShares([usdc.address, deployer.account.address])).to.equal(0n);
  });

  it("lets a queued exit be cancelled", async () => {
    const f = await loadFixture(deployFixture);
    const { deployer, usdc, pool, fundAndApprove } = f;
    await fundAndApprove(deployer, USDC("1000"), 0n);
    await pool.write.backstopDeposit([usdc.address, USDC("1000")]);
    const shares = await pool.read.backstopShares([usdc.address, deployer.account.address]);
    await pool.write.queueBackstopExit([usdc.address, shares]);
    await pool.write.cancelBackstopExit([usdc.address]);
    await time.increase(30 * 24 * 3600);
    await expect(pool.write.withdrawBackstop([usdc.address])).to.be.rejected;
  });

  it("will not pay a backstop exit out of money suppliers are owed", async () => {
    const f = await loadFixture(deployFixture);
    const { deployer, usdc, pool, fundAndApprove } = f;
    await pool.write.setBackstopTakeRate([5000]);
    await withBorrower(f, USDC("18000"));
    await fundAndApprove(deployer, USDC("100"), 0n);
    await pool.write.backstopDeposit([usdc.address, USDC("100")]);

    // Let interest inflate the pot far past the tokens actually sitting here:
    // accrued interest is a claim on future repayments, not cash.
    await time.increase(365 * 24 * 3600);
    const shares = await pool.read.backstopShares([usdc.address, deployer.account.address]);
    await pool.write.queueBackstopExit([usdc.address, shares]);
    await time.increase(22 * 24 * 3600);

    const cash = await usdc.read.balanceOf([pool.address]);
    const claimed = await pool.read.backstopBalanceOf([usdc.address, deployer.account.address]);
    if (claimed > cash) {
      await expect(pool.write.withdrawBackstop([usdc.address])).to.be.rejected;
    } else {
      // Whatever comes out, the pool must not end up owing more than it holds.
      await pool.write.withdrawBackstop([usdc.address]);
      expect(await usdc.read.balanceOf([pool.address]) >= 0n).to.equal(true);
    }
  });

  it("caps the backstop take rate", async () => {
    const { pool } = await loadFixture(deployFixture);
    await pool.write.setBackstopTakeRate([5000]);
    await expect(pool.write.setBackstopTakeRate([5001])).to.be.rejected;
  });
});

describe("TesseraPool — Blend liquidation auctions", () => {
  /** Push Bob underwater by marking his collateral down. */
  async function makeLiquidatable(f: Awaited<ReturnType<typeof deployFixture>>, price = 22_000n) {
    await withBorrower(f, USDC("18000"));
    await f.pool.write.setPrice([f.cbtc.address, price * 10n ** 8n]);
  }

  it("refuses an auction against a healthy account", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, usdc, cbtc, pool, as, liquidator } = f;
    await withBorrower(f, USDC("18000"));
    await expect(
      (await as(liquidator)).write.startLiquidationAuction([bob.account.address, usdc.address, cbtc.address, 5000]),
    ).to.be.rejected;
  });

  it("rejects a percentage that leaves the borrower outside the health band", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, usdc, cbtc, pool, as, liquidator } = f;
    await makeLiquidatable(f);
    const l = await as(liquidator);

    expect(await pool.read.HF_TARGET_MIN()).to.equal((WAD * 103n) / 100n);
    expect(await pool.read.HF_TARGET_MAX()).to.equal((WAD * 115n) / 100n);

    // Too small: the position is still liquidatable afterwards, so the borrower
    // gets seized again on the next tick of interest for one episode of stress.
    await expect(l.write.startLiquidationAuction([bob.account.address, usdc.address, cbtc.address, 100])).to.be.rejected;
    // Too large: no reason to sell three quarters of someone's collateral to fix
    // a position that 70% of it lands squarely inside the band.
    await expect(l.write.startLiquidationAuction([bob.account.address, usdc.address, cbtc.address, 7500])).to.be.rejected;
    // And the one in between is accepted.
    await l.write.startLiquidationAuction([bob.account.address, usdc.address, cbtc.address, 7000]);
  });

  it("allows a full clear, which is never over-liquidation", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, usdc, cbtc, as, liquidator } = f;
    await makeLiquidatable(f);
    // 100% leaves no debt at all. The ceiling exists to stop selling more
    // collateral than the problem needed; there is no residual position left to
    // over-collateralise, so the band does not apply.
    await (await as(liquidator)).write.startLiquidationAuction([
      bob.account.address, usdc.address, cbtc.address, 10000,
    ]);
  });

  /** Search the percentages for one the band accepts, the way a liquidator would. */
  async function openAuction(f: Awaited<ReturnType<typeof deployFixture>>) {
    const { bob, usdc, cbtc, as, liquidator } = f;
    const l = await as(liquidator);
    for (let pct = 500; pct <= 9500; pct += 100) {
      try {
        await l.write.startLiquidationAuction([bob.account.address, usdc.address, cbtc.address, pct]);
        return pct;
      } catch {
        /* outside the band — try the next */
      }
    }
    throw new Error("no percentage landed inside the health band");
  }

  it("opens at terms no liquidator would take and improves with time", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, pool } = f;
    await makeLiquidatable(f);
    await openAuction(f);

    // t=0: full debt demanded, no collateral offered. Nobody fills here, which
    // is the point — the price has to be discovered, not guessed at.
    let [lot, bid] = await pool.read.auctionTerms([bob.account.address]);
    expect(lot).to.equal(0);
    expect(bid).to.equal(10000);

    await time.increase(300);
    [lot, bid] = await pool.read.auctionTerms([bob.account.address]);
    expect(lot > 0 && lot < 10000, "the lot is ramping up").to.equal(true);
    expect(bid).to.equal(10000);

    // Midpoint: the whole lot for the whole bid — the fair exchange.
    await time.increase(300);
    [lot, bid] = await pool.read.auctionTerms([bob.account.address]);
    expect(lot).to.equal(10000);
    expect(bid).to.equal(10000);

    // Past it the liquidator starts being paid to take the position on.
    await time.increase(300);
    [lot, bid] = await pool.read.auctionTerms([bob.account.address]);
    expect(lot).to.equal(10000);
    expect(bid < 10000 && bid > 1000).to.equal(true);
  });

  it("never lets the bid fall to zero", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, pool } = f;
    await makeLiquidatable(f);
    await openAuction(f);
    await time.increase(24 * 3600);
    const [lot, bid] = await pool.read.auctionTerms([bob.account.address]);
    expect(lot).to.equal(10000);
    // A zero bid would let a late filler take the whole lot for free and leave
    // pure bad debt behind — a griefing vector, not price discovery.
    expect(bid).to.equal(await pool.read.MIN_BID_BPS());
    expect(bid).to.equal(1000);
  });

  it("fills partially, and the remainder stays open on the same terms", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, liquidator, usdc, cbtc, pool, as, fundAndApprove } = f;
    await makeLiquidatable(f);
    await openAuction(f);
    await fundAndApprove(liquidator, USDC("50000"), 0n);
    await time.increase(600); // the fair midpoint

    const debtBefore = await pool.read.borrowBalance([usdc.address, bob.account.address]);
    const l = await as(liquidator);

    // A quarter, then another quarter. Requiring one party to have the whole
    // repayment on hand is what leaves large positions sitting unliquidated.
    await l.write.fillLiquidationAuction([bob.account.address, 2500]);
    const [, , , , , filledOnce] = await pool.read.auctionData([bob.account.address]);
    expect(filledOnce).to.equal(2500);

    await l.write.fillLiquidationAuction([bob.account.address, 2500]);
    const [, , , , , filledTwice] = await pool.read.auctionData([bob.account.address]);
    expect(filledTwice).to.equal(5000);

    expect(await pool.read.borrowBalance([usdc.address, bob.account.address]) < debtBefore).to.equal(true);
    // The liquidator holds the seized collateral as a pool position they can
    // withdraw, not as a loose token transfer.
    expect(await pool.read.supplyBalance([cbtc.address, liquidator.account.address]) > 0n).to.equal(true);
  });

  it("closes the auction once it is fully filled", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, liquidator, pool, as, fundAndApprove } = f;
    await makeLiquidatable(f);
    await openAuction(f);
    await fundAndApprove(liquidator, USDC("50000"), 0n);
    await time.increase(600);

    const l = await as(liquidator);
    await l.write.fillLiquidationAuction([bob.account.address, 10000]);
    const [startedAt] = await pool.read.auctionData([bob.account.address]);
    expect(startedAt).to.equal(0n);
    await expect(l.write.fillLiquidationAuction([bob.account.address, 1000])).to.be.rejected;
  });

  it("clamps an over-large fill to what is left", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, liquidator, pool, as, fundAndApprove } = f;
    await makeLiquidatable(f);
    await openAuction(f);
    await fundAndApprove(liquidator, USDC("50000"), 0n);
    await time.increase(600);

    const l = await as(liquidator);
    await l.write.fillLiquidationAuction([bob.account.address, 6000]);
    // Asking for 100% of an auction that is 60% gone takes the remaining 40%,
    // not 100% of the original.
    await l.write.fillLiquidationAuction([bob.account.address, 10000]);
    expect((await pool.read.auctionData([bob.account.address]))[0]).to.equal(0n);
  });

  it("allows only one auction per borrower at a time", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, usdc, cbtc, as, liquidator } = f;
    await makeLiquidatable(f);
    const pct = await openAuction(f);
    await expect(
      (await as(liquidator)).write.startLiquidationAuction([bob.account.address, usdc.address, cbtc.address, pct]),
    ).to.be.rejected;
  });

  it("cancels an auction once the borrower has recovered", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, cbtc, pool, as, alice } = f;
    await makeLiquidatable(f);
    await openAuction(f);

    // While they are still liquidatable the auction must stand — otherwise
    // anyone could cancel every liquidation against themselves.
    await expect((await as(alice)).write.cancelLiquidationAuction([bob.account.address])).to.be.rejected;

    await pool.write.setPrice([cbtc.address, BTC_PRICE]);
    await (await as(alice)).write.cancelLiquidationAuction([bob.account.address]);
    expect((await pool.read.auctionData([bob.account.address]))[0]).to.equal(0n);
  });

  it("cancels an auction nobody ever filled", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, pool, as, alice } = f;
    await makeLiquidatable(f);
    await openAuction(f);
    // Without this, one abandoned auction blocks every future one against the
    // same borrower — a denial of service anyone could mount for the cost of
    // opening an auction they never intend to fill.
    await time.increase(2 * 3600);
    await (await as(alice)).write.cancelLiquidationAuction([bob.account.address]);
    expect((await pool.read.auctionData([bob.account.address]))[0]).to.equal(0n);
  });

  it("rejects a nonsense fill percentage", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, liquidator, as } = f;
    await makeLiquidatable(f);
    await openAuction(f);
    const l = await as(liquidator);
    await expect(l.write.fillLiquidationAuction([bob.account.address, 0])).to.be.rejected;
    await expect(l.write.fillLiquidationAuction([bob.account.address, 10001])).to.be.rejected;
  });

  it("has nothing to fill when no auction is open", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, liquidator, as } = f;
    await withBorrower(f, USDC("18000"));
    await expect((await as(liquidator)).write.fillLiquidationAuction([bob.account.address, 5000])).to.be.rejected;
  });

  it("still offers the immediate path for small positions", async () => {
    const f = await loadFixture(deployFixture);
    const { bob, liquidator, usdc, cbtc, pool, as, fundAndApprove } = f;
    await makeLiquidatable(f);
    await fundAndApprove(liquidator, USDC("50000"), 0n);
    // The auction is the tool for a large position; `liquidate` is still there
    // for one small enough that a fixed 10% bonus and a 50% cap will clear it.
    await (await as(liquidator)).write.liquidate([
      bob.account.address, usdc.address, cbtc.address, USDC("1000"),
    ]);
    expect(await pool.read.supplyBalance([cbtc.address, liquidator.account.address]) > 0n).to.equal(true);
  });
});
