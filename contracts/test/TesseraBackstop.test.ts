import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const U = (n: string) => BigInt(Math.round(Number(n) * 1e6));
const WEEK = 7 * 24 * 3600;

/**
 * The case this contract was extracted to fix is the wipe. Everything else here
 * is the surrounding behaviour that has to keep working while it does — pro
 * rata sharing, an exit queue that does not let anybody dodge a loss, and a
 * recovery path that favours the people who took one.
 */
async function deployFixture() {
  const [owner, alice, bob, carol, pool] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const backstop = await hre.viem.deployContract("TesseraBackstop", [
    usdc.address, usdc.address, owner.account.address, BigInt(WEEK),
  ]);
  await backstop.write.setPool([pool.account.address]);

  for (const who of [alice, bob, carol, pool]) {
    await usdc.write.mint([who.account.address, U("100000")]);
    const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    await c.write.approve([backstop.address, U("100000")]);
  }
  const as = (w: any) => hre.viem.getContractAt("TesseraBackstop", backstop.address, { client: { wallet: w } });
  return { owner, alice, bob, carol, pool, usdc, backstop, as };
}

describe("TesseraBackstop (first-loss capital that survives being wiped out)", () => {
  it("shares a loss in proportion, and prices new money at the new level", async () => {
    const f = await loadFixture(deployFixture);
    await (await f.as(f.alice)).write.deposit([U("9000")]);
    await (await f.as(f.bob)).write.deposit([U("3000")]);

    await (await f.as(f.pool)).write.absorb([U("6000")]); // half the pot

    const a = await f.backstop.read.balanceOf([f.alice.account.address]);
    const b = await f.backstop.read.balanceOf([f.bob.account.address]);
    expect(a).to.equal(U("4500"));
    expect(b).to.equal(U("1500"));

    // A newcomer neither inherits the loss nor gets a discount.
    await (await f.as(f.carol)).write.deposit([U("1000")]);
    const c = await f.backstop.read.balanceOf([f.carol.account.address]);
    expect(c > U("999") && c <= U("1000")).to.equal(true);
  });

  it("retires every share of the era it wipes out", async () => {
    /*
     * The bug, in the version that could not be fixed in the pool: the pot goes
     * to zero, the shares survive as claims on nothing, and the next deposit
     * mints against them. 1,000 in came back as 76.92.
     */
    const f = await loadFixture(deployFixture);
    await (await f.as(f.alice)).write.deposit([U("5000")]);
    await (await f.as(f.pool)).write.absorb([U("9000")]); // more than is there

    expect(await f.backstop.read.backstopBalance()).to.equal(0n);
    expect(await f.backstop.read.backstopTotalShares()).to.equal(0n);
    expect(await f.backstop.read.epoch()).to.equal(1n);
    expect(await f.backstop.read.sharesOf([f.alice.account.address])).to.equal(0n);

    // And the next depositor gets exactly what they put in.
    await (await f.as(f.bob)).write.deposit([U("1000")]);
    expect(await f.backstop.read.balanceOf([f.bob.account.address])).to.equal(U("1000"));
  });

  it("will not let a wiped-out holder withdraw against the next depositor's money", async () => {
    /*
     * The failure a naive reset introduces, and the reason the epoch is
     * per-holder rather than a single counter. Alice's stale share count is
     * still in storage; it must buy her nothing.
     */
    const f = await loadFixture(deployFixture);
    await (await f.as(f.alice)).write.deposit([U("5000")]);
    const a = await f.as(f.alice);
    await a.write.queueExit([await f.backstop.read.backstopShares([f.alice.account.address])]);

    await (await f.as(f.pool)).write.absorb([U("9000")]);
    await (await f.as(f.bob)).write.deposit([U("1000")]);
    await time.increase(WEEK + 1);

    await expect(a.write.withdraw()).to.be.rejected;
    expect(await f.backstop.read.balanceOf([f.bob.account.address])).to.equal(U("1000"));
  });

  it("rolls a returning holder forward instead of adding to a dead balance", async () => {
    const f = await loadFixture(deployFixture);
    await (await f.as(f.alice)).write.deposit([U("5000")]);
    await (await f.as(f.pool)).write.absorb([U("9000")]);

    // Alice comes back. Her old 5,000 of shares are gone, not credited.
    await (await f.as(f.alice)).write.deposit([U("1000")]);
    expect(await f.backstop.read.balanceOf([f.alice.account.address])).to.equal(U("1000"));
    expect(await f.backstop.read.backstopTotalShares()).to.equal(U("1000"));
  });

  it("keeps queued capital in the firing line until it is actually withdrawn", async () => {
    // Otherwise the exit queue is a way to see a default coming and step out of
    // the way while still being counted as cover.
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.deposit([U("9000")]);
    await a.write.queueExit([await f.backstop.read.backstopShares([f.alice.account.address])]);

    await (await f.as(f.pool)).write.absorb([U("4500")]);
    expect(await f.backstop.read.balanceOf([f.alice.account.address])).to.equal(U("4500"));
  });

  it("will not release an exit before its time", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.deposit([U("1000")]);
    await a.write.queueExit([U("1000")]);
    await expect(a.write.withdraw()).to.be.rejected;
    await time.increase(WEEK + 1);
    await a.write.withdraw();
    expect(await f.backstop.read.balanceOf([f.alice.account.address])).to.equal(0n);
  });

  it("restarts the clock when an exit is re-queued", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.deposit([U("1000")]);
    await a.write.queueExit([U("1")]);
    await time.increase(WEEK - 60);
    await a.write.queueExit([U("1000")]);
    await expect(a.write.withdraw()).to.be.rejected;
  });

  it("reports what it actually covered, so the rest can be socialised", async () => {
    const f = await loadFixture(deployFixture);
    await (await f.as(f.alice)).write.deposit([U("2000")]);
    const p = await f.as(f.pool);
    // A view call would return the value; the event is what the pool reads.
    await p.write.absorb([U("5000")]);
    expect(await f.backstop.read.totalAbsorbed()).to.equal(U("2000"));
  });

  it("hands the covered amount to the pool, not to whoever called", async () => {
    const f = await loadFixture(deployFixture);
    await (await f.as(f.alice)).write.deposit([U("2000")]);
    const before = await f.usdc.read.balanceOf([f.pool.account.address]);
    await (await f.as(f.pool)).write.absorb([U("2000")]);
    expect(await f.usdc.read.balanceOf([f.pool.account.address])).to.equal(before + U("2000"));
  });

  it("only the pool may charge a loss", async () => {
    const f = await loadFixture(deployFixture);
    await (await f.as(f.alice)).write.deposit([U("2000")]);
    await expect((await f.as(f.bob)).write.absorb([U("2000")])).to.be.rejected;
  });

  it("lets a donation revive a wiped pot, in favour of whoever is holding", async () => {
    /*
     * `fund` mints nothing, so it accrues to existing holders. After a wipe
     * there are none, so it simply seeds the next era — and before one, it
     * makes the people who absorbed the loss partially whole.
     */
    const f = await loadFixture(deployFixture);
    await (await f.as(f.alice)).write.deposit([U("4000")]);
    await (await f.as(f.pool)).write.absorb([U("2000")]);

    await (await f.as(f.bob)).write.fund([U("2000")]);
    // Alice took the loss and the donation lands on her, not on Bob.
    expect(await f.backstop.read.balanceOf([f.alice.account.address])).to.equal(U("4000"));
    expect(await f.backstop.read.balanceOf([f.bob.account.address])).to.equal(0n);
  });

  it("exposes the share views the emissions contract already reads", async () => {
    // Keeping the pool's names means the backstop side of emissions works
    // against this contract without a migration of something that is fine.
    const f = await loadFixture(deployFixture);
    await (await f.as(f.alice)).write.deposit([U("1000")]);
    expect(await f.backstop.read.backstopShares([f.alice.account.address])).to.equal(U("1000"));
    expect(await f.backstop.read.backstopTotalShares()).to.equal(U("1000"));
  });

  it("only the owner names the pool", async () => {
    const f = await loadFixture(deployFixture);
    await expect((await f.as(f.bob)).write.setPool([f.bob.account.address])).to.be.rejected;
  });
});
