import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n;
const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

/**
 * The sleeve is a second venue for vault capital, and the reason it is valued at
 * cost rather than at market is that `totalAssets()` prices every share. These
 * tests are mostly about that: what the sleeve is worth to the share price must
 * not be something a trade can move.
 *
 * `MockToken` stands in for the LP token. Nothing here depends on it being an
 * AMM position — the vault deliberately does not know how the operator built it.
 */
async function deployFixture() {
  const [deployer, alice, operator] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, PRICE]);

  const lp = await hre.viem.deployContract("MockToken", ["Tessera LP (mock)", "tLP", 18]);
  const vault = await hre.viem.deployContract("TesseraVault", [
    usdc.address,
    pool.address,
    deployer.account.address,
    8000,
    1000,
  ]);

  async function fund(who: any, amount: bigint) {
    await usdc.write.mint([who.account.address, amount]);
    const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    await c.write.approve([vault.address, amount]);
  }
  await fund(alice, USDC("100000"));
  await fund(operator, USDC("100000"));

  // The operator holds LP tokens it created elsewhere, and approves the vault.
  await lp.write.mint([operator.account.address, 10n ** 21n]);
  const lpAsOperator = await hre.viem.getContractAt("MockToken", lp.address, { client: { wallet: operator } });
  await lpAsOperator.write.approve([vault.address, 10n ** 21n]);

  const vaultAs = (who: any) => hre.viem.getContractAt("TesseraVault", vault.address, { client: { wallet: who } });

  // The deployer is the vault owner; give it LP + approvals so it can operate.
  await lp.write.mint([deployer.account.address, 10n ** 21n]);
  await lp.write.approve([vault.address, 10n ** 21n]);
  await usdc.write.mint([deployer.account.address, USDC("100000")]);
  await usdc.write.approve([vault.address, USDC("100000")]);

  return { deployer, alice, operator, usdc, pool, lp, vault, vaultAs, fund };
}

