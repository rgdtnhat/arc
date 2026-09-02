import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const MIN = USDC(10);
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Discovery, and the two things a registry has to get right: that anyone can
 * join without asking, and that joining costs enough to be worth doing once.
 */
async function deployFixture() {
  const [deployer, alice, bob, buyer] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);
  const registry = await hre.viem.deployContract("TesseraRegistry", [usdc.address, MIN]);
  await registry.write.setEscrow([escrow.address]);

  for (const w of [alice, bob, buyer]) {
    await usdc.write.mint([w.account.address, USDC(10_000)]);
  }

  const as = async (w: typeof alice, c: typeof registry) =>
    hre.viem.getContractAt("TesseraRegistry", c.address, { client: { wallet: w } });
  const usdcAs = async (w: typeof alice) =>
    hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: w } });

  return { deployer, alice, bob, buyer, usdc, escrow, registry, as, usdcAs };
}

async function listAs(f: Awaited<ReturnType<typeof deployFixture>>, w: any, resources: string[], price: bigint, stake = MIN) {
  const u = await f.usdcAs(w);
  await u.write.approve([f.registry.address, stake]);
  const r = await f.as(w, f.registry);
  await r.write.list([`https://${w.account.address.slice(2, 8)}.example`, resources, price, stake]);
  return r;
}

