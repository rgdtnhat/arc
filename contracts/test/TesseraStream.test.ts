import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const U = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));
const HOUR = 3600;

/**
 * Chai's `closeTo` predates bigint. Mining a transaction advances the chain by a
 * second, so anything measured across a write is expected to be off by a second
 * or two of rate — which is exactly the tolerance worth asserting.
 */
function near(actual: bigint, expected: bigint, tolerance: bigint) {
  const delta = actual > expected ? actual - expected : expected - actual;
  expect(delta <= tolerance, `expected ${actual} within ${tolerance} of ${expected}`).to.equal(true);
}

/**
 * A stream's whole value proposition is that neither side depends on the other
 * being online. These tests are mostly about that: the recipient can always take
 * what the clock says they earned, and the payer can always take back what it
 * does not.
 */
async function deployFixture() {
  const [payer, recipient, stranger] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const stream = await hre.viem.deployContract("TesseraStream");

  for (const who of [payer, stranger]) {
    await usdc.write.mint([who.account.address, U("10000")]);
    const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    await c.write.approve([stream.address, U("10000")]);
  }

  const as = (who: any) => hre.viem.getContractAt("TesseraStream", stream.address, { client: { wallet: who } });
  const usdcAs = (who: any) => hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });

  // 1 USDC/second for an hour.
  const RATE = U("1");
  const DEPOSIT = RATE * BigInt(HOUR);

  async function openOne() {
    await (await as(payer)).write.open([recipient.account.address, usdc.address, DEPOSIT, RATE]);
    return 1n;
  }

  return { payer, recipient, stranger, usdc, stream, as, usdcAs, RATE, DEPOSIT, openOne };
}

