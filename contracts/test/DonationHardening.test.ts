import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n;
const U = (n: number) => BigInt(Math.round(n * 1e6));
const H = (s: string) => `0x${Buffer.from(s.padEnd(32, "\0")).toString("hex")}` as `0x${string}`;

/**
 * The 2026 donation-attack family, and what stops it here.
 *
 * July 2026 took $6.04m from Lazy Summer's USDC vaults and March took $240k from
 * sDOLA on Llamalend — both share-price manipulation against vaults whose NAV
 * read a balance rather than an accounting figure. `totalAssets()` here does
 * read a balance, so it is inflatable by anyone willing to transfer tokens in.
 *
 * Two things bound it, and they bound different halves. Dead shares stop the
 * classic first-depositor theft. The credit check stops the quieter one: once a
 * donation has made a single share expensive, a deposit that does not divide
 * evenly forfeits up to a share's worth to everyone else, silently.
 */
async function vaultFixture() {
  const [deployer, attacker, victim] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, PRICE]);
  const vault = await hre.viem.deployContract("TesseraVault", [
    usdc.address, pool.address, deployer.account.address, 8000, 1500,
  ]);

  const fund = async (who: any, amt: bigint) => {
    await usdc.write.mint([who.account.address, amt]);
    const t = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    await t.write.approve([vault.address, amt]);
  };
  const vaultAs = (who: any) =>
    hre.viem.getContractAt("TesseraVault", vault.address, { client: { wallet: who } });
  const usdcAs = (who: any) => hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });

  return { deployer, attacker, victim, usdc, pool, vault, fund, vaultAs, usdcAs };
}

describe("Donation hardening (Lazy Summer / sDOLA, 2026)", () => {
  it("locks dead shares on the first deposit", async () => {
    const f = await loadFixture(vaultFixture);
    await f.fund(f.attacker, U(1_000));
    await (await f.vaultAs(f.attacker)).write.deposit([U(1_000)]);
    // The classic attack needs the first depositor to own *all* the shares.
    expect(await f.vault.read.sharesOf(["0x0000000000000000000000000000000000000000"])).to.equal(1_000n);
  });

  it("refuses a first deposit too small to leave dead shares behind", async () => {
    const f = await loadFixture(vaultFixture);
    await f.fund(f.attacker, U(1));
    await expect((await f.vaultAs(f.attacker)).write.deposit([500n])).to.be.rejectedWith("min deposit");
  });

  it("stops a donated share price from quietly eating a later deposit", async () => {
    const f = await loadFixture(vaultFixture);
    // Attacker takes the smallest viable position...
    await f.fund(f.attacker, U(10_000));
    await (await f.vaultAs(f.attacker)).write.deposit([1_001n]);
    // ...then donates, with no deposit call and no shares minted.
    await (await f.usdcAs(f.attacker)).write.transfer([f.vault.address, U(5_000)]);

    // A victim's deposit no longer divides evenly. Rather than silently
    // forfeiting the remainder to the attacker, it is refused with a reason.
    await f.fund(f.victim, U(10_000));
    await expect((await f.vaultAs(f.victim)).write.deposit([U(1)])).to.be.rejectedWith(
      "deposit too small at this share price",
    );
  });

  it("still accepts a deposit large enough to price fairly after a donation", async () => {
    const f = await loadFixture(vaultFixture);
    await f.fund(f.attacker, U(10_000));
    await (await f.vaultAs(f.attacker)).write.deposit([U(1_000)]);
    await (await f.usdcAs(f.attacker)).write.transfer([f.vault.address, U(1_000)]);

    await f.fund(f.victim, U(10_000));
    await (await f.vaultAs(f.victim)).write.deposit([U(500)]);

    // What they can redeem is within a rounding step of what they paid.
    const worth = await f.vault.read.balanceOfAssets([f.victim.account.address]);
    expect(worth >= U(499)).to.equal(true, `victim got ${worth}`);
  });

  it("a donation is a gift to existing holders, never a lever for the donor", async () => {
    const f = await loadFixture(vaultFixture);
    await f.fund(f.attacker, U(10_000));
    await (await f.vaultAs(f.attacker)).write.deposit([U(1_000)]);
    const before = await f.vault.read.balanceOfAssets([f.attacker.account.address]);
    await (await f.usdcAs(f.attacker)).write.transfer([f.vault.address, U(500)]);
    const after = await f.vault.read.balanceOfAssets([f.attacker.account.address]);
    // They get back only their own share of what they gave away — the reason a
    // donation alone never pays, and why the danger is always the rounding.
    expect(after - before < U(500)).to.equal(true);
  });

  it("rounds redemption down, so the vault never pays out more than it holds", async () => {
    const f = await loadFixture(vaultFixture);
    await f.fund(f.attacker, U(10_000));
    await (await f.vaultAs(f.attacker)).write.deposit([U(1_000)]);
    const shares = await f.vault.read.sharesOf([f.attacker.account.address]);
    const worth = await f.vault.read.convertToAssets([shares]);
    expect(worth <= U(1_000)).to.equal(true);
  });
});

