import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n; // $1.00
const EUR_PRICE = 108_000_000n; // $1.08
const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

const SWAP_FEE = 30; // 0.30%
const APP_FEE_SHARE = 5000; // 50% of the fee to the app treasury

async function deployFixture() {
  const [deployer, alice, treasury] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin (mock)", "EURC", 6]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 1000, true, 6, PRICE]);
  await pool.write.addReserve([eurc.address, 8500, 9000, 1000, true, 6, EUR_PRICE]);

  const swap = await hre.viem.deployContract("TesseraSwap", [
    pool.address,
    treasury.account.address,
    SWAP_FEE,
    APP_FEE_SHARE,
  ]);

  // Seed the swap desk's inventory with both tokens.
  await usdc.write.mint([deployer.account.address, USDC("10000")]);
  await eurc.write.mint([deployer.account.address, USDC("10000")]);
  await usdc.write.approve([swap.address, USDC("10000")]);
  await eurc.write.approve([swap.address, USDC("10000")]);
  await swap.write.seed([usdc.address, USDC("5000")]);
  await swap.write.seed([eurc.address, USDC("5000")]);

  const asSwap = (who: any) => hre.viem.getContractAt("TesseraSwap", swap.address, { client: { wallet: who } });
  return { deployer, alice, treasury, usdc, eurc, pool, swap, asSwap };
}

describe("TesseraSwap (oracle-priced swap desk)", () => {
  it("quotes at oracle prices with the fee removed", async () => {
    const { usdc, eurc, swap } = await loadFixture(deployFixture);
    // 108 USDC → EURC. At $1.08/EUR, 108 USD buys 100 EURC gross, minus 0.30%.
    const [out, fee, appFee] = await swap.read.quote([usdc.address, eurc.address, USDC("108")]);
    expect(out > USDC("99.6") && out < USDC("100")).to.equal(true);
    expect(fee > 0n).to.equal(true);
    expect(appFee).to.equal(fee / 2n); // 50% app share
  });

  it("executes a swap and pays the app its fee share", async () => {
    const { alice, treasury, usdc, eurc, swap, asSwap } = await loadFixture(deployFixture);
    await usdc.write.mint([alice.account.address, USDC("108")]);
    const aliceUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: alice } });
    await aliceUsdc.write.approve([swap.address, USDC("108")]);

    const treasuryBefore = await eurc.read.balanceOf([treasury.account.address]);
    const [expectedOut, , appFee] = await swap.read.quote([usdc.address, eurc.address, USDC("108")]);
    await (await asSwap(alice)).write.swap([usdc.address, eurc.address, USDC("108"), expectedOut]);

    // Alice received the EURC output; the treasury received the app fee.
    expect(await eurc.read.balanceOf([alice.account.address])).to.equal(expectedOut);
    const treasuryAfter = await eurc.read.balanceOf([treasury.account.address]);
    expect(treasuryAfter - treasuryBefore).to.equal(appFee);
  });

  it("enforces slippage protection", async () => {
    const { alice, usdc, eurc, swap, asSwap } = await loadFixture(deployFixture);
    await usdc.write.mint([alice.account.address, USDC("108")]);
    const aliceUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: alice } });
    await aliceUsdc.write.approve([swap.address, USDC("108")]);
    // Demand more out than the quote allows → revert.
    await expect(
      (await asSwap(alice)).write.swap([usdc.address, eurc.address, USDC("108"), USDC("101")])
    ).to.be.rejected;
  });

  it("reverts when inventory can't cover the output", async () => {
    const { alice, usdc, eurc, swap, asSwap } = await loadFixture(deployFixture);
    // Try to pull far more EURC than the 5,000 seeded.
    await usdc.write.mint([alice.account.address, USDC("100000")]);
    const aliceUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: alice } });
    await aliceUsdc.write.approve([swap.address, USDC("100000")]);
    await expect(
      (await asSwap(alice)).write.swap([usdc.address, eurc.address, USDC("100000"), 0n])
    ).to.be.rejected;
  });

  it("caps the swap fee and app-fee share at construction", async () => {
    const { deployer, treasury, pool } = await loadFixture(deployFixture);
    await expect(
      hre.viem.deployContract("TesseraSwap", [pool.address, treasury.account.address, 501, 5000])
    ).to.be.rejected; // fee > 5%
    await expect(
      hre.viem.deployContract("TesseraSwap", [pool.address, treasury.account.address, 30, 10001])
    ).to.be.rejected; // app share > 100%
  });
});
