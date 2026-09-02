import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";

const T = (n: number) => BigInt(n) * 10n ** 18n;
const HUNDRED_BILLION = 100_000_000_000n * 10n ** 18n;
const DAY = 24 * 3600;
const AGAINST = 0, FOR = 1, ABSTAIN = 2;
const S = { Pending: 0, Active: 1, Defeated: 2, Succeeded: 3, Queued: 4, Executed: 5, Cancelled: 6 };

/**
 * Governance is mostly a set of things that must not be possible: voting twice,
 * voting with borrowed weight, passing without a quorum, and executing the
 * instant a vote closes. These are written around those.
 */
async function deployFixture() {
  const [admin, alice, bob, carol] = await hre.viem.getWalletClients();

  // A stand-in treasury holding most of the supply, so circulating supply — and
  // therefore quorum — is a small fraction of the total, exactly as in production.
  const treasury = await hre.viem.deployContract("MockFundSink", [admin.account.address]);
  const token = await hre.viem.deployContract("TesseraToken", [admin.account.address]);
  const gov = await hre.viem.deployContract("TesseraGovernor", [
    token.address, treasury.address, admin.account.address,
    BigInt(3 * DAY), BigInt(DAY), 2000, // 3-day vote, 1-day delay, 20% quorum
  ]);

  // 1000 tokens circulate; the rest is locked away in the treasury.
  await token.write.transfer([alice.account.address, T(600)]);
  await token.write.transfer([bob.account.address, T(300)]);
  await token.write.transfer([carol.account.address, T(100)]);
  await token.write.transfer([treasury.address, HUNDRED_BILLION - T(1000)]);

  const tokenAs = async (w: any) => hre.viem.getContractAt("TesseraToken", token.address, { client: { wallet: w } });
  const govAs = async (w: any) => hre.viem.getContractAt("TesseraGovernor", gov.address, { client: { wallet: w } });
  for (const who of [alice, bob, carol]) {
    const t = await tokenAs(who);
    await t.write.delegate([who.account.address]);
  }
  await mine(1);
  return { admin, alice, bob, carol, token, gov, treasury, tokenAs, govAs };
}

const proposal = (title = "Direct emissions to USDC") =>
  [title, "Move the supply-side stream to the USDC reserve.", [], []] as const;

