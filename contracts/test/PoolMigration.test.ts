import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n;
const U = (n: number) => BigInt(Math.round(n * 1e6));

/**
 * A whole pool migration, end to end, on a chain.
 *
 * `Migration.test.ts` pins down the primitives — `supplyFor` credits the user
 * and debits the caller, and nothing can move a position that already exists.
 * This is the operation those primitives were built for: an old pool that
 * cannot be fixed in place, a new one that can, and every supplier moved across
 * without anyone's balance being taken from them.
 *
 * The cases are written around what actually goes wrong in a migration: it gets
 * interrupted, somebody supplies to the old pool while it is running, and one of
 * the accounts turns out to be a borrower.
 */
async function deployFixture() {
  const [operator, alice, bob, carol, borrower] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin (mock)", "EURC", 6]);

  // "old" and "new" are the same contract here — what differs on the real chain
  // is the deployed build, and that difference is not what this test is about.
  // What it is about is that positions land in the destination correctly.
  const oldPool = await hre.viem.deployContract("TesseraPool", [operator.account.address]);
  const newPool = await hre.viem.deployContract("TesseraPool", [operator.account.address]);
  for (const p of [oldPool, newPool]) {
    await p.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, PRICE]);
    await p.write.addReserve([eurc.address, 8500, 9000, 9000, 1000, true, 6, 108_000_000n]);
  }

  const as = (addr: string, who: any) => hre.viem.getContractAt("TesseraPool", addr, { client: { wallet: who } });
  const tokenAs = (token: any, who: any) =>
    hre.viem.getContractAt(token.address === usdc.address ? "MockUSDC" : "MockToken", token.address, {
      client: { wallet: who },
    });

  const fund = async (token: any, who: any, amount: bigint, spender: string) => {
    await token.write.mint([who.account.address, amount]);
    await (await tokenAs(token, who)).write.approve([spender, amount]);
  };

  return { operator, alice, bob, carol, borrower, usdc, eurc, oldPool, newPool, as, tokenAs, fund };
}

/** Everyone's supplied balance in the old pool, as the script would read it. */
async function positions(pool: any, asset: string, users: any[]) {
  const out: { user: string; supplied: bigint; borrowed: bigint }[] = [];
  for (const u of users) {
    out.push({
      user: u.account.address,
      supplied: await pool.read.supplyBalance([asset, u.account.address]),
      borrowed: await pool.read.borrowBalance([asset, u.account.address]),
    });
  }
  return out;
}

/**
 * Run the plan: `supplyFor` each account the difference it is short.
 *
 * `owes` is checked across every asset, not just the one being migrated —
 * a borrower posts cirBTC and draws USDC, so their cirBTC row shows no debt at
 * all and reads as perfectly migratable.
 */
async function owesAnything(f: any, user: any) {
  for (const asset of [f.usdc.address, f.eurc.address]) {
    if ((await f.oldPool.read.borrowBalance([asset, user.account.address])) > 0n) return true;
  }
  return false;
}

async function migrate(f: any, asset: string, users: any[]) {
  const src = await positions(f.oldPool, asset, users);
  const dst = await positions(f.newPool, asset, users);
  const token = asset === f.usdc.address ? f.usdc : f.eurc;

  let spent = 0n;
  for (let i = 0; i < src.length; i++) {
    if (await owesAnything(f, users[i]!)) continue;
    const topUp = src[i]!.supplied > dst[i]!.supplied ? src[i]!.supplied - dst[i]!.supplied : 0n;
    if (topUp <= 1n) continue;
    await f.fund(token, f.operator, topUp, f.newPool.address);
    await (await f.as(f.newPool.address, f.operator)).write.supplyFor([asset, src[i]!.user, topUp]);
    spent += topUp;
  }
  return spent;
}