describe("TesseraVault LP sleeve (a second venue, valued at cost)", () => {
  it("starts with no sleeve and no room", async () => {
    const { vault } = await loadFixture(deployFixture);
    expect(await vault.read.lpCostBasis()).to.equal(0n);
    expect(await vault.read.lpRoom()).to.equal(0n);
    const [, , inLp, lpBps] = await vault.read.allocation();
    expect(inLp).to.equal(0n);
    expect(lpBps).to.equal(0n);
  });

  it("caps the sleeve at the hard ceiling regardless of what the owner asks for", async () => {
    const { lp, vault } = await loadFixture(deployFixture);
    const hardCap = await vault.read.MAX_LP_ALLOCATION();
    expect(hardCap).to.equal(2000);
    await expect(vault.write.setLpStrategy([lp.address, hardCap + 1])).to.be.rejected;
    await vault.write.setLpStrategy([lp.address, hardCap]);
    expect(await vault.read.maxLpBps()).to.equal(hardCap);
  });

  it("moves capital into the sleeve and records what it paid", async () => {
    const { alice, lp, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    await vault.write.setLpStrategy([lp.address, 2000]);

    const before = await vault.read.totalAssets();
    await vault.write.enterLpSleeve([USDC("1000"), 10n ** 18n]);

    expect(await vault.read.lpCostBasis()).to.equal(USDC("1000"));
    expect(await lp.read.balanceOf([vault.address])).to.equal(10n ** 18n);
    // TVL is unchanged: assets moved venue, they did not appear or vanish.
    expect(await vault.read.totalAssets()).to.equal(before);
  });

  it("refuses to exceed the allocation cap", async () => {
    const { alice, lp, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    await vault.write.setLpStrategy([lp.address, 2000]); // 20% of 10,000 = 2,000

    expect(await vault.read.lpRoom()).to.equal(USDC("2000"));
    await expect(vault.write.enterLpSleeve([USDC("2001"), 10n ** 18n])).to.be.rejected;
    await vault.write.enterLpSleeve([USDC("2000"), 10n ** 18n]);
    expect(await vault.read.lpRoom()).to.equal(0n);
  });

  it("does not let the share price move when the sleeve's market value does", async () => {
    // This is the whole reason for cost-basis valuation. `lp` is a plain token
    // here, so "the AMM revalued" is simulated by minting more of it to the
    // vault — the position is worth more, and the share price must not care.
    const { alice, lp, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    await vault.write.setLpStrategy([lp.address, 2000]);
    await vault.write.enterLpSleeve([USDC("2000"), 10n ** 18n]);

    const shares = await vault.read.sharesOf([alice.account.address]);
    const priced = await vault.read.convertToAssets([shares]);

    // The sleeve doubles in market terms.
    await lp.write.mint([vault.address, 10n ** 18n]);

    expect(await vault.read.convertToAssets([shares])).to.equal(priced);
    expect(await vault.read.lpCostBasis()).to.equal(USDC("2000"));
  });

  it("realises the gain only on unwind, and shares it through the share price", async () => {
    const { deployer, alice, lp, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    await vault.write.setLpStrategy([lp.address, 2000]);
    await vault.write.enterLpSleeve([USDC("2000"), 10n ** 18n]);

    const shares = await vault.read.sharesOf([alice.account.address]);
    const before = await vault.read.convertToAssets([shares]);

    // The operator unwinds the position for more than it cost.
    await vault.write.exitLpSleeve([10n ** 18n, USDC("2300")]);

    expect(await vault.read.lpCostBasis()).to.equal(0n);
    const after = await vault.read.convertToAssets([shares]);
    expect(after > before).to.equal(true);
    void deployer;
  });

  it("books a loss honestly when the sleeve comes back worth less", async () => {
    const { alice, lp, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    await vault.write.setLpStrategy([lp.address, 2000]);
    await vault.write.enterLpSleeve([USDC("2000"), 10n ** 18n]);

    const shares = await vault.read.sharesOf([alice.account.address]);
    const before = await vault.read.convertToAssets([shares]);

    await vault.write.exitLpSleeve([10n ** 18n, USDC("1700")]);

    expect(await vault.read.lpCostBasis()).to.equal(0n);
    expect((await vault.read.convertToAssets([shares])) < before).to.equal(true);
  });

  it("releases cost basis proportionally on a partial unwind", async () => {
    const { alice, lp, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    await vault.write.setLpStrategy([lp.address, 2000]);
    await vault.write.enterLpSleeve([USDC("2000"), 10n ** 18n]);

    // Half the tokens out releases half the basis — a partial unwind cannot
    // book all the gain while keeping the position.
    await vault.write.exitLpSleeve([5n * 10n ** 17n, USDC("1200")]);
    expect(await vault.read.lpCostBasis()).to.equal(USDC("1000"));
    expect(await lp.read.balanceOf([vault.address])).to.equal(5n * 10n ** 17n);
  });

  it("keeps sleeve value out of what a depositor can withdraw", async () => {
    const { alice, lp, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    await vault.write.setLpStrategy([lp.address, 2000]);
    await vault.write.enterLpSleeve([USDC("2000"), 10n ** 18n]);

    // Her shares are still worth the full 10,000 — the sleeve is counted.
    const shares = await vault.read.sharesOf([alice.account.address]);
    expect((await vault.read.convertToAssets([shares])) > USDC("9000")).to.equal(true);
    // But she cannot withdraw the part sitting in an AMM position.
    const max = await vault.read.maxWithdraw([alice.account.address]);
    expect(max < USDC("10000")).to.equal(true);
    // What she can withdraw, she can actually withdraw.
    await (await vaultAs(alice)).write.withdraw([(shares * max) / (await vault.read.convertToAssets([shares]))]);
  });

  it("reports the split across buffer, pool and sleeve", async () => {
    const { alice, lp, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    await vault.write.setLpStrategy([lp.address, 2000]);
    await vault.write.enterLpSleeve([USDC("1000"), 10n ** 18n]);

    const [buffer, inPool, inLp, lpBps] = await vault.read.allocation();
    expect(inLp).to.equal(USDC("1000"));
    expect(lpBps).to.equal(1000n); // 10% of TVL
    expect(buffer + inPool + inLp).to.equal(await vault.read.totalAssets());
  });

  it("refuses to repoint the sleeve while a position is open", async () => {
    const { alice, lp, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    await vault.write.setLpStrategy([lp.address, 2000]);
    await vault.write.enterLpSleeve([USDC("1000"), 10n ** 18n]);

    const other = await hre.viem.deployContract("MockToken", ["Other LP", "oLP", 18]);
    // Swapping the token out would leave the cost basis describing assets the
    // vault no longer holds.
    await expect(vault.write.setLpStrategy([other.address, 2000])).to.be.rejected;
    // Changing only the cap is fine.
    await vault.write.setLpStrategy([lp.address, 1500]);
    expect(await vault.read.maxLpBps()).to.equal(1500);
  });

  it("only the owner may point, enter, or exit the sleeve", async () => {
    const { alice, lp, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    const v = await vaultAs(alice);
    await expect(v.write.setLpStrategy([lp.address, 2000])).to.be.rejected;
    await vault.write.setLpStrategy([lp.address, 2000]);
    await expect(v.write.enterLpSleeve([USDC("100"), 10n ** 18n])).to.be.rejected;
    await vault.write.enterLpSleeve([USDC("100"), 10n ** 18n]);
    await expect(v.write.exitLpSleeve([10n ** 18n, USDC("100")])).to.be.rejected;
  });

  it("refuses to enter without a sleeve configured", async () => {
    const { alice, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    await expect(vault.write.enterLpSleeve([USDC("100"), 10n ** 18n])).to.be.rejected;
  });

  it("leaves depositors able to exit fully once the sleeve is unwound", async () => {
    const { alice, lp, vault, vaultAs } = await loadFixture(deployFixture);
    await (await vaultAs(alice)).write.deposit([USDC("10000")]);
    await vault.write.setLpStrategy([lp.address, 2000]);
    await vault.write.enterLpSleeve([USDC("2000"), 10n ** 18n]);
    await vault.write.exitLpSleeve([10n ** 18n, USDC("2000")]);

    const shares = await vault.read.sharesOf([alice.account.address]);
    const max = await vault.read.maxWithdraw([alice.account.address]);
    expect(max).to.equal(await vault.read.convertToAssets([shares]));
  });
});
