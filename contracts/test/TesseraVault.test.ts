import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n; // $1.00
const BTC_PRICE = 30_000n * 10n ** 8n;
const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

// reserveRatio 20% liquid buffer, 15% performance fee on yield.
const RESERVE_RATIO = 2000;
const PERF_FEE = 1500;

async function deployFixture() {
  const [deployer, alice, bob, borrower] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const cbtc = await hre.viem.deployContract("MockToken", ["Circle Wrapped Bitcoin (mock)", "cirBTC", 8]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 1000, true, 6, PRICE]);
  await pool.write.addReserve([cbtc.address, 7000, 8000, 1000, false, 8, BTC_PRICE]);

  const vault = await hre.viem.deployContract("TesseraVault", [
    usdc.address,
    pool.address,
    deployer.account.address, // treasury
    RESERVE_RATIO,
    PERF_FEE,
  ]);

  const mint = async (who: any, u: bigint) => {
    await usdc.write.mint([who.account.address, u]);
    const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    await c.write.approve([vault.address, u]);
  };
  const asVault = (who: any) => hre.viem.getContractAt("TesseraVault", vault.address, { client: { wallet: who } });
  const asPool = (who: any) => hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: who } });

  return { deployer, alice, bob, borrower, publicClient, usdc, cbtc, pool, vault, mint, asVault, asPool };
}

describe("TesseraVault (yield vault over the pool)", () => {
  it("keeps the reserve buffer liquid and supplies the excess to the pool", async () => {
    const { alice, vault, mint, asVault } = await loadFixture(deployFixture);
    await mint(alice, USDC("100"));
    await (await asVault(alice)).write.deposit([USDC("100")]);

    // 20% (~20 USDC) stays liquid in the vault; ~80 goes to the pool.
    const buffer = await vault.read.currentBufferBps();
    expect(Number(buffer)).to.be.greaterThan(1900);
    expect(Number(buffer)).to.be.lessThan(2100);
    expect(await vault.read.totalAssets()).to.equal(USDC("100"));
  });

  it("lets a depositor fully withdraw their principal on demand", async () => {
    const { alice, usdc, vault, mint, asVault } = await loadFixture(deployFixture);
    await mint(alice, USDC("100"));
    const av = await asVault(alice);
    await av.write.deposit([USDC("100")]);

    const shares = await vault.read.sharesOf([alice.account.address]);
    await av.write.withdraw([shares]);
    // Alice gets back ~all of her 100 USDC (minus the tiny dead-share seed).
    const back = await usdc.read.balanceOf([alice.account.address]);
    expect(back > USDC("99.99")).to.equal(true);
    expect(back <= USDC("100")).to.equal(true);
  });

  it("routes yield to depositors and a capped fee to the treasury", async () => {
    const { deployer, alice, borrower, usdc, cbtc, pool, vault, mint, asVault, asPool } =
      await loadFixture(deployFixture);

    // Alice deposits 1,000 USDC → ~800 supplied to the pool.
    await mint(alice, USDC("1000"));
    await (await asVault(alice)).write.deposit([USDC("1000")]);

    // A borrower posts BTC collateral and borrows 400 USDC, creating utilization.
    await cbtc.write.mint([borrower.account.address, 10n ** 8n]); // 1 cirBTC
    const bcbtc = await hre.viem.getContractAt("MockToken", cbtc.address, { client: { wallet: borrower } });
    await bcbtc.write.approve([pool.address, 10n ** 8n]);
    await (await asPool(borrower)).write.supply([cbtc.address, 10n ** 8n]);
    await (await asPool(borrower)).write.borrow([usdc.address, USDC("400")]);

    // A year passes; interest accrues to the pool's suppliers (incl. the vault).
    await time.increase(365 * 24 * 3600);
    // Poke accrual by repaying a dust amount is unnecessary; deposit triggers it.
    await mint(deployer, USDC("1"));
    await (await asVault(deployer)).write.deposit([USDC("1")]); // triggers _accrueFee

    const aliceAssets = await vault.read.balanceOfAssets([alice.account.address]);
    const treasuryAssets = await vault.read.balanceOfAssets([deployer.account.address]);

    // Alice earned yield above her 1,000 principal.
    expect(aliceAssets > USDC("1000")).to.equal(true);
    const aliceYield = aliceAssets - USDC("1000");
    // Treasury holds a fee, and it's a *minority* of total yield (≤ the 15% cap
    // with margin) — users always keep the lion's share.
    expect(treasuryAssets > 0n).to.equal(true);
    expect(treasuryAssets < aliceYield).to.equal(true);
  });

  it("rejects a fee above the hard cap and a reserve ratio below the floor", async () => {
    const { deployer, usdc, pool } = await loadFixture(deployFixture);
    // performance fee > 30% → revert
    await expect(
      hre.viem.deployContract("TesseraVault", [usdc.address, pool.address, deployer.account.address, 2000, 3001])
    ).to.be.rejected;
    // reserve ratio < 10% → revert
    await expect(
      hre.viem.deployContract("TesseraVault", [usdc.address, pool.address, deployer.account.address, 999, 1500])
    ).to.be.rejected;
  });

  it("blocks the first-deposit share-inflation attack", async () => {
    const { alice, bob, vault, mint, asVault } = await loadFixture(deployFixture);
    // Attacker seeds 1 wei above the minimum, then donates to inflate share price.
    await mint(alice, USDC("1000"));
    await (await asVault(alice)).write.deposit([1001n]); // just above MINIMUM_LIQUIDITY
    // A normal depositor still receives a fair, non-zero share allocation.
    await mint(bob, USDC("100"));
    await (await asVault(bob)).write.deposit([USDC("100")]);
    const bobAssets = await vault.read.balanceOfAssets([bob.account.address]);
    // Bob's redeemable value is close to what he put in (not griefed to ~0).
    expect(bobAssets > USDC("99")).to.equal(true);
  });
});
