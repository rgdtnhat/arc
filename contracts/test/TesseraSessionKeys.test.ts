import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * A delegation is only as good as the things it refuses.
 *
 * Almost every test here is a refusal, because the whole value of a session key
 * is what it *cannot* do with somebody else's wallet. A session that spends
 * correctly is the easy half; one that stops at the cap, dies on revocation,
 * expires on time, and cannot be widened by the key that holds it is the half
 * that makes it safe to hand out.
 */

const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));
const DAY = 24 * 60 * 60;

async function fixture() {
  const [owner, sessionKey, alice, bob, stranger] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const sessions = await hre.viem.deployContract("TesseraSessionKeys");
  await usdc.write.mint([owner.account.address, USDC("1000")]);
  return { sessions, usdc, owner, sessionKey, alice, bob, stranger };
}

/** Open a session and return its id, read from the event the UI reads. */
async function open(
  ctx: Awaited<ReturnType<typeof fixture>>,
  opts: { cap?: bigint; perTxMax?: bigint; expiry?: number; recipients?: `0x${string}`[]; approve?: bigint } = {},
) {
  const { sessions, usdc, owner, sessionKey } = ctx;
  const cap = opts.cap ?? USDC("100");
  const expiry = opts.expiry ?? (await time.latest()) + 30 * DAY;
  await usdc.write.approve([sessions.address, opts.approve ?? cap], { account: owner.account });
  await sessions.write.open(
    [sessionKey.account.address, usdc.address, cap, opts.perTxMax ?? 0n, BigInt(expiry), opts.recipients ?? []],
    { account: owner.account },
  );
  const logs = await sessions.getEvents.SessionOpened();
  return logs[logs.length - 1].args.id as `0x${string}`;
}

