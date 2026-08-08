import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const T = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/**
 * The keeper exists because "permissionless" and "somebody will" are not the
 * same sentence. What matters is that it pays for punctuality rather than for
 * backlog, refuses to pay for doing nothing, and keeps working when its own
 * tip jar is empty.
 */
async function deployFixture() {
  const [owner, bot, other] = await hre.viem.getWalletClients();
  const token = await hre.viem.deployContract("MockToken", ["Tessera", "TSRA", 18]);
  const emitter = await hre.viem.deployContract("MockActivity");
  void emitter;
  // A stand-in emitter: sinks with pending amounts the keeper can push.
  const stub = await hre.viem.deployContract("MockEmitterSinks", [token.address]);
  const keeper = await hre.viem.deployContract("TesseraKeeper", [stub.address, token.address, owner.account.address]);

  await token.write.mint([keeper.address, T(1000)]);
  await token.write.mint([stub.address, T(100_000)]);
  const as = async (w: any) => hre.viem.getContractAt("TesseraKeeper", keeper.address, { client: { wallet: w } });
  return { owner, bot, other, token, stub, keeper, as };
}

describe("TesseraKeeper (paying whoever turns the handle)", () => {
  it("pays a bot for a round that actually moved something", async () => {
    const f = await loadFixture(deployFixture);
    await f.stub.write.setPending([0n, T(50)]);
    const before = await f.token.read.balanceOf([f.bot.account.address]);

    const k = await f.as(f.bot);
    await k.write.poke();
    expect(await f.token.read.balanceOf([f.bot.account.address])).to.equal(before + T(1));
    expect(await f.keeper.read.rounds()).to.equal(1n);
  });

  it("refuses to pay for a round with nothing to do", async () => {
    // A bot on a timer should spend nothing on an idle protocol, rather than
    // collect a bounty for making no difference.
    const f = await loadFixture(deployFixture);
    const k = await f.as(f.bot);
    await expect(k.write.poke()).to.be.rejected;
  });

  it("leaves dust alone", async () => {
    const f = await loadFixture(deployFixture);
    await f.stub.write.setPending([0n, T(0.5)]); // under the 1-token threshold
    const k = await f.as(f.bot);
    await expect(k.write.poke()).to.be.rejected;
  });

  it("will not be farmed by poking again immediately", async () => {
    /*
     * The interval is what makes a flat bounty pay for punctuality. Without it
     * a bot pokes every block and drains the float for nothing.
     */
    const f = await loadFixture(deployFixture);
    await f.stub.write.setPending([0n, T(50)]);
    const k = await f.as(f.bot);
    await k.write.poke();
    await f.stub.write.setPending([0n, T(50)]);
    await expect(k.write.poke()).to.be.rejected;

    await time.increase(11 * 60);
    await k.write.poke(); // an interval later, fine
    expect(await f.keeper.read.rounds()).to.equal(2n);
  });

  it("keeps doing the work when the tip jar is empty", async () => {
    /*
     * The failure this must not have: upkeep stopping because nobody topped up
     * the bounty. The distribution is the point; the tip is the incentive.
     */
    const f = await loadFixture(deployFixture);
    await f.keeper.write.sweep([f.owner.account.address, T(1000)]);
    expect(await f.token.read.balanceOf([f.keeper.address])).to.equal(0n);

    await f.stub.write.setPending([0n, T(50)]);
    const k = await f.as(f.bot);
    await k.write.poke();
    expect(await f.stub.read.distributed([0n])).to.equal(T(50)); // the work happened
    expect(await f.keeper.read.totalPaid()).to.equal(0n); // the tip did not
  });

  it("does not let one reverting sink abandon the others", async () => {
    const f = await loadFixture(deployFixture);
    await f.stub.write.setPending([0n, T(50)]);
    await f.stub.write.setPending([1n, T(50)]);
    await f.stub.write.setBroken([0n, true]);

    const k = await f.as(f.bot);
    await k.write.poke();
    expect(await f.stub.read.distributed([1n])).to.equal(T(50));
  });

  it("pokes a slice, so a bot can price a round exactly", async () => {
    const f = await loadFixture(deployFixture);
    await f.stub.write.setPending([0n, T(50)]);
    await f.stub.write.setPending([2n, T(50)]);

    const k = await f.as(f.bot);
    await k.write.pokeRange([0n, 1n]); // sink 0 only
    expect(await f.stub.read.distributed([0n])).to.equal(T(50));
    expect(await f.stub.read.distributed([2n])).to.equal(0n); // still waiting
  });

  it("survives a sink that tries to eat the whole round's gas", async () => {
    /*
     * The failure this exists for happened live: the first real poke came back
     * with gasUsed exactly equal to the limit. A `try` hands over all but a
     * sixty-fourth of what is left, so one greedy sink can starve the payout
     * that follows the loop. Each sink gets a fixed allowance instead, and
     * overrunning it costs that sink its turn and nothing else.
     */
    const f = await loadFixture(deployFixture);
    await f.stub.write.setPending([0n, T(50)]);
    await f.stub.write.setPending([1n, T(50)]);
    await f.stub.write.setBurn([0n, 20_000_000n]); // far beyond its allowance

    const k = await f.as(f.bot);
    await k.write.poke();
    expect(await f.stub.read.distributed([0n])).to.equal(0n); // it overran
    expect(await f.stub.read.distributed([1n])).to.equal(T(50)); // the rest went through
    expect(await f.keeper.read.totalPaid()).to.equal(T(1)); // and the bounty still paid
  });

  it("stops early rather than reverting when the round runs short of gas", async () => {
    // A short round that moved something is a good round. Reverting would
    // charge the bot for the whole attempt and move nothing.
    const f = await loadFixture(deployFixture);
    for (const i of [0n, 1n, 2n]) await f.stub.write.setPending([i, T(50)]);
    // Two expensive-but-affordable sinks, and a limit with room for two.
    await f.stub.write.setBurn([0n, 800_000n]);
    await f.stub.write.setBurn([1n, 800_000n]);

    const k = await f.as(f.bot);
    await k.write.poke({ gas: 3_000_000n });
    expect(await f.keeper.read.rounds()).to.equal(1n);
    expect(await f.stub.read.distributed([0n])).to.equal(T(50));
    expect(await f.stub.read.distributed([1n])).to.equal(T(50));
    expect(await f.stub.read.distributed([2n])).to.equal(0n); // ran out, kept for next time
    expect(await f.keeper.read.totalPaid()).to.equal(T(1)); // and the tail still ran
  });

  it("previews a round, so a bot can price its own gas first", async () => {
    const f = await loadFixture(deployFixture);
    await f.stub.write.setPending([0n, T(50)]);
    const [sinks, pending, wouldPay, , gasNeeded] = await f.keeper.read.previewPoke();
    expect(sinks).to.equal(1n);
    expect(pending).to.equal(T(50));
    expect(wouldPay).to.equal(T(1));
    // Three sinks peeked at, one of them distributed, plus the tail.
    expect(gasNeeded).to.equal(3n * 500_000n + 900_000n + 150_000n);
  });

  it("agrees with itself: a preview that names a sink is a sink the round moves", async () => {
    /*
     * The live regression. `previewPoke` read every sink with no gas limit and
     * reported two ready; `poke` capped the same reads far lower, could not
     * finish them, and reverted with nothing to do. Both now use one allowance.
     */
    const f = await loadFixture(deployFixture);
    await f.stub.write.setPending([0n, T(50)]);
    await f.stub.write.setBurn([0n, 400_000n]); // dear to read, still affordable
    const [sinks] = await f.keeper.read.previewPoke();

    const k = await f.as(f.bot);
    if (sinks > 0n) await k.write.poke();
    else await expect(k.write.poke()).to.be.rejected;
    expect(await f.keeper.read.rounds()).to.equal(sinks > 0n ? 1n : 0n);
  });

  it("refuses a gas budget too small to read a sink at all", async () => {
    // A budget under the floor would make every round silently do nothing,
    // which is the failure this whole mechanism exists to prevent.
    const f = await loadFixture(deployFixture);
    await expect(f.keeper.write.setGasBudget([1n, 1n, 1n])).to.be.rejected;
    await f.keeper.write.setGasBudget([1_200_000n, 600_000n, 200_000n]);
    expect(await f.keeper.read.gasPerSink()).to.equal(1_200_000n);
  });

  it("bounds the bounty, so a fat finger cannot empty the float in a round", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.keeper.write.setConfig([T(100_000), 60n, T(1)])).to.be.rejected;
    await f.keeper.write.setConfig([T(2), 60n, T(1)]);
    expect(await f.keeper.read.bounty()).to.equal(T(2));
  });

  it("only the owner configures it or sweeps the float", async () => {
    const f = await loadFixture(deployFixture);
    const k = await f.as(f.other);
    await expect(k.write.setConfig([T(1), 60n, T(1)])).to.be.rejected;
    await expect(k.write.sweep([f.other.account.address, T(1)])).to.be.rejected;
  });
});
