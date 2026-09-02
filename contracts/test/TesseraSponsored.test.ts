import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const H = (s: string) => `0x${Buffer.from(s.padEnd(32, "\0")).toString("hex")}` as `0x${string}`;
const HOUR = 3600;

/**
 * Arc charges gas in USDC, which quietly makes it a market only funded sellers
 * can enter: to be paid a provider must call `fulfill` and `providerClaim`, both
 * of which cost USDC, and it has none — because being paid is the thing it is
 * trying to do.
 *
 * The provider in these tests is deliberately created with a zero balance and
 * never given one. Every assertion is about it earning anyway.
 */
async function deployFixture() {
  const [deployer, buyer, relayer, broke] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);

  await usdc.write.mint([buyer.account.address, USDC(10_000)]);
  // `relayer` gets nothing either; it is paid out of the payout it carries.

  const escrowAs = async (w: any) =>
    hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: w } });
  const usdcAs = async (w: any) => hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: w } });

  const chainId = await (await hre.viem.getPublicClient()).getChainId();
  const domain = { name: "Tessera", version: "1", chainId, verifyingContract: escrow.address } as const;

  const signFulfill = async (paymentId: bigint, responseHash: `0x${string}`, nonce: bigint, deadline: bigint) =>
    broke.signTypedData({
      domain,
      types: {
        FulfillAuth: [
          { name: "paymentId", type: "uint256" },
          { name: "responseHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" },
        ],
      },
      primaryType: "FulfillAuth",
      message: { paymentId, responseHash, nonce, deadline },
    });

  const signClaim = async (paymentId: bigint, maxRelayFee: bigint, nonce: bigint, deadline: bigint) =>
    broke.signTypedData({
      domain,
      types: {
        ClaimAuth: [
          { name: "paymentId", type: "uint256" },
          { name: "maxRelayFee", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" },
        ],
      },
      primaryType: "ClaimAuth",
      message: { paymentId, maxRelayFee, nonce, deadline },
    });

  return { deployer, buyer, relayer, broke, usdc, escrow, escrowAs, usdcAs, signFulfill, signClaim };
}

async function openTo(f: Awaited<ReturnType<typeof deployFixture>>, price = USDC(100)) {
  const bond = await f.escrow.read.bondFor([price]);
  const ub = await f.usdcAs(f.buyer);
  await ub.write.approve([f.escrow.address, price + bond]);
  const eb = await f.escrowAs(f.buyer);
  await eb.write.open([f.broke.account.address, price, BigInt((await time.latest()) + HOUR), H("q")]);
  return { id: 1n, price, bond };
}

