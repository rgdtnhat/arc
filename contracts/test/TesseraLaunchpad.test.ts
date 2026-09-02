import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * A curated launchpad, and the two things that make curation real.
 *
 * The first is that "pending" has to mean unmintable. A launchpad where an
 * admin's approval is advisory is not curated, it is decorated — anybody could
 * submit a drop and sell it before the admin ever saw it.
 *
 * The second is the price. `mint` moves a buyer's USDC to a stranger's address,
 * and the stranger is allowed to re-price their own drop at any time. Without
 * the buyer stating a ceiling, a creator can watch a mint in the mempool, raise
 * the price, and be paid the higher one out of a wallet that never agreed to
 * it. That is the same failure the escrow side spends a whole invariant on:
 * escrow only what was vetted.
 */

const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

async function fixture() {
  const [admin, creator, buyer, treasury] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const pad = await hre.viem.deployContract("TesseraLaunchpad", [
    usdc.address,
    treasury.account.address,
    250, // 2.5%
  ]);

  const as = async (who: any) =>
    hre.viem.getContractAt("TesseraLaunchpad", pad.address, { client: { wallet: who } });
  const usdcAs = async (who: any) =>
    hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: who } });

  await usdc.write.mint([buyer.account.address, USDC("1000")]);
  const bu = await usdcAs(buyer);
  await bu.write.approve([pad.address, USDC("1000")]);

  return { pad, usdc, admin, creator, buyer, treasury, as, usdcAs };
}

/** A submitted, admin-approved drop at `price`. */
async function approvedDrop(f: Awaited<ReturnType<typeof fixture>>, price: bigint, supply = 10) {
  const c = await f.as(f.creator);
  await c.write.submit(["Drop", "ipfs://base", price, supply]);
  const id = (await f.pad.read.dropCount()) - 1n;
  await f.pad.write.approveDrop([id]);
  return id;
}

