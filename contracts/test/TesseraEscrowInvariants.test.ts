import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex } from "viem";

const U = (n: number) => BigInt(Math.round(n * 1e6));
const H = (s: string) => keccak256(toHex(s));

/** xorshift32 — seeded, so a failure is reproducible rather than a flake. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

/**
 * Properties of the escrow and the AMM.
 *
 * The escrow holds other people's money across a four-state lifecycle with three
 * parties who can act on it. Example tests cover the paths somebody enumerated;
 * these cover the arithmetic that has to survive whatever order those paths
 * happen in — most importantly that the contract never ends up owing more than
 * it holds, and never strands a bond.
 */
async function escrowFixture() {
  const [deployer, agent, provider, treasury, other] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);
  await escrow.write.setProtocolFee([100, treasury.account.address]); // 1%

  const actors = [agent, provider, other];
  for (const who of [...actors, deployer]) {
    await usdc.write.mint([who.account.address, U(1_000_000)]);
    const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    await c.write.approve([escrow.address, U(1_000_000)]);
  }

  const as = (who: any) => hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: who } });
  return { deployer, agent, provider, treasury, other, actors, usdc, escrow, as };
}

describe("TesseraEscrow invariants", () => {
  it("never owes more than it holds, across a randomised lifecycle walk", async () => {
    const f = await loadFixture(escrowFixture);
    const { agent, provider, usdc, escrow, as } = f;
    const SEED = 424242;
    const rand = rng(SEED);
    const trail: string[] = [`seed ${SEED}`];

    const live: bigint[] = [];

    /**
     * What the contract is still on the hook for: every unsettled payment's
     * amount plus its bond. Its token balance must never fall below this, or
     * somebody's escrow is being paid out of somebody else's.
     */
    const checkSolvent = async () => {
      let owed = 0n;
      for (const id of live) {
        const p = (await escrow.read.getPayment([id])) as readonly [
          string, string, bigint, bigint, string, string, number,
        ];
        const status = p[6];
        if (status === 1 || status === 2) {
          // Escrowed or Fulfilled — the money is still the contract's to move.
          const [bond] = (await escrow.read.bondOf([id])) as readonly [bigint, boolean];
          owed += p[2] + bond;
        }
      }
      const held = (await usdc.read.balanceOf([escrow.address])) as bigint;
      expect(held >= owed, `holds ${held} but owes ${owed}\n  after: ${trail.join(" → ")}`).to.equal(true);
    };

    for (let step = 0; step < 45; step++) {
      const roll = rand();
      try {
        if (roll < 0.35 || live.length === 0) {
          const amount = U(1 + Math.floor(rand() * 500));
          const deadline = BigInt(await time.latest()) + 3600n;
          await (await as(agent)).write.open([provider.account.address, amount, deadline, H(`q${step}`)]);
          const id = ((await escrow.read.nextPaymentId()) as bigint) - 1n;
          live.push(id);
          trail.push(`open#${id}`);
        } else {
          const id = live[Math.floor(rand() * live.length)]!;
          const which = rand();
          if (which < 0.35) {
            await (await as(provider)).write.fulfill([id, H(`r${id}`)]);
            trail.push(`fulfill#${id}`);
          } else if (which < 0.6) {
            await (await as(agent)).write.settle([id]);
            trail.push(`settle#${id}`);
          } else if (which < 0.8) {
            await (await as(agent)).write.refund([id]);
            trail.push(`refund#${id}`);
          } else {
            await time.increase(1 + Math.floor(rand() * 7200));
            trail.push("wait");
          }
        }
      } catch {
        trail.push("✗");
      }
      await checkSolvent();
    }

    // And once everything is resolved, nothing is stranded.
    for (const id of live) {
      const p = (await escrow.read.getPayment([id])) as readonly [
        string, string, bigint, bigint, string, string, number,
      ];
      if (p[6] === 1) {
        await time.increase(7200);
        try { await (await as(agent)).write.refund([id]); } catch { /* already resolved */ }
      } else if (p[6] === 2) {
        try { await (await as(agent)).write.settle([id]); } catch { /* already resolved */ }
      }
    }
    expect(await usdc.read.balanceOf([escrow.address])).to.equal(0n);
  });

  it("conserves every unit of a payment, whichever way it ends", async () => {
    // Payment + bond in; payment + bond out, split across at most four places.
    // A unit that reaches none of them has been lost inside the contract.
    for (const ending of ["settle", "reject", "timeout", "claim"] as const) {
      const f = await loadFixture(escrowFixture);
      const { agent, provider, treasury, usdc, escrow, as } = f;
      const amount = U(250);
      const bond = (await escrow.read.bondFor([amount])) as bigint;

      const before = {
        agent: (await usdc.read.balanceOf([agent.account.address])) as bigint,
        provider: (await usdc.read.balanceOf([provider.account.address])) as bigint,
        treasury: (await usdc.read.balanceOf([treasury.account.address])) as bigint,
      };

      const deadline = BigInt(await time.latest()) + 3600n;
      await (await as(agent)).write.open([provider.account.address, amount, deadline, H("q")]);
      const id = ((await escrow.read.nextPaymentId()) as bigint) - 1n;

      if (ending === "timeout") {
        await time.increaseTo(deadline + 1n);
        await (await as(agent)).write.refund([id]);
      } else {
        await (await as(provider)).write.fulfill([id, H("r")]);
        if (ending === "settle") await (await as(agent)).write.settle([id]);
        else if (ending === "reject") await (await as(agent)).write.refund([id]);
        else {
          await time.increase(Number(await escrow.read.DISPUTE_WINDOW()) + 1);
          await (await as(provider)).write.providerClaim([id]);
        }
      }

      const after = {
        agent: (await usdc.read.balanceOf([agent.account.address])) as bigint,
        provider: (await usdc.read.balanceOf([provider.account.address])) as bigint,
        treasury: (await usdc.read.balanceOf([treasury.account.address])) as bigint,
      };
      const moved =
        (after.agent - before.agent) +
        (after.provider - before.provider) +
        (after.treasury - before.treasury);

      expect(moved, `${ending}: ${moved} unaccounted for`).to.equal(0n);
      expect(await usdc.read.balanceOf([escrow.address]), `${ending}: escrow retained funds`).to.equal(0n);
      void bond;
    }
  });

  it("only ever moves a payment forward through its states", async () => {
    // Escrowed → Fulfilled → Settled, or → Refunded. Never backwards, never
    // twice. A state that can be re-entered is a payout that can be repeated.
    const f = await loadFixture(escrowFixture);
    const { agent, provider, escrow, as } = f;
    const deadline = BigInt(await time.latest()) + 3600n;

    await (await as(agent)).write.open([provider.account.address, U(10), deadline, H("q")]);
    const id = 1n;
    const status = async () => ((await escrow.read.getPayment([id])) as readonly unknown[])[6] as number;

    expect(await status()).to.equal(1); // Escrowed
    await (await as(provider)).write.fulfill([id, H("r")]);
    expect(await status()).to.equal(2); // Fulfilled
    // Fulfilling twice must not be possible.
    await expect((await as(provider)).write.fulfill([id, H("r2")])).to.be.rejected;

    await (await as(agent)).write.settle([id]);
    expect(await status()).to.equal(3); // Settled
    for (const attempt of [
      (await as(agent)).write.settle([id]),
      (await as(agent)).write.refund([id]),
      (await as(provider)).write.fulfill([id, H("r3")]),
      (await as(provider)).write.providerClaim([id]),
    ]) {
      await expect(attempt).to.be.rejected;
    }
  });

  it("keeps a provider's earnings equal to what it was actually paid", async () => {
    const f = await loadFixture(escrowFixture);
    const { agent, provider, usdc, escrow, as } = f;
    const rand = rng(31337);
    const before = (await usdc.read.balanceOf([provider.account.address])) as bigint;

    for (let i = 0; i < 10; i++) {
      const amount = U(1 + Math.floor(rand() * 200));
      const deadline = BigInt(await time.latest()) + 3600n;
      await (await as(agent)).write.open([provider.account.address, amount, deadline, H(`q${i}`)]);
      const id = ((await escrow.read.nextPaymentId()) as bigint) - 1n;
      await (await as(provider)).write.fulfill([id, H(`r${i}`)]);
      if (rand() < 0.7) await (await as(agent)).write.settle([id]);
      else await (await as(agent)).write.refund([id]);
    }

    const gained = ((await usdc.read.balanceOf([provider.account.address])) as bigint) - before;
    const [, , earned] = (await escrow.read.reputation([provider.account.address])) as readonly [
      bigint, bigint, bigint, bigint, bigint,
    ];
    // `earned` is the track record buyers read. If it drifts from the money that
    // actually arrived, it is advertising rather than accounting.
    expect(earned).to.equal(gained);
  });

  it("keeps distinctBuyers bounded by the settlements it summarises", async () => {
    const f = await loadFixture(escrowFixture);
    const { agent, provider, other, escrow, as } = f;
    const buyers = [agent, other];

    for (let i = 0; i < 8; i++) {
      const buyer = buyers[i % buyers.length]!;
      const deadline = BigInt(await time.latest()) + 3600n;
      await (await as(buyer)).write.open([provider.account.address, U(5), deadline, H(`q${i}`)]);
      const id = ((await escrow.read.nextPaymentId()) as bigint) - 1n;
      await (await as(provider)).write.fulfill([id, H(`r${i}`)]);
      await (await as(buyer)).write.settle([id]);

      const [fulfilled, , , distinct] = (await escrow.read.reputation([
        provider.account.address,
      ])) as readonly [bigint, bigint, bigint, bigint, bigint];
      // More counterparties than settlements would mean somebody was counted
      // without paying — the exact direction that would make the anti-farming
      // signal lie in the provider's favour.
      expect(distinct <= fulfilled, `${distinct} buyers for ${fulfilled} settlements`).to.equal(true);
      expect(distinct <= BigInt(buyers.length)).to.equal(true);
    }
  });
});

