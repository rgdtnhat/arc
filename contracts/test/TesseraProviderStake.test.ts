import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const T = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const WEEK = 7 * 24 * 3600;

/**
 * A stake that can leave the moment it would cost something is a display, not
 * a bond. Almost every test here is about the exit: that queuing is visible
 * immediately, that the queued portion is still at risk, and that a provider
 * who sees a dispute coming cannot move their stake out of reach.
 */
async function deployFixture() {
  const [owner, provider, backer, arbiter, treasury] = await hre.viem.getWalletClients();
  const token = await hre.viem.deployContract("MockToken", ["Tessera", "TSRA", 18]);
  const stake = await hre.viem.deployContract("TesseraProviderStake", [
    token.address, owner.account.address, treasury.account.address, BigInt(WEEK),
  ]);
  await stake.write.setArbiter([arbiter.account.address]);

  for (const who of [provider, backer]) {
    await token.write.mint([who.account.address, T(10_000)]);
    const t = await hre.viem.getContractAt("MockToken", token.address, { client: { wallet: who } });
    await t.write.approve([stake.address, T(10_000)]);
  }
  const as = async (w: any) => hre.viem.getContractAt("TesseraProviderStake", stake.address, { client: { wallet: w } });
  return { owner, provider, backer, arbiter, treasury, token, stake, as };
}

describe("TesseraProviderStake (a bond that cannot walk away)", () => {
  it("records a bond and reports it as the provider's standing", async () => {
    const f = await loadFixture(deployFixture);
    const p = await f.as(f.provider);
    await p.write.bond([f.provider.account.address, T(500)]);
    expect(await f.stake.read.stakeOf([f.provider.account.address])).to.equal(T(500));
    expect(await f.stake.read.totalBonded()).to.equal(T(500));
  });

  it("lets somebody else stand behind a provider", async () => {
    // A backer is a real arrangement; refusing it only pushes it off chain
    // where a buyer cannot see it.
    const f = await loadFixture(deployFixture);
    const b = await f.as(f.backer);
    await b.write.bond([f.provider.account.address, T(300)]);
    expect(await f.stake.read.stakeOf([f.provider.account.address])).to.equal(T(300));
  });

  it("drops the visible stake the moment an exit is queued", async () => {
    /*
     * A buyer reads `stakeOf` to decide whether to deal. If queuing did not
     * reduce it, a provider on their way out would look exactly like one who
     * is committed, right up until the money left.
     */
    const f = await loadFixture(deployFixture);
    const p = await f.as(f.provider);
    await p.write.bond([f.provider.account.address, T(500)]);
    await p.write.queueUnbond([T(200)]);
    expect(await f.stake.read.stakeOf([f.provider.account.address])).to.equal(T(300));
    // But it is still at risk, which is the other half.
    expect(await f.stake.read.atRiskOf([f.provider.account.address])).to.equal(T(500));
  });

  it("will not release before the delay is up", async () => {
    const f = await loadFixture(deployFixture);
    const p = await f.as(f.provider);
    await p.write.bond([f.provider.account.address, T(500)]);
    await p.write.queueUnbond([T(500)]);
    await expect(p.write.withdraw()).to.be.rejected;

    await time.increase(WEEK + 1);
    await p.write.withdraw();
    expect(await f.stake.read.atRiskOf([f.provider.account.address])).to.equal(0n);
  });

  it("slashes the queued portion first, so the exit is not a shield", async () => {
    /*
     * The attack the delay exists to stop: see a dispute coming, queue an
     * exit, and let the arbiter find nothing left to take.
     */
    const f = await loadFixture(deployFixture);
    const p = await f.as(f.provider);
    await p.write.bond([f.provider.account.address, T(1000)]);
    await p.write.queueUnbond([T(1000)]); // everything on its way out

    const a = await f.as(f.arbiter);
    await a.write.slash([f.provider.account.address, 5000, "delivered junk twice"]);

    expect(await f.stake.read.atRiskOf([f.provider.account.address])).to.equal(T(500));
    expect(await f.token.read.balanceOf([f.treasury.account.address])).to.equal(T(500));
  });

  it("restarts the clock when more is queued", async () => {
    // Otherwise a provider queues a token on day one and years later tops it
    // up to withdraw everything instantly.
    const f = await loadFixture(deployFixture);
    const p = await f.as(f.provider);
    await p.write.bond([f.provider.account.address, T(1000)]);
    await p.write.queueUnbond([T(1)]);
    await time.increase(WEEK - 60);
    await p.write.queueUnbond([T(999)]);
    await expect(p.write.withdraw()).to.be.rejected;
  });

  it("sends a slash to the treasury, never to whoever called it", async () => {
    const f = await loadFixture(deployFixture);
    const p = await f.as(f.provider);
    await p.write.bond([f.provider.account.address, T(1000)]);
    const before = await f.token.read.balanceOf([f.arbiter.account.address]);

    const a = await f.as(f.arbiter);
    await a.write.slash([f.provider.account.address, 1000, "late"]);
    expect(await f.token.read.balanceOf([f.arbiter.account.address])).to.equal(before);
    expect(await f.token.read.balanceOf([f.treasury.account.address])).to.equal(T(100));
  });

  it("bounds a single slash, so a compromised arbiter cannot empty anybody at once", async () => {
    const f = await loadFixture(deployFixture);
    const p = await f.as(f.provider);
    await p.write.bond([f.provider.account.address, T(1000)]);
    const a = await f.as(f.arbiter);
    await expect(a.write.slash([f.provider.account.address, 9000, "everything"])).to.be.rejected;
    await a.write.slash([f.provider.account.address, 5000, "the cap itself is allowed"]);
  });

  it("only the arbiter or the owner may slash", async () => {
    const f = await loadFixture(deployFixture);
    const p = await f.as(f.provider);
    await p.write.bond([f.provider.account.address, T(1000)]);
    const b = await f.as(f.backer);
    await expect(b.write.slash([f.provider.account.address, 100, "mine now"])).to.be.rejected;
  });

  it("refuses to unbond more than is bonded", async () => {
    const f = await loadFixture(deployFixture);
    const p = await f.as(f.provider);
    await p.write.bond([f.provider.account.address, T(100)]);
    await expect(p.write.queueUnbond([T(200)])).to.be.rejected;
  });

  it("lists every provider that has ever bonded, once", async () => {
    const f = await loadFixture(deployFixture);
    const p = await f.as(f.provider);
    const b = await f.as(f.backer);
    await p.write.bond([f.provider.account.address, T(10)]);
    await b.write.bond([f.provider.account.address, T(10)]);
    await b.write.bond([f.backer.account.address, T(10)]);
    expect(await f.stake.read.providerCount()).to.equal(2n);
  });

  it("only the owner appoints the arbiter or moves the treasury", async () => {
    const f = await loadFixture(deployFixture);
    const b = await f.as(f.backer);
    await expect(b.write.setArbiter([f.backer.account.address])).to.be.rejected;
    await expect(b.write.setTreasury([f.backer.account.address])).to.be.rejected;
  });
});
