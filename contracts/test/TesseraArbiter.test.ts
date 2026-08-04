import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const H = (s: string) => `0x${Buffer.from(s.padEnd(32, "\0")).toString("hex")}` as `0x${string}`;
const HOUR = 3600;
const ZERO = "0x0000000000000000000000000000000000000000";

const Status = { Escrowed: 1, Fulfilled: 2, Settled: 3, Refunded: 4, Disputed: 5 } as const;

/**
 * Arbitration exists because `fulfill` proves a provider answered, never that it
 * answered correctly — any bytes hash to something. These cases are the three
 * outcomes that matter: the complaint is upheld, the complaint is rejected, and
 * nobody turns up to rule.
 */
async function deployFixture() {
  const [deployer, buyer, provider, judge, judge2] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);
  const arbiter = await hre.viem.deployContract("TesseraArbiter", [usdc.address, escrow.address, USDC(100)]);
  await escrow.write.setArbiter([arbiter.address]);

  for (const w of [buyer, provider, judge, judge2]) {
    await usdc.write.mint([w.account.address, USDC(10_000)]);
  }

  const escrowAs = async (w: any) =>
    hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: w } });
  const arbiterAs = async (w: any) =>
    hre.viem.getContractAt("TesseraArbiter", arbiter.address, { client: { wallet: w } });
  const usdcAs = async (w: any) => hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: w } });

  // One registered arbitrator, so selection is deterministic in these tests.
  const uj = await usdcAs(judge);
  await uj.write.approve([arbiter.address, USDC(100)]);
  const aj = await arbiterAs(judge);
  await aj.write.register([USDC(100)]);

  return { deployer, buyer, provider, judge, judge2, usdc, escrow, arbiter, escrowAs, arbiterAs, usdcAs };
}

/** Open a payment, deliver it, and escalate — the state every case starts from. */
async function escalated(f: Awaited<ReturnType<typeof deployFixture>>, price = USDC(100)) {
  const bond = await f.escrow.read.bondFor([price]);
  const ub = await f.usdcAs(f.buyer);
  await ub.write.approve([f.escrow.address, price + bond]);
  const eb = await f.escrowAs(f.buyer);
  const deadline = BigInt((await time.latest()) + HOUR);
  await eb.write.open([f.provider.account.address, price, deadline, H("quote")]);
  const ep = await f.escrowAs(f.provider);
  await ep.write.fulfill([1n, H("response")]);
  await eb.write.escalate([1n]);
  return { id: 1n, price, bond };
}

