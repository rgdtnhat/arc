import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-network-helpers";

const T = (n: number) => BigInt(n) * 10n ** 18n;
const HUNDRED_BILLION = 100_000_000_000n * 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * The token's job is to be boring in two specific ways: the supply never
 * changes, and voting power cannot be conjured out of a transfer. Both are
 * properties an attacker probes rather than features a user notices.
 */
async function deployFixture() {
  const [deployer, alice, bob, carol] = await hre.viem.getWalletClients();
  const token = await hre.viem.deployContract("TesseraToken", [deployer.account.address]);
  const as = async (w: any) => hre.viem.getContractAt("TesseraToken", token.address, { client: { wallet: w } });
  return { deployer, alice, bob, carol, token, as };
}

describe("TesseraToken (a supply fixed by the absence of a function)", () => {
  it("mints exactly one hundred billion, once, to the treasury", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.token.read.totalSupply()).to.equal(HUNDRED_BILLION);
    expect(await f.token.read.MAX_SUPPLY()).to.equal(HUNDRED_BILLION);
    expect(await f.token.read.balanceOf([f.deployer.account.address])).to.equal(HUNDRED_BILLION);
    expect(await f.token.read.decimals()).to.equal(18);
    expect(await f.token.read.symbol()).to.equal("TSRA");
    expect(await f.token.read.name()).to.equal("Tessera");
  });

  it("has no way to create another unit", async () => {
    // The guarantee is structural, so the test is too: the ABI must not carry
    // a mint, a burn that could be paired with one, or an owner who could add
    // either. A supply "fixed by policy" is fixed until the policy changes.
    const names = (f: any) => f.abi.filter((x: any) => x.type === "function").map((x: any) => x.name);
    const f = await loadFixture(deployFixture);
    const fns = names(f.token);
    for (const forbidden of ["mint", "burn", "owner", "transferOwnership", "upgradeTo", "setSupply"]) {
      expect(fns).to.not.include(forbidden);
    }
  });

  it("refuses a zero treasury rather than burning the whole supply", async () => {
    await expect(hre.viem.deployContract("TesseraToken", [ZERO])).to.be.rejected;
  });

  it("moves tokens and keeps the books", async () => {
    const f = await loadFixture(deployFixture);
    await f.token.write.transfer([f.alice.account.address, T(1000)]);
    expect(await f.token.read.balanceOf([f.alice.account.address])).to.equal(T(1000));
    expect(await f.token.read.balanceOf([f.deployer.account.address])).to.equal(HUNDRED_BILLION - T(1000));
  });

  it("refuses a transfer larger than the balance", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await expect(a.write.transfer([f.bob.account.address, T(1)])).to.be.rejected;
  });

  it("spends an allowance down, and treats max as infinite", async () => {
    const f = await loadFixture(deployFixture);
    await f.token.write.approve([f.alice.account.address, T(100)]);
    const a = await f.as(f.alice);
    await a.write.transferFrom([f.deployer.account.address, f.bob.account.address, T(40)]);
    expect(await f.token.read.allowance([f.deployer.account.address, f.alice.account.address])).to.equal(T(60));
    await expect(a.write.transferFrom([f.deployer.account.address, f.bob.account.address, T(100)])).to.be.rejected;

    await f.token.write.approve([f.alice.account.address, 2n ** 256n - 1n]);
    await a.write.transferFrom([f.deployer.account.address, f.bob.account.address, T(1000)]);
    expect(await f.token.read.allowance([f.deployer.account.address, f.alice.account.address])).to.equal(2n ** 256n - 1n);
  });

  it("gives holders no voting power until they delegate", async () => {
    /*
     * The property that keeps an exchange's omnibus wallet — or an AMM pool —
     * from silently voting with other people's tokens.
     */
    const f = await loadFixture(deployFixture);
    await f.token.write.transfer([f.alice.account.address, T(1000)]);
    expect(await f.token.read.balanceOf([f.alice.account.address])).to.equal(T(1000));
    expect(await f.token.read.getVotes([f.alice.account.address])).to.equal(0n);

    const a = await f.as(f.alice);
    await a.write.delegate([f.alice.account.address]);
    expect(await f.token.read.getVotes([f.alice.account.address])).to.equal(T(1000));
  });

  it("moves voting power with the tokens once delegated", async () => {
    const f = await loadFixture(deployFixture);
    await f.token.write.transfer([f.alice.account.address, T(1000)]);
    const a = await f.as(f.alice);
    await a.write.delegate([f.alice.account.address]);
    await a.write.transfer([f.bob.account.address, T(400)]);

    expect(await f.token.read.getVotes([f.alice.account.address])).to.equal(T(600));
    // Bob has not delegated, so the weight simply leaves rather than arriving.
    expect(await f.token.read.getVotes([f.bob.account.address])).to.equal(0n);
  });

  it("lets one holder point weight at somebody else", async () => {
    const f = await loadFixture(deployFixture);
    await f.token.write.transfer([f.alice.account.address, T(1000)]);
    const a = await f.as(f.alice);
    await a.write.delegate([f.bob.account.address]);
    expect(await f.token.read.getVotes([f.bob.account.address])).to.equal(T(1000));
    expect(await f.token.read.getVotes([f.alice.account.address])).to.equal(0n);

    await a.write.delegate([ZERO]); // and withdraw it again
    expect(await f.token.read.getVotes([f.bob.account.address])).to.equal(0n);
  });

  it("cannot be voted twice by passing the same tokens along", async () => {
    /*
     * The attack live balances allow: delegate, vote, send the tokens on, and
     * have the recipient vote the same weight again. A snapshot taken before
     * the transfer answers for the state at that block for everybody.
     */
    const f = await loadFixture(deployFixture);
    await f.token.write.transfer([f.alice.account.address, T(1000)]);
    const a = await f.as(f.alice);
    await a.write.delegate([f.alice.account.address]);
    await mine(1);
    const snapshot = BigInt(await hre.network.provider.send("eth_blockNumber"));

    await a.write.transfer([f.bob.account.address, T(1000)]);
    const b = await f.as(f.bob);
    await b.write.delegate([f.bob.account.address]);
    await mine(1);

    // At the snapshot the weight was Alice's and nobody else's.
    expect(await f.token.read.getPastVotes([f.alice.account.address, snapshot])).to.equal(T(1000));
    expect(await f.token.read.getPastVotes([f.bob.account.address, snapshot])).to.equal(0n);
    // Total voted at that block is 1000, not 2000.
  });

  it("refuses to answer for the current block or the future", async () => {
    // A snapshot of a block still being built can change under a voter between
    // the read and the vote, which is the thing checkpoints exist to prevent.
    const f = await loadFixture(deployFixture);
    const now = BigInt(await hre.network.provider.send("eth_blockNumber"));
    await expect(f.token.read.getPastVotes([f.alice.account.address, now])).to.be.rejected;
    await expect(f.token.read.getPastVotes([f.alice.account.address, now + 100n])).to.be.rejected;
  });

  it("answers zero for a block before the holder existed", async () => {
    const f = await loadFixture(deployFixture);
    const early = BigInt(await hre.network.provider.send("eth_blockNumber"));
    await mine(2);
    await f.token.write.transfer([f.alice.account.address, T(1000)]);
    const a = await f.as(f.alice);
    await a.write.delegate([f.alice.account.address]);
    await mine(1);
    expect(await f.token.read.getPastVotes([f.alice.account.address, early])).to.equal(0n);
  });

  it("collapses several moves in one block into one record", async () => {
    // Otherwise a lookup for that block could see a partial state.
    const f = await loadFixture(deployFixture);
    await f.token.write.transfer([f.alice.account.address, T(1000)]);
    const a = await f.as(f.alice);
    await a.write.delegate([f.alice.account.address]);
    const before = await f.token.read.checkpointCount([f.alice.account.address]);

    await hre.network.provider.send("evm_setAutomine", [false]);
    await a.write.transfer([f.bob.account.address, T(100)]);
    await a.write.transfer([f.carol.account.address, T(100)]);
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_setAutomine", [true]);

    const after = await f.token.read.checkpointCount([f.alice.account.address]);
    expect(after - before).to.equal(1n);
    expect(await f.token.read.getVotes([f.alice.account.address])).to.equal(T(800));
  });

  it("keeps history searchable across many checkpoints", async () => {
    const f = await loadFixture(deployFixture);
    await f.token.write.transfer([f.alice.account.address, T(1000)]);
    const a = await f.as(f.alice);
    await a.write.delegate([f.alice.account.address]);

    const marks: { block: bigint; votes: bigint }[] = [];
    for (let i = 0; i < 12; i++) {
      await a.write.transfer([f.bob.account.address, T(10)]);
      marks.push({
        block: BigInt(await hre.network.provider.send("eth_blockNumber")),
        votes: await f.token.read.getVotes([f.alice.account.address]),
      });
    }
    await mine(1);
    // The binary search must land on the right record for every one of them.
    for (const m of marks) {
      expect(await f.token.read.getPastVotes([f.alice.account.address, m.block])).to.equal(m.votes);
    }
  });

  it("will not send to the zero address by accident", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.token.write.transfer([ZERO, T(1)])).to.be.rejected;
  });
});
