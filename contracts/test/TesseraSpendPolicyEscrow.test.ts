import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex } from "viem";

const U = (n: number) => BigInt(Math.round(n * 1e6));
const H = (s: string) => keccak256(toHex(s));
const DAY = 24 * 3600;

/**
 * The policy paying for things, rather than sitting next to the wallet that does.
 *
 * `spend` sends money to an address; the escrow pulls from whoever calls `open`
 * and records that caller as the buyer. So a policy that only knows how to
 * `spend` cannot be on the path the agent actually pays through — which is how
 * it came to be deployed, funded and completely bypassed.
 */
async function deployFixture() {
  const [guardian, agent, provider, other] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);

  const policy = await hre.viem.deployContract("TesseraSpendPolicy", [
    guardian.account.address,
    agent.account.address,
    { periodSeconds: DAY, periodCap: U(500), perCounterpartyCap: U(200), allowlistOnly: false, expiresAt: 0n },
  ]);
  await policy.write.setEscrow([escrow.address]);

  await usdc.write.mint([guardian.account.address, U(10_000)]);
  await usdc.write.approve([policy.address, U(10_000)]);
  await policy.write.fund([usdc.address, U(5_000)]);

  const as = (who: any) =>
    hre.viem.getContractAt("TesseraSpendPolicy", policy.address, { client: { wallet: who } });
  const escrowAs = (who: any) =>
    hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: who } });
  const soon = async () => BigInt(await time.latest()) + 3600n;

  return { guardian, agent, provider, other, usdc, escrow, policy, as, escrowAs, soon };
}

