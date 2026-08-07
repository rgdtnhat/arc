import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const USD = (n: number) => BigInt(Math.round(n * 1e6));
const T = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
/**
 * One TSRA is worth ten cents, so a dollar buys ten of them.
 *
 * `tsraPerUsdc` is TSRA base units per USDC base unit at 1e18 scale, which for
 * an 18-decimal token against a 6-decimal one works out as
 * `tokensPerDollar * 1e30`. Writing the derivation down rather than the number
 * is the difference between a constant somebody can check and one they have to
 * trust — the first version of this was out by a factor of a hundred.
 */
const TOKENS_PER_DOLLAR = 10n;
const RATE = TOKENS_PER_DOLLAR * 10n ** 30n;

async function deployFixture() {
  const [owner, agent, alice, bob, treasury] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockToken", ["USD Coin", "USDC", 6]);
  const tsra = await hre.viem.deployContract("MockToken", ["Tessera", "TSRA", 18]);
  const fees = await hre.viem.deployContract("TesseraServiceFees", [
    usdc.address, tsra.address, owner.account.address, treasury.account.address,
  ]);
  await fees.write.setSpender([agent.account.address, true]);
  await fees.write.setRate([RATE, 2000]); // 20% off for paying in TSRA

  for (const who of [alice, bob]) {
    await usdc.write.mint([who.account.address, USD(1000)]);
    await tsra.write.mint([who.account.address, T(100_000)]);
    const u = await hre.viem.getContractAt("MockToken", usdc.address, { client: { wallet: who } });
    const t = await hre.viem.getContractAt("MockToken", tsra.address, { client: { wallet: who } });
    await u.write.approve([fees.address, USD(1000)]);
    await t.write.approve([fees.address, T(100_000)]);
  }
  const as = async (w: any) => hre.viem.getContractAt("TesseraServiceFees", fees.address, { client: { wallet: w } });
  return { owner, agent, alice, bob, treasury, usdc, tsra, fees, as };
}