describe("TesseraRegistry (a market you can join without asking)", () => {
  it("lists a provider nobody approved, and finds it by what it sells", async () => {
    const f = await loadFixture(deployFixture);
    await listAs(f, f.alice, ["weather:current"], USDC(0.001));

    const [providers, prices, stakes, , , , found] = await f.registry.read.findByResource([
      "weather:current",
      0n,
      50n,
    ]);
    expect(found).to.equal(1n);
    expect(providers[0].toLowerCase()).to.equal(f.alice.account.address.toLowerCase());
    expect(prices[0]).to.equal(USDC(0.001));
    expect(stakes[0]).to.equal(MIN);
  });

  it("does not return a provider that sells something else", async () => {
    const f = await loadFixture(deployFixture);
    await listAs(f, f.alice, ["weather:current"], USDC(0.001));

    const [, , , , , , found] = await f.registry.read.findByResource(["fx:rate", 0n, 50n]);
    expect(found).to.equal(0n);
  });

  it("refuses a listing that does not meet the stake floor", async () => {
    const f = await loadFixture(deployFixture);
    const u = await f.usdcAs(f.alice);
    await u.write.approve([f.registry.address, USDC(1)]);
    const r = await f.as(f.alice, f.registry);
    await expect(
      r.write.list(["https://a.example", ["weather:current"], USDC(0.001), USDC(1)]),
    ).to.be.rejectedWith("StakeTooLow");
  });

  it("returns the stake in full on unlisting — a listing costs time, not money", async () => {
    const f = await loadFixture(deployFixture);
    await listAs(f, f.alice, ["weather:current"], USDC(0.001));
    const before = await f.usdc.read.balanceOf([f.alice.account.address]);

    const r = await f.as(f.alice, f.registry);
    await r.write.unlist();

    const after = await f.usdc.read.balanceOf([f.alice.account.address]);
    expect(after - before).to.equal(MIN);
    const [, , , , , , found] = await f.registry.read.findByResource(["weather:current", 0n, 50n]);
    expect(found).to.equal(0n);
  });

  it("lets a pause stop new listings but never trap a stake", async () => {
    const f = await loadFixture(deployFixture);
    await listAs(f, f.alice, ["weather:current"], USDC(0.001));
    await f.registry.write.setPaused([true]);

    // In: refused.
    const u = await f.usdcAs(f.bob);
    await u.write.approve([f.registry.address, MIN]);
    const rb = await f.as(f.bob, f.registry);
    // Plain `rejected`: `ContractPaused` is declared in the Guarded base, and
    // Hardhat's decoder only names errors from the contract's own source file.
    await expect(rb.write.list(["https://b.example", ["weather:current"], USDC(0.002), MIN])).to.be.rejected;

    // Out: still open. A switch that trapped funds would turn every false alarm
    // into the incident it was meant to prevent.
    const ra = await f.as(f.alice, f.registry);
    await ra.write.unlist();
    expect(await f.usdc.read.balanceOf([f.alice.account.address])).to.equal(USDC(10_000));
  });

  it("surfaces the escrow's reputation rather than keeping its own", async () => {
    const f = await loadFixture(deployFixture);
    await listAs(f, f.alice, ["weather:current"], USDC(0.001));

    // One real settlement through the escrow.
    const price = USDC(1);
    const bond = await f.escrow.read.bondFor([price]);
    const ub = await f.usdcAs(f.buyer);
    await ub.write.approve([f.escrow.address, price + bond]);
    const eb = await hre.viem.getContractAt("TesseraEscrow", f.escrow.address, {
      client: { wallet: f.buyer },
    });
    // Block time, not wall-clock: earlier suites move the chain forward, and a
    // Date.now() deadline is already in the past by the time this file runs.
    const deadline = BigInt((await time.latest()) + 3600);
    await eb.write.open([f.alice.account.address, price, deadline, "0x".padEnd(66, "1") as `0x${string}`]);
    const ea = await hre.viem.getContractAt("TesseraEscrow", f.escrow.address, {
      client: { wallet: f.alice },
    });
    await ea.write.fulfill([1n, "0x".padEnd(66, "2") as `0x${string}`]);
    await eb.write.settle([1n]);

    const [, , , fulfilled, failed, distinct, found] = await f.registry.read.findByResource([
      "weather:current",
      0n,
      50n,
    ]);
    expect(found).to.equal(1n);
    expect(fulfilled[0]).to.equal(1n);
    expect(failed[0]).to.equal(0n);
    expect(distinct[0]).to.equal(1n);
  });

  it("pages, so the call an agent makes on every purchase cannot outgrow the block", async () => {
    const f = await loadFixture(deployFixture);
    await listAs(f, f.alice, ["weather:current"], USDC(0.001));
    await listAs(f, f.bob, ["weather:current"], USDC(0.002));

    const [p1, , , , , , found1, next1] = await f.registry.read.findByResource(["weather:current", 0n, 1n]);
    expect(found1).to.equal(1n);
    expect(next1).to.equal(1n);
    const [p2, , , , , , found2] = await f.registry.read.findByResource(["weather:current", next1, 1n]);
    expect(found2).to.equal(1n);
    expect(p1[0].toLowerCase()).to.not.equal(p2[0].toLowerCase());
  });

  it("keeps an existing listing when the floor is raised, and asks for the gap on update", async () => {
    const f = await loadFixture(deployFixture);
    await listAs(f, f.alice, ["weather:current"], USDC(0.001));
    await f.registry.write.setMinStake([USDC(50)]);

    // Still discoverable: raising a number must not silently delist people.
    const [, , , , , , found] = await f.registry.read.findByResource(["weather:current", 0n, 50n]);
    expect(found).to.equal(1n);

    // But an update has to meet the new floor.
    const r = await f.as(f.alice, f.registry);
    await expect(
      r.write.update(["https://a2.example", ["weather:current"], USDC(0.002), 0n]),
    ).to.be.rejectedWith("StakeTooLow");

    const u = await f.usdcAs(f.alice);
    await u.write.approve([f.registry.address, USDC(40)]);
    await r.write.update(["https://a2.example", ["weather:current"], USDC(0.002), USDC(40)]);
    const [, , stakes] = await f.registry.read.findByResource(["weather:current", 0n, 50n]);
    expect(stakes[0]).to.equal(USDC(50));
  });

  it("refuses an empty endpoint and an empty resource list", async () => {
    const f = await loadFixture(deployFixture);
    const u = await f.usdcAs(f.alice);
    await u.write.approve([f.registry.address, MIN]);
    const r = await f.as(f.alice, f.registry);
    await expect(r.write.list(["", ["weather:current"], 0n, MIN])).to.be.rejectedWith("BadEndpoint");
    await expect(r.write.list(["https://a.example", [], 0n, MIN])).to.be.rejectedWith("TooManyResources");
  });

  it("reads reputation as zero rather than reverting when no escrow is wired", async () => {
    const f = await loadFixture(deployFixture);
    await f.registry.write.setEscrow([ZERO]);
    await listAs(f, f.alice, ["weather:current"], USDC(0.001));
    const [, , , fulfilled, , , found] = await f.registry.read.findByResource(["weather:current", 0n, 50n]);
    expect(found).to.equal(1n);
    expect(fulfilled[0]).to.equal(0n);
  });

  it("lets a provider relist into the same slot without double-staking", async () => {
    const f = await loadFixture(deployFixture);
    await listAs(f, f.alice, ["weather:current"], USDC(0.001));
    const r = await f.as(f.alice, f.registry);
    await r.write.unlist();

    // Stake came back, so relisting costs the floor again — and the provider
    // keeps its original position rather than appearing twice.
    const u = await f.usdcAs(f.alice);
    await u.write.approve([f.registry.address, MIN]);
    await r.write.list(["https://a.example", ["weather:current"], USDC(0.003), MIN]);

    expect(await f.registry.read.providerCount()).to.equal(1n);
    const [, prices, , , , , found] = await f.registry.read.findByResource(["weather:current", 0n, 50n]);
    expect(found).to.equal(1n);
    expect(prices[0]).to.equal(USDC(0.003));
  });
});