describe("Sponsored settlement (earning your first dollar owning nothing)", () => {
  it("the provider starts with literally zero and still gets paid", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.usdc.read.balanceOf([f.broke.account.address])).to.equal(0n);
    const { id, price } = await openTo(f);

    const dl = BigInt((await time.latest()) + HOUR);
    const sig1 = await f.signFulfill(id, H("response"), 0n, dl);
    const er = await f.escrowAs(f.relayer);
    await er.write.fulfillFor([id, H("response"), dl, sig1]);

    await time.increase(2 * HOUR);
    const fee = USDC(1);
    const sig2 = await f.signClaim(id, fee, 1n, BigInt((await time.latest()) + HOUR));
    await er.write.claimFor([id, fee, fee, BigInt((await time.latest()) + HOUR), sig2]);

    expect(await f.usdc.read.balanceOf([f.broke.account.address])).to.equal(price - fee);
    expect(await f.usdc.read.balanceOf([f.relayer.account.address])).to.equal(fee);
  });

  it("never charges more than the fee the provider signed", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openTo(f);
    const dl = BigInt((await time.latest()) + HOUR);
    const er = await f.escrowAs(f.relayer);
    await er.write.fulfillFor([id, H("r"), dl, await f.signFulfill(id, H("r"), 0n, dl)]);
    await time.increase(2 * HOUR);

    const dl2 = BigInt((await time.latest()) + HOUR);
    const sig = await f.signClaim(id, USDC(1), 1n, dl2);
    // A relayer setting its own price would make the authorization a blank cheque.
    await expect(er.write.claimFor([id, USDC(1), USDC(50), dl2, sig])).to.be.rejectedWith("FeeAboveAuthorized");
  });

  it("refuses a signature from anyone but the provider", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openTo(f);
    const dl = BigInt((await time.latest()) + HOUR);
    const forged = await f.buyer.signTypedData({
      domain: {
        name: "Tessera",
        version: "1",
        chainId: await (await hre.viem.getPublicClient()).getChainId(),
        verifyingContract: f.escrow.address,
      },
      types: {
        FulfillAuth: [
          { name: "paymentId", type: "uint256" },
          { name: "responseHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" },
        ],
      },
      primaryType: "FulfillAuth",
      message: { paymentId: id, responseHash: H("r"), nonce: 0n, deadline: dl },
    });
    const er = await f.escrowAs(f.relayer);
    await expect(er.write.fulfillFor([id, H("r"), dl, forged])).to.be.rejectedWith("BadSignature");
  });

  it("burns the nonce, so an authorization cannot be replayed", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openTo(f);
    const dl = BigInt((await time.latest()) + HOUR);
    const sig = await f.signFulfill(id, H("r"), 0n, dl);
    const er = await f.escrowAs(f.relayer);
    await er.write.fulfillFor([id, H("r"), dl, sig]);
    expect(await f.escrow.read.authNonce([f.broke.account.address])).to.equal(1n);
    await expect(er.write.fulfillFor([id, H("r"), dl, sig])).to.be.rejectedWith("BadState");
  });

  it("expires, so a signature is not a standing permission", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openTo(f);
    const dl = BigInt((await time.latest()) + 60);
    const sig = await f.signFulfill(id, H("r"), 0n, dl);
    await time.increase(120);
    const er = await f.escrowAs(f.relayer);
    await expect(er.write.fulfillFor([id, H("r"), dl, sig])).to.be.rejectedWith("AuthExpired");
  });

  it("is a gas sponsorship, not a shortcut past the dispute window", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openTo(f);
    const dl = BigInt((await time.latest()) + HOUR);
    const er = await f.escrowAs(f.relayer);
    await er.write.fulfillFor([id, H("r"), dl, await f.signFulfill(id, H("r"), 0n, dl)]);

    const dl2 = BigInt((await time.latest()) + HOUR);
    const sig = await f.signClaim(id, USDC(1), 1n, dl2);
    await expect(er.write.claimFor([id, USDC(1), USDC(1), dl2, sig])).to.be.rejectedWith("DisputeWindowOpen");
  });

  it("counts reputation on what the provider received, not the gross", async () => {
    const f = await loadFixture(deployFixture);
    const { id, price } = await openTo(f);
    const dl = BigInt((await time.latest()) + HOUR);
    const er = await f.escrowAs(f.relayer);
    await er.write.fulfillFor([id, H("r"), dl, await f.signFulfill(id, H("r"), 0n, dl)]);
    await time.increase(2 * HOUR);
    const dl2 = BigInt((await time.latest()) + HOUR);
    await er.write.claimFor([id, USDC(2), USDC(2), dl2, await f.signClaim(id, USDC(2), 1n, dl2)]);

    const [fulfilled, , earned] = await f.escrow.read.reputation([f.broke.account.address]);
    expect(fulfilled).to.equal(1n);
    // `earned` is read as a record of income, so the relay fee comes off it.
    expect(earned).to.equal(price - USDC(2));
  });

  it("leaves the protocol fee unchanged by whether a claim was sponsored", async () => {
    const f = await loadFixture(deployFixture);
    await f.escrow.write.setProtocolFee([100, f.deployer.account.address]);
    const { id, price } = await openTo(f);
    const dl = BigInt((await time.latest()) + HOUR);
    const er = await f.escrowAs(f.relayer);
    await er.write.fulfillFor([id, H("r"), dl, await f.signFulfill(id, H("r"), 0n, dl)]);
    await time.increase(2 * HOUR);
    const dl2 = BigInt((await time.latest()) + HOUR);
    await er.write.claimFor([id, USDC(1), USDC(1), dl2, await f.signClaim(id, USDC(1), 1n, dl2)]);

    const protocolFee = (price * 100n) / 10_000n;
    expect(await f.usdc.read.balanceOf([f.deployer.account.address])).to.equal(protocolFee);
    expect(await f.usdc.read.balanceOf([f.broke.account.address])).to.equal(price - protocolFee - USDC(1));
  });

  it("still lets the provider do it itself once it can afford to", async () => {
    const f = await loadFixture(deployFixture);
    const { id, price } = await openTo(f);
    await f.usdc.write.mint([f.broke.account.address, USDC(5)]);
    const ep = await f.escrowAs(f.broke);
    await ep.write.fulfill([id, H("r")]);
    await time.increase(2 * HOUR);
    await ep.write.providerClaim([id]);
    expect(await f.usdc.read.balanceOf([f.broke.account.address])).to.equal(price + USDC(5));
  });

  it("rejects a malleable signature rather than letting it burn a nonce twice", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openTo(f);
    const dl = BigInt((await time.latest()) + HOUR);
    const sig = await f.signFulfill(id, H("r"), 0n, dl);

    // Flip s to its complement and v with it: same signer, different bytes.
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const r = sig.slice(0, 66);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = parseInt(sig.slice(130, 132), 16);
    const flipped = (`${r}${(N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27)
      .toString(16)
      .padStart(2, "0")}`) as `0x${string}`;

    const er = await f.escrowAs(f.relayer);
    await expect(er.write.fulfillFor([id, H("r"), dl, flipped])).to.be.rejectedWith("BadSignature");
  });
});