describe("TesseraSessionKeys", () => {
  it("lets the session key pay from the owner's wallet", async () => {
    const ctx = await loadFixture(fixture);
    const id = await open(ctx);
    await ctx.sessions.write.spend([id, ctx.alice.account.address, USDC("10")], { account: ctx.sessionKey.account });
    expect(await ctx.usdc.read.balanceOf([ctx.alice.account.address])).to.equal(USDC("10"));
    // The owner's wallet is where the money came from — the contract never held it.
    expect(await ctx.usdc.read.balanceOf([ctx.sessions.address])).to.equal(0n);
    expect(await ctx.usdc.read.balanceOf([ctx.owner.account.address])).to.equal(USDC("990"));
  });

  it("stops at the cap, however many transfers it takes", async () => {
    const ctx = await loadFixture(fixture);
    const id = await open(ctx, { cap: USDC("25") });
    for (let i = 0; i < 5; i++) {
      await ctx.sessions.write.spend([id, ctx.alice.account.address, USDC("5")], { account: ctx.sessionKey.account });
    }
    await expect(
      ctx.sessions.write.spend([id, ctx.alice.account.address, 1n], { account: ctx.sessionKey.account }),
    ).to.be.rejectedWith("CapExceeded");
    expect(await ctx.usdc.read.balanceOf([ctx.alice.account.address])).to.equal(USDC("25"));
  });

  it("refuses a single transfer above the per-transfer ceiling", async () => {
    const ctx = await loadFixture(fixture);
    const id = await open(ctx, { cap: USDC("100"), perTxMax: USDC("10") });
    await expect(
      ctx.sessions.write.spend([id, ctx.alice.account.address, USDC("11")], { account: ctx.sessionKey.account }),
    ).to.be.rejectedWith("PerTxExceeded");
    await ctx.sessions.write.spend([id, ctx.alice.account.address, USDC("10")], { account: ctx.sessionKey.account });
  });

  it("is dead the moment the owner revokes it", async () => {
    const ctx = await loadFixture(fixture);
    const id = await open(ctx);
    await ctx.sessions.write.revoke([id], { account: ctx.owner.account });
    await expect(
      ctx.sessions.write.spend([id, ctx.alice.account.address, 1n], { account: ctx.sessionKey.account }),
    ).to.be.rejectedWith("SessionRevokedError");
    expect(await ctx.sessions.read.active([id])).to.equal(false);
    expect(await ctx.sessions.read.spendable([id])).to.equal(0n);
  });

  it("cannot be revoked by the key that holds it, or by a stranger", async () => {
    const ctx = await loadFixture(fixture);
    const id = await open(ctx);
    await expect(ctx.sessions.write.revoke([id], { account: ctx.sessionKey.account })).to.be.rejectedWith("NotOwner");
    await expect(ctx.sessions.write.revoke([id], { account: ctx.stranger.account })).to.be.rejectedWith("NotOwner");
    expect(await ctx.sessions.read.active([id])).to.equal(true);
  });

  it("stops on its own at the expiry, with nobody watching", async () => {
    const ctx = await loadFixture(fixture);
    const expiry = (await time.latest()) + DAY;
    const id = await open(ctx, { expiry });
    await ctx.sessions.write.spend([id, ctx.alice.account.address, USDC("1")], { account: ctx.sessionKey.account });
    await time.increaseTo(expiry + 1);
    await expect(
      ctx.sessions.write.spend([id, ctx.alice.account.address, USDC("1")], { account: ctx.sessionKey.account }),
    ).to.be.rejectedWith("SessionExpired");
  });

  it("refuses an expiry that has already passed", async () => {
    const ctx = await loadFixture(fixture);
    const past = BigInt((await time.latest()) - 1);
    await ctx.usdc.write.approve([ctx.sessions.address, USDC("10")], { account: ctx.owner.account });
    await expect(
      ctx.sessions.write.open(
        [ctx.sessionKey.account.address, ctx.usdc.address, USDC("10"), 0n, past, []],
        { account: ctx.owner.account },
      ),
    ).to.be.rejectedWith("PastExpiry");
  });

  it("only the named key can spend", async () => {
    const ctx = await loadFixture(fixture);
    const id = await open(ctx);
    for (const who of [ctx.stranger, ctx.owner, ctx.alice]) {
      await expect(
        ctx.sessions.write.spend([id, ctx.alice.account.address, 1n], { account: who.account }),
      ).to.be.rejectedWith("NotSessionKey");
    }
  });

  it("pays only the allow-list when one was set", async () => {
    const ctx = await loadFixture(fixture);
    const id = await open(ctx, { recipients: [ctx.alice.account.address] });
    await ctx.sessions.write.spend([id, ctx.alice.account.address, USDC("1")], { account: ctx.sessionKey.account });
    await expect(
      ctx.sessions.write.spend([id, ctx.bob.account.address, USDC("1")], { account: ctx.sessionKey.account }),
    ).to.be.rejectedWith("RecipientNotAllowed");
  });

  it("the owner's allowance is a second ceiling the contract cannot raise", async () => {
    const ctx = await loadFixture(fixture);
    // A 100 cap, but the wallet only approved 5. Revocation must not depend on
    // this contract cooperating, so the allowance binds independently.
    const id = await open(ctx, { cap: USDC("100"), approve: USDC("5") });
    expect(await ctx.sessions.read.spendable([id])).to.equal(USDC("5"));
    await ctx.sessions.write.spend([id, ctx.alice.account.address, USDC("5")], { account: ctx.sessionKey.account });
    await expect(
      ctx.sessions.write.spend([id, ctx.alice.account.address, USDC("1")], { account: ctx.sessionKey.account }),
    ).to.be.rejected;
  });

  it("reports what can actually be paid, not what the cap says", async () => {
    const ctx = await loadFixture(fixture);
    const id = await open(ctx, { cap: USDC("500"), approve: USDC("500") });
    // The owner holds 1000 and approved 500, so the cap binds.
    expect(await ctx.sessions.read.spendable([id])).to.equal(USDC("500"));
    // Move the balance away: the session is still live and still uncapped, and
    // can still pay nothing. A scheduler reading the cap would queue a transfer
    // the chain refuses.
    await ctx.usdc.write.transfer([ctx.bob.account.address, USDC("900")], { account: ctx.owner.account });
    expect(await ctx.sessions.read.spendable([id])).to.equal(USDC("100"));
  });

  it("keeps sessions apart, including two for the same key and asset", async () => {
    const ctx = await loadFixture(fixture);
    const a = await open(ctx, { cap: USDC("10") });
    const b = await open(ctx, { cap: USDC("20") });
    expect(a).to.not.equal(b);
    await ctx.usdc.write.approve([ctx.sessions.address, USDC("30")], { account: ctx.owner.account });
    await ctx.sessions.write.spend([a, ctx.alice.account.address, USDC("10")], { account: ctx.sessionKey.account });
    // Draining one leaves the other exactly where it was.
    await expect(
      ctx.sessions.write.spend([a, ctx.alice.account.address, 1n], { account: ctx.sessionKey.account }),
    ).to.be.rejectedWith("CapExceeded");
    await ctx.sessions.write.spend([b, ctx.alice.account.address, USDC("20")], { account: ctx.sessionKey.account });
    expect((await ctx.sessions.read.sessionsOf([ctx.owner.account.address])).length).to.equal(2);
  });

  it("a session for one asset cannot touch another", async () => {
    const ctx = await loadFixture(fixture);
    const other = await hre.viem.deployContract("MockUSDC");
    await other.write.mint([ctx.owner.account.address, USDC("100")]);
    await other.write.approve([ctx.sessions.address, USDC("100")], { account: ctx.owner.account });
    const id = await open(ctx);
    await ctx.sessions.write.spend([id, ctx.alice.account.address, USDC("10")], { account: ctx.sessionKey.account });
    // The other token is untouched: the asset is fixed at open time and there
    // is no call that changes it.
    expect(await other.read.balanceOf([ctx.owner.account.address])).to.equal(USDC("100"));
  });

  it("counts spending down and says what is left", async () => {
    const ctx = await loadFixture(fixture);
    const id = await open(ctx, { cap: USDC("30") });
    await ctx.sessions.write.spend([id, ctx.alice.account.address, USDC("12")], { account: ctx.sessionKey.account });
    const s = await ctx.sessions.read.sessions([id]);
    expect(s[4]).to.equal(USDC("12")); // spent
    expect(await ctx.sessions.read.spendable([id])).to.equal(USDC("18"));
  });
});
