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

  return { deployer, agent, provider, publicClient, usdc, escrow, agentEscrow, providerEscrow };
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
});
