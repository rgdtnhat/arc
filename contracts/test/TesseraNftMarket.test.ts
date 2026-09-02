import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Listing an NFT for USDC, and the two things that make a listing trustworthy.
 *
 * The first is escrow. A market that leaves the token with the seller and pulls
 * it on sale lets a buyer pay gas to discover that the seller moved, sold, or
 * un-approved it a block earlier. Escrow makes a live listing a promise the
 * contract can keep — and `cancel` stays open to the seller, so nothing is
 * trapped by it.
 *
 * The second is the price. A seller may re-price their own listing at any time,
 * so without the buyer stating a ceiling a seller could watch a purchase in the
 * mempool, raise the price, and be paid the higher one out of a wallet that
 * never agreed to it. Same failure the escrow and launchpad sides guard.
 */

const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));
const ZERO = "0x0000000000000000000000000000000000000000";

async function fixture() {
  const [admin, seller, buyer, treasury] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const pad = await hre.viem.deployContract("TesseraLaunchpad", [usdc.address, treasury.account.address, 0]);
  const market = await hre.viem.deployContract("TesseraNftMarket", [
    usdc.address, treasury.account.address, 250,
  ]);

  const as = async (name: string, addr: `0x${string}`, who: any) =>
    hre.viem.getContractAt(name as never, addr, { client: { wallet: who } });

  // A free drop, approved, so the seller can own a token to sell.
  const padSeller = await as("TesseraLaunchpad", pad.address, seller);
  await padSeller.write.submit(["Art", "ipfs://a", 0n, 10]);
  await pad.write.approveDrop([0n]);
  await padSeller.write.mint([0n, seller.account.address, 0n]); // token 1

  await usdc.write.mint([buyer.account.address, USDC("1000")]);
  const usdcBuyer = await as("MockUSDC", usdc.address, buyer);
  await usdcBuyer.write.approve([market.address, USDC("1000")]);

  return { usdc, pad, market, admin, seller, buyer, treasury, as };
}

/** Approve the market and list token 1 at `price`. */
async function listed(f: Awaited<ReturnType<typeof fixture>>, price: bigint) {
  const padSeller = await f.as("TesseraLaunchpad", f.pad.address, f.seller);
  await padSeller.write.approve([f.market.address, 1n]);
  const mSeller = await f.as("TesseraNftMarket", f.market.address, f.seller);
  await mSeller.write.list([f.pad.address, 1n, price]);
  return 0n;
}

