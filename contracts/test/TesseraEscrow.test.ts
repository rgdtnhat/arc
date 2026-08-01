import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex, getAddress } from "viem";

const PRICE = 2500n; // 0.0025 USDC (6 decimals)
const MINT = 1_000_000n; // 1 USDC

async function deployFixture() {
  const [deployer, agent, provider] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);

  // Fund the agent and approve the escrow to pull USDC.
  await usdc.write.mint([agent.account.address, MINT]);
  const agentUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, {
    client: { wallet: agent },
  });
  await agentUsdc.write.approve([escrow.address, MINT]);

  const agentEscrow = await hre.viem.getContractAt("TesseraEscrow", escrow.address, {
    client: { wallet: agent },
  });
  const providerEscrow = await hre.viem.getContractAt("TesseraEscrow", escrow.address, {
    client: { wallet: provider },
  });

  // A treasury and an unrelated pair, for the escrow-as-a-service tests: the
  // point there is that neither side is this app's agent or provider.
  const [, , , treasury, other] = await hre.viem.getWalletClients();
  const asEscrow = (who: any) =>
    hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: who } });

  return {
    deployer, agent, provider, treasury, other, publicClient, usdc, escrow,
    agentEscrow, providerEscrow, asEscrow,
  };
}

async function futureDeadline(seconds = 60): Promise<bigint> {
  return BigInt((await time.latest()) + seconds);
}

const quoteHash = keccak256(toHex("quote-1"));
const responseHash = keccak256(toHex("response-1"));

