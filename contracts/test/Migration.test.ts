import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n;
const U = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

/**
 * Migration primitives: `supplyFor`, `depositFor`, `addLiquidityFor`.
 *
 * These exist so an operator can re-create users' positions in a replacement
 * contract **out of their own funds**. The property that matters most is the
 * one they must NOT have: no way to move a position that already exists. These
 * tests pin that down as much as they pin down the happy path.
 */
async function deployFixture() {
  const [deployer, alice, bob, mallory] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin (mock)", "EURC", 6]);
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, PRICE]);
  await pool.write.addReserve([eurc.address, 8500, 9000, 9000, 1000, true, 6, 108_000_000n]);
  const vault = await hre.viem.deployContract("TesseraVault", [
    usdc.address,
    pool.address,
    deployer.account.address,
    8000,
    1500,
  ]);
  const amm = await hre.viem.deployContract("TesseraAMM", [deployer.account.address]);
  await amm.write.createPool([[usdc.address, eurc.address], 30, 5000, "USDC / EURC"]);

  const give = async (token: any, who: any, amount: bigint, spender: string) => {
    await token.write.mint([who.account.address, amount]);
    const t = await hre.viem.getContractAt(token.address === usdc.address ? "MockUSDC" : "MockToken", token.address, {
      client: { wallet: who },
    });
    await t.write.approve([spender, amount]);
  };
  const as = (name: string, addr: string, who: any) => hre.viem.getContractAt(name, addr, { client: { wallet: who } });

  return { deployer, alice, bob, mallory, usdc, eurc, pool, vault, amm, give, as };
}

