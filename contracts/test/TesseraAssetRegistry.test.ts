import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const UNLISTED = 0, WHITELISTED = 1, REVOKED = 2;

/**
 * The register is small, so what matters is the shape of its decisions: three
 * states rather than two, a reason attached to each, and a revocation that
 * stops future rewards without touching anything anybody already holds.
 */
async function deployFixture() {
  const [owner, alice] = await hre.viem.getWalletClients();
  const reg = await hre.viem.deployContract("TesseraAssetRegistry", [owner.account.address]);
  const usdc = await hre.viem.deployContract("MockToken", ["USD Coin", "USDC", 6]);
  const scam = await hre.viem.deployContract("MockToken", ["Definitely Fine", "FINE", 18]);
  const as = async (w: any) => hre.viem.getContractAt("TesseraAssetRegistry", reg.address, { client: { wallet: w } });
  return { owner, alice, reg, usdc, scam, as };
}

describe("TesseraAssetRegistry (what the protocol will pay rewards for)", () => {
  it("defaults to undecided rather than to no", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.reg.read.statusOf([f.usdc.address])).to.equal(UNLISTED);
    expect(await f.reg.read.isWhitelisted([f.usdc.address])).to.equal(false);
  });

  it("distinguishes a revocation from never having been listed", async () => {
    /*
     * "Somebody looked and said no" is information that "nothing has been
     * decided" erases, and it is exactly the information a person deciding
     * whether to provide liquidity wants.
     */
    const f = await loadFixture(deployFixture);
    await f.reg.write.setStatus([f.scam.address, WHITELISTED, "listed on request"]);
    await f.reg.write.setStatus([f.scam.address, REVOKED, "issuer stopped answering"]);
    expect(await f.reg.read.statusOf([f.scam.address])).to.equal(REVOKED);
    const [status, , reason] = await f.reg.read.entryOf([f.scam.address]);
    expect(status).to.equal(REVOKED);
    expect(reason).to.equal("issuer stopped answering");
  });

  it("records when a decision was made", async () => {
    const f = await loadFixture(deployFixture);
    await f.reg.write.setStatus([f.usdc.address, WHITELISTED, "the unit everything is priced in"]);
    const [, changedAt] = await f.reg.read.entryOf([f.usdc.address]);
    expect(changedAt > 0n).to.equal(true);
  });

  it("needs every asset of a set, not a majority of them", async () => {
    const f = await loadFixture(deployFixture);
    await f.reg.write.setStatus([f.usdc.address, WHITELISTED, "listed"]);
    expect(await f.reg.read.allWhitelisted([[f.usdc.address, f.scam.address]])).to.equal(false);
    await f.reg.write.setStatus([f.scam.address, WHITELISTED, "listed"]);
    expect(await f.reg.read.allWhitelisted([[f.usdc.address, f.scam.address]])).to.equal(true);
  });

  it("calls an empty set ineligible, not trivially eligible", async () => {
    // `every` over nothing is true, which would make a market with no declared
    // assets pass the check it exists to fail.
    const f = await loadFixture(deployFixture);
    expect(await f.reg.read.allWhitelisted([[]])).to.equal(false);
  });

  it("enumerates everything it has ever decided about, once", async () => {
    const f = await loadFixture(deployFixture);
    await f.reg.write.setStatus([f.usdc.address, WHITELISTED, "a"]);
    await f.reg.write.setStatus([f.usdc.address, REVOKED, "b"]);
    await f.reg.write.setStatus([f.scam.address, REVOKED, "c"]);
    expect(await f.reg.read.knownAssetCount()).to.equal(2n);
  });

  it("decides a batch in one call, which is what a proposal carries", async () => {
    const f = await loadFixture(deployFixture);
    await f.reg.write.setStatuses([
      [f.usdc.address, f.scam.address], [WHITELISTED, REVOKED], "quarterly review",
    ]);
    expect(await f.reg.read.isWhitelisted([f.usdc.address])).to.equal(true);
    expect(await f.reg.read.statusOf([f.scam.address])).to.equal(REVOKED);
  });

  it("refuses a batch whose lists disagree", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.reg.write.setStatuses([[f.usdc.address], [], "mismatched"])).to.be.rejected;
  });

  it("only the owner decides", async () => {
    const f = await loadFixture(deployFixture);
    const a = await f.as(f.alice);
    await expect(a.write.setStatus([f.usdc.address, WHITELISTED, "mine now"])).to.be.rejected;
    await expect(a.write.transferOwnership([f.alice.account.address])).to.be.rejected;
  });

  it("hands over to a governor in one call", async () => {
    // The intended end state: the register belongs to the vote, not to an
    // operator who can quietly list their own token.
    const f = await loadFixture(deployFixture);
    await f.reg.write.transferOwnership([f.alice.account.address]);
    expect((await f.reg.read.owner()).toLowerCase()).to.equal(f.alice.account.address.toLowerCase());
    await expect(f.reg.write.setStatus([f.usdc.address, WHITELISTED, "still mine?"])).to.be.rejected;
  });
});
