import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const U = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));
const soon = async () => BigInt(await time.latest()) + 3600n;
const H = (s: string) => `0x${Buffer.from(s.padEnd(32, " ")).toString("hex")}` as `0x${string}`;

async function deployFixture() {
  const [deployer, agent, provider] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);

  const fund = async (who: any, amount: bigint) => {
    await usdc.write.mint([who.account.address, amount]);
    const c = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });
    await c.write.approve([escrow.address, amount]);
  };
  const as = (who: any) => hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: who } });

  await fund(agent, U("1000"));
  await fund(provider, U("500"));

  return { deployer, agent, provider, usdc, escrow, fund, as };
}

/** Open, then deliver — the state a dispute is possible from. */
async function delivered(f: Awaited<ReturnType<typeof deployFixture>>, amount = U("10")) {
  const a = await f.as(f.agent);
  await a.write.open([f.provider.account.address, amount, await soon(), H("quote")]);
  const id = (await f.escrow.read.nextPaymentId()) - 1n;
  await (await f.as(f.provider)).write.fulfill([id, H("response")]);
  return id;
}

describe("TesseraEscrow — the buyer's side of the record", () => {
  it("counts a settled payment for the buyer as well as the provider", async () => {
    const f = await loadFixture(deployFixture);
    const id = await delivered(f);
    await (await f.as(f.agent)).write.settle([id]);

    const [settled, disputed, spent] = await f.escrow.read.buyerRecord([f.agent.account.address]);
    expect(settled).to.equal(1n);
    expect(disputed).to.equal(0n);
    expect(spent).to.equal(U("10"));
  });

  it("records a dispute when the buyer reclaims a delivered payment", async () => {
    const f = await loadFixture(deployFixture);
    const id = await delivered(f);

    // The free option: take delivery, then reclaim the escrow inside the
    // dispute window. The money still goes back — that is the buyer's right —
    // but it is no longer invisible.
    await (await f.as(f.agent)).write.refund([id]);

    const [settled, disputed] = await f.escrow.read.buyerRecord([f.agent.account.address]);
    expect(settled).to.equal(0n);
    expect(disputed).to.equal(1n);

    // The provider's side is unchanged: still marked failed, still slashed.
    // Fixing that is an economic design question; making the buyer visible is
    // not, which is why only this half is here.
    const [, failed] = await f.escrow.read.reputation([f.provider.account.address]);
    expect(failed).to.equal(1n);
  });

  it("does not blame the buyer when the provider simply never delivered", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.agent);
    const deadline = BigInt(await time.latest()) + 60n;
    await a.write.open([f.provider.account.address, U("5"), deadline, H("quote")]);
    const id = (await f.escrow.read.nextPaymentId()) - 1n;

    await time.increase(120);
    await a.write.refund([id]);

    // Nothing was delivered, so there is nothing to dispute — counting this
    // against the buyer would punish them for being let down.
    const [settled, disputed] = await f.escrow.read.buyerRecord([f.agent.account.address]);
    expect(settled).to.equal(0n);
    expect(disputed).to.equal(0n);
  });

  it("counts a provider-claimed payment as settled for the buyer", async () => {
    const f = await loadFixture(deployFixture);
    const id = await delivered(f);
    await time.increase(3601); // past the dispute window
    await (await f.as(f.provider)).write.providerClaim([id]);

    // The buyer went quiet rather than settling, but the payment landed. Left
    // uncounted, `settled + disputed` would stop matching the number of
    // deliveries the buyer actually received.
    const [settled, disputed] = await f.escrow.read.buyerRecord([f.agent.account.address]);
    expect(settled).to.equal(1n);
    expect(disputed).to.equal(0n);
  });

  it("builds a track record a provider can read before doing the work", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.agent);
    for (let i = 0; i < 3; i++) {
      const id = await delivered(f, U("1"));
      await a.write.settle([id]);
    }
    for (let i = 0; i < 2; i++) {
      const id = await delivered(f, U("1"));
      await a.write.refund([id]);
    }
    const [settled, disputed] = await f.escrow.read.buyerRecord([f.agent.account.address]);
    expect(settled).to.equal(3n);
    expect(disputed).to.equal(2n);
  });
});