/**
 * Arbitrator selection must not be steerable by whoever builds the block.
 */
async function arbiterFixture() {
  const [deployer, buyer, provider, j1, j2, j3] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);
  const arbiter = await hre.viem.deployContract("TesseraArbiter", [usdc.address, escrow.address, U(100)]);
  await escrow.write.setArbiter([arbiter.address]);

  for (const w of [buyer, j1, j2, j3]) await usdc.write.mint([w.account.address, U(10_000)]);
  for (const j of [j1, j2, j3]) {
    const t = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: j } });
    await t.write.approve([arbiter.address, U(100)]);
    const a = await hre.viem.getContractAt("TesseraArbiter", arbiter.address, { client: { wallet: j } });
    await a.write.register([U(100)]);
  }

  const price = U(100);
  const bond = await escrow.read.bondFor([price]);
  const ub = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: buyer } });
  await ub.write.approve([escrow.address, price + bond]);
  const eb = await hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: buyer } });
  await eb.write.open([provider.account.address, price, BigInt((await time.latest()) + 3600), H("q")]);
  const ep = await hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: provider } });
  await ep.write.fulfill([1n, H("r")]);
  await eb.write.escalate([1n]);
  await arbiter.write.openCase([1n]);

  return { arbiter, escrow };
}

describe("Arbitrator reassignment (not steerable by a block proposer)", () => {
  it("moves the case off the arbitrator that let it lapse", async () => {
    const f = await loadFixture(arbiterFixture);
    const before = (await f.arbiter.read.caseOf([1n]))[0];
    await time.increase(9 * 3600);
    await f.arbiter.write.reassign([1n]);
    const after = (await f.arbiter.read.caseOf([1n]))[0];
    expect(after.toLowerCase()).to.not.equal(before.toLowerCase());
  });

  it("lands on the same address regardless of when the reassign is mined", async () => {
    // The old draw was salted with block.timestamp, so a proposer sitting on the
    // panel could grind it until a lapsed case — the one nobody is watching —
    // landed on itself. A rotation has nothing to grind.
    const a = await loadFixture(arbiterFixture);
    await time.increase(9 * 3600);
    await a.arbiter.write.reassign([1n]);
    const first = (await a.arbiter.read.caseOf([1n]))[0];

    const b = await loadFixture(arbiterFixture);
    await time.increase(9 * 3600 + 977); // a different timestamp entirely
    await b.arbiter.write.reassign([1n]);
    const second = (await b.arbiter.read.caseOf([1n]))[0];

    expect(first.toLowerCase()).to.equal(second.toLowerCase());
  });

  it("keeps walking the panel when arbitrators keep lapsing", async () => {
    const f = await loadFixture(arbiterFixture);
    const seen = new Set<string>();
    seen.add(((await f.arbiter.read.caseOf([1n]))[0] as string).toLowerCase());
    for (let i = 0; i < 2; i++) {
      await time.increase(9 * 3600);
      await f.arbiter.write.reassign([1n]);
      seen.add(((await f.arbiter.read.caseOf([1n]))[0] as string).toLowerCase());
    }
    expect(seen.size).to.equal(3, "a three-member panel should be walked, not revisited");
  });

  it("still refuses a reassignment while the window is open", async () => {
    const f = await loadFixture(arbiterFixture);
    await expect(f.arbiter.write.reassign([1n])).to.be.rejectedWith("WindowOpen");
  });
});