describe("TesseraEscrow", () => {
  it("runs the happy path: open -> fulfill -> settle, and pays the provider", async () => {
    const { agent, provider, usdc, escrow, agentEscrow, providerEscrow } =
      await loadFixture(deployFixture);

    const deadline = await futureDeadline();
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);

    // Escrow holds the funds.
    expect(await usdc.read.balanceOf([escrow.address])).to.equal(PRICE);

    await providerEscrow.write.fulfill([1n, responseHash]);
    await agentEscrow.write.settle([1n]);

    expect(await usdc.read.balanceOf([provider.account.address])).to.equal(PRICE);
    expect(await usdc.read.balanceOf([escrow.address])).to.equal(0n);

    const [fulfilled, failed, earned] = await escrow.read.reputation([
      provider.account.address,
    ]);
    expect(fulfilled).to.equal(1n);
    expect(failed).to.equal(0n);
    expect(earned).to.equal(PRICE);
  });

  it("auto-refunds the agent when the provider misses the deadline", async () => {
    const { agent, provider, usdc, escrow, agentEscrow } = await loadFixture(deployFixture);

    const deadline = await futureDeadline(30);
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);

    // Time travel past the SLA window; provider never fulfilled.
    await time.increaseTo(deadline + 1n);
    await agentEscrow.write.refund([1n]);

    expect(await usdc.read.balanceOf([agent.account.address])).to.equal(MINT);
    const [fulfilled, failed] = await escrow.read.reputation([provider.account.address]);
    expect(fulfilled).to.equal(0n);
    expect(failed).to.equal(1n);
  });

  it("lets the agent reject a fulfilled-but-bad response for a refund", async () => {
    const { agent, provider, usdc, escrow, agentEscrow, providerEscrow } =
      await loadFixture(deployFixture);

    const deadline = await futureDeadline();
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);
    await providerEscrow.write.fulfill([1n, responseHash]);

    // Agent decides the SLA/quality was not met.
    await agentEscrow.write.refund([1n]);

    expect(await usdc.read.balanceOf([agent.account.address])).to.equal(MINT);
    expect(await usdc.read.balanceOf([provider.account.address])).to.equal(0n);
    const [, failed] = await escrow.read.reputation([provider.account.address]);
    expect(failed).to.equal(1n);
  });

  it("rejects a refund before the deadline when nothing was fulfilled", async () => {
    const { provider, agentEscrow } = await loadFixture(deployFixture);
    const deadline = await futureDeadline(60);
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);

    await expect(agentEscrow.write.refund([1n])).to.be.rejected;
  });

  it("stops a provider from fulfilling after the deadline", async () => {
    const { provider, agentEscrow, providerEscrow } = await loadFixture(deployFixture);
    const deadline = await futureDeadline(30);
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);

    await time.increaseTo(deadline + 1n);
    await expect(providerEscrow.write.fulfill([1n, responseHash])).to.be.rejected;
  });

  it("only the named provider can fulfill", async () => {
    const { provider, agent, agentEscrow } = await loadFixture(deployFixture);
    const deadline = await futureDeadline();
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);

    // agent is not the provider
    await expect(agentEscrow.write.fulfill([1n, responseHash])).to.be.rejected;
  });

  it("only the paying agent can settle", async () => {
    const { provider, agentEscrow, providerEscrow } = await loadFixture(deployFixture);
    const deadline = await futureDeadline();
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);
    await providerEscrow.write.fulfill([1n, responseHash]);

    // Provider cannot settle its own payment.
    await expect(providerEscrow.write.settle([1n])).to.be.rejected;
  });

  it("slashes a staked provider on SLA breach and compensates the agent", async () => {
    const { agent, provider, usdc, escrow, agentEscrow, providerEscrow } =
      await loadFixture(deployFixture);

    // Provider bonds 0.1 USDC of stake.
    const STAKE = 100_000n;
    await usdc.write.mint([provider.account.address, STAKE]);
    const providerUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, {
      client: { wallet: provider },
    });
    await providerUsdc.write.approve([escrow.address, STAKE]);
    await providerEscrow.write.stake([STAKE]);
    expect(await escrow.read.stakeOf([provider.account.address])).to.equal(STAKE);

    // Breach: fulfilled but the agent rejects.
    const deadline = await futureDeadline();
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);
    await providerEscrow.write.fulfill([1n, responseHash]);
    await agentEscrow.write.refund([1n]);

    // Agent got the refund PLUS 20% of the payment slashed from the stake.
    const slash = (PRICE * 2000n) / 10000n;
    expect(await usdc.read.balanceOf([agent.account.address])).to.equal(MINT + slash);
    expect(await escrow.read.stakeOf([provider.account.address])).to.equal(STAKE - slash);
  });

  it("lets a provider stake and unstake", async () => {
    const { provider, usdc, escrow, providerEscrow } = await loadFixture(deployFixture);
    const STAKE = 50_000n;
    await usdc.write.mint([provider.account.address, STAKE]);
    const providerUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, {
      client: { wallet: provider },
    });
    await providerUsdc.write.approve([escrow.address, STAKE]);
    await providerEscrow.write.stake([STAKE]);
    await providerEscrow.write.unstake([STAKE]);
    expect(await escrow.read.stakeOf([provider.account.address])).to.equal(0n);
    expect(await usdc.read.balanceOf([provider.account.address])).to.equal(STAKE);
  });

  it("refunds without slash when the provider has no stake", async () => {
    const { agent, provider, usdc, agentEscrow, providerEscrow } =
      await loadFixture(deployFixture);
    const deadline = await futureDeadline();
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);
    await providerEscrow.write.fulfill([1n, responseHash]);
    await agentEscrow.write.refund([1n]);
    expect(await usdc.read.balanceOf([agent.account.address])).to.equal(MINT);
  });

  it("lets the provider claim a delivered payment after the dispute window", async () => {
    const { agent, provider, usdc, escrow, agentEscrow, providerEscrow } =
      await loadFixture(deployFixture);

    const deadline = await futureDeadline();
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);
    await providerEscrow.write.fulfill([1n, responseHash]);

    // Agent goes silent — never settles or rejects.
    const DISPUTE_WINDOW = await escrow.read.DISPUTE_WINDOW();
    await time.increase(Number(DISPUTE_WINDOW) + 1);
    await providerEscrow.write.providerClaim([1n]);

    expect(await usdc.read.balanceOf([provider.account.address])).to.equal(PRICE);
    const [fulfilled, failed, earned] = await escrow.read.reputation([provider.account.address]);
    expect(fulfilled).to.equal(1n);
    expect(failed).to.equal(0n);
    expect(earned).to.equal(PRICE);
  });

  it("blocks a provider claim while the dispute window is still open", async () => {
    const { provider, agentEscrow, providerEscrow } = await loadFixture(deployFixture);
    const deadline = await futureDeadline();
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);
    await providerEscrow.write.fulfill([1n, responseHash]);

    await expect(providerEscrow.write.providerClaim([1n])).to.be.rejected; // window open
  });

  it("only the provider can claim", async () => {
    const { provider, escrow, agentEscrow, providerEscrow } = await loadFixture(deployFixture);
    const deadline = await futureDeadline();
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);
    await providerEscrow.write.fulfill([1n, responseHash]);
    await time.increase(Number(await escrow.read.DISPUTE_WINDOW()) + 1);

    await expect(agentEscrow.write.providerClaim([1n])).to.be.rejected; // agent is not provider
  });

  it("still lets the agent reject inside the dispute window even after delay", async () => {
    const { agent, provider, usdc, escrow, agentEscrow, providerEscrow } =
      await loadFixture(deployFixture);
    const deadline = await futureDeadline();
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);
    await providerEscrow.write.fulfill([1n, responseHash]);

    // Half the window passes, then the agent rejects — refund still works.
    await time.increase(Number(await escrow.read.DISPUTE_WINDOW()) / 2);
    await agentEscrow.write.refund([1n]);
    expect(await usdc.read.balanceOf([agent.account.address])).to.equal(MINT);
    // And the provider can no longer claim a refunded payment.
    await time.increase(Number(await escrow.read.DISPUTE_WINDOW()));
    await expect(providerEscrow.write.providerClaim([1n])).to.be.rejected;
  });

  it("exposes payment state via getPayment", async () => {
    const { agent, provider, agentEscrow, escrow } = await loadFixture(deployFixture);
    const deadline = await futureDeadline();
    await agentEscrow.write.open([provider.account.address, PRICE, deadline, quoteHash]);

    const p = await escrow.read.getPayment([1n]);
    expect(getAddress(p[0])).to.equal(getAddress(agent.account.address));
    expect(getAddress(p[1])).to.equal(getAddress(provider.account.address));
    expect(p[2]).to.equal(PRICE);
    expect(p[6]).to.equal(1); // Status.Escrowed
  });

  // --- escrow as a service for third parties ---------------------------------
  //
  // `open` was always permissionless, so any agent/provider pair could already
  // use this contract for their own trade. These pin the fee that turns that
  // into revenue, and the limits on it.

  /** open -> fulfill, returning the payment id. */
  async function opened(fx: any, amount: bigint, buyer: any, seller: any) {
    const deadline = await futureDeadline(3600);
    await (await fx.asEscrow(buyer)).write.open([seller.account.address, amount, deadline, quoteHash]);
    const id = (await fx.escrow.read.nextPaymentId()) - 1n;
    await (await fx.asEscrow(seller)).write.fulfill([id, responseHash]);
    return id;
  }

  it("defaults to charging nothing, so existing flows are untouched", async () => {
    const { escrow } = await loadFixture(deployFixture);
    expect(await escrow.read.protocolFeeBps()).to.equal(0);
    const [net, fee] = await escrow.read.quotePayout([MINT]);
    expect(net).to.equal(MINT);
    expect(fee).to.equal(0n);
  });

  it("takes the fee from the provider's payout on settle", async () => {
    const fx = await loadFixture(deployFixture);
    const { agent, provider, treasury, usdc, escrow } = fx;
    await escrow.write.setProtocolFee([100, treasury.account.address]); // 1%

    const before = await usdc.read.balanceOf([provider.account.address]);
    const tBefore = await usdc.read.balanceOf([treasury.account.address]);
    const id = await opened(fx, 1_000_000n, agent, provider);
    await (await fx.asEscrow(agent)).write.settle([id]);

    // 1 USDC less 1%: 0.99 to the provider, 0.01 to the treasury, 0 stranded.
    expect((await usdc.read.balanceOf([provider.account.address])) - before).to.equal(990_000n);
    expect((await usdc.read.balanceOf([treasury.account.address])) - tBefore).to.equal(10_000n);
    expect(await usdc.read.balanceOf([escrow.address])).to.equal(0n);
  });

  it("charges nothing on a refund — the agent got nothing to be taxed on", async () => {
    const fx = await loadFixture(deployFixture);
    const { agent, provider, treasury, usdc, escrow } = fx;
    await escrow.write.setProtocolFee([100, treasury.account.address]);

    const before = await usdc.read.balanceOf([agent.account.address]);
    const tBefore = await usdc.read.balanceOf([treasury.account.address]);
    const id = await opened(fx, 1_000_000n, agent, provider);
    await (await fx.asEscrow(agent)).write.refund([id]);

    expect(await usdc.read.balanceOf([agent.account.address])).to.equal(before);
    expect(await usdc.read.balanceOf([treasury.account.address])).to.equal(tBefore);
  });

  it("takes the fee on a provider claim too, so the liveness path isn't a bypass", async () => {
    const fx = await loadFixture(deployFixture);
    const { agent, provider, treasury, usdc, escrow } = fx;
    await escrow.write.setProtocolFee([100, treasury.account.address]);
    const tBefore = await usdc.read.balanceOf([treasury.account.address]);

    const id = await opened(fx, 1_000_000n, agent, provider);
    await time.increase(3601 + 3600); // past the dispute window
    await (await fx.asEscrow(provider)).write.providerClaim([id]);

    expect((await usdc.read.balanceOf([treasury.account.address])) - tBefore).to.equal(10_000n);
  });

  it("records what the provider actually received, not the gross", async () => {
    const fx = await loadFixture(deployFixture);
    const { agent, provider, treasury, escrow } = fx;
    await escrow.write.setProtocolFee([100, treasury.account.address]);
    const id = await opened(fx, 1_000_000n, agent, provider);
    await (await fx.asEscrow(agent)).write.settle([id]);
    const [, , earned] = await escrow.read.reputation([provider.account.address]);
    // `earned` reads as a track record of income; gross would overstate it.
    expect(earned).to.equal(990_000n);
  });

  it("caps the fee in the bytecode, so no key can raise it toward confiscation", async () => {
    const { treasury, escrow } = await loadFixture(deployFixture);
    expect(await escrow.read.MAX_PROTOCOL_FEE()).to.equal(100);
    await expect(escrow.write.setProtocolFee([101, treasury.account.address])).to.be.rejected;
    await escrow.write.setProtocolFee([100, treasury.account.address]); // the ceiling itself is fine
  });

  it("keeps the fee switch owner-only", async () => {
    const fx = await loadFixture(deployFixture);
    await expect(
      (await fx.asEscrow(fx.agent)).write.setProtocolFee([50, fx.treasury.account.address])
    ).to.be.rejected;
  });

  it("lets an unrelated pair use the escrow for their own trade", async () => {
    // The point of escrow-as-a-service: neither side is the app's agent or one
    // of its providers, and it works anyway.
    const fx = await loadFixture(deployFixture);
    const { treasury, other, usdc, escrow } = fx;
    await escrow.write.setProtocolFee([50, treasury.account.address]); // 0.5%
    const buyer = other, seller = fx.deployer;

    await usdc.write.mint([buyer.account.address, 10_000_000n]);
    const buyerUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: buyer } });
    await buyerUsdc.write.approve([escrow.address, 10_000_000n]);

    const sellerBefore = await usdc.read.balanceOf([seller.account.address]);
    const id = await opened(fx, 10_000_000n, buyer, seller);
    await (await fx.asEscrow(buyer)).write.settle([id]);

    // 10 USDC less 0.5% = 9.95 to the seller.
    expect((await usdc.read.balanceOf([seller.account.address])) - sellerBefore).to.equal(9_950_000n);
  });
});