describe("TesseraSpendPolicy paying through the escrow", () => {
  it("opens a payment with the policy as the buyer, not the agent", async () => {
    const { agent, provider, usdc, escrow, policy, as, soon } = await loadFixture(deployFixture);
    const agentBefore = await usdc.read.balanceOf([agent.account.address]);

    await (await as(agent)).write.openPayment([
      usdc.address, provider.account.address, U(100), await soon(), H("q"),
    ]);

    // The agent's own wallet paid nothing — the money came from the policy.
    expect(await usdc.read.balanceOf([agent.account.address])).to.equal(agentBefore);
    const p = (await escrow.read.getPayment([1n])) as readonly [string, string, bigint, bigint, string, string, number];
    expect(p[0].toLowerCase()).to.equal(policy.address.toLowerCase());
  });

  it("charges the payment and its bond against the period cap", async () => {
    const { agent, provider, usdc, escrow, policy, as, soon } = await loadFixture(deployFixture);
    const bond = (await escrow.read.bondFor([U(100)])) as bigint;
    await (await as(agent)).write.openPayment([
      usdc.address, provider.account.address, U(100), await soon(), H("q"),
    ]);
    // The bond is money that left the policy, so it counts.
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.equal(U(500) - U(100) - bond);
  });

  it("refuses a payment that would break the period cap", async () => {
    const { agent, provider, other, usdc, as, soon } = await loadFixture(deployFixture);
    // 180 + its 18 bond is 198 per provider, just inside the 200 counterparty
    // cap. Two of those is 396, so a third payment breaks the 500 period cap.
    await (await as(agent)).write.openPayment([usdc.address, provider.account.address, U(180), await soon(), H("a")]);
    await (await as(agent)).write.openPayment([usdc.address, other.account.address, U(180), await soon(), H("b")]);
    await expect(
      (await as(agent)).write.openPayment([usdc.address, provider.account.address, U(100), await soon(), H("c")]),
    ).to.be.rejected;
  });

  it("books the provider as the counterparty, not the escrow", async () => {
    // Charging it to the escrow would collapse every provider into one
    // counterparty and make the per-counterparty cap meaningless.
    const { agent, provider, other, usdc, policy, as, soon } = await loadFixture(deployFixture);
    await (await as(agent)).write.openPayment([usdc.address, provider.account.address, U(150), await soon(), H("a")]);

    expect(await policy.read.remainingToCounterparty([usdc.address, provider.account.address]))
      .to.be.a("bigint");
    // The other provider still has its own full allowance.
    expect(await policy.read.remainingToCounterparty([usdc.address, other.account.address])).to.equal(U(200));
    // And this one is nearly spent, so a second large payment to it fails while
    // the same amount to a different provider succeeds.
    await expect(
      (await as(agent)).write.openPayment([usdc.address, provider.account.address, U(100), await soon(), H("b")]),
    ).to.be.rejected;
    await (await as(agent)).write.openPayment([usdc.address, other.account.address, U(100), await soon(), H("c")]);
  });

  it("settles to the provider and gives the bond's budget back", async () => {
    const { agent, provider, usdc, escrow, policy, as, escrowAs, soon } = await loadFixture(deployFixture);
    const bond = (await escrow.read.bondFor([U(100)])) as bigint;
    await (await as(agent)).write.openPayment([usdc.address, provider.account.address, U(100), await soon(), H("q")]);
    await (await escrowAs(provider)).write.fulfill([1n, H("r")]);

    const provBefore = await usdc.read.balanceOf([provider.account.address]);
    await (await as(agent)).write.settlePayment([usdc.address, 1n]);

    expect((await usdc.read.balanceOf([provider.account.address])) - provBefore).to.equal(U(100));
    // The bond came back, so the budget it consumed comes back too.
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.equal(U(500) - U(100));
    void bond;
  });

  it("credits the whole budget back when a payment is refunded", async () => {
    const { agent, provider, usdc, policy, as, soon } = await loadFixture(deployFixture);
    const deadline = BigInt(await time.latest()) + 60n;
    await (await as(agent)).write.openPayment([usdc.address, provider.account.address, U(180), deadline, H("q")]);
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.be.a("bigint");

    await time.increaseTo(deadline + 1n);
    await (await as(agent)).write.refundPayment([usdc.address, 1n]);

    // A provider that never delivered must not cost the agent its budget.
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.equal(U(500));
    void soon;
  });

  it("lets anyone reclaim a timed-out payment, not just the agent", async () => {
    // Requiring the agent key would strand funds exactly when that key is the
    // problem the policy exists for.
    const { agent, provider, other, usdc, policy, as } = await loadFixture(deployFixture);
    const deadline = BigInt(await time.latest()) + 60n;
    await (await as(agent)).write.openPayment([usdc.address, provider.account.address, U(50), deadline, H("q")]);
    await time.increaseTo(deadline + 1n);
    await (await as(other)).write.refundPayment([usdc.address, 1n]);
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.equal(U(500));
  });

  it("only the agent may open or settle", async () => {
    const { provider, other, usdc, as, soon } = await loadFixture(deployFixture);
    await expect(
      (await as(other)).write.openPayment([usdc.address, provider.account.address, U(10), await soon(), H("q")]),
    ).to.be.rejected;
  });

  it("stops entirely when the guardian pauses it", async () => {
    const { guardian, agent, provider, usdc, policy, as, soon } = await loadFixture(deployFixture);
    await (await as(guardian)).write.setPaused([true]);
    await expect(
      (await as(agent)).write.openPayment([usdc.address, provider.account.address, U(10), await soon(), H("q")]),
    ).to.be.rejected;
    void policy;
  });

  it("respects the allowlist when the policy is set to one", async () => {
    const { guardian, agent, provider, other, usdc, policy, as, soon } = await loadFixture(deployFixture);
    await (await as(guardian)).write.setPolicy([
      { periodSeconds: DAY, periodCap: U(500), perCounterpartyCap: U(200), allowlistOnly: true, expiresAt: 0n },
    ]);
    await (await as(guardian)).write.setAllowed([provider.account.address, true]);

    await (await as(agent)).write.openPayment([usdc.address, provider.account.address, U(10), await soon(), H("q")]);
    await expect(
      (await as(agent)).write.openPayment([usdc.address, other.account.address, U(10), await soon(), H("r")]),
    ).to.be.rejected;
    void policy;
  });

  it("bounds what a compromised agent key can take to one period's cap", async () => {
    // The whole point. The policy holds 5000; the cap is 500 a day. An attacker
    // with the agent key cannot reach the rest without waiting.
    const { agent, provider, other, usdc, policy, as, soon } = await loadFixture(deployFixture);
    expect(await usdc.read.balanceOf([policy.address])).to.equal(U(5_000));

    let drained = 0n;
    for (const to of [provider, other]) {
      try {
        await (await as(agent)).write.openPayment([usdc.address, to.account.address, U(180), await soon(), H(`x${to.account.address}`)]);
        drained += U(198); // payment plus bond
      } catch { /* capped */ }
    }
    await expect(
      (await as(agent)).write.openPayment([usdc.address, provider.account.address, U(180), await soon(), H("y")]),
    ).to.be.rejected;

    expect(drained <= U(500), `drained ${drained} in one period`).to.equal(true);
    // The rest is still sitting there, out of reach until the window turns.
    expect((await usdc.read.balanceOf([policy.address])) > U(4_000)).to.equal(true);
  });

  it("refuses to route when no escrow is configured", async () => {
    const [guardian, agent, provider] = await hre.viem.getWalletClients();
    const usdc = await hre.viem.deployContract("MockUSDC");
    const policy = await hre.viem.deployContract("TesseraSpendPolicy", [
      guardian.account.address,
      agent.account.address,
      { periodSeconds: DAY, periodCap: U(500), perCounterpartyCap: 0n, allowlistOnly: false, expiresAt: 0n },
    ]);
    const asAgent = await hre.viem.getContractAt("TesseraSpendPolicy", policy.address, {
      client: { wallet: agent },
    });
    await expect(
      asAgent.write.openPayment([usdc.address, provider.account.address, U(10), 9999999999n, H("q")]),
    ).to.be.rejected;
  });
});

