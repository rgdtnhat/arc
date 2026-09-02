import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { encodePacked, keccak256, type Hex } from "viem";

const DEPOSIT = 50_000n; // 0.05 USDC
const MINT = 1_000_000n;
const DURATION = 3600n;

async function deployFixture() {
  const [, agent, provider] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const tab = await hre.viem.deployContract("TesseraTab", [usdc.address]);

  await usdc.write.mint([agent.account.address, MINT]);
  const agentUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, {
    client: { wallet: agent },
  });
  await agentUsdc.write.approve([tab.address, MINT]);

  const agentTab = await hre.viem.getContractAt("TesseraTab", tab.address, {
    client: { wallet: agent },
  });
  const providerTab = await hre.viem.getContractAt("TesseraTab", tab.address, {
    client: { wallet: provider },
  });

  // Sign a voucher exactly the way the contract verifies it.
  const voucher = async (tabId: bigint, cum: bigint): Promise<Hex> => {
    const hash = keccak256(
      encodePacked(["address", "uint256", "uint256"], [tab.address, tabId, cum])
    );
    return agent.signMessage({ message: { raw: hash } });
  };

  return { agent, provider, usdc, tab, agentTab, providerTab, voucher };
}

describe("TesseraTab", () => {
  it("streams micro-payments off-chain and settles once on-chain", async () => {
    const { agent, provider, usdc, agentTab, providerTab, voucher } =
      await loadFixture(deployFixture);

    await agentTab.write.openTab([provider.account.address, DEPOSIT, DURATION]);

    // Five off-chain ticks of 0.001 USDC each — no transactions here.
    const perTick = 1_000n;
    let cum = 0n;
    let lastSig: Hex = "0x";
    for (let i = 0; i < 5; i++) {
      cum += perTick;
      lastSig = await voucher(1n, cum);
    }

    // Provider closes with the single best voucher.
    await providerTab.write.closeTab([1n, cum, lastSig]);

    expect(await usdc.read.balanceOf([provider.account.address])).to.equal(cum);
    // Agent got the unspent remainder back.
    expect(await usdc.read.balanceOf([agent.account.address])).to.equal(MINT - cum);
  });

  it("supports incremental claims (pays only the delta)", async () => {
    const { provider, usdc, agentTab, providerTab, voucher } =
      await loadFixture(deployFixture);
    await agentTab.write.openTab([provider.account.address, DEPOSIT, DURATION]);

    await providerTab.write.claim([1n, 2_000n, await voucher(1n, 2_000n)]);
    await providerTab.write.claim([1n, 5_000n, await voucher(1n, 5_000n)]);
    expect(await usdc.read.balanceOf([provider.account.address])).to.equal(5_000n);
  });

  it("rejects vouchers not signed by the agent", async () => {
    const { provider, agentTab, providerTab, tab } = await loadFixture(deployFixture);
    await agentTab.write.openTab([provider.account.address, DEPOSIT, DURATION]);

    const hash = keccak256(
      encodePacked(["address", "uint256", "uint256"], [tab.address, 1n, 1_000n])
    );
    const forged = await provider.signMessage({ message: { raw: hash } });
    await expect(providerTab.write.claim([1n, 1_000n, forged])).to.be.rejected;
  });

  it("rejects vouchers above the deposit or not increasing", async () => {
    const { provider, agentTab, providerTab, voucher } = await loadFixture(deployFixture);
    await agentTab.write.openTab([provider.account.address, DEPOSIT, DURATION]);

    await expect(
      providerTab.write.claim([1n, DEPOSIT + 1n, await voucher(1n, DEPOSIT + 1n)])
    ).to.be.rejected;

    await providerTab.write.claim([1n, 3_000n, await voucher(1n, 3_000n)]);
    await expect(providerTab.write.claim([1n, 3_000n, await voucher(1n, 3_000n)])).to.be
      .rejected;
  });

  it("lets the agent reclaim after expiry if the provider never settles", async () => {
    const { agent, provider, usdc, agentTab } = await loadFixture(deployFixture);
    await agentTab.write.openTab([provider.account.address, DEPOSIT, DURATION]);

    await expect(agentTab.write.reclaim([1n])).to.be.rejected; // not expired yet
    await time.increase(DURATION + 1n);
    await agentTab.write.reclaim([1n]);
    expect(await usdc.read.balanceOf([agent.account.address])).to.equal(MINT);
  });

  it("blocks claims after the tab is closed", async () => {
    const { provider, agentTab, providerTab, voucher } = await loadFixture(deployFixture);
    await agentTab.write.openTab([provider.account.address, DEPOSIT, DURATION]);
    await providerTab.write.closeTab([1n, 1_000n, await voucher(1n, 1_000n)]);
    await expect(providerTab.write.claim([1n, 2_000n, await voucher(1n, 2_000n)])).to.be
      .rejected;
  });
});
