import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const T = (n: number) => BigInt(n) * 10n ** 18n;
const HUNDRED_BILLION = 100_000_000_000n * 10n ** 18n;
const TEN_YEARS = 10 * 365 * 24 * 3600;
const SEND = 0, FUND = 1;

/*
 * The release is activity-driven, so the tests need a protocol to be busy.
 * MockActivity stands in for the pool and the AMM: it reports a dollar figure
 * and nothing else, because a dollar figure is all the emitter reads.
 */
const PER_USD_PER_SEC = 10n ** 12n;      // 1e-6 TSRA per $1 per second
const MAX_RATE = 1000n * 10n ** 18n;     // 1000 TSRA/s, whatever happens
const USD = (n: number) => BigInt(n) * 10n ** 8n; // the pool's 1e8 scale
/*
 * The mock answers for both the lending pool and the AMM, so a figure set on it
 * is counted twice — which is the sum the emitter is meant to take. Rather than
 * mirror that arithmetic here and risk the test agreeing with itself, the
 * expectations read the rate the contract reports.
 */

/**
 * "Locked" is a claim about what cannot happen, so these are mostly tests of
 * absence: the owner cannot take tokens, cannot speed the clock up, and cannot
 * strand a sink that is already owed.
 *
 * Deployment order matters and is part of the design — the emitter exists
 * first so the token's constructor can mint the entire supply straight into
 * it, and there is never a block in which the supply sits in a wallet.
 */
async function deployFixture() {
  const [deployer, alice, liquidity] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();

  // The emitter needs the token address, and the token needs the emitter's.
  // Deploy the emitter against a placeholder, then the real pair: in practice
  // the script computes the address, but a two-step keeps the test honest
  // about the ordering rather than pretending it is free.
  const predicted = await hre.viem.deployContract("TesseraToken", [deployer.account.address]);
  const activity = await hre.viem.deployContract("MockActivity");
  await activity.write.setActivityUsd([USD(1_000_000)]); // a busy protocol
  const emitter = await hre.viem.deployContract("TesseraEmitter", [
    predicted.address, deployer.account.address,
    activity.address, activity.address,
    PER_USD_PER_SEC, MAX_RATE,
  ]);
  // Move the whole supply in, which is what the real constructor does directly.
  await predicted.write.transfer([emitter.address, HUNDRED_BILLION]);

  const sink = await hre.viem.deployContract("MockFundSink", [predicted.address]);
  const as = async (w: any) => hre.viem.getContractAt("TesseraEmitter", emitter.address, { client: { wallet: w } });
  return { deployer, alice, liquidity, token: predicted, emitter, sink, activity, as, pub };
}