/**
 * Delegation.
 *
 * One agent, one key, one flat cap is not how agentic work runs. An agent that
 * spawns a sub-task wants to hand it a budget it cannot exceed and cannot reach
 * past — and, crucially, delegating must not be a way around the agent's own
 * limit.
 */
describe("TesseraSpendPolicy — sub-agent budgets", () => {
  it("lets a sub-agent spend its slice", async () => {
    const { guardian, agent, provider, other, usdc, policy, as } = await loadFixture(deployFixture);
    await (await as(agent)).write.delegate([other.account.address, U(100)]);
    await (await as(other)).write.subSpend([usdc.address, provider.account.address, U(40)]);
    expect(await usdc.read.balanceOf([provider.account.address])).to.equal(U(40));
    expect(await policy.read.remainingForDelegate([other.account.address])).to.equal(U(60));
    void guardian;
  });

  it("stops the sub-agent at its own cap", async () => {
    const { agent, provider, other, usdc, as } = await loadFixture(deployFixture);
    await (await as(agent)).write.delegate([other.account.address, U(100)]);
    await (await as(other)).write.subSpend([usdc.address, provider.account.address, U(100)]);
    await expect((await as(other)).write.subSpend([usdc.address, provider.account.address, U(1)])).to.be.rejected;
  });

  it("charges the parent too, so delegation is not a way around the cap", async () => {
    // The property that matters. The parent may spend 500 a day; handing out
    // three 400-budgets must not make that 1200.
    const { guardian, agent, provider, other, usdc, policy, as } = await loadFixture(deployFixture);
    const [, , , , kid2, kid3] = await hre.viem.getWalletClients();
    for (const kid of [other, kid2, kid3]) {
      await (await as(agent)).write.delegate([kid.account.address, U(400)]);
    }

    let moved = 0n;
    for (const kid of [other, kid2, kid3]) {
      try {
        await (await as(kid)).write.subSpend([usdc.address, provider.account.address, U(180)]);
        moved += U(180);
      } catch { /* parent cap bit */ }
    }
    expect(moved <= U(500), `three children moved ${moved} against a 500 parent cap`).to.equal(true);
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.be.a("bigint");
    void guardian;
  });

  it("refuses a stranger with no delegation", async () => {
    const { provider, other, usdc, as } = await loadFixture(deployFixture);
    await expect((await as(other)).write.subSpend([usdc.address, provider.account.address, U(1)])).to.be.rejected;
  });

  it("revokes, and the sub-agent stops immediately", async () => {
    const { agent, provider, other, usdc, as } = await loadFixture(deployFixture);
    await (await as(agent)).write.delegate([other.account.address, U(100)]);
    await (await as(other)).write.subSpend([usdc.address, provider.account.address, U(10)]);
    await (await as(agent)).write.revokeDelegation([other.account.address]);
    await expect((await as(other)).write.subSpend([usdc.address, provider.account.address, U(10)])).to.be.rejected;
  });

  it("lets the guardian revoke as well as the agent", async () => {
    // A sub-agent most needs stopping when the agent that spawned it is the
    // thing that went wrong.
    const { guardian, agent, provider, other, usdc, as } = await loadFixture(deployFixture);
    await (await as(agent)).write.delegate([other.account.address, U(100)]);
    await (await as(guardian)).write.revokeDelegation([other.account.address]);
    await expect((await as(other)).write.subSpend([usdc.address, provider.account.address, U(10)])).to.be.rejected;
  });

  it("resets a sub-agent's allowance when the parent period turns", async () => {
    const { agent, provider, other, usdc, policy, as } = await loadFixture(deployFixture);
    await (await as(agent)).write.delegate([other.account.address, U(100)]);
    await (await as(other)).write.subSpend([usdc.address, provider.account.address, U(100)]);
    expect(await policy.read.remainingForDelegate([other.account.address])).to.equal(0n);
    await time.increase(DAY + 1);
    expect(await policy.read.remainingForDelegate([other.account.address])).to.equal(U(100));
  });

  it("stops every sub-agent when the guardian pauses the policy", async () => {
    const { guardian, agent, provider, other, usdc, as } = await loadFixture(deployFixture);
    await (await as(agent)).write.delegate([other.account.address, U(100)]);
    await (await as(guardian)).write.setPaused([true]);
    await expect((await as(other)).write.subSpend([usdc.address, provider.account.address, U(10)])).to.be.rejected;
  });

  it("will not delegate to the agent itself", async () => {
    const { agent, as } = await loadFixture(deployFixture);
    await expect((await as(agent)).write.delegate([agent.account.address, U(100)])).to.be.rejected;
  });
});
