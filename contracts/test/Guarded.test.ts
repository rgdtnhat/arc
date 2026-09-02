import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex, getAddress } from "viem";

const U = (n: number) => BigInt(Math.round(n * 1e6));
const H = (s: string) => keccak256(toHex(s));

/**
 * The stop switch, and the property that makes it safe to have.
 *
 * A pause that could trap funds would turn every false alarm into the incident
 * it was meant to prevent, and make the guardian key as dangerous as the bug it
 * defends against. So each case here checks both halves: the entry is closed,
 * and the exit is still open.
 */
async function deployFixture() {
  const [deployer, agent, provider, stranger] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");

  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);
  const tab = await hre.viem.deployContract("TesseraTab", [usdc.address]);
  const stream = await hre.viem.deployContract("TesseraStream");
  const sub = await hre.viem.deployContract("TesseraSubscription");

  for (const who of [agent, provider, stranger]) {
    await usdc.write.mint([who.account.address, U(1_000_000)]);
    const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    for (const target of [escrow, tab, stream, sub]) {
      await c.write.approve([target.address, U(1_000_000)]);
    }
  }

  const at = (name: string, addr: string, who: any) =>
    hre.viem.getContractAt(name as any, addr as any, { client: { wallet: who } });
  const soon = async () => BigInt(await time.latest()) + 3600n;

  return { deployer, agent, provider, stranger, usdc, escrow, tab, stream, sub, at, soon };
}

describe("Guarded — the stop switch", () => {
  it("makes the deployer guardian, and only the guardian may pause", async () => {
    const { deployer, stranger, escrow, at } = await loadFixture(deployFixture);
    expect(getAddress(await escrow.read.guardian())).to.equal(getAddress(deployer.account.address));
    expect(await escrow.read.paused()).to.equal(false);

    const asStranger = await at("TesseraEscrow", escrow.address, stranger);
    await expect(asStranger.write.setPaused([true])).to.be.rejected;
    await escrow.write.setPaused([true]);
    expect(await escrow.read.paused()).to.equal(true);
  });

  it("hands the switch on, and the old holder loses it", async () => {
    const { stranger, escrow, at } = await loadFixture(deployFixture);
    await escrow.write.setGuardian([stranger.account.address]);
    expect(getAddress(await escrow.read.guardian())).to.equal(getAddress(stranger.account.address));
    await expect(escrow.write.setPaused([true])).to.be.rejected;
    await (await at("TesseraEscrow", escrow.address, stranger)).write.setPaused([true]);
  });

  it("refuses to hand the switch to nobody", async () => {
    const { escrow } = await loadFixture(deployFixture);
    await expect(escrow.write.setGuardian(["0x0000000000000000000000000000000000000000"])).to.be.rejected;
  });

  it("escrow: stops new payments but never a settlement or a refund", async () => {
    const { agent, provider, escrow, at, soon } = await loadFixture(deployFixture);
    const a = await at("TesseraEscrow", escrow.address, agent);
    const p = await at("TesseraEscrow", escrow.address, provider);

    // A payment already in flight when the pause lands.
    await a.write.open([provider.account.address, U(100), await soon(), H("q")]);
    await p.write.fulfill([1n, H("r")]);

    await escrow.write.setPaused([true]);

    // No new exposure...
    await expect(a.write.open([provider.account.address, U(100), await soon(), H("q2")])).to.be.rejected;
    // ...but the money already in there still moves to where it belongs.
    await a.write.settle([1n]);
    expect(await escrow.read.getPayment([1n]).then((r: any) => r[6])).to.equal(3); // Settled
  });

  it("escrow: a paused contract still lets a buyer reclaim after a timeout", async () => {
    const { agent, provider, escrow, at } = await loadFixture(deployFixture);
    const a = await at("TesseraEscrow", escrow.address, agent);
    const deadline = BigInt(await time.latest()) + 60n;
    await a.write.open([provider.account.address, U(100), deadline, H("q")]);

    await escrow.write.setPaused([true]);
    await time.increaseTo(deadline + 1n);
    // Being unable to get your money back during an incident is the incident.
    await a.write.refund([1n]);
    void provider;
  });

  it("stream: stops new streams and top-ups, never a withdrawal or a cancel", async () => {
    const { agent, provider, usdc, stream, at } = await loadFixture(deployFixture);
    const a = await at("TesseraStream", stream.address, agent);
    const p = await at("TesseraStream", stream.address, provider);
    await a.write.open([provider.account.address, usdc.address, U(3600), U(1)]);

    await stream.write.setPaused([true]);
    await expect(a.write.open([provider.account.address, usdc.address, U(3600), U(1)])).to.be.rejected;
    await expect(a.write.topUp([1n, U(100)])).to.be.rejected;

    await time.increase(600);
    await p.write.withdraw([1n]); // recipient is still paid for time already spent
    await a.write.cancel([1n]); // payer can still get out
  });

  it("subscription: stops charges and new plans, never a cancellation", async () => {
    const { agent, provider, usdc, sub, at } = await loadFixture(deployFixture);
    const a = await at("TesseraSubscription", sub.address, agent);
    const p = await at("TesseraSubscription", sub.address, provider);
    await a.write.subscribe([provider.account.address, usdc.address, U(500), U(100), 3600n]);

    await sub.write.setPaused([true]);
    await expect(a.write.subscribe([provider.account.address, usdc.address, U(500), U(100), 3600n])).to.be.rejected;
    // A charge is the provider pulling money — exactly the path worth stopping.
    await expect(p.write.charge([1n, U(10), H("m")])).to.be.rejected;
    // And the buyer can still take their balance back.
    await a.write.cancel([1n]);
  });

  it("tab: stops new tabs, never a claim or a reclaim", async () => {
    const { agent, provider, tab, at } = await loadFixture(deployFixture);
    const a = await at("TesseraTab", tab.address, agent);
    await a.write.openTab([provider.account.address, U(100), 3600n]);

    await tab.write.setPaused([true]);
    await expect(a.write.openTab([provider.account.address, U(100), 3600n])).to.be.rejected;

    await time.increase(3601);
    await a.write.reclaim([1n]); // the agent's own funds, after expiry
  });

  it("unpauses, and everything resumes", async () => {
    const { agent, provider, escrow, at, soon } = await loadFixture(deployFixture);
    const a = await at("TesseraEscrow", escrow.address, agent);
    await escrow.write.setPaused([true]);
    await expect(a.write.open([provider.account.address, U(100), await soon(), H("q")])).to.be.rejected;
    // Staying paused after the danger has passed is its own harm.
    await escrow.write.setPaused([false]);
    await a.write.open([provider.account.address, U(100), await soon(), H("q")]);
  });

  it("gives every payment contract a switch", async () => {
    // The gap this closes: the pool had setFrozen and nothing else had anything.
    const { escrow, tab, stream, sub } = await loadFixture(deployFixture);
    for (const c of [escrow, tab, stream, sub]) {
      expect(await c.read.paused()).to.equal(false);
      await c.write.setPaused([true]);
      expect(await c.read.paused()).to.equal(true);
    }
  });
});

