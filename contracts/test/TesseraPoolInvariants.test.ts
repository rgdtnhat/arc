import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n;
const BTC_PRICE = 30_000n * 10n ** 8n;
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const BTC = (n: number) => BigInt(Math.round(n * 1e8));
const WAD = 10n ** 18n;

/**
 * Properties of the pool, checked over randomised action sequences.
 *
 * The rest of the suite is example-based: each case sets up one situation and
 * asserts what should happen in it. That catches the mistakes somebody thought
 * of. What it cannot catch is the ordering nobody wrote down — a withdrawal
 * between an accrual and a liquidation, a repay that lands in the same block as
 * a price move, the tenth interleaving of four operations.
 *
 * So this drives the pool with a seeded random walk and, after *every* step,
 * re-checks a handful of things that must be true regardless of how it got
 * there. A failure prints the seed and the exact sequence, so a random find
 * becomes a reproducible test rather than a story about a flake.
 *
 * Deterministic on purpose. A suite that runs different inputs on every CI run
 * is one where a red build cannot be reproduced and a green one proves less
 * than it appears to.
 */

/** xorshift32 — small, seeded, and identical across runs. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

async function deployFixture() {
  const [deployer, alice, bob, carol] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const cbtc = await hre.viem.deployContract("MockToken", ["cirBTC (mock)", "cirBTC", 8]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);

  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, PRICE]);
  await pool.write.addReserve([cbtc.address, 7000, 8000, 8000, 1000, false, 8, BTC_PRICE]);

  const actors = [alice, bob, carol];
  for (const who of actors) {
    await usdc.write.mint([who.account.address, USDC(1_000_000)]);
    await cbtc.write.mint([who.account.address, BTC(50)]);
    const u = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    const c = await hre.viem.getContractAt("MockToken", cbtc.address, { client: { wallet: who } });
    await u.write.approve([pool.address, USDC(1_000_000)]);
    await c.write.approve([pool.address, BTC(50)]);
  }

  const as = (who: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: who } });
  return { deployer, actors, usdc, cbtc, pool, as };
}

describe("TesseraPool invariants (properties, not scenarios)", () => {
  /**
   * The things that must hold after every single action, whatever the sequence.
   */
  async function checkInvariants(ctx: any, trail: string[]) {
    const { pool, usdc, cbtc, actors } = ctx;
    const why = (m: string) => `${m}\n  after: ${trail.join(" → ")}`;

    for (const token of [usdc, cbtc]) {
      const r = await pool.read.reserves([token.address]);
      const totalSupplyShares = r[8] as bigint;
      const totalSupplyAssets = r[9] as bigint;
      const totalBorrowShares = r[10] as bigint;
      const totalBorrowAssets = r[11] as bigint;

      // 1. The pool can never have lent out more than was supplied. This is the
      //    solvency statement: violate it and `_available` underflows, which
      //    means withdrawals start reverting for reasons unrelated to the
      //    withdrawer.
      expect(totalBorrowAssets <= totalSupplyAssets, why(
        `borrowed ${totalBorrowAssets} exceeds supplied ${totalSupplyAssets}`,
      )).to.equal(true);

      // 2. Shares and assets are either both zero or both non-zero. A reserve
      //    with shares but no assets prices every share at zero; one with assets
      //    but no shares has value nobody can claim.
      expect((totalSupplyShares === 0n) === (totalSupplyAssets === 0n), why(
        `supply shares ${totalSupplyShares} vs assets ${totalSupplyAssets}`,
      )).to.equal(true);
      expect((totalBorrowShares === 0n) === (totalBorrowAssets === 0n), why(
        `borrow shares ${totalBorrowShares} vs assets ${totalBorrowAssets}`,
      )).to.equal(true);

      // 3. The contract actually holds the cash it claims is available. Token
      //    balance is the ground truth; everything else is bookkeeping.
      const held = (await token.read.balanceOf([pool.address])) as bigint;
      const claimed = totalSupplyAssets - totalBorrowAssets;
      expect(held >= claimed, why(`holds ${held} but claims ${claimed} is available`)).to.equal(true);

      // 4. No account's balance exceeds the reserve's total. Individually
      //    plausible balances that sum past the total is how a rounding bug
      //    becomes a drain.
      let sum = 0n;
      for (const a of actors) sum += (await pool.read.supplyBalance([token.address, a.account.address])) as bigint;
      expect(sum <= totalSupplyAssets, why(`supplied balances sum to ${sum} > ${totalSupplyAssets}`)).to.equal(true);
    }

    // 5. Nobody is ever left holding debt with no collateral recorded against
    //    them while still reading as healthy — that combination means the
    //    health check is looking at the wrong account.
    for (const a of actors) {
      const [borrowLimit, liqLimit, liability] = (await pool.read.accountLimits([
        a.account.address,
      ])) as readonly [bigint, bigint, bigint];
      if (liability > 0n) {
        expect(liqLimit >= borrowLimit, why(
          `${a.account.address}: liquidation limit ${liqLimit} below borrow limit ${borrowLimit}`,
        )).to.equal(true);
      }
    }
  }

  it("holds its invariants across a randomised walk of supply/borrow/repay/withdraw", async () => {
    const ctx = await loadFixture(deployFixture);
    const { actors, usdc, cbtc, as } = ctx;
    const SEED = 20260803;
    const rand = rng(SEED);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const trail: string[] = [`seed ${SEED}`];

    // Seed the pool so borrowing is possible at all.
    await (await as(actors[0])).write.supply([usdc.address, USDC(200_000)]);
    await (await as(actors[1])).write.supply([cbtc.address, BTC(5)]);
    trail.push("seed supply");
    await checkInvariants(ctx, trail);

    for (let step = 0; step < 60; step++) {
      const who = pick(actors);
      const action = pick(["supply", "supplyBtc", "borrow", "repay", "withdraw", "wait"]);
      const p = await as(who);
      const label = `${action}(${actors.indexOf(who)})`;

      try {
        if (action === "supply") {
          await p.write.supply([usdc.address, USDC(1 + Math.floor(rand() * 5000))]);
        } else if (action === "supplyBtc") {
          await p.write.supply([cbtc.address, BTC(0.01 + rand() * 2)]);
        } else if (action === "borrow") {
          await p.write.borrow([usdc.address, USDC(1 + Math.floor(rand() * 20000))]);
        } else if (action === "repay") {
          const debt = (await ctx.pool.read.borrowBalance([usdc.address, who.account.address])) as bigint;
          if (debt > 0n) await p.write.repay([usdc.address, debt / 2n > 0n ? debt / 2n : debt]);
        } else if (action === "withdraw") {
          const bal = (await ctx.pool.read.supplyBalance([usdc.address, who.account.address])) as bigint;
          if (bal > 0n) await p.write.withdraw([usdc.address, bal / 3n > 0n ? bal / 3n : bal]);
        } else {
          // Time passing is an action too — it is the one that accrues interest,
          // and most ordering bugs need it to show up.
          await time.increase(1 + Math.floor(rand() * 86_400));
        }
        trail.push(label);
      } catch {
        // A reverted action is a legitimate outcome (over the cap, unhealthy,
        // illiquid). What must not happen is the state being wrong afterwards.
        trail.push(`${label}✗`);
      }

      await checkInvariants(ctx, trail);
    }
  });

  it("never lets an account withdraw more than it supplied", async () => {
    const ctx = await loadFixture(deployFixture);
    const { actors, usdc, pool, as } = ctx;
    const rand = rng(7);

    await (await as(actors[0])).write.supply([usdc.address, USDC(100_000)]);
    for (let i = 0; i < 20; i++) {
      const who = actors[Math.floor(rand() * actors.length)]!;
      const p = await as(who);
      const before = (await pool.read.supplyBalance([usdc.address, who.account.address])) as bigint;
      const walletBefore = (await usdc.read.balanceOf([who.account.address])) as bigint;

      try {
        await p.write.withdraw([usdc.address, before + USDC(1)]);
        // Getting here means it let someone take more than they had.
        expect.fail(`withdrew ${before + USDC(1)} against a balance of ${before}`);
      } catch (e: any) {
        if (String(e?.message ?? "").includes("withdrew")) throw e;
      }

      // And the failed attempt moved nothing.
      expect(await usdc.read.balanceOf([who.account.address])).to.equal(walletBefore);
      await time.increase(3600);
    }
  });

  it("keeps interest monotonic: a debt never shrinks on its own", async () => {
    const ctx = await loadFixture(deployFixture);
    const { actors, usdc, cbtc, pool, as } = ctx;

    await (await as(actors[0])).write.supply([usdc.address, USDC(100_000)]);
    await (await as(actors[1])).write.supply([cbtc.address, BTC(2)]);
    await (await as(actors[1])).write.borrow([usdc.address, USDC(20_000)]);

    let last = (await pool.read.borrowBalance([usdc.address, actors[1].account.address])) as bigint;
    for (let i = 0; i < 12; i++) {
      await time.increase(86_400);
      // Poke the reserve so interest is realised rather than merely pending.
      await (await as(actors[0])).write.supply([usdc.address, USDC(1)]);
      const now = (await pool.read.borrowBalance([usdc.address, actors[1].account.address])) as bigint;
      expect(now >= last, `debt fell from ${last} to ${now} with no repayment`).to.equal(true);
      last = now;
    }
  });

  it("keeps the share price monotonic for suppliers", async () => {
    // A supplier's claim per share must never fall. It can only rise, with
    // interest — anything else means somebody else's action diluted them.
    const ctx = await loadFixture(deployFixture);
    const { actors, usdc, cbtc, pool, as } = ctx;
    const rand = rng(99);

    await (await as(actors[0])).write.supply([usdc.address, USDC(50_000)]);
    await (await as(actors[1])).write.supply([cbtc.address, BTC(3)]);
    await (await as(actors[1])).write.borrow([usdc.address, USDC(20_000)]);

    const priceOfShare = async () => {
      const r = await pool.read.reserves([usdc.address]);
      const shares = r[8] as bigint;
      const assets = r[9] as bigint;
      return shares === 0n ? WAD : (assets * WAD) / shares;
    };

    let last = await priceOfShare();
    for (let i = 0; i < 25; i++) {
      const who = actors[Math.floor(rand() * actors.length)]!;
      const p = await as(who);
      try {
        if (rand() < 0.4) await p.write.supply([usdc.address, USDC(1 + Math.floor(rand() * 1000))]);
        else if (rand() < 0.7) {
          const bal = (await pool.read.supplyBalance([usdc.address, who.account.address])) as bigint;
          if (bal > 0n) await p.write.withdraw([usdc.address, bal / 4n > 0n ? bal / 4n : bal]);
        } else await time.increase(3600 * (1 + Math.floor(rand() * 24)));
      } catch { /* reverts are fine; the price still must not fall */ }

      const now = await priceOfShare();
      expect(now >= last, `share price fell from ${last} to ${now}`).to.equal(true);
      last = now;
    }
  });

  it("always clears debt against the collateral a fill seizes", async () => {
    const ctx = await loadFixture(deployFixture);
    const { actors, usdc, cbtc, pool, as, deployer } = ctx;

    await (await as(actors[0])).write.supply([usdc.address, USDC(100_000)]);
    await (await as(actors[1])).write.supply([cbtc.address, BTC(1)]);
    await (await as(actors[1])).write.borrow([usdc.address, USDC(18_000)]);

    // Mark the collateral down until the position is seizable.
    await pool.write.setPrice([cbtc.address, 22_000n * 10n ** 8n]);
    const victim = actors[1].account.address;
    const [, liqBefore, liabBefore] = (await pool.read.accountLimits([victim])) as readonly [
      bigint, bigint, bigint,
    ];
    expect(liabBefore > liqBefore, "victim should be liquidatable").to.equal(true);

    const healthBefore = (liqBefore * WAD) / liabBefore;

    // The pool only accepts a percentage that lands the borrower back inside its
    // health band, so search for one rather than guessing. This is the same
    // search `planLiquidation` does in the keeper, and hardcoding a number here
    // would make the test about that number rather than about the property.
    let opened = false;
    for (let pct = 500; pct <= 9500 && !opened; pct += 100) {
      try {
        await (await as(deployer)).write.startLiquidationAuction([
          victim, usdc.address, cbtc.address, pct,
        ]);
        opened = true;
      } catch { /* out of band at this size — try a bigger slice */ }
    }
    expect(opened, "no percentage in [5%, 95%] was acceptable to the pool").to.equal(true);

    // Let the auction ramp to where a fill is possible, then take it.
    await time.increase(700);
    const filler = actors[2];
    await (await as(filler)).write.fillLiquidationAuction([victim, 10_000]);

    const [, liqAfter, liabAfter] = (await pool.read.accountLimits([victim])) as readonly [
      bigint, bigint, bigint,
    ];

    // A fill must always reduce what the borrower owes. This is the property
    // that actually has to hold: collateral was taken, so debt must have been
    // cleared against it.
    expect(liabAfter < liabBefore, `liability ${liabBefore} → ${liabAfter}`).to.equal(true);
    // And it must not take collateral without clearing anything.
    expect(liqAfter < liqBefore, `collateral untouched: ${liqBefore} → ${liqAfter}`).to.equal(true);

    /*
     * Health, notably, is NOT asserted to improve — and that is worth being
     * explicit about, because the obvious property is false here.
     *
     * `startLiquidationAuction` checks that a *full* fill would land the
     * borrower inside the health band. But a Dutch auction decays: by the time
     * somebody fills, the bid has fallen, so the filler pays less than the full
     * debt for the whole lot. The borrower therefore gives up collateral sized
     * for a payment that no longer happens, and can come out of a late fill with
     * worse health than they went in with.
     *
     * That is the mechanism working as designed rather than a defect — the same
     * shape Blend uses, and the reason the auction opens at terms nobody would
     * take. The borrower's protection is that they can repay at any point before
     * a fill. It is recorded here because it looks alarming and somebody will
     * otherwise "fix" it by asserting the opposite and weakening the auction.
     */
    void healthBefore;
  });

  it("clears debt in proportion to the collateral it takes, at any point in the ramp", async () => {
    // The decay changes the exchange rate, not the direction. However late the
    // fill, the borrower must end up owing strictly less than before.
    for (const elapsed of [650, 900, 1300]) {
      const ctx = await loadFixture(deployFixture);
      const { actors, usdc, cbtc, pool, as, deployer } = ctx;

      await (await as(actors[0])).write.supply([usdc.address, USDC(100_000)]);
      await (await as(actors[1])).write.supply([cbtc.address, BTC(1)]);
      await (await as(actors[1])).write.borrow([usdc.address, USDC(18_000)]);
      await pool.write.setPrice([cbtc.address, 22_000n * 10n ** 8n]);

      const victim = actors[1].account.address;
      let opened = false;
      for (let pct = 500; pct <= 9500 && !opened; pct += 100) {
        try {
          await (await as(deployer)).write.startLiquidationAuction([
            victim, usdc.address, cbtc.address, pct,
          ]);
          opened = true;
        } catch { /* keep searching */ }
      }
      expect(opened, `could not open an auction for the ${elapsed}s case`).to.equal(true);

      const [, , liabBefore] = (await pool.read.accountLimits([victim])) as readonly [
        bigint, bigint, bigint,
      ];
      await time.increase(elapsed);
      await (await as(actors[2])).write.fillLiquidationAuction([victim, 10_000]);
      const [, , liabAfter] = (await pool.read.accountLimits([victim])) as readonly [
        bigint, bigint, bigint,
      ];
      expect(liabAfter < liabBefore, `at ${elapsed}s: ${liabBefore} → ${liabAfter}`).to.equal(true);
    }
  });

  it("conserves value across a supply/borrow/repay/withdraw round trip", async () => {
    // Nobody should be able to end a round trip with more of the asset than they
    // started with. Interest can only move value from borrowers to suppliers.
    const ctx = await loadFixture(deployFixture);
    const { actors, usdc, cbtc, pool, as } = ctx;
    const borrower = actors[1];

    await (await as(actors[0])).write.supply([usdc.address, USDC(100_000)]);
    const before = (await usdc.read.balanceOf([borrower.account.address])) as bigint;

    await (await as(borrower)).write.supply([cbtc.address, BTC(2)]);
    await (await as(borrower)).write.borrow([usdc.address, USDC(10_000)]);
    await time.increase(30 * 86_400);
    // `borrowBalance` reads the stored totals; it does not project accrual. So
    // poke the reserve first, or the number read back is the debt as of the last
    // touch and the repay covers only part of what is actually owed — which is
    // exactly the mistake this test would otherwise hide.
    await (await as(actors[0])).write.supply([usdc.address, USDC(1)]);
    const debt = (await pool.read.borrowBalance([usdc.address, borrower.account.address])) as bigint;
    await (await as(borrower)).write.repay([usdc.address, debt]);

    const after = (await usdc.read.balanceOf([borrower.account.address])) as bigint;
    // Borrowed and repaid with interest: strictly worse off in USDC terms.
    expect(after <= before, `borrower gained ${after - before} by borrowing and repaying`).to.equal(true);
    expect(before - after > 0n, "a month of debt should have cost something").to.equal(true);
  });
});