describe("TesseraArbiter (a third party, because 'it hashed' is not 'it was right')", () => {
  it("freezes the payment on escalation — neither side can act alone", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await escalated(f);

    const [, , , , , , status] = await f.escrow.read.getPayment([id]);
    expect(status).to.equal(Status.Disputed);

    const eb = await f.escrowAs(f.buyer);
    await expect(eb.write.settle([id])).to.be.rejectedWith("BadState");
    await expect(eb.write.refund([id])).to.be.rejected;
    const ep = await f.escrowAs(f.provider);
    await expect(ep.write.providerClaim([id])).to.be.rejectedWith("ArbitrationPending");
  });

  it("upholds the complaint: buyer made whole, provider marked failed, bond returned", async () => {
    const f = await loadFixture(deployFixture);
    const { id, price, bond } = await escalated(f);
    const before = await f.usdc.read.balanceOf([f.buyer.account.address]);

    const aa = await f.arbiterAs(f.judge);
    await f.arbiter.write.openCase([id]);
    await aa.write.rule([id, true, H("reason")]);

    const fee = (bond * 2000n) / 10_000n;
    // Full price back, plus the bond less the judge's cut.
    expect((await f.usdc.read.balanceOf([f.buyer.account.address])) - before).to.equal(price + bond - fee);
    const [fulfilled, failed] = await f.escrow.read.reputation([f.provider.account.address]);
    expect(fulfilled).to.equal(0n);
    expect(failed).to.equal(1n);
  });

  it("rejects the complaint: provider paid, and the buyer forfeits the bond it staked", async () => {
    const f = await loadFixture(deployFixture);
    const { id, price, bond } = await escalated(f);
    const providerBefore = await f.usdc.read.balanceOf([f.provider.account.address]);
    const buyerBefore = await f.usdc.read.balanceOf([f.buyer.account.address]);

    const aa = await f.arbiterAs(f.judge);
    await f.arbiter.write.openCase([id]);
    await aa.write.rule([id, false, H("reason")]);

    expect((await f.usdc.read.balanceOf([f.provider.account.address])) - providerBefore).to.equal(price);
    // Took a provider to arbitration and was wrong: nothing comes back.
    expect(await f.usdc.read.balanceOf([f.buyer.account.address])).to.equal(buyerBefore);
    const [fulfilled] = await f.escrow.read.reputation([f.provider.account.address]);
    expect(fulfilled).to.equal(1n);
    void bond;
  });

  it("pays the arbitrator identically whichever way it rules", async () => {
    const f = await loadFixture(deployFixture);
    const { id, bond } = await escalated(f);
    const before = await f.usdc.read.balanceOf([f.judge.account.address]);

    const aa = await f.arbiterAs(f.judge);
    await f.arbiter.write.openCase([id]);
    await aa.write.rule([id, false, H("reason")]);

    // A judge paid only by the winner has a side to prefer.
    expect((await f.usdc.read.balanceOf([f.judge.account.address])) - before).to.equal((bond * 2000n) / 10_000n);
  });

  it("pays the provider anyway when nobody rules — a dispute is not a freeze", async () => {
    const f = await loadFixture(deployFixture);
    const { id, price } = await escalated(f);
    const before = await f.usdc.read.balanceOf([f.provider.account.address]);

    // The cheapest griefing attack available if this did not exist: escalate,
    // never rule, and the provider's money never moves.
    await time.increase(25 * HOUR);
    const ep = await f.escrowAs(f.provider);
    await ep.write.providerClaim([id]);

    expect((await f.usdc.read.balanceOf([f.provider.account.address])) - before).to.equal(price);
  });

  it("only the buyer may escalate, and only inside the dispute window", async () => {
    const f = await loadFixture(deployFixture);
    const price = USDC(100);
    const bond = await f.escrow.read.bondFor([price]);
    const ub = await f.usdcAs(f.buyer);
    await ub.write.approve([f.escrow.address, price + bond]);
    const eb = await f.escrowAs(f.buyer);
    await eb.write.open([f.provider.account.address, price, BigInt((await time.latest()) + HOUR), H("q")]);
    const ep = await f.escrowAs(f.provider);
    await ep.write.fulfill([1n, H("r")]);

    await expect(ep.write.escalate([1n])).to.be.rejectedWith("NotAgent");
    await time.increase(2 * HOUR);
    await expect(eb.write.escalate([1n])).to.be.rejectedWith("DisputeWindowClosed");
  });

  it("refuses to open a case for a payment nobody disputed", async () => {
    const f = await loadFixture(deployFixture);
    const price = USDC(100);
    const bond = await f.escrow.read.bondFor([price]);
    const ub = await f.usdcAs(f.buyer);
    await ub.write.approve([f.escrow.address, price + bond]);
    const eb = await f.escrowAs(f.buyer);
    await eb.write.open([f.provider.account.address, price, BigInt((await time.latest()) + HOUR), H("q")]);

    // The escrow is the authority on whether a dispute exists, so an outsider
    // cannot manufacture one by calling the arbiter directly.
    await expect(f.arbiter.write.openCase([1n])).to.be.rejectedWith("NotDisputed");
  });

  it("lets only the assigned arbitrator rule, and only inside its window", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await escalated(f);
    await f.arbiter.write.openCase([id]);

    const stranger = await f.arbiterAs(f.judge2);
    await expect(stranger.write.rule([id, true, H("r")])).to.be.rejectedWith("NotAssigned");

    await time.increase(9 * HOUR);
    const aa = await f.arbiterAs(f.judge);
    await expect(aa.write.rule([id, true, H("r")])).to.be.rejectedWith("WindowOpen");
  });

  it("reassigns a lapsed case and counts the miss", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await escalated(f);
    await f.arbiter.write.openCase([id]);
    await time.increase(9 * HOUR);

    await f.arbiter.write.reassign([id]);
    const [, , , missed] = await f.arbiter.read.arbitratorOf([f.judge.account.address]);
    expect(missed).to.equal(1n);
  });

  it("cannot escalate at all with no arbiter wired", async () => {
    const f = await loadFixture(deployFixture);
    await f.escrow.write.setArbiter([ZERO]);
    const price = USDC(100);
    const bond = await f.escrow.read.bondFor([price]);
    const ub = await f.usdcAs(f.buyer);
    await ub.write.approve([f.escrow.address, price + bond]);
    const eb = await f.escrowAs(f.buyer);
    await eb.write.open([f.provider.account.address, price, BigInt((await time.latest()) + HOUR), H("q")]);
    const ep = await f.escrowAs(f.provider);
    await ep.write.fulfill([1n, H("r")]);

    await expect(eb.write.escalate([1n])).to.be.rejectedWith("NoArbiter");
    // ...and the ordinary path still works, so clearing the arbiter is safe.
    await eb.write.settle([1n]);
  });

  it("only the escrow's own arbiter may resolve", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await escalated(f);
    // Anyone able to call this directly could decide any dispute they liked.
    await expect(
      f.escrow.write.resolveDispute([id, false, f.judge.account.address]),
    ).to.be.rejectedWith("NotArbiter");
  });

  it("cannot rule twice on the same case", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await escalated(f);
    await f.arbiter.write.openCase([id]);
    const aa = await f.arbiterAs(f.judge);
    await aa.write.rule([id, false, H("r")]);
    await expect(aa.write.rule([id, true, H("r")])).to.be.rejectedWith("AlreadyDecided");
  });

  it("draws from responseHash, which is fixed before anyone knows there is a case", async () => {
    const f = await loadFixture(deployFixture);
    // With one arbitrator the draw is trivially that arbitrator; what matters is
    // that it is a pure function of values fixed at delivery, so neither party
    // can steer it after the fact.
    const a = await f.arbiter.read.selectorFor([1n, H("response")]);
    const b = await f.arbiter.read.selectorFor([1n, H("response")]);
    expect(a).to.equal(b);
    expect(a.toLowerCase()).to.equal(f.judge.account.address.toLowerCase());
  });

  it("drops an arbitrator below the floor out of the panel when slashed", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.arbiter.read.panelSize()).to.equal(1n);
    await f.arbiter.write.slash([f.judge.account.address, USDC(60), f.deployer.account.address]);
    expect(await f.arbiter.read.panelSize()).to.equal(0n);
  });
});