describe("TesseraTab — finding your own tabs", () => {
  it("indexes a tab against both sides", async () => {
    const { agent, provider, tab, at } = await loadFixture(deployFixture);
    const a = await at("TesseraTab", tab.address, agent);
    await a.write.openTab([provider.account.address, U(100), 3600n]);

    expect(await tab.read.tabsAsAgent([agent.account.address])).to.deep.equal([1n]);
    expect(await tab.read.tabsAsProvider([provider.account.address])).to.deep.equal([1n]);
    expect(await tab.read.tabsAsProvider([agent.account.address])).to.deep.equal([]);
  });

  it("accumulates tabs in order and counts each side", async () => {
    const { agent, provider, tab, at } = await loadFixture(deployFixture);
    const a = await at("TesseraTab", tab.address, agent);
    for (let i = 0; i < 3; i++) await a.write.openTab([provider.account.address, U(10), 3600n]);
    expect(await tab.read.tabsAsAgent([agent.account.address])).to.deep.equal([1n, 2n, 3n]);
    const [asAgent, asProvider] = await tab.read.tabCounts([agent.account.address]);
    expect(asAgent).to.equal(3n);
    expect(asProvider).to.equal(0n);
  });

  it("returns nothing for an address with no tabs", async () => {
    const { stranger, tab } = await loadFixture(deployFixture);
    expect(await tab.read.tabsAsAgent([stranger.account.address])).to.deep.equal([]);
  });
});