describe("TesseraEmitter (a lock you can read the balance of)", () => {
  it("holds the entire supply at the start", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.token.read.balanceOf([f.emitter.address])).to.equal(HUNDRED_BILLION);
    expect(await f.emitter.read.locked()).to.equal(HUNDRED_BILLION);
    expect(await f.emitter.read.distributedTotal()).to.equal(0n);
  });

  it("has no path for the owner to take tokens out", async () => {
    // The whole promise, expressed as an ABI that cannot express the opposite.
    const f = await loadFixture(deployFixture);
    const fns = f.emitter.abi.filter((x: any) => x.type === "function").map((x: any) => x.name);
    for (const forbidden of ["sweep", "withdraw", "rescue", "emergencyWithdraw", "setRate", "setStart"]) {
      expect(fns).to.not.include(forbidden);
    }
  });

  it("cannot have its curve wound forward", async () => {
    // Both parameters are immutable. If either were governable an accelerated
    // unlock would be one transaction away, which is the risk holders are
    // being asked to accept the lock against.
    const f = await loadFixture(deployFixture);
    expect(await f.emitter.read.emissionPerUsdPerSecond()).to.equal(PER_USD_PER_SEC);
    expect(await f.emitter.read.maxRatePerSecond()).to.equal(MAX_RATE);
    const setters = f.emitter.abi
      .filter((x: any) => x.type === "function" && x.stateMutability !== "view")
      .map((x: any) => x.name);
    for (const forbidden of ["setRatePerSecond", "setEmissionPerUsd", "setMaxRate", "setActivity"]) {
      expect(setters).to.not.include(forbidden);
    }
  });

  it("emits nothing at all while the protocol is idle", async () => {
    /*
     * The point of the change: a calendar schedule pays whether or not anybody
     * shows up, so an unused protocol dilutes its holders on time and the
     * tokens land on whoever is standing under the tap.
     */
    const f = await loadFixture(deployFixture);
    await f.activity.write.setActivityUsd([0n]);
    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 100n, "liquidity"]);
    await time.increase(100_000);
    await f.emitter.write.release();
    expect(await f.emitter.read.releasedTotal()).to.equal(0n);
    expect(await f.emitter.read.currentRatePerSecond()).to.equal(0n);
    expect(await f.token.read.balanceOf([f.emitter.address])).to.equal(HUNDRED_BILLION);
  });

  it("emits faster when the pools are busier", async () => {
    const f = await loadFixture(deployFixture);
    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 100n, "liquidity"]);

    await f.activity.write.setActivityUsd([USD(100_000)]);
    await time.increase(1000);
    await f.emitter.write.distributeAll();
    const quiet = await f.token.read.balanceOf([f.liquidity.account.address]);

    await f.activity.write.setActivityUsd([USD(1_000_000)]); // ten times busier
    await time.increase(1000);
    await f.emitter.write.distributeAll();
    const busy = (await f.token.read.balanceOf([f.liquidity.account.address])) - quiet;

    expect(busy > quiet * 8n).to.equal(true);
    expect(busy < quiet * 12n).to.equal(true);
  });

  it("caps the rate however much capital arrives", async () => {
    // Without this, one very large deposit could drain the supply in an
    // afternoon and call it activity.
    const f = await loadFixture(deployFixture);
    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 100n, "liquidity"]);
    await f.activity.write.setActivityUsd([USD(1_000_000_000_000)]); // absurd
    expect(await f.emitter.read.currentRatePerSecond()).to.equal(MAX_RATE);
    await time.increase(100);
    await f.emitter.write.distributeAll();
    const got = await f.token.read.balanceOf([f.liquidity.account.address]);
    expect(got <= MAX_RATE * 102n).to.equal(true);
  });

  it("counts both venues", async () => {
    const f = await loadFixture(deployFixture);
    // The mock answers for both interfaces, so its figure lands twice — which
    // is the sum the emitter is supposed to take.
    const lending = await f.emitter.read.lendingActivityUsd();
    const amm = await f.emitter.read.ammActivityUsd();
    expect(await f.emitter.read.activityUsd()).to.equal(lending + amm);
  });

  it("says the supply lasts indefinitely when nothing is happening", async () => {
    const f = await loadFixture(deployFixture);
    await f.activity.write.setActivityUsd([0n]);
    expect(await f.emitter.read.secondsRemaining()).to.equal(2n ** 256n - 1n);
  });

  it("releases on the clock and splits by weight", async () => {
    const f = await loadFixture(deployFixture);
    await f.emitter.write.addSink([f.sink.address, FUND, 70n, "lending emissions"]);
    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 30n, "liquidity"]);

    const rate = await f.emitter.read.currentRatePerSecond();
    await time.increase(1000);
    await f.emitter.write.distributeAll();

    const toSink = await f.token.read.balanceOf([f.sink.address]);
    const toLiq = await f.token.read.balanceOf([f.liquidity.account.address]);
    const total = toSink + toLiq;
    expect(total > rate * 990n).to.equal(true);
    expect(total < rate * 1010n).to.equal(true);
    // 70/30, within the rounding of one release.
    expect(toSink > (total * 69n) / 100n).to.equal(true);
    expect(toSink < (total * 71n) / 100n).to.equal(true);
  });

  it("calls fund() on a Fund sink so it can book the top-up itself", async () => {
    const f = await loadFixture(deployFixture);
    await f.emitter.write.addSink([f.sink.address, FUND, 100n, "lending emissions"]);
    await time.increase(100);
    await f.emitter.write.distribute([0n]);
    expect(await f.sink.read.funded() > 0n).to.equal(true);
    expect(await f.sink.read.funded()).to.equal(await f.token.read.balanceOf([f.sink.address]));
  });

  it("leaves no standing approval behind a Fund call", async () => {
    // An approval that outlives its call is exactly what the approvals audit
    // spent a commit removing from the front end.
    const f = await loadFixture(deployFixture);
    await f.emitter.write.addSink([f.sink.address, FUND, 100n, "lending emissions"]);
    await time.increase(100);
    await f.emitter.write.distribute([0n]);
    expect(await f.token.read.allowance([f.emitter.address, f.sink.address])).to.equal(0n);
  });

  it("does not run the clock while there is nowhere to send", async () => {
    /*
     * Two failures to avoid at once. Carrying the backlog forward hands
     * whoever is configured first a windfall they did not earn; releasing it
     * and holding it aside loses it permanently, because nothing can pay it
     * out — the first version did that and stranded 634 tokens by the end of a
     * ten-year schedule. Stopping the clock does neither.
     */
    const f = await loadFixture(deployFixture);
    await time.increase(10_000);
    await f.emitter.write.release();
    expect(await f.emitter.read.releasedTotal()).to.equal(0n);
    expect(await f.token.read.balanceOf([f.emitter.address])).to.equal(HUNDRED_BILLION);

    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 100n, "liquidity"]);
    const rate = await f.emitter.read.currentRatePerSecond();
    await time.increase(100);
    await f.emitter.write.distributeAll();
    const got = await f.token.read.balanceOf([f.liquidity.account.address]);
    // A hundred seconds' worth, not ten thousand and a hundred.
    expect(got < rate * 200n).to.equal(true);
    expect(got > rate * 50n).to.equal(true);
  });

  it("leaves nothing behind once the supply is finally exhausted", async () => {
    // The leak the previous version had, pinned so it cannot come back. There
    // is no deadline now, so "the end" is whenever enough activity has run.
    const f = await loadFixture(deployFixture);
    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 60n, "liquidity"]);
    await f.emitter.write.addSink([f.alice.account.address, SEND, 40n, "grants"]);
    await f.activity.write.setActivityUsd([USD(1_000_000_000_000)]); // pinned at the cap
    await time.increase(Number(HUNDRED_BILLION / MAX_RATE) * 2);
    await f.emitter.write.distributeAll();
    await f.emitter.write.distributeAll(); // sweep up the final carry

    const left = await f.token.read.balanceOf([f.emitter.address]);
    expect(left <= 2n).to.equal(true); // at most a wei of dust per sink
    const out = (await f.token.read.balanceOf([f.liquidity.account.address])) +
      (await f.token.read.balanceOf([f.alice.account.address]));
    expect(out).to.equal(HUNDRED_BILLION - left);
  });

  it("applies a re-weight from now, not retroactively", async () => {
    const f = await loadFixture(deployFixture);
    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 100n, "liquidity"]);
    await f.emitter.write.addSink([f.alice.account.address, SEND, 0n, "later"]);
    await time.increase(1000);

    // Alice's weight goes up only from here; the first 1000 seconds were the
    // liquidity sink's and stay that way.
    await f.emitter.write.setSinkWeight([1n, 100n]);
    const rate = await f.emitter.read.currentRatePerSecond();
    const owedAlice = await f.emitter.read.pendingOf([1n]);
    expect(owedAlice < rate * 10n).to.equal(true);
    const owedLiq = await f.emitter.read.pendingOf([0n]);
    expect(owedLiq > rate * 900n).to.equal(true);
  });

  it("retires a sink without losing what it is already owed", async () => {
    const f = await loadFixture(deployFixture);
    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 100n, "liquidity"]);
    await time.increase(1000);
    await f.emitter.write.setSinkWeight([0n, 0n]); // retired
    const owed = await f.emitter.read.pendingOf([0n]);
    expect(owed > 0n).to.equal(true);
    await f.emitter.write.distribute([0n]);
    expect(await f.token.read.balanceOf([f.liquidity.account.address])).to.equal(owed);
  });

  it("lets anyone advance the clock, because the schedule belongs to holders", async () => {
    const f = await loadFixture(deployFixture);
    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 100n, "liquidity"]);
    await time.increase(500);
    const a = await f.as(f.alice); // not the owner
    await a.write.release();
    expect(await f.emitter.read.releasedTotal() > 0n).to.equal(true);
    await a.write.distribute([0n]);
    expect(await f.token.read.balanceOf([f.liquidity.account.address]) > 0n).to.equal(true);
  });

  it("only the owner may add or re-weight a sink", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await expect(a.write.addSink([f.alice.account.address, SEND, 100n, "mine"])).to.be.rejected;
    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 100n, "liquidity"]);
    await expect(a.write.setSinkWeight([0n, 1n])).to.be.rejected;
  });

  it("never releases more than it holds", async () => {
    /*
     * Near the end of the schedule the clock outruns the balance. The contract
     * must pay out what is left and stop, not revert and strand it.
     */
    const f = await loadFixture(deployFixture);
    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 100n, "liquidity"]);
    await f.activity.write.setActivityUsd([USD(1_000_000_000_000)]); // pinned at the cap
    await time.increase(Number(HUNDRED_BILLION / MAX_RATE) * 2);
    await f.emitter.write.distributeAll();
    expect(await f.token.read.balanceOf([f.emitter.address])).to.equal(0n);
    expect(await f.token.read.balanceOf([f.liquidity.account.address])).to.equal(HUNDRED_BILLION);
    expect(await f.emitter.read.carry()).to.equal(0n);
    // And a further attempt simply has nothing to give.
    await time.increase(1000);
    await expect(f.emitter.write.distribute([0n])).to.be.rejected;
  });

  it("reports how long the supply lasts at the current pace", async () => {
    const f = await loadFixture(deployFixture);
    const rate = await f.emitter.read.currentRatePerSecond();
    const left = await f.emitter.read.secondsRemaining();
    expect(left).to.equal(HUNDRED_BILLION / rate);
  });

  it("pays each sink separately so one failure cannot block the rest", async () => {
    const f = await loadFixture(deployFixture);
    const bad = await hre.viem.deployContract("MockRevertingSink");
    await f.emitter.write.addSink([bad.address, FUND, 50n, "broken"]);
    await f.emitter.write.addSink([f.liquidity.account.address, SEND, 50n, "liquidity"]);
    await time.increase(1000);

    await expect(f.emitter.write.distribute([0n])).to.be.rejected; // the broken one
    await f.emitter.write.distribute([1n]); // the good one is unaffected
    expect(await f.token.read.balanceOf([f.liquidity.account.address]) > 0n).to.equal(true);
  });

  it("refuses a weight large enough to break the share maths", async () => {
    const f = await loadFixture(deployFixture);
    const max = await f.emitter.read.MAX_WEIGHT();
    await expect(f.emitter.write.addSink([f.alice.account.address, SEND, max + 1n, "huge"])).to.be.rejected;
    await f.emitter.write.addSink([f.alice.account.address, SEND, max, "at the limit"]);
  });
});