/**
 * The AMM's job is to never give away more than the curve allows. These check
 * that across randomised trading rather than at a handful of sizes.
 */
async function ammFixture() {
  const [deployer, lp, trader] = await hre.viem.getWalletClients();
  const a = await hre.viem.deployContract("MockToken", ["Token A", "AAA", 6]);
  const b = await hre.viem.deployContract("MockToken", ["Token B", "BBB", 6]);
  const amm = await hre.viem.deployContract("TesseraAMM", [deployer.account.address]);
  await amm.write.createPool([[a.address, b.address], 30, 5000, "A / B"]);

  for (const who of [lp, trader]) {
    for (const t of [a, b]) {
      await t.write.mint([who.account.address, U(1_000_000)]);
      const c = await hre.viem.getContractAt("MockToken", t.address, { client: { wallet: who } });
      await c.write.approve([amm.address, U(1_000_000)]);
    }
  }
  const asLp = await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: lp } });
  await asLp.write.addLiquidity([0n, [U(100_000), U(100_000)], 0n]);

  const as = (who: any) => hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: who } });
  return { deployer, lp, trader, a, b, amm, as };
}

describe("TesseraAMM invariants", () => {
  it("never lets the product of reserves fall through trading", async () => {
    // Constant product with a fee: every swap must leave k at least where it
    // was. A swap that lowers k has handed value to the trader.
    const f = await loadFixture(ammFixture);
    const { trader, a, b, amm, as } = f;
    const rand = rng(5150);
    const t = await as(trader);

    const k = async () => {
      const info = (await amm.read.poolInfo([0n])) as readonly unknown[];
      const bal = info[1] as readonly bigint[];
      return bal[0]! * bal[1]!;
    };

    let last = await k();
    for (let i = 0; i < 25; i++) {
      const [tokenIn, tokenOut] = rand() < 0.5 ? [a, b] : [b, a];
      const amountIn = U(1 + Math.floor(rand() * 2000));
      try {
        await t.write.swap([0n, tokenIn.address, tokenOut.address, amountIn, 0n]);
      } catch {
        continue;
      }
      const now = await k();
      expect(now >= last, `k fell from ${last} to ${now} on swap ${i}`).to.equal(true);
      last = now;
    }
  });

  it("never quotes more out than the reserve holds", async () => {
    const f = await loadFixture(ammFixture);
    const { a, b, amm } = f;
    const rand = rng(2024);

    for (let i = 0; i < 20; i++) {
      // Deliberately including absurd sizes: a curve that saturates gracefully
      // must still never promise more than exists.
      const amountIn = U(1 + Math.floor(rand() * 10_000_000));
      const [out] = (await amm.read.estimateSwap([0n, a.address, b.address, amountIn])) as readonly [
        bigint, bigint, bigint,
      ];
      const info = (await amm.read.poolInfo([0n])) as readonly unknown[];
      const bal = info[1] as readonly bigint[];
      expect(out < bal[1]!, `quoted ${out} out of a reserve holding ${bal[1]}`).to.equal(true);
    }
  });

  it("round-trips a swap at a loss, never a profit", async () => {
    // In and straight back out must cost the fee. If it ever returns more than
    // it took, the pool is a money printer.
    const f = await loadFixture(ammFixture);
    const { trader, a, b, as } = f;
    const t = await as(trader);
    const rand = rng(8080);

    for (let i = 0; i < 8; i++) {
      const amountIn = U(10 + Math.floor(rand() * 5000));
      const beforeA = (await a.read.balanceOf([trader.account.address])) as bigint;
      const beforeB = (await b.read.balanceOf([trader.account.address])) as bigint;
      await t.write.swap([0n, a.address, b.address, amountIn, 0n]);
      // Send back exactly what that leg produced, not the whole B balance.
      const gotB = ((await b.read.balanceOf([trader.account.address])) as bigint) - beforeB;
      await t.write.swap([0n, b.address, a.address, gotB, 0n]);
      const afterA = (await a.read.balanceOf([trader.account.address])) as bigint;
      expect(afterA <= beforeA, `round trip gained ${afterA - beforeA}`).to.equal(true);
    }
  });

  it("gives a liquidity provider back no more than their share", async () => {
    const f = await loadFixture(ammFixture);
    const { lp, trader, a, b, amm, as } = f;
    const t = await as(trader);
    const l = await as(lp);

    // Trade a little so there are fees in the pool.
    for (let i = 0; i < 5; i++) {
      await t.write.swap([0n, a.address, b.address, U(500), 0n]);
      await t.write.swap([0n, b.address, a.address, U(500), 0n]);
    }

    const shares = (await amm.read.sharesOf([0n, lp.account.address])) as bigint;
    const info = (await amm.read.poolInfo([0n])) as readonly unknown[];
    const bal = info[1] as readonly bigint[];
    const total = info[4] as bigint;
    const maxA = (bal[0]! * shares) / total;

    const beforeA = (await a.read.balanceOf([lp.account.address])) as bigint;
    await l.write.removeLiquidity([0n, shares, [0n, 0n]]);
    const gainedA = ((await a.read.balanceOf([lp.account.address])) as bigint) - beforeA;

    expect(gainedA <= maxA, `withdrew ${gainedA} against a share worth ${maxA}`).to.equal(true);
  });
});
