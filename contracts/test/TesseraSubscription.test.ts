import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { toHex } from "viem";

const U = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));
const HOUR = 3600;
const MEMO = toHex("weather:current", { size: 32 });

/**
 * A plan hands the provider the ability to take money without the buyer
 * agreeing to any particular charge. Everything here is about the two things
 * that make that safe: the cap bounds a period, and cancellation is immediate.
 */
async function deployFixture() {
  const [buyer, provider, stranger] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const sub = await hre.viem.deployContract("TesseraSubscription");

  for (const who of [buyer, stranger]) {
    await usdc.write.mint([who.account.address, U("10000")]);
    const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    await c.write.approve([sub.address, U("10000")]);
  }

  const as = (who: any) => hre.viem.getContractAt("TesseraSubscription", sub.address, { client: { wallet: who } });

  // 500 prepaid, at most 100 per hour.
  async function openPlan(deposit = U("500"), cap = U("100"), period = HOUR) {
    await (await as(buyer)).write.subscribe([provider.account.address, usdc.address, deposit, cap, BigInt(period)]);
    return 1n;
  }

  return { buyer, provider, stranger, usdc, sub, as, openPlan };
}

describe("TesseraSubscription (prepaid credit, drawn per call)", () => {
  it("lets the provider charge without the buyer signing anything", async () => {
    const { provider, usdc, sub, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();

    const before = await usdc.read.balanceOf([provider.account.address]);
    await (await as(provider)).write.charge([id, U("10"), MEMO]);
    expect((await usdc.read.balanceOf([provider.account.address])) - before).to.equal(U("10"));

    const d = await sub.read.planData([id]);
    expect(d[3]).to.equal(U("490")); // balance
    expect(d[4]).to.equal(U("10")); // spent
  });

  it("stops the provider at the period cap", async () => {
    const { provider, sub, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();

    await (await as(provider)).write.charge([id, U("100"), MEMO]);
    expect(await sub.read.remainingThisPeriod([id])).to.equal(0n);
    await expect((await as(provider)).write.charge([id, 1n, MEMO])).to.be.rejected;
  });

  it("bounds the buyer's exposure to one period's cap, not the balance", async () => {
    const { provider, usdc, as, openPlan } = await loadFixture(deployFixture);
    // 5000 prepaid but only 100 per hour reachable.
    const id = await openPlan(U("5000"), U("100"), HOUR);
    const before = await usdc.read.balanceOf([provider.account.address]);
    await (await as(provider)).write.charge([id, U("100"), MEMO]);
    await expect((await as(provider)).write.charge([id, U("1"), MEMO])).to.be.rejected;
    expect((await usdc.read.balanceOf([provider.account.address])) - before).to.equal(U("100"));
  });

  it("resets the allowance in a new period without anyone touching the plan", async () => {
    const { provider, sub, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    await (await as(provider)).write.charge([id, U("100"), MEMO]);
    expect(await sub.read.remainingThisPeriod([id])).to.equal(0n);

    await time.increase(HOUR * 2);
    // The view reflects the reset before any transaction rolls it forward.
    expect(await sub.read.remainingThisPeriod([id])).to.equal(U("100"));
    await (await as(provider)).write.charge([id, U("100"), MEMO]);
  });

  it("refunds everything unspent the moment the buyer cancels", async () => {
    const { buyer, provider, usdc, sub, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    await (await as(provider)).write.charge([id, U("40"), MEMO]);

    const before = await usdc.read.balanceOf([buyer.account.address]);
    await (await as(buyer)).write.cancel([id]);
    expect((await usdc.read.balanceOf([buyer.account.address])) - before).to.equal(U("460"));
    // Nothing is left stranded in the contract.
    expect(await usdc.read.balanceOf([sub.address])).to.equal(0n);
  });

  it("gives the provider no window to drain after a cancellation", async () => {
    const { buyer, provider, sub, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    await (await as(buyer)).write.cancel([id]);
    await expect((await as(provider)).write.charge([id, U("1"), MEMO])).to.be.rejected;
    expect(await sub.read.chargeableNow([id])).to.equal(0n);
  });

  it("only the named provider can charge", async () => {
    const { buyer, stranger, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    await expect((await as(stranger)).write.charge([id, U("1"), MEMO])).to.be.rejected;
    await expect((await as(buyer)).write.charge([id, U("1"), MEMO])).to.be.rejected;
  });

  it("only the buyer can cancel", async () => {
    const { provider, stranger, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    await expect((await as(provider)).write.cancel([id])).to.be.rejected;
    await expect((await as(stranger)).write.cancel([id])).to.be.rejected;
  });

  it("never lets a charge exceed the remaining balance", async () => {
    const { provider, sub, as, openPlan } = await loadFixture(deployFixture);
    // Cap above the balance: the balance is what binds.
    const id = await openPlan(U("30"), U("100"), HOUR);
    expect(await sub.read.chargeableNow([id])).to.equal(U("30"));
    await expect((await as(provider)).write.charge([id, U("31"), MEMO])).to.be.rejected;
    await (await as(provider)).write.charge([id, U("30"), MEMO]);
    expect(await sub.read.chargeableNow([id])).to.equal(0n);
  });

  it("reports chargeable as the smaller of cap and balance", async () => {
    const { buyer, provider, usdc, sub, as, openPlan } = await loadFixture(deployFixture);
    // Balance well above the cap: the cap binds.
    const capBound = await openPlan(U("500"), U("100"), HOUR);
    expect(await sub.read.chargeableNow([capBound])).to.equal(U("100"));

    // Cap well above the balance: the balance binds.
    await (await as(buyer)).write.subscribe([
      provider.account.address, usdc.address, U("30"), U("100"), BigInt(HOUR),
    ]);
    expect(await sub.read.chargeableNow([2n])).to.equal(U("30"));

    // And it tracks a partial draw within the period.
    await (await as(provider)).write.charge([capBound, U("60"), MEMO]);
    expect(await sub.read.chargeableNow([capBound])).to.equal(U("40"));
  });

  it("tops up without widening what the provider can take in a period", async () => {
    const { stranger, sub, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    await (await as(stranger)).write.topUp([id, U("1000")]);
    const d = await sub.read.planData([id]);
    expect(d[3]).to.equal(U("1500")); // balance grew
    expect(d[5]).to.equal(U("100")); // cap did not
    expect(await sub.read.chargeableNow([id])).to.equal(U("100"));
  });

  it("lets the buyer lower the cap but never raise it", async () => {
    const { buyer, provider, sub, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    await (await as(buyer)).write.lowerCap([id, U("25")]);
    expect((await sub.read.planData([id]))[5]).to.equal(U("25"));
    await expect((await as(buyer)).write.lowerCap([id, U("200")])).to.be.rejected;
    await expect((await as(buyer)).write.lowerCap([id, U("25")])).to.be.rejected;
    // The lower cap binds immediately.
    await expect((await as(provider)).write.charge([id, U("26"), MEMO])).to.be.rejected;
    await (await as(provider)).write.charge([id, U("25"), MEMO]);
  });

  it("only the buyer may lower the cap", async () => {
    const { provider, stranger, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    await expect((await as(provider)).write.lowerCap([id, U("10")])).to.be.rejected;
    await expect((await as(stranger)).write.lowerCap([id, U("10")])).to.be.rejected;
  });

  it("accumulates several charges inside one period against the same cap", async () => {
    const { provider, sub, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    for (let i = 0; i < 4; i++) await (await as(provider)).write.charge([id, U("20"), MEMO]);
    expect(await sub.read.remainingThisPeriod([id])).to.equal(U("20"));
    await expect((await as(provider)).write.charge([id, U("21"), MEMO])).to.be.rejected;
  });

  it("refuses a second cancellation, and top-ups after cancelling", async () => {
    const { buyer, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    await (await as(buyer)).write.cancel([id]);
    await expect((await as(buyer)).write.cancel([id])).to.be.rejected;
    await expect((await as(buyer)).write.topUp([id, U("10")])).to.be.rejected;
  });

  it("rejects a plan with yourself, a zero cap, or a zero period", async () => {
    const { buyer, provider, usdc, as } = await loadFixture(deployFixture);
    await expect(
      (await as(buyer)).write.subscribe([buyer.account.address, usdc.address, U("10"), U("1"), 3600n]),
    ).to.be.rejected;
    await expect(
      (await as(buyer)).write.subscribe([provider.account.address, usdc.address, U("10"), 0n, 3600n]),
    ).to.be.rejected;
    await expect(
      (await as(buyer)).write.subscribe([provider.account.address, usdc.address, U("10"), U("1"), 0n]),
    ).to.be.rejected;
  });

  it("keeps two plans independent", async () => {
    const { buyer, provider, stranger, usdc, sub, as, openPlan } = await loadFixture(deployFixture);
    await openPlan();
    await (await as(stranger)).write.subscribe([
      provider.account.address, usdc.address, U("200"), U("50"), BigInt(HOUR),
    ]);
    await (await as(provider)).write.charge([1n, U("100"), MEMO]);
    // Draining plan 1's period does nothing to plan 2.
    expect(await sub.read.remainingThisPeriod([1n])).to.equal(0n);
    expect(await sub.read.remainingThisPeriod([2n])).to.equal(U("50"));
    // And cancelling plan 1 refunds only plan 1.
    await (await as(buyer)).write.cancel([1n]);
    expect((await sub.read.planData([2n]))[3]).to.equal(U("200"));
  });

  it("reports zero for an unknown plan rather than a phantom one", async () => {
    const { provider, sub, as } = await loadFixture(deployFixture);
    expect(await sub.read.chargeableNow([99n])).to.equal(0n);
    expect(await sub.read.remainingThisPeriod([99n])).to.equal(0n);
    await expect((await as(provider)).write.charge([99n, U("1"), MEMO])).to.be.rejected;
  });

  it("counts down the seconds to the next reset", async () => {
    const { sub, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    const first = await sub.read.secondsUntilReset([id]);
    expect(first > 0n && first <= BigInt(HOUR)).to.equal(true);
    await time.increase(Number(first) + 1);
    const second = await sub.read.secondsUntilReset([id]);
    expect(second > 0n && second <= BigInt(HOUR)).to.equal(true);
  });
});

/** Same reason as the stream index: a plan the app cannot enumerate is a plan
 *  the app cannot show. */
describe("TesseraSubscription (finding your own plans)", () => {
  it("indexes a new plan against both sides", async () => {
    const { buyer, provider, sub, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    expect(await sub.read.plansAsBuyer([buyer.account.address])).to.deep.equal([id]);
    expect(await sub.read.plansAsProvider([provider.account.address])).to.deep.equal([id]);
  });

  it("lists a provider's plans across different buyers", async () => {
    const { buyer, provider, stranger, usdc, sub, as, openPlan } = await loadFixture(deployFixture);
    await openPlan();
    await (await as(stranger)).write.subscribe([
      provider.account.address, usdc.address, U("200"), U("50"), 3600n,
    ]);
    expect(await sub.read.plansAsProvider([provider.account.address])).to.deep.equal([1n, 2n]);
    expect(await sub.read.plansAsBuyer([buyer.account.address])).to.deep.equal([1n]);
    expect(await sub.read.plansAsBuyer([stranger.account.address])).to.deep.equal([2n]);
  });

  it("keeps a cancelled plan listed", async () => {
    const { buyer, sub, as, openPlan } = await loadFixture(deployFixture);
    const id = await openPlan();
    await (await as(buyer)).write.cancel([id]);
    expect(await sub.read.plansAsBuyer([buyer.account.address])).to.deep.equal([id]);
    expect((await sub.read.planData([id]))[9]).to.equal(true);
  });

  it("returns nothing for an address with no plans", async () => {
    const { stranger, sub } = await loadFixture(deployFixture);
    expect(await sub.read.plansAsProvider([stranger.account.address])).to.deep.equal([]);
    const [a, b] = await sub.read.planCounts([stranger.account.address]);
    expect(a).to.equal(0n);
    expect(b).to.equal(0n);
  });
});