describe("Pool migration — rebuilding positions in a pool that can be governed", () => {
  it("moves every supplier across, to the wei", async () => {
    const f = await loadFixture(deployFixture);
    const holders = [f.alice, f.bob, f.carol];
    const amounts = [U(1_000), U(250), U(33.5)];

    for (let i = 0; i < holders.length; i++) {
      await f.fund(f.usdc, holders[i]!, amounts[i]!, f.oldPool.address);
      await (await f.as(f.oldPool.address, holders[i]!)).write.supply([f.usdc.address, amounts[i]!]);
    }

    await migrate(f, f.usdc.address, holders);

    for (let i = 0; i < holders.length; i++) {
      expect(await f.newPool.read.supplyBalance([f.usdc.address, holders[i]!.account.address])).to.equal(amounts[i]!);
    }
  });

  it("leaves the old pool untouched, so nobody's funds depend on the migration working", async () => {
    const f = await loadFixture(deployFixture);
    await f.fund(f.usdc, f.alice, U(500), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.usdc.address, U(500)]);

    await migrate(f, f.usdc.address, [f.alice]);

    // The operator fronted the new position out of its own pocket; Alice's
    // original deposit is still hers to withdraw from the old contract.
    expect(await f.oldPool.read.supplyBalance([f.usdc.address, f.alice.account.address])).to.equal(U(500));
    const before = await f.usdc.read.balanceOf([f.alice.account.address]);
    await (await f.as(f.oldPool.address, f.alice)).write.withdraw([f.usdc.address, U(500)]);
    expect((await f.usdc.read.balanceOf([f.alice.account.address])) - before).to.equal(U(500));
  });

  it("costs the operator exactly what it moved, and nobody else anything", async () => {
    const f = await loadFixture(deployFixture);
    await f.fund(f.usdc, f.alice, U(700), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.usdc.address, U(700)]);

    const aliceBefore = await f.usdc.read.balanceOf([f.alice.account.address]);
    const spent = await migrate(f, f.usdc.address, [f.alice]);

    expect(spent).to.equal(U(700));
    expect(await f.usdc.read.balanceOf([f.alice.account.address])).to.equal(aliceBefore);
  });

  it("is idempotent: running it twice does not double anybody's position", async () => {
    const f = await loadFixture(deployFixture);
    await f.fund(f.usdc, f.alice, U(400), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.usdc.address, U(400)]);

    await migrate(f, f.usdc.address, [f.alice]);
    const second = await migrate(f, f.usdc.address, [f.alice]);

    expect(second).to.equal(0n, "the second pass should find nothing to do");
    expect(await f.newPool.read.supplyBalance([f.usdc.address, f.alice.account.address])).to.equal(U(400));
  });

  it("resumes correctly after being interrupted halfway", async () => {
    const f = await loadFixture(deployFixture);
    await f.fund(f.usdc, f.alice, U(1_000), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.usdc.address, U(1_000)]);

    // A partial run: the operator got 300 across before the RPC gave up.
    await f.fund(f.usdc, f.operator, U(300), f.newPool.address);
    await (await f.as(f.newPool.address, f.operator)).write.supplyFor([f.usdc.address, f.alice.account.address, U(300)]);

    const spent = await migrate(f, f.usdc.address, [f.alice]);
    expect(spent).to.equal(U(700), "should top up the difference, not re-supply the whole balance");
    expect(await f.newPool.read.supplyBalance([f.usdc.address, f.alice.account.address])).to.equal(U(1_000));
  });

  it("catches a deposit made to the old pool while the migration was running", async () => {
    const f = await loadFixture(deployFixture);
    await f.fund(f.usdc, f.alice, U(100), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.usdc.address, U(100)]);
    await migrate(f, f.usdc.address, [f.alice]);

    // The old pool has no freeze — that is the whole reason for this migration —
    // so somebody can still deposit into it. A second pass has to pick that up.
    await f.fund(f.usdc, f.alice, U(60), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.usdc.address, U(60)]);

    const spent = await migrate(f, f.usdc.address, [f.alice]);
    expect(spent).to.equal(U(60));
    expect(await f.newPool.read.supplyBalance([f.usdc.address, f.alice.account.address])).to.equal(U(160));
  });

  it("refuses to move a borrower, leaving both sides of their position together", async () => {
    const f = await loadFixture(deployFixture);
    // Collateral in EURC, debt in USDC.
    await f.fund(f.eurc, f.borrower, U(1_000), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.borrower)).write.supply([f.eurc.address, U(1_000)]);
    await f.fund(f.usdc, f.alice, U(5_000), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.usdc.address, U(5_000)]);
    await (await f.as(f.oldPool.address, f.borrower)).write.borrow([f.usdc.address, U(200)]);

    await migrate(f, f.eurc.address, [f.borrower]);

    // Moving the collateral without the debt would leave them over-collateralised
    // in one pool and under-collateralised in the other — worse than both staying.
    expect(await f.newPool.read.supplyBalance([f.eurc.address, f.borrower.account.address])).to.equal(0n);
    expect(await f.oldPool.read.supplyBalance([f.eurc.address, f.borrower.account.address])).to.equal(U(1_000));
  });

  it("lets a borrower repay the old pool and then be migrated", async () => {
    const f = await loadFixture(deployFixture);
    await f.fund(f.eurc, f.borrower, U(1_000), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.borrower)).write.supply([f.eurc.address, U(1_000)]);
    await f.fund(f.usdc, f.alice, U(5_000), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.usdc.address, U(5_000)]);
    await (await f.as(f.oldPool.address, f.borrower)).write.borrow([f.usdc.address, U(200)]);

    // The old pool keeps working for exactly this — it was never paused.
    await f.fund(f.usdc, f.borrower, U(300), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.borrower)).write.repay([f.usdc.address, U(300)]);
    expect(await f.oldPool.read.borrowBalance([f.usdc.address, f.borrower.account.address])).to.equal(0n);

    await migrate(f, f.eurc.address, [f.borrower]);
    expect(await f.newPool.read.supplyBalance([f.eurc.address, f.borrower.account.address])).to.equal(U(1_000));
  });

  it("migrates each asset independently", async () => {
    const f = await loadFixture(deployFixture);
    await f.fund(f.usdc, f.alice, U(100), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.usdc.address, U(100)]);
    await f.fund(f.eurc, f.alice, U(70), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.eurc.address, U(70)]);

    await migrate(f, f.usdc.address, [f.alice]);
    await migrate(f, f.eurc.address, [f.alice]);

    expect(await f.newPool.read.supplyBalance([f.usdc.address, f.alice.account.address])).to.equal(U(100));
    expect(await f.newPool.read.supplyBalance([f.eurc.address, f.alice.account.address])).to.equal(U(70));
  });

  it("the migrated position is fully the user's — they can withdraw it themselves", async () => {
    const f = await loadFixture(deployFixture);
    await f.fund(f.usdc, f.alice, U(250), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.usdc.address, U(250)]);
    await migrate(f, f.usdc.address, [f.alice]);

    const before = await f.usdc.read.balanceOf([f.alice.account.address]);
    await (await f.as(f.newPool.address, f.alice)).write.withdraw([f.usdc.address, U(250)]);
    expect((await f.usdc.read.balanceOf([f.alice.account.address])) - before).to.equal(U(250));
  });

  it("the operator cannot take back what it supplied for someone", async () => {
    const f = await loadFixture(deployFixture);
    await f.fund(f.usdc, f.alice, U(250), f.oldPool.address);
    await (await f.as(f.oldPool.address, f.alice)).write.supply([f.usdc.address, U(250)]);
    await migrate(f, f.usdc.address, [f.alice]);

    // Fronting the capital must not create a claim on it. If it did, "migration"
    // would be a way to mint positions the operator could later withdraw.
    await expect(
      (await f.as(f.newPool.address, f.operator)).write.withdraw([f.usdc.address, U(250)]),
    ).to.be.rejected;
    expect(await f.newPool.read.supplyBalance([f.usdc.address, f.operator.account.address])).to.equal(0n);
  });

  it("the new pool has the controls the old one was missing", async () => {
    const f = await loadFixture(deployFixture);
    // The reason for the whole exercise: prices readable and settable, assets
    // freezable, and the risk oracle and outflow limiter attachable.
    expect(await f.newPool.read.price([f.usdc.address])).to.equal(PRICE);
    await f.newPool.write.setPrice([f.usdc.address, PRICE * 2n]);
    expect(await f.newPool.read.price([f.usdc.address])).to.equal(PRICE * 2n);

    await f.newPool.write.setFrozen([f.usdc.address, 15]);
    const [mask] = await f.newPool.read.reserveMeta([f.usdc.address]);
    expect(mask).to.equal(15);
    await f.newPool.write.setFrozen([f.usdc.address, 0]);

    const limiter = await hre.viem.deployContract("TesseraRateLimiter", [f.newPool.address]);
    await f.newPool.write.setRateLimiter([limiter.address]);
    expect((await f.newPool.read.rateLimiter()).toLowerCase()).to.equal(limiter.address.toLowerCase());
  });
});