describe("TesseraEscrow — batching", () => {
  it("settles many payments in one transaction", async () => {
    const f = await loadFixture(deployFixture);
    const ids: bigint[] = [];
    for (let i = 0; i < 5; i++) ids.push(await delivered(f, U("2")));

    const before = await f.usdc.read.balanceOf([f.provider.account.address]);
    await (await f.as(f.agent)).write.settleMany([ids]);
    expect(await f.usdc.read.balanceOf([f.provider.account.address])).to.equal(before + U("10"));

    const [fulfilled] = await f.escrow.read.reputation([f.provider.account.address]);
    expect(fulfilled).to.equal(5n);
    const [settled] = await f.escrow.read.buyerRecord([f.agent.account.address]);
    expect(settled).to.equal(5n);
  });

  it("fulfils many at once, each against its own response hash", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.agent);
    const ids: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      await a.write.open([f.provider.account.address, U("1"), await soon(), H("q")]);
      ids.push((await f.escrow.read.nextPaymentId()) - 1n);
    }
    const hashes = [H("r0"), H("r1"), H("r2")];
    await (await f.as(f.provider)).write.fulfillMany([ids, hashes]);
    for (let i = 0; i < 3; i++) {
      const p = await f.escrow.read.getPayment([ids[i]!]);
      expect(p[5]).to.equal(hashes[i]);
    }
  });

  it("rejects a fulfil batch whose arrays disagree", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.agent);
    await a.write.open([f.provider.account.address, U("1"), await soon(), H("q")]);
    const id = (await f.escrow.read.nextPaymentId()) - 1n;
    // Committing to the wrong payload hash is not recoverable, so a mismatch
    // reverts rather than truncating to the shorter array.
    await expect((await f.as(f.provider)).write.fulfillMany([[id], []])).to.be.rejected;
  });

  it("reverts the whole settle batch if any leg is not settleable", async () => {
    const f = await loadFixture(deployFixture);
    const good = await delivered(f, U("1"));
    const a = await f.as(f.agent);
    await a.write.open([f.provider.account.address, U("1"), await soon(), H("q")]); // never fulfilled
    const notDelivered = (await f.escrow.read.nextPaymentId()) - 1n;

    // A batch that silently drops the legs it could not do leaves an operator
    // believing they are paid.
    await expect(a.write.settleMany([[good, notDelivered]])).to.be.rejected;
    const [fulfilled] = await f.escrow.read.reputation([f.provider.account.address]);
    expect(fulfilled).to.equal(0n);
  });

  it("sweeps up timed-out payments in one call", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.agent);
    const deadline = BigInt(await time.latest()) + 60n;
    const ids: bigint[] = [];
    for (let i = 0; i < 4; i++) {
      await a.write.open([f.provider.account.address, U("3"), deadline, H("q")]);
      ids.push((await f.escrow.read.nextPaymentId()) - 1n);
    }
    await time.increase(120);
    const before = await f.usdc.read.balanceOf([f.agent.account.address]);
    await a.write.refundMany([ids]);
    // Four timed-out payments of 3, each returning its bond as well: nobody
    // delivered anything, so no bond was forfeited.
    const bond = await f.escrow.read.bondFor([U("3")]);
    expect(await f.usdc.read.balanceOf([f.agent.account.address])).to.equal(
      before + U("12") + bond * 4n,
    );
  });
});