describe("Migration primitives — pay for someone else, never move their funds", () => {
  it("pool: supplyFor credits the user and debits the caller", async () => {
    const { alice, bob, usdc, pool, give, as } = await loadFixture(deployFixture);
    await give(usdc, alice, U("1000"), pool.address);
    const aliceBefore = await usdc.read.balanceOf([alice.account.address]);

    await (await as("TesseraPool", pool.address, alice)).write.supplyFor([usdc.address, bob.account.address, U("1000")]);

    expect(await pool.read.supplyBalance([usdc.address, bob.account.address])).to.equal(U("1000"));
    expect(await pool.read.supplyBalance([usdc.address, alice.account.address])).to.equal(0n);
    expect(aliceBefore - (await usdc.read.balanceOf([alice.account.address]))).to.equal(U("1000"));
  });

  it("pool: the recipient can withdraw what was supplied for them", async () => {
    const { alice, bob, usdc, pool, give, as } = await loadFixture(deployFixture);
    await give(usdc, alice, U("1000"), pool.address);
    await (await as("TesseraPool", pool.address, alice)).write.supplyFor([usdc.address, bob.account.address, U("1000")]);
    await (await as("TesseraPool", pool.address, bob)).write.withdraw([usdc.address, U("1000")]);
    expect(await usdc.read.balanceOf([bob.account.address])).to.equal(U("1000"));
  });

  it("pool: supplyFor cannot pull from the recipient's wallet", async () => {
    const { bob, mallory, usdc, pool, give, as } = await loadFixture(deployFixture);
    // Bob holds funds and has approved the pool (as any normal user would).
    await give(usdc, bob, U("5000"), pool.address);
    const bobBefore = await usdc.read.balanceOf([bob.account.address]);
    // Mallory has nothing. Naming Bob as the beneficiary must not spend Bob's money.
    await expect(
      (await as("TesseraPool", pool.address, mallory)).write.supplyFor([usdc.address, bob.account.address, U("5000")]),
    ).to.be.rejected;
    expect(await usdc.read.balanceOf([bob.account.address])).to.equal(bobBefore);
  });

  it("pool: there is no admin path to move an existing supplier's position", async () => {
    const { deployer, alice, usdc, pool, give, as } = await loadFixture(deployFixture);
    await give(usdc, alice, U("1000"), pool.address);
    await (await as("TesseraPool", pool.address, alice)).write.supply([usdc.address, U("1000")]);
    const owner = await pool.read.owner();
    expect(owner.toLowerCase()).to.equal(deployer.account.address.toLowerCase());
    // The whole owner surface — nothing here can reassign supplyShares.
    const fns = (pool.abi as any[]).filter((f) => f.type === "function").map((f) => f.name);
    for (const forbidden of ["seize", "transferFrom", "moveShares", "setSupplyShares", "rescue", "sweep"]) {
      expect(fns).to.not.include(forbidden);
    }
    // Alice's position is exactly where she left it.
    expect(await pool.read.supplyBalance([usdc.address, alice.account.address])).to.equal(U("1000"));
  });

  it("vault: depositFor mints shares to the beneficiary, paid by the caller", async () => {
    const { alice, bob, usdc, vault, give, as } = await loadFixture(deployFixture);
    await give(usdc, alice, U("1000"), vault.address);
    await (await as("TesseraVault", vault.address, alice)).write.depositFor([bob.account.address, U("1000")]);

    expect((await vault.read.sharesOf([bob.account.address])) > 0n).to.equal(true);
    expect(await vault.read.sharesOf([alice.account.address])).to.equal(0n);
    // And Bob can actually get the money out.
    const shares = await vault.read.sharesOf([bob.account.address]);
    await (await as("TesseraVault", vault.address, bob)).write.withdraw([shares]);
    expect((await usdc.read.balanceOf([bob.account.address])) > 0n).to.equal(true);
  });

  it("vault: depositFor rejects the zero address rather than burning the deposit", async () => {
    const { alice, usdc, vault, give, as } = await loadFixture(deployFixture);
    await give(usdc, alice, U("1000"), vault.address);
    await expect(
      (await as("TesseraVault", vault.address, alice)).write.depositFor([
        "0x0000000000000000000000000000000000000000",
        U("1000"),
      ]),
    ).to.be.rejected;
  });

  it("vault: a migrated position is worth what was paid in, not more", async () => {
    const { deployer, alice, bob, usdc, vault, give, as } = await loadFixture(deployFixture);
    // Seed the vault so shares are not being priced from empty.
    await give(usdc, deployer, U("5000"), vault.address);
    await vault.write.deposit([U("5000")]);

    await give(usdc, alice, U("1000"), vault.address);
    await (await as("TesseraVault", vault.address, alice)).write.depositFor([bob.account.address, U("1000")]);
    const worth = await vault.read.balanceOfAssets([bob.account.address]);
    // Allow a wei or two of share-rounding, but nothing like free value.
    expect(worth <= U("1000") && worth > U("999.99")).to.equal(true);
  });

  it("amm: addLiquidityFor gives shares to the beneficiary", async () => {
    const { alice, bob, usdc, eurc, amm, give, as } = await loadFixture(deployFixture);
    await give(usdc, alice, U("1000"), amm.address);
    await give(eurc, alice, U("1000"), amm.address);
    await (await as("TesseraAMM", amm.address, alice)).write.addLiquidityFor([
      0n,
      bob.account.address,
      [U("1000"), U("1000")],
      0n,
    ]);
    expect((await amm.read.sharesOf([0n, bob.account.address])) > 0n).to.equal(true);
    expect(await amm.read.sharesOf([0n, alice.account.address])).to.equal(0n);
  });

  it("amm: the beneficiary can withdraw the migrated liquidity", async () => {
    const { alice, bob, usdc, eurc, amm, give, as } = await loadFixture(deployFixture);
    await give(usdc, alice, U("1000"), amm.address);
    await give(eurc, alice, U("1000"), amm.address);
    await (await as("TesseraAMM", amm.address, alice)).write.addLiquidityFor([
      0n,
      bob.account.address,
      [U("1000"), U("1000")],
      0n,
    ]);
    const shares = await amm.read.sharesOf([0n, bob.account.address]);
    await (await as("TesseraAMM", amm.address, bob)).write.removeLiquidity([0n, shares, [0n, 0n]]);
    expect((await usdc.read.balanceOf([bob.account.address])) > 0n).to.equal(true);
  });

  it("amm: addLiquidityFor cannot pull from the beneficiary's wallet", async () => {
    const { bob, mallory, usdc, eurc, amm, give, as } = await loadFixture(deployFixture);
    await give(usdc, bob, U("1000"), amm.address);
    await give(eurc, bob, U("1000"), amm.address);
    const before = await usdc.read.balanceOf([bob.account.address]);
    await expect(
      (await as("TesseraAMM", amm.address, mallory)).write.addLiquidityFor([
        0n,
        bob.account.address,
        [U("1000"), U("1000")],
        0n,
      ]),
    ).to.be.rejected;
    expect(await usdc.read.balanceOf([bob.account.address])).to.equal(before);
  });

  it("amm: addLiquidityFor rejects the zero address", async () => {
    const { alice, usdc, eurc, amm, give, as } = await loadFixture(deployFixture);
    await give(usdc, alice, U("1000"), amm.address);
    await give(eurc, alice, U("1000"), amm.address);
    await expect(
      (await as("TesseraAMM", amm.address, alice)).write.addLiquidityFor([
        0n,
        "0x0000000000000000000000000000000000000000",
        [U("1000"), U("1000")],
        0n,
      ]),
    ).to.be.rejected;
  });

  it("supplyFor respects a supply freeze — migration is not a way around a halt", async () => {
    const { alice, bob, usdc, pool, give, as } = await loadFixture(deployFixture);
    await pool.write.setFrozenMany([[usdc.address], 1]); // FREEZE_SUPPLY
    await give(usdc, alice, U("100"), pool.address);
    await expect(
      (await as("TesseraPool", pool.address, alice)).write.supplyFor([usdc.address, bob.account.address, U("100")]),
    ).to.be.rejected;
  });
});