describe("TesseraStream (paying by the second)", () => {
  it("implies the end date from deposit and rate", async () => {
    const { stream, RATE, DEPOSIT, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    const d = await stream.read.streamData([id]);
    // startAt = d[7], stopAt = d[8]
    expect(d[8] - d[7]).to.equal(BigInt(HOUR));
    expect(d[3]).to.equal(DEPOSIT);
    expect(RATE * BigInt(HOUR)).to.equal(DEPOSIT);
  });

  it("accrues to the recipient second by second", async () => {
    const { stream, RATE, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    expect(await stream.read.earned([id])).to.equal(0n);

    await time.increase(600); // ten minutes
    expect(await stream.read.earned([id])).to.equal(RATE * 600n);

    await time.increase(600);
    expect(await stream.read.earned([id])).to.equal(RATE * 1200n);
  });

  it("lets the recipient withdraw without the payer doing anything", async () => {
    const { recipient, usdc, stream, as, RATE, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    await time.increase(1800);

    const before = await usdc.read.balanceOf([recipient.account.address]);
    await (await as(recipient)).write.withdraw([id]);
    const after = await usdc.read.balanceOf([recipient.account.address]);

    // The withdraw transaction itself advances the clock by a second.
    near(after - before, RATE * 1800n, RATE * 2n);
    // Nothing left to take immediately after.
    expect(await stream.read.withdrawable([id])).to.equal(0n);
  });

  it("only pays the recipient", async () => {
    const { as, stranger, payer, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    await time.increase(600);
    await expect((await as(stranger)).write.withdraw([id])).to.be.rejected;
    await expect((await as(payer)).write.withdraw([id])).to.be.rejected;
  });

  it("splits the deposit at the moment of cancellation", async () => {
    const { payer, recipient, usdc, stream, as, DEPOSIT, RATE, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    await time.increase(1200); // twenty minutes of an hour

    const payerBefore = await usdc.read.balanceOf([payer.account.address]);
    const recipientBefore = await usdc.read.balanceOf([recipient.account.address]);
    await (await as(payer)).write.cancel([id]);
    const payerGot = (await usdc.read.balanceOf([payer.account.address])) - payerBefore;
    const recipientGot = (await usdc.read.balanceOf([recipient.account.address])) - recipientBefore;

    near(recipientGot, RATE * 1200n, RATE * 2n);
    // Every last unit is accounted for — nothing is stranded in the contract.
    expect(payerGot + recipientGot).to.equal(DEPOSIT);
    expect(await usdc.read.balanceOf([stream.address])).to.equal(0n);
  });

  it("stops the clock at cancellation", async () => {
    const { payer, stream, as, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    await time.increase(600);
    await (await as(payer)).write.cancel([id]);
    const atCancel = await stream.read.earned([id]);

    await time.increase(3600);
    // Time kept passing; earnings did not.
    expect(await stream.read.earned([id])).to.equal(atCancel);
    expect(await stream.read.refundable([id])).to.equal(0n);
  });

  it("credits a mid-stream withdrawal against the cancellation payout", async () => {
    const { payer, recipient, usdc, stream, as, DEPOSIT, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    await time.increase(1200);
    await (await as(recipient)).write.withdraw([id]);
    await time.increase(1200);

    const payerBefore = await usdc.read.balanceOf([payer.account.address]);
    const recipientBefore = await usdc.read.balanceOf([recipient.account.address]);
    await (await as(payer)).write.cancel([id]);
    const total =
      (await usdc.read.balanceOf([payer.account.address])) - payerBefore +
      ((await usdc.read.balanceOf([recipient.account.address])) - recipientBefore);

    // The already-withdrawn 20 minutes is not paid a second time.
    expect(total < DEPOSIT, `${total} should be under ${DEPOSIT}`).to.equal(true);
    expect(await usdc.read.balanceOf([stream.address])).to.equal(0n);
  });

  it("never pays out more than was deposited, however long it runs", async () => {
    const { stream, DEPOSIT, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    await time.increase(HOUR * 10); // ten times the funded window
    expect(await stream.read.earned([id])).to.equal(DEPOSIT);
    expect(await stream.read.withdrawable([id])).to.equal(DEPOSIT);
  });

  it("lets the recipient collect after the stream has run dry", async () => {
    const { recipient, usdc, stream, as, DEPOSIT, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    await time.increase(HOUR * 2);
    const before = await usdc.read.balanceOf([recipient.account.address]);
    await (await as(recipient)).write.withdraw([id]);
    expect((await usdc.read.balanceOf([recipient.account.address])) - before).to.equal(DEPOSIT);
    expect(await usdc.read.balanceOf([stream.address])).to.equal(0n);
  });

  it("extends the end when topped up, keeping the rate", async () => {
    const { payer, stream, as, RATE, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    const before = (await stream.read.streamData([id]))[8];
    await time.increase(600);
    await (await as(payer)).write.topUp([id, RATE * 600n]);
    const after = (await stream.read.streamData([id]))[8];
    expect(after - before).to.equal(600n);
  });

  it("lets a stranger top up somebody else's stream", async () => {
    const { stranger, stream, as, RATE, DEPOSIT, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    await (await as(stranger)).write.topUp([id, RATE * 300n]);
    expect((await stream.read.streamData([id]))[3]).to.equal(DEPOSIT + RATE * 300n);
  });

  it("refuses a second cancellation", async () => {
    const { payer, as, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    await time.increase(600);
    await (await as(payer)).write.cancel([id]);
    await expect((await as(payer)).write.cancel([id])).to.be.rejected;
  });

  it("only lets the payer cancel", async () => {
    const { recipient, stranger, as, openOne } = await loadFixture(deployFixture);
    const id = await openOne();
    await time.increase(600);
    await expect((await as(recipient)).write.cancel([id])).to.be.rejected;
    await expect((await as(stranger)).write.cancel([id])).to.be.rejected;
  });

  it("rejects streams that would be over before they start", async () => {
    const { payer, recipient, usdc, as, RATE } = await loadFixture(deployFixture);
    // Less than one second of rate.
    await expect(
      (await as(payer)).write.open([recipient.account.address, usdc.address, RATE - 1n, RATE]),
    ).to.be.rejected;
  });

  it("rejects a stream to yourself, and a zero rate", async () => {
    const { payer, recipient, usdc, as, DEPOSIT } = await loadFixture(deployFixture);
    await expect(
      (await as(payer)).write.open([payer.account.address, usdc.address, DEPOSIT, U("1")]),
    ).to.be.rejected;
    await expect(
      (await as(payer)).write.open([recipient.account.address, usdc.address, DEPOSIT, 0n]),
    ).to.be.rejected;
  });

  it("keeps two streams independent", async () => {
    const { payer, recipient, stranger, usdc, stream, as, RATE } = await loadFixture(deployFixture);
    await (await as(payer)).write.open([recipient.account.address, usdc.address, RATE * 100n, RATE]);
    await (await as(stranger)).write.open([recipient.account.address, usdc.address, RATE * 1000n, RATE]);
    await time.increase(200);
    // The first ran dry at 100s; the second is still going.
    expect(await stream.read.earned([1n])).to.equal(RATE * 100n);
    expect((await stream.read.earned([2n])) > RATE * 190n).to.equal(true);
  });

  it("reverts on an unknown stream rather than reporting a phantom one", async () => {
    const { recipient, stream, as } = await loadFixture(deployFixture);
    expect(await stream.read.earned([99n])).to.equal(0n);
    await expect((await as(recipient)).write.withdraw([99n])).to.be.rejected;
  });
});
