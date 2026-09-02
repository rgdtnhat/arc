import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex } from "viem";

const U = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));
const H = (s: string) => keccak256(toHex(s));

/**
 * The escrow's two economic holes, and what closes them.
 *
 * Both were real and both were reachable by anyone: a buyer could take delivery
 * and reclaim the payment for nothing, and a provider could manufacture a
 * spotless record by trading with itself.
 */
async function deployFixture() {
  const [deployer, agent, provider, treasury, other] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);
  await escrow.write.setProtocolFee([0, treasury.account.address]);

  for (const who of [agent, provider, other, deployer]) {
    await usdc.write.mint([who.account.address, U("100000")]);
    const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    await c.write.approve([escrow.address, U("100000")]);
  }

  const as = (who: any) => hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: who } });
  const soon = async () => BigInt(await time.latest()) + 3600n;

  /** open -> fulfill, returning the id. */
  async function delivered(buyer: any, seller: any, amount = U("100")) {
    await (await as(buyer)).write.open([seller.account.address, amount, await soon(), H("q")]);
    const id = (await escrow.read.nextPaymentId()) - 1n;
    await (await as(seller)).write.fulfill([id, H("r")]);
    return id;
  }

  return { deployer, agent, provider, treasury, other, usdc, escrow, as, soon, delivered };
}

describe("TesseraEscrow — the buyer's dispute is no longer free", () => {
  it("charges a bond alongside the payment", async () => {
    const { agent, provider, usdc, escrow, as, soon } = await loadFixture(deployFixture);
    const before = await usdc.read.balanceOf([agent.account.address]);
    await (await as(agent)).write.open([provider.account.address, U("100"), await soon(), H("q")]);

    const bond = await escrow.read.bondFor([U("100")]);
    expect(bond).to.equal(U("10")); // 10%
    expect(before - (await usdc.read.balanceOf([agent.account.address]))).to.equal(U("100") + bond);
  });

  it("returns the bond when the buyer settles", async () => {
    const { agent, provider, usdc, escrow, as, delivered } = await loadFixture(deployFixture);
    const before = await usdc.read.balanceOf([agent.account.address]);
    const id = await delivered(agent, provider);
    await (await as(agent)).write.settle([id]);
    // Paid the price, kept the bond.
    expect(before - (await usdc.read.balanceOf([agent.account.address]))).to.equal(U("100"));
    expect(await usdc.read.balanceOf([escrow.address])).to.equal(0n);
  });

  it("takes the bond when the buyer rejects work that was delivered", async () => {
    const { agent, provider, treasury, usdc, escrow, as, delivered } = await loadFixture(deployFixture);
    const before = await usdc.read.balanceOf([agent.account.address]);
    const tBefore = await usdc.read.balanceOf([treasury.account.address]);
    const bond = await escrow.read.bondFor([U("100")]);

    const id = await delivered(agent, provider);
    await (await as(agent)).write.refund([id]);

    // This is the whole point: taking delivery and reclaiming the payment now
    // costs something, so it is a decision rather than a free option.
    expect(before - (await usdc.read.balanceOf([agent.account.address]))).to.equal(bond);
    expect((await usdc.read.balanceOf([treasury.account.address])) - tBefore).to.equal(bond);
  });

  it("returns the bond when the provider never delivered", async () => {
    const { agent, provider, usdc, escrow, as } = await loadFixture(deployFixture);
    const before = await usdc.read.balanceOf([agent.account.address]);
    const deadline = BigInt(await time.latest()) + 60n;
    await (await as(agent)).write.open([provider.account.address, U("100"), deadline, H("q")]);
    await time.increaseTo(deadline + 1n);
    await (await as(agent)).write.refund([1n]);

    // Being let down is not disputing. A buyer who received nothing pays nothing.
    expect(await usdc.read.balanceOf([agent.account.address])).to.equal(before);
    expect(await usdc.read.balanceOf([escrow.address])).to.equal(0n);
  });

  it("returns the bond when the provider claims after the window", async () => {
    const { agent, provider, usdc, escrow, as, delivered } = await loadFixture(deployFixture);
    const before = await usdc.read.balanceOf([agent.account.address]);
    const id = await delivered(agent, provider);
    await time.increase(Number(await escrow.read.DISPUTE_WINDOW()) + 1);
    await (await as(provider)).write.providerClaim([id]);

    // Going quiet already costs the payment; taking the bond too would punish
    // an outage twice.
    expect(before - (await usdc.read.balanceOf([agent.account.address]))).to.equal(U("100"));
    expect(await usdc.read.balanceOf([escrow.address])).to.equal(0n);
  });

  it("keeps rejection net-negative for a staked provider", async () => {
    const { agent, provider, usdc, escrow, as, delivered } = await loadFixture(deployFixture);
    await (await as(provider)).write.stake([U("1000")]);

    const provBefore = await usdc.read.balanceOf([provider.account.address]);
    const stakeBefore = await escrow.read.stakeOf([provider.account.address]);
    const id = await delivered(agent, provider);
    await (await as(agent)).write.refund([id]);

    // The provider gains nothing from the bond — it went to the treasury — and
    // loses the slash. Sending the bond to the provider instead would have let
    // an unstaked one deliver garbage and bank it, which is the reason it does
    // not go there.
    expect(await usdc.read.balanceOf([provider.account.address])).to.equal(provBefore);
    const slashed = stakeBefore - (await escrow.read.stakeOf([provider.account.address]));
    expect(slashed).to.equal(U("20")); // 20% of 100
  });

  it("reports the bond and whether it is still at risk", async () => {
    const { agent, provider, escrow, as, delivered } = await loadFixture(deployFixture);
    const id = await delivered(agent, provider);
    const [bond, atRisk] = await escrow.read.bondOf([id]);
    expect(bond).to.equal(U("10"));
    expect(atRisk).to.equal(true);

    await (await as(agent)).write.settle([id]);
    const [after, stillAtRisk] = await escrow.read.bondOf([id]);
    expect(after).to.equal(0n);
    expect(stillAtRisk).to.equal(false);
  });

  it("scales the bond with the payment", async () => {
    const { escrow } = await loadFixture(deployFixture);
    expect(await escrow.read.bondFor([U("1")])).to.equal(U("0.1"));
    expect(await escrow.read.bondFor([U("1000")])).to.equal(U("100"));
    expect(await escrow.read.bondFor([0n])).to.equal(0n);
  });

  it("never pays the same bond twice", async () => {
    const { agent, provider, usdc, escrow, as, delivered } = await loadFixture(deployFixture);
    const id = await delivered(agent, provider);
    await (await as(agent)).write.settle([id]);
    // Settling again must fail, and the contract must be empty either way.
    await expect((await as(agent)).write.settle([id])).to.be.rejected;
    expect(await usdc.read.balanceOf([escrow.address])).to.equal(0n);
  });
});