describe("TesseraLaunchpad", () => {
  it("a pending drop cannot be minted, at any price", async () => {
    const f = await loadFixture(fixture);
    const c = await f.as(f.creator);
    await c.write.submit(["Unapproved", "ipfs://x", USDC("1"), 5]);
    const b = await f.as(f.buyer);
    await expect(b.write.mint([0n, f.buyer.account.address, USDC("1000")])).to.be.rejected;
    const [ok, why] = await f.pad.read.mintable([0n]);
    expect(ok).to.equal(false);
    expect(why).to.contain("approve");
  });

  it("a rejected drop stays unmintable and keeps the reason", async () => {
    const f = await loadFixture(fixture);
    const c = await f.as(f.creator);
    await c.write.submit(["Nope", "ipfs://x", 0n, 5]);
    await f.pad.write.rejectDrop([0n, "artwork is not the submitter's"]);
    const d = await f.pad.read.drops([0n]);
    expect(Number(d[4])).to.equal(2); // Status.Rejected
    expect(d[8]).to.equal("artwork is not the submitter's");
    const b = await f.as(f.buyer);
    await expect(b.write.mint([0n, f.buyer.account.address, 0n])).to.be.rejected;
  });

  it("a decision is final — neither approve nor reject can be replayed", async () => {
    const f = await loadFixture(fixture);
    const c = await f.as(f.creator);
    await c.write.submit(["Once", "ipfs://x", 0n, 5]);
    await f.pad.write.approveDrop([0n]);
    // Re-approving is harmless; un-approving after somebody minted would make
    // their token a claim on a drop the admin had disowned.
    await expect(f.pad.write.approveDrop([0n])).to.be.rejected;
    await expect(f.pad.write.rejectDrop([0n, "changed my mind"])).to.be.rejected;
  });

  it("only the admin decides", async () => {
    const f = await loadFixture(fixture);
    const c = await f.as(f.creator);
    await c.write.submit(["Mine", "ipfs://x", 0n, 5]);
    await expect(c.write.approveDrop([0n])).to.be.rejected;
    const b = await f.as(f.buyer);
    await expect(b.write.rejectDrop([0n, "no"])).to.be.rejected;
  });

  it("minting pays the creator and the treasury, and the contract keeps nothing", async () => {
    const f = await loadFixture(fixture);
    const id = await approvedDrop(f, USDC("10"));
    const b = await f.as(f.buyer);
    await b.write.mint([id, f.buyer.account.address, USDC("10")]);

    expect(await f.usdc.read.balanceOf([f.treasury.account.address])).to.equal(USDC("0.25"));
    expect(await f.usdc.read.balanceOf([f.creator.account.address])).to.equal(USDC("9.75"));
    expect(await f.usdc.read.balanceOf([f.pad.address])).to.equal(0n);
    // Checksummed out, lowercase in — compare the addresses, not their casing.
    expect((await f.pad.read.ownerOf([1n])).toLowerCase()).to.equal(f.buyer.account.address.toLowerCase());
    expect(await f.pad.read.balanceOf([f.buyer.account.address])).to.equal(1n);
  });

  it("a creator cannot be paid more than the buyer agreed to", async () => {
    /*
     * The attack, run for real. The buyer approves 1000 USDC because that is
     * what an approval looks like, signs a mint at 10, and the creator re-prices
     * to 500 first. `maxPrice` is the only thing standing between those two
     * facts.
     */
    const f = await loadFixture(fixture);
    const id = await approvedDrop(f, USDC("10"));
    const c = await f.as(f.creator);
    await c.write.setDropPrice([id, USDC("500")]);

    const b = await f.as(f.buyer);
    await expect(b.write.mint([id, f.buyer.account.address, USDC("10")])).to.be.rejected;
    // Nothing moved, and nothing was minted.
    expect(await f.usdc.read.balanceOf([f.buyer.account.address])).to.equal(USDC("1000"));
    expect(await f.pad.read.totalSupply()).to.equal(0n);
  });

  it("the supply is a ceiling, counted before the money moves", async () => {
    const f = await loadFixture(fixture);
    const id = await approvedDrop(f, USDC("1"), 2);
    const b = await f.as(f.buyer);
    await b.write.mint([id, f.buyer.account.address, USDC("1")]);
    await b.write.mint([id, f.buyer.account.address, USDC("1")]);
    await expect(b.write.mint([id, f.buyer.account.address, USDC("1")])).to.be.rejected;
    const [ok, why] = await f.pad.read.mintable([id]);
    expect(ok).to.equal(false);
    expect(why).to.equal("sold out");
  });

  it("pausing stops new mints and cannot touch minted tokens", async () => {
    const f = await loadFixture(fixture);
    const id = await approvedDrop(f, USDC("1"));
    const b = await f.as(f.buyer);
    await b.write.mint([id, f.buyer.account.address, USDC("1")]);

    const c = await f.as(f.creator);
    await c.write.setDropPaused([id, true]);
    await expect(b.write.mint([id, f.buyer.account.address, USDC("1")])).to.be.rejected;
    // The token already bought is still the buyer's.
    expect(await f.pad.read.balanceOf([f.buyer.account.address])).to.equal(1n);
    await c.write.setDropPaused([id, false]);
    await b.write.mint([id, f.buyer.account.address, USDC("1")]);
    expect(await f.pad.read.balanceOf([f.buyer.account.address])).to.equal(2n);
  });

  it("only the creator re-prices, and only creator or admin pauses", async () => {
    const f = await loadFixture(fixture);
    const id = await approvedDrop(f, USDC("1"));
    const b = await f.as(f.buyer);
    await expect(b.write.setDropPrice([id, 0n])).to.be.rejected;
    await expect(b.write.setDropPaused([id, true])).to.be.rejected;
    // The admin's kill switch works on somebody else's drop.
    await f.pad.write.setDropPaused([id, true]);
  });

  it("the fee is capped in code, not by convention", async () => {
    const f = await loadFixture(fixture);
    // 10% is the cap; anything above is refused however the admin asks.
    await f.pad.write.setFeeBps([1000]);
    await expect(f.pad.write.setFeeBps([1001])).to.be.rejected;
    await expect(f.pad.write.setFeeBps([10000])).to.be.rejected;
    await expect(
      hre.viem.deployContract("TesseraLaunchpad", [f.usdc.address, f.treasury.account.address, 1001]),
    ).to.be.rejected;
  });

  it("a free drop mints without touching USDC at all", async () => {
    const f = await loadFixture(fixture);
    const id = await approvedDrop(f, 0n);
    const b = await f.as(f.buyer);
    await b.write.mint([id, f.buyer.account.address, 0n]);
    expect(await f.usdc.read.balanceOf([f.buyer.account.address])).to.equal(USDC("1000"));
    expect(await f.pad.read.ownerOf([1n])).to.not.equal("0x0000000000000000000000000000000000000000");
  });

  it("a submission has to be a drop somebody could mint", async () => {
    const f = await loadFixture(fixture);
    const c = await f.as(f.creator);
    await expect(c.write.submit(["Zero", "ipfs://x", 0n, 0])).to.be.rejected;
    await expect(c.write.submit(["", "ipfs://x", 0n, 1])).to.be.rejected;
    await expect(c.write.submit(["Name", "", 0n, 1])).to.be.rejected;
    await expect(c.write.submit(["N".repeat(301), "ipfs://x", 0n, 1])).to.be.rejected;
  });

  it("tokenURI is the drop's base plus the token id", async () => {
    const f = await loadFixture(fixture);
    const id = await approvedDrop(f, 0n);
    const b = await f.as(f.buyer);
    await b.write.mint([id, f.buyer.account.address, 0n]);
    expect(await f.pad.read.tokenURI([1n])).to.equal("ipfs://base/1");
    await expect(f.pad.read.tokenURI([99n])).to.be.rejected;
  });

  it("a collection numbers its own items 1..N, whatever the global ids are", async () => {
    /*
     * The distinction that matters once a creator uploads a folder of images.
     * They number them 1..100; the global token id is whatever the launchpad
     * happened to be at, so a drop that opened second would send a wallet
     * looking for image 431 in a folder holding a hundred.
     */
    const f = await loadFixture(fixture);
    const first = await approvedDrop(f, 0n, 3);
    const second = await approvedDrop(f, 0n, 3);
    const b = await f.as(f.buyer);
    await b.write.mint([first, f.buyer.account.address, 0n]); // global 1
    await b.write.mint([second, f.buyer.account.address, 0n]); // global 2
    await b.write.mint([second, f.buyer.account.address, 0n]); // global 3

    expect(await f.pad.read.tokenURI([1n])).to.equal("ipfs://base/1");
    // Second drop, first item — not "2".
    expect(await f.pad.read.tokenURI([2n])).to.equal("ipfs://base/1");
    expect(await f.pad.read.tokenURI([3n])).to.equal("ipfs://base/2");
    expect(await f.pad.read.indexInDrop([3n])).to.equal(2);
  });

  it("transfers behave, and only for the holder or an approved spender", async () => {
    const f = await loadFixture(fixture);
    const id = await approvedDrop(f, 0n);
    const b = await f.as(f.buyer);
    await b.write.mint([id, f.buyer.account.address, 0n]);
    const c = await f.as(f.creator);
    await expect(
      c.write.transferFrom([f.buyer.account.address, f.creator.account.address, 1n]),
    ).to.be.rejected;
    await b.write.approve([f.creator.account.address, 1n]);
    await c.write.transferFrom([f.buyer.account.address, f.creator.account.address, 1n]);
    expect(await f.pad.read.balanceOf([f.buyer.account.address])).to.equal(0n);
    expect(await f.pad.read.balanceOf([f.creator.account.address])).to.equal(1n);
    // The approval does not survive the transfer.
    await expect(
      c.write.transferFrom([f.creator.account.address, f.buyer.account.address, 1n]),
    ).to.not.be.rejected;
  });

  it("advertises the ERC-721 interfaces a wallet looks for", async () => {
    const f = await loadFixture(fixture);
    expect(await f.pad.read.supportsInterface(["0x01ffc9a7"])).to.equal(true);
    expect(await f.pad.read.supportsInterface(["0x80ac58cd"])).to.equal(true);
    expect(await f.pad.read.supportsInterface(["0x5b5e139f"])).to.equal(true);
    expect(await f.pad.read.supportsInterface(["0xdeadbeef"])).to.equal(false);
  });
});
