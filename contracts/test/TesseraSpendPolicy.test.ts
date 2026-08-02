import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const U = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));
const DAY = 24 * 3600;

/**
 * The policy the app already had was an `if` in a Node process. These tests are
 * about the difference: what a holder of the agent key can and cannot do.
 */
async function deployFixture() {
  const [guardian, agent, provider, other] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");

  const policy = await hre.viem.deployContract("TesseraSpendPolicy", [
    guardian.account.address,
    agent.account.address,
    { periodSeconds: DAY, periodCap: U("50"), perCounterpartyCap: U("20"), allowlistOnly: false, expiresAt: 0n },
  ]);

  await usdc.write.mint([guardian.account.address, U("1000")]);
  await usdc.write.approve([policy.address, U("1000")]);
  await policy.write.fund([usdc.address, U("500")]);

  const as = (who: any) =>
    hre.viem.getContractAt("TesseraSpendPolicy", policy.address, { client: { wallet: who } });

  return { guardian, agent, provider, other, usdc, policy, as };
}

describe("TesseraSpendPolicy (the agent's limit, enforced on chain)", () => {
  it("lets the agent spend inside the cap", async () => {
    const { agent, provider, usdc, policy, as } = await loadFixture(deployFixture);
    await (await as(agent)).write.spend([usdc.address, provider.account.address, U("15")]);
    expect(await usdc.read.balanceOf([provider.account.address])).to.equal(U("15"));
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.equal(U("35"));
  });

  it("stops the agent at the period cap, whatever it asks for", async () => {
    const { agent, provider, other, usdc, policy, as } = await loadFixture(deployFixture);
    const [, , , , spare] = await hre.viem.getWalletClients();
    const a = await as(agent);
    // Spread across three counterparties so the per-counterparty cap is not
    // what bites — the period cap is what this test is about.
    await a.write.spend([usdc.address, provider.account.address, U("20")]);
    await a.write.spend([usdc.address, other.account.address, U("20")]);
    await a.write.spend([usdc.address, spare.account.address, U("10")]);
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.equal(0n);

    // The property the whole contract exists for: a fully compromised agent —
    // right key, right calldata, no bugs — still cannot get more out.
    await expect(a.write.spend([usdc.address, other.account.address, 1n])).to.be.rejected;
    expect(await usdc.read.balanceOf([policy.address])).to.equal(U("450"));
  });

  it("caps what can go to any one counterparty", async () => {
    const { agent, provider, usdc, as } = await loadFixture(deployFixture);
    const a = await as(agent);
    await a.write.spend([usdc.address, provider.account.address, U("20")]);
    // Room left in the period, none left for this destination.
    await expect(a.write.spend([usdc.address, provider.account.address, 1n])).to.be.rejected;
  });

  it("refills when the window rolls over", async () => {
    const { agent, provider, usdc, policy, as } = await loadFixture(deployFixture);
    const a = await as(agent);
    await a.write.spend([usdc.address, provider.account.address, U("20")]);
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.equal(U("30"));
    await time.increase(DAY + 60);
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.equal(U("50"));
    await a.write.spend([usdc.address, provider.account.address, U("20")]);
  });

  it("uses wall-clock windows the agent cannot restart by timing its spends", async () => {
    const { agent, provider, usdc, policy, as } = await loadFixture(deployFixture);
    const a = await as(agent);
    const untilReset = Number(await policy.read.secondsUntilReset());
    await time.increase(Math.max(1, untilReset - 30));
    await a.write.spend([usdc.address, provider.account.address, U("20")]);
    await time.increase(60);
    // A sliding window anchored on first use would still be counting; a fixed
    // one has rolled. Fixed is the safer of the two — it cannot be gamed — and
    // this pins which one is implemented.
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.equal(U("50"));
  });

  it("refuses anyone who is not the agent", async () => {
    const { guardian, provider, other, usdc, as } = await loadFixture(deployFixture);
    await expect((await as(guardian)).write.spend([usdc.address, provider.account.address, 1n])).to.be.rejected;
    await expect((await as(other)).write.spend([usdc.address, provider.account.address, 1n])).to.be.rejected;
  });

  it("will not let the agent rewrite its own limits", async () => {
    const { agent, other, usdc, as } = await loadFixture(deployFixture);
    const a = await as(agent);
    // The failure that would make all of this decoration.
    await expect(
      a.write.setPolicy([
        { periodSeconds: DAY, periodCap: U("1000000"), perCounterpartyCap: 0n, allowlistOnly: false, expiresAt: 0n },
      ]),
    ).to.be.rejected;
    await expect(a.write.setPaused([false])).to.be.rejected;
    await expect(a.write.setAgent([other.account.address])).to.be.rejected;
    await expect(a.write.setGuardian([other.account.address])).to.be.rejected;
    await expect(a.write.sweep([usdc.address, other.account.address, 0n])).to.be.rejected;
    await expect(a.write.setAllowed([other.account.address, true])).to.be.rejected;
  });

  it("cannot be constructed with the guardian as the agent", async () => {
    const [guardian] = await hre.viem.getWalletClients();
    await expect(
      hre.viem.deployContract("TesseraSpendPolicy", [
        guardian.account.address,
        guardian.account.address,
        { periodSeconds: DAY, periodCap: U("50"), perCounterpartyCap: 0n, allowlistOnly: false, expiresAt: 0n },
      ]),
    ).to.be.rejected;
  });

  it("honours an allowlist when one is set", async () => {
    const { guardian, agent, provider, other, usdc, as } = await loadFixture(deployFixture);
    const g = await as(guardian);
    await g.write.setPolicy([
      { periodSeconds: DAY, periodCap: U("50"), perCounterpartyCap: 0n, allowlistOnly: true, expiresAt: 0n },
    ]);
    const a = await as(agent);
    await expect(a.write.spend([usdc.address, provider.account.address, U("1")])).to.be.rejected;
    await g.write.setAllowed([provider.account.address, true]);
    await a.write.spend([usdc.address, provider.account.address, U("1")]);
    await expect(a.write.spend([usdc.address, other.account.address, U("1")])).to.be.rejected;
  });

  it("stops spending when the policy expires", async () => {
    const { guardian, agent, provider, usdc, as } = await loadFixture(deployFixture);
    const expires = BigInt(await time.latest()) + 3600n;
    await (await as(guardian)).write.setPolicy([
      { periodSeconds: DAY, periodCap: U("50"), perCounterpartyCap: 0n, allowlistOnly: false, expiresAt: expires },
    ]);
    const a = await as(agent);
    await a.write.spend([usdc.address, provider.account.address, U("1")]);
    await time.increase(3601);
    // An agent nobody is watching any more eventually stops on its own.
    await expect(a.write.spend([usdc.address, provider.account.address, U("1")])).to.be.rejected;
  });

  it("lets the guardian stop everything at once", async () => {
    const { guardian, agent, provider, usdc, as } = await loadFixture(deployFixture);
    await (await as(guardian)).write.setPaused([true]);
    await expect((await as(agent)).write.spend([usdc.address, provider.account.address, 1n])).to.be.rejected;
    await (await as(guardian)).write.setPaused([false]);
    await (await as(agent)).write.spend([usdc.address, provider.account.address, 1n]);
  });

  it("does not hand a rotated key a fresh budget", async () => {
    const { guardian, agent, provider, other, usdc, policy, as } = await loadFixture(deployFixture);
    await (await as(agent)).write.spend([usdc.address, provider.account.address, U("20")]);
    await (await as(guardian)).write.setAgent([other.account.address]);
    // Spending is tracked per token per window, not per key — otherwise
    // rotating would be a way to spend the cap twice in one period.
    expect(await policy.read.remainingThisPeriod([usdc.address])).to.equal(U("30"));
    await expect((await as(other)).write.spend([usdc.address, provider.account.address, U("31")])).to.be.rejected;
  });

  it("lets the guardian sweep regardless of the caps", async () => {
    const { guardian, usdc, policy, as } = await loadFixture(deployFixture);
    // The caps restrain the agent's spending, not the owner's own money.
    await (await as(guardian)).write.sweep([usdc.address, guardian.account.address, 0n]);
    expect(await usdc.read.balanceOf([policy.address])).to.equal(0n);
  });

  it("answers whether a spend would go through, and why not", async () => {
    const { agent, provider, usdc, policy, as } = await loadFixture(deployFixture);
    const [ok] = await policy.read.canSpend([usdc.address, provider.account.address, U("10")]);
    expect(ok).to.equal(true);

    const [ok2, why] = await policy.read.canSpend([usdc.address, provider.account.address, U("100")]);
    expect(ok2).to.equal(false);
    expect(why).to.contain("period cap");

    await (await as(agent)).write.spend([usdc.address, provider.account.address, U("20")]);
    const [ok3, why3] = await policy.read.canSpend([usdc.address, provider.account.address, U("5")]);
    expect(ok3).to.equal(false);
    expect(why3).to.contain("counterparty");
  });

  it("rejects a policy that cannot be evaluated", async () => {
    const { guardian, as } = await loadFixture(deployFixture);
    const g = await as(guardian);
    // A zero period would divide by zero when picking a window.
    await expect(
      g.write.setPolicy([
        { periodSeconds: 0, periodCap: U("1"), perCounterpartyCap: 0n, allowlistOnly: false, expiresAt: 0n },
      ]),
    ).to.be.rejected;
    // A zero cap permits nothing; `setPaused` says that more honestly.
    await expect(
      g.write.setPolicy([
        { periodSeconds: DAY, periodCap: 0n, perCounterpartyCap: 0n, allowlistOnly: false, expiresAt: 0n },
      ]),
    ).to.be.rejected;
  });
});