describe("TesseraEscrow — a record that costs something to build", () => {
  it("counts distinct counterparties, not just settlements", async () => {
    const { agent, provider, other, escrow, as, delivered } = await loadFixture(deployFixture);

    await (await as(agent)).write.settle([await delivered(agent, provider)]);
    let [fulfilled, , , distinct] = await escrow.read.reputation([provider.account.address]);
    expect(fulfilled).to.equal(1n);
    expect(distinct).to.equal(1n);

    // The same buyer again adds a settlement but not a counterparty.
    await (await as(agent)).write.settle([await delivered(agent, provider)]);
    [fulfilled, , , distinct] = await escrow.read.reputation([provider.account.address]);
    expect(fulfilled).to.equal(2n);
    expect(distinct).to.equal(1n);

    // A different buyer does.
    await (await as(other)).write.settle([await delivered(other, provider)]);
    [fulfilled, , , distinct] = await escrow.read.reputation([provider.account.address]);
    expect(fulfilled).to.equal(3n);
    expect(distinct).to.equal(2n);
  });

  it("makes a self-dealt record visible as concentration", async () => {
    const { agent, provider, escrow, as, delivered } = await loadFixture(deployFixture);
    // A provider trading with one address it controls: excellent counts.
    for (let i = 0; i < 8; i++) {
      await (await as(agent)).write.settle([await delivered(agent, provider, U("1"))]);
    }
    const [fulfilled, failed, , distinct] = await escrow.read.reputation([provider.account.address]);
    expect(fulfilled).to.equal(8n);
    expect(failed).to.equal(0n);
    // And one counterparty behind all of it, which is the tell.
    expect(distinct).to.equal(1n);
    expect(await escrow.read.concentrationBps([provider.account.address])).to.equal(1250n); // 1/8
  });

  it("reports full concentration for a genuinely spread record", async () => {
    const { agent, provider, other, escrow, as, delivered } = await loadFixture(deployFixture);
    await (await as(agent)).write.settle([await delivered(agent, provider, U("1"))]);
    await (await as(other)).write.settle([await delivered(other, provider, U("1"))]);
    expect(await escrow.read.concentrationBps([provider.account.address])).to.equal(10_000n);
  });

  it("counts a provider claim toward the record too", async () => {
    const { agent, provider, escrow, as, delivered } = await loadFixture(deployFixture);
    const id = await delivered(agent, provider);
    await time.increase(Number(await escrow.read.DISPUTE_WINDOW()) + 1);
    await (await as(provider)).write.providerClaim([id]);
    const [fulfilled, , , distinct] = await escrow.read.reputation([provider.account.address]);
    expect(fulfilled).to.equal(1n);
    // The liveness path must not be a way to build a record without a
    // counterparty being recorded against it.
    expect(distinct).to.equal(1n);
  });

  it("timestamps the last settlement so a stale record can be discounted", async () => {
    const { agent, provider, escrow, as, delivered } = await loadFixture(deployFixture);
    const [, , , , never] = await escrow.read.reputation([provider.account.address]);
    expect(never).to.equal(0n);

    await (await as(agent)).write.settle([await delivered(agent, provider)]);
    const [, , , , at] = await escrow.read.reputation([provider.account.address]);
    expect(at > 0n).to.equal(true);
    expect(Number(at)).to.be.closeTo(await time.latest(), 5);
  });

  it("reports zero concentration for a provider with no record", async () => {
    const { other, escrow } = await loadFixture(deployFixture);
    expect(await escrow.read.concentrationBps([other.account.address])).to.equal(0n);
  });
});