describe("TesseraEscrow — paying in an asset the buyer holds", () => {
  async function routedFixture() {
    const base = await deployFixture();
    const [, , , lp] = await hre.viem.getWalletClients();
    const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin", "EURC", 6]);
    const amm = await hre.viem.deployContract("TesseraAMM", [base.deployer.account.address]);
    await amm.write.createPool([[base.usdc.address, eurc.address], 30, 5000, "USDC / EURC"]);
    const router = await hre.viem.deployContract("TesseraRouter", [amm.address, [base.usdc.address]]);
    await base.escrow.write.setRouter([router.address]);

    // Deep, balanced liquidity so the route is not the thing under test.
    for (const [t, kind] of [[base.usdc, "MockUSDC"], [eurc, "MockToken"]] as const) {
      await t.write.mint([lp.account.address, U("500000")]);
      const c = await hre.viem.getContractAt(kind, t.address, { client: { wallet: lp } });
      await c.write.approve([amm.address, U("500000")]);
    }
    await (await hre.viem.getContractAt("TesseraAMM", amm.address, { client: { wallet: lp } })).write.addLiquidity([
      0n,
      [U("200000"), U("200000")],
      0n,
    ]);

    await eurc.write.mint([base.agent.account.address, U("1000")]);
    await (
      await hre.viem.getContractAt("MockToken", eurc.address, { client: { wallet: base.agent } })
    ).write.approve([base.escrow.address, U("1000")]);

    return { ...base, eurc, amm, router };
  }

  it("routes the buyer's asset into the one the provider quoted", async () => {
    const f = await loadFixture(routedFixture);
    const a = await f.as(f.agent);
    const eurcBefore = await f.eurc.read.balanceOf([f.agent.account.address]);

    // Provider quoted 100 USDC; the buyer holds only EURC. The route has to
    // cover the 10% bond as well as the price, so the buyer's bound is set
    // against 110 USDC of need rather than 100.
    await a.write.openWith([f.eurc.address, U("125"), f.provider.account.address, U("100"), await soon(), H("q")]);
    const id = (await f.escrow.read.nextPaymentId()) - 1n;

    const p = await f.escrow.read.getPayment([id]);
    expect(p[2]).to.equal(U("100")); // escrowed in the quoted asset, exactly
    expect(await f.eurc.read.balanceOf([f.agent.account.address])).to.equal(eurcBefore - U("125"));

    await (await f.as(f.provider)).write.fulfill([id, H("r")]);
    const provBefore = await f.usdc.read.balanceOf([f.provider.account.address]);
    await a.write.settle([id]);
    expect(await f.usdc.read.balanceOf([f.provider.account.address])).to.equal(provBefore + U("100"));
  });

  it("returns the change rather than keeping it", async () => {
    const f = await loadFixture(routedFixture);
    const usdcBefore = await f.usdc.read.balanceOf([f.agent.account.address]);
    await (await f.as(f.agent)).write.openWith([
      f.eurc.address,
      U("125"),
      f.provider.account.address,
      U("100"),
      await soon(),
      H("q"),
    ]);
    // Whatever the route did not need comes straight back.
    const back = (await f.usdc.read.balanceOf([f.agent.account.address])) - usdcBefore;
    expect(back > 0n).to.equal(true);
    // And the escrow holds exactly what it owes plus the bond, not a wei more.
    expect(await f.usdc.read.balanceOf([f.escrow.address])).to.equal(
      U("100") + (await f.escrow.read.bondFor([U("100")])),
    );
  });

  it("reverts rather than opening a payment the route could not cover", async () => {
    const f = await loadFixture(routedFixture);
    // 50 EURC cannot buy 100 USDC. A partial fill would open a payment for less
    // than the provider agreed to.
    await expect(
      (await f.as(f.agent)).write.openWith([
        f.eurc.address,
        U("50"),
        f.provider.account.address,
        U("100"),
        await soon(),
        H("q"),
      ]),
    ).to.be.rejected;
    expect(await f.usdc.read.balanceOf([f.escrow.address])).to.equal(0n);
  });

  it("accepts the escrow asset itself without routing", async () => {
    const f = await loadFixture(routedFixture);
    await (await f.as(f.agent)).write.openWith([
      f.usdc.address,
      U("44"), // the quote plus its 10% bond
      f.provider.account.address,
      U("40"),
      await soon(),
      H("q"),
    ]);
    expect(await f.usdc.read.balanceOf([f.escrow.address])).to.equal(
      U("40") + (await f.escrow.read.bondFor([U("40")])),
    );
  });

  it("refuses to route when no router is wired", async () => {
    const f = await loadFixture(routedFixture);
    await f.escrow.write.setRouter(["0x0000000000000000000000000000000000000000"]);
    await expect(
      (await f.as(f.agent)).write.openWith([
        f.eurc.address,
        U("110"),
        f.provider.account.address,
        U("100"),
        await soon(),
        H("q"),
      ]),
    ).to.be.rejected;
  });

  it("prices the route before committing to it", async () => {
    const f = await loadFixture(routedFixture);
    const [out, hops] = await f.escrow.read.quoteOpenWith([f.eurc.address, U("110")]);
    expect(out > U("100")).to.equal(true);
    expect(hops).to.equal(1n);

    // An asset with no route answers 0 rather than reverting, so a caller can
    // ask about anything.
    const orphan = await hre.viem.deployContract("MockToken", ["Orphan", "ORP", 6]);
    const [none] = await f.escrow.read.quoteOpenWith([orphan.address, U("10")]);
    expect(none).to.equal(0n);
  });
});