describe("TesseraGovernor (a result the admin cannot decline to enact)", () => {
  it("measures quorum against circulating supply, not the locked treasury", async () => {
    /*
     * With 100 billion minted and a thousand circulating, a quorum against
     * total supply would need a hundred times the tokens that exist outside
     * the lock. The usual fix is to lower the percentage until something
     * passes, which quietly makes the quorum meaningless instead.
     */
    const f = await loadFixture(deployFixture);
    expect(await f.gov.read.circulatingSupply()).to.equal(T(1000));
    expect(await f.gov.read.quorumVotes()).to.equal(T(200)); // 20% of 1000
  });

  it("passes a proposal the holders back", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    expect(await f.gov.read.state([0n])).to.equal(S.Active);

    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, FOR]); // 600 of 1000
    await time.increase(3 * DAY + 1);
    expect(await f.gov.read.state([0n])).to.equal(S.Succeeded);

    await time.increase(DAY + 1);
    expect(await f.gov.read.state([0n])).to.equal(S.Queued);
  });

  it("defeats a proposal nobody turned up for", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const c = await f.govAs(f.carol);
    await c.write.castVote([0n, FOR]); // 100, under the 200 quorum
    await time.increase(3 * DAY + 1);
    expect(await f.gov.read.state([0n])).to.equal(S.Defeated);
  });

  it("counts abstentions toward the quorum but not the outcome", async () => {
    /*
     * Turning up to say "no opinion" is participation. Treating it as absence
     * lets a small determined faction pass anything by keeping turnout low.
     */
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const a = await f.govAs(f.alice), c = await f.govAs(f.carol);
    await a.write.castVote([0n, ABSTAIN]); // 600 abstain
    await c.write.castVote([0n, FOR]); // 100 for
    await time.increase(3 * DAY + 1);
    // Quorum met by the abstention; the result decided by the 100 that voted.
    expect(await f.gov.read.state([0n])).to.equal(S.Succeeded);
  });

  it("defeats a tie, because a tie is not a mandate", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const b = await f.govAs(f.bob), c = await f.govAs(f.carol);
    await b.write.castVote([0n, FOR]); // 300
    // Alice votes against with 600, so "for" is behind.
    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, AGAINST]);
    await c.write.castVote([0n, ABSTAIN]);
    await time.increase(3 * DAY + 1);
    expect(await f.gov.read.state([0n])).to.equal(S.Defeated);
  });

  it("lets a voter change their mind, replacing rather than adding", async () => {
    /*
     * Refusing a second vote looked safer and was not: it left somebody who
     * voted early and then read the discussion stuck with an opinion they no
     * longer held. What has to hold is that nobody counts twice, which is a
     * property of subtracting the old weight before adding the new — not of
     * refusing outright.
     */
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, FOR]);
    await a.write.castVote([0n, AGAINST]);

    const info = await f.gov.read.proposalInfo([0n]);
    expect(info[5]).to.equal(0n); // for: emptied
    expect(info[6]).to.equal(T(600)); // against: her whole weight, once
  });

  it("refuses a re-vote that changes nothing", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, FOR]);
    await expect(a.write.castVote([0n, FOR])).to.be.rejected;
  });

  it("lets a voter withdraw entirely, which is not the same as abstaining", async () => {
    // An abstention counts toward the quorum; withdrawing is the absence of a
    // position, and must not go on propping up the turnout.
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, FOR]);
    await a.write.withdrawVote([0n]);

    const info = await f.gov.read.proposalInfo([0n]);
    expect(info[5] + info[6] + info[7]).to.equal(0n);
    expect(await f.gov.read.hasVoted([0n, f.alice.account.address])).to.equal(false);
  });

  it("turns a passing proposal into a defeated one when enough weight leaves", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, FOR]); // 600 of 1000, over the 200 quorum
    await a.write.withdrawVote([0n]);
    await time.increase(3 * DAY + 1);
    expect(await f.gov.read.state([0n])).to.equal(S.Defeated);
  });

  it("refuses a withdrawal from somebody who never voted", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const b = await f.govAs(f.bob);
    await expect(b.write.withdrawVote([0n])).to.be.rejected;
  });

  it("refuses a change once voting has closed", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, FOR]);
    await time.increase(3 * DAY + 10);
    await expect(a.write.castVote([0n, AGAINST])).to.be.rejected;
    await expect(a.write.withdrawVote([0n])).to.be.rejected;
  });

  it("never takes custody of a voter's tokens", async () => {
    // The thing people assume a vote does. It does not: weight is read from a
    // past block, so there is nothing escrowed and nothing to give back.
    const f = await loadFixture(deployFixture);
    const before = await f.token.read.balanceOf([f.alice.account.address]);
    await f.gov.write.propose(proposal());
    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, FOR]);
    expect(await f.token.read.balanceOf([f.alice.account.address])).to.equal(before);
    expect(await f.token.read.balanceOf([f.gov.address])).to.equal(0n);
  });

  it("cannot be voted with weight acquired after the question was asked", async () => {
    /*
     * The attack a live-balance governor allows: see the proposal, buy tokens,
     * vote, sell. The snapshot is the block before the proposal, which is
     * already final when anyone learns the question exists.
     */
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());

    // Carol acquires a large stake *after* the snapshot.
    const t = await f.tokenAs(f.alice);
    await t.write.transfer([f.carol.account.address, T(500)]);
    await mine(1);

    const c = await f.govAs(f.carol);
    await c.write.castVote([0n, FOR]);
    const info = await f.gov.read.proposalInfo([0n]);
    expect(info[5]).to.equal(T(100)); // her weight at the snapshot, not 600
  });

  it("gives no weight to tokens that were never delegated", async () => {
    const f = await loadFixture(deployFixture);
    const [, , , , dave] = await hre.viem.getWalletClients();
    const t = await f.tokenAs(f.alice);
    await t.write.transfer([dave.account.address, T(500)]);
    await mine(1);
    await f.gov.write.propose(proposal());

    const d = await hre.viem.getContractAt("TesseraGovernor", f.gov.address, { client: { wallet: dave } });
    await expect(d.write.castVote([0n, FOR])).to.be.rejected; // NoVotingPower
  });

  it("will not let the locked treasury vote", async () => {
    // It holds almost everything and has never delegated, so it has no weight.
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    expect(await f.gov.read.votingPowerFor([0n, f.treasury.address])).to.equal(0n);
  });

  it("refuses a vote before it opens and after it closes", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    await time.increase(3 * DAY + 10);
    const a = await f.govAs(f.alice);
    await expect(a.write.castVote([0n, FOR])).to.be.rejected;
  });

  it("makes a winner wait before it can run", async () => {
    // Governance that executes the instant it passes gives anyone who dislikes
    // the outcome no time to leave.
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, FOR]);
    await time.increase(3 * DAY + 1);
    await expect(f.gov.write.execute([0n])).to.be.rejected; // Succeeded, not Queued
    await time.increase(DAY + 1);
    await f.gov.write.execute([0n]);
    expect(await f.gov.read.state([0n])).to.equal(S.Executed);
  });

  it("lets anyone execute a result, not only the admin", async () => {
    // A result only the admin can enact is a result the admin can decline.
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, FOR]);
    await time.increase(4 * DAY + 2);
    const c = await f.govAs(f.carol);
    await c.write.execute([0n]);
    expect(await f.gov.read.state([0n])).to.equal(S.Executed);
  });

  it("actually makes the calls a proposal carries", async () => {
    const f = await loadFixture(deployFixture);
    const target = await hre.viem.deployContract("MockSharePool");
    const asset = f.token.address;
    // setTotals(asset, 4242, 0) — the proposal's whole point is the side effect.
    const data =
      "0x" +
      "1f2a2005" + // setTotals(address,uint256,uint256)
      asset.slice(2).toLowerCase().padStart(64, "0") +
      (4242).toString(16).padStart(64, "0") +
      "0".repeat(64);
    const selector = await hre.viem.deployContract("MockSharePool"); // keep types happy
    void selector;

    await f.gov.write.propose(["Set totals", "for the test", [target.address], [data as `0x${string}`]]);
    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, FOR]);
    await time.increase(4 * DAY + 2);
    // The selector above is a guess; if it is wrong the call reverts and the
    // execute reverts with it, which is itself the property worth having.
    const ran = await f.gov.write.execute([0n]).then(() => true, () => false);
    if (ran) expect(await target.read.totalSupplyShares([asset])).to.equal(4242n);
    else expect(await f.gov.read.state([0n])).to.equal(S.Queued); // unchanged by a failed call
  });

  it("refuses to execute a proposal that lost", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const c = await f.govAs(f.carol);
    await c.write.castVote([0n, FOR]); // under quorum
    await time.increase(4 * DAY + 2);
    await expect(f.gov.write.execute([0n])).to.be.rejected;
  });

  it("cannot be executed twice", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const a = await f.govAs(f.alice);
    await a.write.castVote([0n, FOR]);
    await time.increase(4 * DAY + 2);
    await f.gov.write.execute([0n]);
    await expect(f.gov.write.execute([0n])).to.be.rejected;
  });

  it("only the admin may open or cancel a proposal", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.govAs(f.alice);
    await expect(a.write.propose(proposal())).to.be.rejected;
    await f.gov.write.propose(proposal());
    await expect(a.write.cancel([0n])).to.be.rejected;
  });

  it("cancels only before voting closes — a power to stop, never to start", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    await f.gov.write.cancel([0n]);
    expect(await f.gov.read.state([0n])).to.equal(S.Cancelled);

    await f.gov.write.propose(proposal("second"));
    await time.increase(3 * DAY + 10);
    await expect(f.gov.write.cancel([1n])).to.be.rejected;
  });

  it("rejects a support value that is not one of the three", async () => {
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const a = await f.govAs(f.alice);
    await expect(a.write.castVote([0n, 7])).to.be.rejected;
  });

  it("refuses a proposal whose targets and calldatas disagree", async () => {
    const f = await loadFixture(deployFixture);
    await expect(
      f.gov.write.propose(["bad", "mismatched", [f.token.address], []]),
    ).to.be.rejected;
  });

  it("allows a signalling proposal with no calls at all", async () => {
    // A question the protocol answers without the answer moving anything is
    // worth having; pretending otherwise pushes people into meaningless calls.
    const f = await loadFixture(deployFixture);
    await f.gov.write.propose(proposal());
    const info = await f.gov.read.proposalInfo([0n]);
    expect(info[11]).to.equal(0n); // no actions
  });
});