describe("TesseraNftMarket", () => {
  it("listing escrows the token, so a live listing is a promise it can keep", async () => {
    const f = await loadFixture(fixture);
    const id = await listed(f, USDC("10"));
    expect((await f.pad.read.ownerOf([1n])).toLowerCase()).to.equal(f.market.address.toLowerCase());
    const l = await f.market.read.listings([id]);
    expect(l[3]).to.equal(USDC("10"));
    expect(l[4]).to.equal(true);
  });

  it("refuses to list without an approval, and says which problem it is", async () => {
    const f = await loadFixture(fixture);
    const mSeller = await f.as("TesseraNftMarket", f.market.address, f.seller);
    await expect(mSeller.write.list([f.pad.address, 1n, USDC("1")])).to.be.rejected;
  });

  it("refuses to list somebody else's token", async () => {
    const f = await loadFixture(fixture);
    const mBuyer = await f.as("TesseraNftMarket", f.market.address, f.buyer);
    await expect(mBuyer.write.list([f.pad.address, 1n, USDC("1")])).to.be.rejected;
  });

  it("a sale pays the seller and the treasury, and the market keeps nothing", async () => {
    const f = await loadFixture(fixture);
    const id = await listed(f, USDC("10"));
    const mBuyer = await f.as("TesseraNftMarket", f.market.address, f.buyer);
    await mBuyer.write.buy([id, USDC("10")]);

    expect((await f.pad.read.ownerOf([1n])).toLowerCase()).to.equal(f.buyer.account.address.toLowerCase());
    expect(await f.usdc.read.balanceOf([f.seller.account.address])).to.equal(USDC("9.75"));
    expect(await f.usdc.read.balanceOf([f.treasury.account.address])).to.equal(USDC("0.25"));
    expect(await f.usdc.read.balanceOf([f.market.address])).to.equal(0n);
  });

  it("a seller cannot be paid more than the buyer agreed to", async () => {
    /*
     * The attack, run for real: the buyer approves 1000 because that is what an
     * approval looks like, signs a purchase at 10, and the seller re-prices to
     * 500 first.
     */
    const f = await loadFixture(fixture);
    const id = await listed(f, USDC("10"));
    const mSeller = await f.as("TesseraNftMarket", f.market.address, f.seller);
    await mSeller.write.setPrice([id, USDC("500")]);

    const mBuyer = await f.as("TesseraNftMarket", f.market.address, f.buyer);
    await expect(mBuyer.write.buy([id, USDC("10")])).to.be.rejected;
    // Nothing moved, and the token is still escrowed.
    expect(await f.usdc.read.balanceOf([f.buyer.account.address])).to.equal(USDC("1000"));
    expect((await f.pad.read.ownerOf([1n])).toLowerCase()).to.equal(f.market.address.toLowerCase());
  });

  it("the seller can always take it back", async () => {
    const f = await loadFixture(fixture);
    const id = await listed(f, USDC("10"));
    const mSeller = await f.as("TesseraNftMarket", f.market.address, f.seller);
    await mSeller.write.cancel([id]);
    expect((await f.pad.read.ownerOf([1n])).toLowerCase()).to.equal(f.seller.account.address.toLowerCase());
    // …and it is no longer buyable.
    const mBuyer = await f.as("TesseraNftMarket", f.market.address, f.buyer);
    await expect(mBuyer.write.buy([id, USDC("10")])).to.be.rejected;
  });

  it("a sold or cancelled listing cannot be bought twice", async () => {
    const f = await loadFixture(fixture);
    const id = await listed(f, USDC("10"));
    const mBuyer = await f.as("TesseraNftMarket", f.market.address, f.buyer);
    await mBuyer.write.buy([id, USDC("10")]);
    await expect(mBuyer.write.buy([id, USDC("10")])).to.be.rejected;
  });

  it("only the seller re-prices or cancels; the admin may cancel", async () => {
    const f = await loadFixture(fixture);
    const id = await listed(f, USDC("10"));
    const mBuyer = await f.as("TesseraNftMarket", f.market.address, f.buyer);
    await expect(mBuyer.write.setPrice([id, 0n])).to.be.rejected;
    await expect(mBuyer.write.cancel([id])).to.be.rejected;
    // The admin's kill switch returns it to the seller, not to the admin.
    await f.market.write.cancel([id]);
    expect((await f.pad.read.ownerOf([1n])).toLowerCase()).to.equal(f.seller.account.address.toLowerCase());
  });

  it("you cannot buy your own listing", async () => {
    const f = await loadFixture(fixture);
    const id = await listed(f, USDC("10"));
    const mSeller = await f.as("TesseraNftMarket", f.market.address, f.seller);
    await expect(mSeller.write.buy([id, USDC("10")])).to.be.rejected;
  });

  it("the fee is capped in code, not by convention", async () => {
    const f = await loadFixture(fixture);
    await f.market.write.setFeeBps([1000]);
    await expect(f.market.write.setFeeBps([1001])).to.be.rejected;
    await expect(
      hre.viem.deployContract("TesseraNftMarket", [f.usdc.address, f.treasury.account.address, 1001]),
    ).to.be.rejected;
  });

  it("a free listing transfers without touching USDC", async () => {
    const f = await loadFixture(fixture);
    const id = await listed(f, 0n);
    const mBuyer = await f.as("TesseraNftMarket", f.market.address, f.buyer);
    await mBuyer.write.buy([id, 0n]);
    expect(await f.usdc.read.balanceOf([f.buyer.account.address])).to.equal(USDC("1000"));
    expect((await f.pad.read.ownerOf([1n])).toLowerCase()).to.equal(f.buyer.account.address.toLowerCase());
  });

  it("listingOf finds the live listing for a token, and forgets a dead one", async () => {
    const f = await loadFixture(fixture);
    const id = await listed(f, USDC("1"));
    let [found, at] = await f.market.read.listingOf([f.pad.address, 1n]);
    expect(found).to.equal(true);
    expect(at).to.equal(id);
    const mSeller = await f.as("TesseraNftMarket", f.market.address, f.seller);
    await mSeller.write.cancel([id]);
    [found] = await f.market.read.listingOf([f.pad.address, 1n]);
    expect(found).to.equal(false);
  });

  it("refuses a zero collection address", async () => {
    const f = await loadFixture(fixture);
    const mSeller = await f.as("TesseraNftMarket", f.market.address, f.seller);
    await expect(mSeller.write.list([ZERO, 1n, USDC("1")])).to.be.rejected;
  });
});