describe("TesseraServiceFees (pay the agent in either asset)", () => {
  it("sells credit for USDC at par", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.topUpUsdc([USD(10)]);
    expect(await f.fees.read.creditOf([f.alice.account.address])).to.equal(USD(10));
    expect(await f.fees.read.heldUsdc([f.alice.account.address])).to.equal(USD(10));
  });

  it("sells the same credit for less when it is paid for in TSRA", async () => {
    /*
     * The discount is the whole point of the token route: a protocol that wants
     * its token used has to make using it worth something.
     */
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    const cost = await f.fees.read.quoteTsra([USD(10)]);
    // 10 USDC at 0.1 USDC/TSRA is 100 TSRA; less 20% is 80.
    expect(cost).to.equal(T(80));

    await a.write.topUpTsra([USD(10)]);
    expect(await f.fees.read.creditOf([f.alice.account.address])).to.equal(USD(10));
    expect(await f.fees.read.heldTsra([f.alice.account.address])).to.equal(T(80));
  });

  it("does not re-price credit somebody has already bought", async () => {
    /*
     * The rate is a parameter, not a price, which makes "the owner cannot
     * shrink your balance by moving it" the property that has to hold.
     */
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.topUpTsra([USD(10)]);
    await f.fees.write.setRate([RATE * 100n, 0]); // TSRA collapses
    expect(await f.fees.read.creditOf([f.alice.account.address])).to.equal(USD(10));
    expect(await f.fees.read.heldTsra([f.alice.account.address])).to.equal(T(80));
  });

  it("lets the agent draw credit down, and sends the assets to the treasury", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.topUpUsdc([USD(10)]);
    const ag = await f.as(f.agent);
    await ag.write.spend([f.alice.account.address, USD(3), "market data, 400 calls"]);

    expect(await f.fees.read.creditOf([f.alice.account.address])).to.equal(USD(7));
    expect(await f.usdc.read.balanceOf([f.treasury.account.address])).to.equal(USD(3));
    // Not to the agent: an agent that could pay itself is a withdrawal function.
    expect(await f.usdc.read.balanceOf([f.agent.account.address])).to.equal(0n);
  });

  it("consumes a mixed balance in the proportion it was funded", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.topUpUsdc([USD(10)]);
    await a.write.topUpTsra([USD(10)]); // 80 TSRA for the same credit
    expect(await f.fees.read.creditOf([f.alice.account.address])).to.equal(USD(20));

    const ag = await f.as(f.agent);
    await ag.write.spend([f.alice.account.address, USD(10), "half of it"]);
    // Half the credit gone means half of each holding gone.
    expect(await f.fees.read.heldUsdc([f.alice.account.address])).to.equal(USD(5));
    expect(await f.fees.read.heldTsra([f.alice.account.address])).to.equal(T(40));
  });

  it("returns exactly what is left, in the assets it was paid in", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.topUpUsdc([USD(10)]);
    await a.write.topUpTsra([USD(10)]);
    const ag = await f.as(f.agent);
    await ag.write.spend([f.alice.account.address, USD(10), "spent"]);

    const usdcBefore = await f.usdc.read.balanceOf([f.alice.account.address]);
    const tsraBefore = await f.tsra.read.balanceOf([f.alice.account.address]);
    await a.write.withdraw();
    expect(await f.usdc.read.balanceOf([f.alice.account.address])).to.equal(usdcBefore + USD(5));
    expect(await f.tsra.read.balanceOf([f.alice.account.address])).to.equal(tsraBefore + T(40));
    expect(await f.fees.read.creditOf([f.alice.account.address])).to.equal(0n);
  });

  it("leaves nothing stranded when the last of a balance is spent", async () => {
    // Proportional maths on the final spend would leave a rounding crumb that
    // no withdrawal could ever reach.
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.topUpUsdc([USD(3)]);
    await a.write.topUpTsra([USD(7)]);
    const ag = await f.as(f.agent);
    await ag.write.spend([f.alice.account.address, USD(10), "everything"]);
    expect(await f.fees.read.heldUsdc([f.alice.account.address])).to.equal(0n);
    expect(await f.fees.read.heldTsra([f.alice.account.address])).to.equal(0n);
    expect(await f.usdc.read.balanceOf([f.fees.address])).to.equal(0n);
    expect(await f.tsra.read.balanceOf([f.fees.address])).to.equal(0n);
  });

  it("will not let the agent spend more than somebody has", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.topUpUsdc([USD(5)]);
    const ag = await f.as(f.agent);
    await expect(ag.write.spend([f.alice.account.address, USD(6), "too much"])).to.be.rejected;
  });

  it("will not let one account spend another's credit", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.topUpUsdc([USD(5)]);
    const b = await f.as(f.bob);
    await expect(b.write.spend([f.alice.account.address, USD(1), "not yours"])).to.be.rejected;
  });

  it("keeps one user's balance out of another's withdrawal", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    const b = await f.as(f.bob);
    await a.write.topUpUsdc([USD(10)]);
    await b.write.topUpUsdc([USD(1)]);
    const before = await f.usdc.read.balanceOf([f.bob.account.address]);
    await b.write.withdraw();
    expect(await f.usdc.read.balanceOf([f.bob.account.address])).to.equal(before + USD(1));
    expect(await f.fees.read.creditOf([f.alice.account.address])).to.equal(USD(10));
  });

  it("caps the discount, so credit cannot be bought for nothing", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.fees.write.setRate([RATE, 9000])).to.be.rejected;
    await f.fees.write.setRate([RATE, 5000]); // the cap itself is allowed
  });

  it("refuses a TSRA top-up before a rate exists", async () => {
    // Otherwise the quote is zero and the buyer pays nothing for real credit.
    const [owner, , alice, , treasury] = await hre.viem.getWalletClients();
    const usdc = await hre.viem.deployContract("MockToken", ["USD Coin", "USDC", 6]);
    const tsra = await hre.viem.deployContract("MockToken", ["Tessera", "TSRA", 18]);
    const fees = await hre.viem.deployContract("TesseraServiceFees", [
      usdc.address, tsra.address, owner.account.address, treasury.account.address,
    ]);
    const a = await hre.viem.getContractAt("TesseraServiceFees", fees.address, { client: { wallet: alice } });
    await expect(a.write.topUpTsra([USD(1)])).to.be.rejected;
  });

  it("only the owner appoints a spender or moves the treasury", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await expect(a.write.setSpender([f.alice.account.address, true])).to.be.rejected;
    await expect(a.write.setTreasury([f.alice.account.address])).to.be.rejected;
    await expect(a.write.setRate([RATE, 0])).to.be.rejected;
  });

  it("refuses a withdrawal with nothing to withdraw", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await expect(a.write.withdraw()).to.be.rejected;
  });

  it("reports an account in one call", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await a.write.topUpUsdc([USD(4)]);
    await a.write.topUpTsra([USD(6)]);
    const [credit, usdcHeld, tsraHeld] = await f.fees.read.accountOf([f.alice.account.address]);
    expect(credit).to.equal(USD(10));
    expect(usdcHeld).to.equal(USD(4));
    expect(tsraHeld).to.equal(T(48)); // 60 TSRA less the 20% discount
  });
});
