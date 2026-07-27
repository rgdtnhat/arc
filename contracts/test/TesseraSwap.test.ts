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

  // --- inventory funding ----------------------------------------------------
  //
  // `swap` reads inventory as `balanceOf(address(this))`, with no internal
  // ledger. These pin the consequence: ownership does not gate *adding*
  // inventory, and it never did — so the permissionless `fund` is a visible
  // route to something that was always possible, not a new capability.

  it("lets anyone fund inventory, and fills swaps out of it", async () => {
    const { deployer, alice, treasury, pool, usdc, eurc } = await loadFixture(deployFixture);
    // A desk owned by someone else entirely, with no inventory.
    const desk = await hre.viem.deployContract("TesseraSwap", [
      pool.address, treasury.account.address, SWAP_FEE, APP_FEE_SHARE,
    ]);
    await desk.write.transferOwnership([treasury.account.address]);
    expect((await desk.read.owner()).toLowerCase()).to.equal(treasury.account.address.toLowerCase());

    // Alice is not the owner. She funds it anyway.
    await eurc.write.mint([alice.account.address, USDC("500")]);
    const aliceEurc = await hre.viem.getContractAt("MockToken", eurc.address, { client: { wallet: alice } });
    await aliceEurc.write.approve([desk.address, USDC("500")]);
    const asAlice = await hre.viem.getContractAt("TesseraSwap", desk.address, { client: { wallet: alice } });
    await asAlice.write.fund([eurc.address, USDC("500")]);
    expect(await desk.read.inventoryOf([eurc.address])).to.equal(USDC("500"));

    // And that inventory is fillable: the deployer can now swap against it.
    await usdc.write.mint([deployer.account.address, USDC("108")]);
    await usdc.write.approve([desk.address, USDC("108")]);
    const before = await eurc.read.balanceOf([deployer.account.address]);
    await desk.write.swap([usdc.address, eurc.address, USDC("108"), 0n]);
    expect(await eurc.read.balanceOf([deployer.account.address]) > before).to.equal(true);
  });

  it("counts a plain transfer as inventory, which is why fund() gates nothing", async () => {
    const { alice, treasury, pool, usdc, eurc } = await loadFixture(deployFixture);
    const desk = await hre.viem.deployContract("TesseraSwap", [
      pool.address, treasury.account.address, SWAP_FEE, APP_FEE_SHARE,
    ]);
    await desk.write.transferOwnership([treasury.account.address]);

    // No approval, no fund(), no ownership — just an ERC-20 transfer.
    await eurc.write.mint([alice.account.address, USDC("300")]);
    const aliceEurc = await hre.viem.getContractAt("MockToken", eurc.address, { client: { wallet: alice } });
    await aliceEurc.write.transfer([desk.address, USDC("300")]);
    expect(await desk.read.inventoryOf([eurc.address])).to.equal(USDC("300"));

    // Fillable, exactly as if it had been seeded by the owner.
    await usdc.write.mint([alice.account.address, USDC("108")]);
    const aliceUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: alice } });
    await aliceUsdc.write.approve([desk.address, USDC("108")]);
    const asAlice = await hre.viem.getContractAt("TesseraSwap", desk.address, { client: { wallet: alice } });
    const before = await eurc.read.balanceOf([alice.account.address]);
    await asAlice.write.swap([usdc.address, eurc.address, USDC("108"), 0n]);
    expect(await eurc.read.balanceOf([alice.account.address]) > before).to.equal(true);
  });

  it("still lets only the owner take inventory out", async () => {
    const { alice, usdc, swap, asSwap } = await loadFixture(deployFixture);
    // Funding is open; withdrawing is not. This is the asymmetry that makes
    // inventory app-owned — a donation, with no claim on it.
    await expect(
      (await asSwap(alice)).write.withdrawInventory([usdc.address, USDC("1"), alice.account.address])
    ).to.be.rejected;
    await swap.write.withdrawInventory([usdc.address, USDC("1"), alice.account.address]);
    expect(await usdc.read.balanceOf([alice.account.address])).to.equal(USDC("1"));
  });

  it("rejects a zero-amount fund", async () => {
    const { usdc, swap } = await loadFixture(deployFixture);
    await expect(swap.write.fund([usdc.address, 0n])).to.be.rejected;
  });

  it("reports inventory as the desk's own balance", async () => {
    const { usdc, eurc, swap } = await loadFixture(deployFixture);
    expect(await swap.read.inventoryOf([usdc.address])).to.equal(await usdc.read.balanceOf([swap.address]));
    expect(await swap.read.inventoryOf([eurc.address])).to.equal(await eurc.read.balanceOf([swap.address]));
  });
});