describe("TesseraEscrow (the fee is fixed when the escrow is funded)", () => {
  /**
   * `protocolFeeBps` is owner-settable. Reading it at payout time meant an owner
   * could raise the cut *after* a provider had delivered — changing the terms of
   * a trade that was agreed, and had already been performed, before the change.
   *
   * Both sides commit to the fee they could see at `open()`. A later change
   * applies to later escrows, which is the only version of "the owner can set a
   * fee" that a counterparty can reason about.
   */

  /** open -> fulfill at whatever fee is currently set, returning the id. */
  async function openAndFulfil(fx: any, amount: bigint) {
    const deadline = await futureDeadline(3600);
    await (await fx.asEscrow(fx.agent)).write.open([
      fx.provider.account.address, amount, deadline, quoteHash,
    ]);
    const id = (await fx.escrow.read.nextPaymentId()) - 1n;
    await (await fx.asEscrow(fx.provider)).write.fulfill([id, responseHash]);
    return id;
  }

  it("settles at the fee in force when it was opened, not the current one", async () => {
    const fx = await loadFixture(deployFixture);
    const { escrow, usdc, agent, provider, treasury } = fx;

    // Opened while the fee is zero.
    const id = await openAndFulfil(fx, MINT);

    // Owner raises it to the 1% ceiling afterwards.
    await escrow.write.setProtocolFee([100, treasury.account.address]);

    const before = await usdc.read.balanceOf([provider.account.address]);
    const tBefore = await usdc.read.balanceOf([treasury.account.address]);
    await (await fx.asEscrow(agent)).write.settle([id]);

    expect((await usdc.read.balanceOf([provider.account.address])) - before)
      .to.equal(MINT, "provider keeps the whole amount it agreed to");
    expect((await usdc.read.balanceOf([treasury.account.address])) - tBefore)
      .to.equal(0n, "the later fee cannot reach back into this escrow");
  });

  it("charges the new fee on an escrow opened after the change", async () => {
    // The other half of the promise: a fee change must actually take effect.
    const fx = await loadFixture(deployFixture);
    const { escrow, usdc, agent, treasury } = fx;
    await escrow.write.setProtocolFee([100, treasury.account.address]);

    const id = await openAndFulfil(fx, MINT);
    const tBefore = await usdc.read.balanceOf([treasury.account.address]);
    await (await fx.asEscrow(agent)).write.settle([id]);

    expect((await usdc.read.balanceOf([treasury.account.address])) - tBefore)
      .to.equal(MINT / 100n, "1% of the amount");
  });

  it("reports the payout for a specific payment at its own recorded fee", async () => {
    const fx = await loadFixture(deployFixture);
    const { escrow, treasury } = fx;
    const id = await openAndFulfil(fx, MINT);
    await escrow.write.setProtocolFee([100, treasury.account.address]);

    // The generic quote follows the current setting; the per-payment one does not.
    const [genericNet] = await escrow.read.quotePayout([MINT]);
    const [thisNet, thisFee] = await escrow.read.quotePayoutFor([id]);
    expect(thisNet).to.equal(MINT);
    expect(thisFee).to.equal(0n);
    expect(genericNet).to.equal(MINT - MINT / 100n);
  });

  it("a refund is unaffected either way", async () => {
    // A refund returns the full amount at any fee, so the snapshot must not
    // introduce a path where a fee is taken from a failed delivery.
    const fx = await loadFixture(deployFixture);
    const { escrow, usdc, agent, treasury } = fx;
    await escrow.write.setProtocolFee([100, treasury.account.address]);

    const deadline = await futureDeadline(3600);
    await (await fx.asEscrow(agent)).write.open([
      fx.provider.account.address, MINT, deadline, quoteHash,
    ]);
    const id = (await fx.escrow.read.nextPaymentId()) - 1n;

    const before = await usdc.read.balanceOf([agent.account.address]);
    const tBefore = await usdc.read.balanceOf([treasury.account.address]);
    await time.increaseTo(Number(deadline) + 1);
    await (await fx.asEscrow(agent)).write.refund([id]);

    expect((await usdc.read.balanceOf([agent.account.address])) - before).to.equal(MINT);
    expect((await usdc.read.balanceOf([treasury.account.address])) - tBefore).to.equal(0n);
  });
});
