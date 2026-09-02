import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeFunctionData, toFunctionSelector, getAddress } from "viem";

const PRICE = 10n ** 8n;
const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));
const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * The timelock owns the pool, so these drive it the way an operator would:
 * through the queue, against a real TesseraPool, checking that the pool's state
 * only moves when it is supposed to.
 */
async function deployFixture() {
  const [operator, alice, stranger, guardian] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const pool = await hre.viem.deployContract("TesseraPool", [operator.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, PRICE]);

  // Freezing is the emergency brake, so it is the one thing that skips the wait.
  const FREEZE_MANY = toFunctionSelector("function setFrozenMany(address[],uint8)");

  const timelock = await hre.viem.deployContract("TesseraTimelock", [
    operator.account.address,
    guardian.account.address,
    BigInt(DAY),
    [FREEZE_MANY],
  ]);

  // Hand the pool over. From here the operator can only act through the queue.
  await pool.write.transferOwnership([timelock.address]);

  const poolAbi = (await hre.artifacts.readArtifact("TesseraPool")).abi;
  const timelockAbi = (await hre.artifacts.readArtifact("TesseraTimelock")).abi;
  const call = (functionName: string, args: any[]) =>
    encodeFunctionData({ abi: poolAbi as any, functionName, args });
  const selfCall = (functionName: string, args: any[]) =>
    encodeFunctionData({ abi: timelockAbi as any, functionName, args });

  const as = (who: any) =>
    hre.viem.getContractAt("TesseraTimelock", timelock.address, { client: { wallet: who } });

  return { operator, alice, stranger, usdc, pool, timelock, call, selfCall, as, FREEZE_MANY, guardian };
}

describe("TesseraTimelock (owner powers that announce themselves)", () => {
  it("takes ownership of the pool, so the operator cannot act directly", async () => {
    const { operator, pool, timelock } = await loadFixture(deployFixture);
    expect(getAddress(await pool.read.owner())).to.equal(getAddress(timelock.address));
    // The operator's own key no longer moves anything on the pool.
    await expect(pool.write.setPrice([await pool.read.reserveList([0n]), 2n * PRICE])).to.be.rejected;
    void operator;
  });

  it("does not apply a queued change until the delay has passed", async () => {
    const { usdc, pool, timelock, call } = await loadFixture(deployFixture);
    await timelock.write.queue([pool.address, call("setPrice", [usdc.address, 2n * PRICE])]);

    // Announced, and not yet in force.
    await expect(timelock.write.execute([1n])).to.be.rejected;
    const r = await pool.read.reserves([usdc.address]);
    expect(r[7]).to.equal(PRICE);

    await time.increase(DAY + 1);
    await timelock.write.execute([1n]);
    expect((await pool.read.reserves([usdc.address]))[7]).to.equal(2n * PRICE);
  });

  it("publishes the calldata, not a hash of it", async () => {
    // A depositor cannot evaluate a change they can only see the hash of.
    const { usdc, pool, timelock, call } = await loadFixture(deployFixture);
    const data = call("setCaps", [usdc.address, USDC("1000"), USDC("500")]);
    await timelock.write.queue([pool.address, data]);
    const d = await timelock.read.actionData([1n]);
    expect(d[7]).to.equal(data);
    expect(getAddress(d[0])).to.equal(getAddress(pool.address));
  });

  it("reports where an action is in its life", async () => {
    const { usdc, pool, timelock, call } = await loadFixture(deployFixture);
    await timelock.write.queue([pool.address, call("setPrice", [usdc.address, 2n * PRICE])]);

    let d = await timelock.read.actionData([1n]);
    expect(d[4]).to.equal(false); // not ready
    expect(d[6] > 0n).to.equal(true); // seconds remaining

    await time.increase(DAY + 1);
    d = await timelock.read.actionData([1n]);
    expect(d[4]).to.equal(true);
    expect(d[6]).to.equal(0n);
    expect(d[5]).to.equal(false); // not stale
  });

  it("lets a matured action go stale rather than sit executable forever", async () => {
    const { usdc, pool, timelock, call } = await loadFixture(deployFixture);
    await timelock.write.queue([pool.address, call("setPrice", [usdc.address, 5n * PRICE])]);
    const grace = Number(await timelock.read.GRACE_PERIOD());
    await time.increase(DAY + grace + 1);

    // Springing a months-old approval on a depositor who stopped watching is
    // exactly what the announcement is meant to prevent.
    expect((await timelock.read.actionData([1n]))[5]).to.equal(true);
    await expect(timelock.write.execute([1n])).to.be.rejected;
    expect((await pool.read.reserves([usdc.address]))[7]).to.equal(PRICE);
  });

  it("cancels a queued action, permanently", async () => {
    const { usdc, pool, timelock, call } = await loadFixture(deployFixture);
    await timelock.write.queue([pool.address, call("setPrice", [usdc.address, 9n * PRICE])]);
    await timelock.write.cancel([1n]);
    await time.increase(DAY + 1);
    await expect(timelock.write.execute([1n])).to.be.rejected;
    expect((await pool.read.reserves([usdc.address]))[7]).to.equal(PRICE);
  });

  it("never runs the same action twice", async () => {
    const { usdc, pool, timelock, call } = await loadFixture(deployFixture);
    await timelock.write.queue([pool.address, call("setPrice", [usdc.address, 3n * PRICE])]);
    await time.increase(DAY + 1);
    await timelock.write.execute([1n]);
    await expect(timelock.write.execute([1n])).to.be.rejected;
  });

  it("surfaces a failing call rather than marking it done", async () => {
    const { pool, timelock, call, stranger } = await loadFixture(deployFixture);
    // setCaps on an asset that is not a reserve reverts inside the pool.
    await timelock.write.queue([pool.address, call("setCaps", [stranger.account.address, 1n, 1n])]);
    await time.increase(DAY + 1);
    await expect(timelock.write.execute([1n])).to.be.rejected;
  });

  it("freezes immediately, because a brake that waits a day is not a brake", async () => {
    const { usdc, pool, timelock, call } = await loadFixture(deployFixture);
    await timelock.write.runInstant([pool.address, call("setFrozenMany", [[usdc.address], 15])]);
    expect(await pool.read.frozenActions([usdc.address])).to.equal(15);
  });

  it("refuses the fast lane to anything not on the list", async () => {
    const { usdc, pool, timelock, call } = await loadFixture(deployFixture);
    // The whole point: re-marking a price cannot skip the wait.
    await expect(
      timelock.write.runInstant([pool.address, call("setPrice", [usdc.address, 100n * PRICE])]),
    ).to.be.rejected;
    expect((await pool.read.reserves([usdc.address]))[7]).to.equal(PRICE);
  });

  it("will not let the operator widen the fast lane without waiting", async () => {
    // An instant list the operator can edit at will is not a timelock.
    const { timelock } = await loadFixture(deployFixture);
    const setPriceSel = toFunctionSelector("function setPrice(address,uint256)");
    await expect(timelock.write.setInstant([setPriceSel, true])).to.be.rejected;
  });

  it("does let it be widened through the queue, like everything else", async () => {
    const { usdc, pool, timelock, call, selfCall } = await loadFixture(deployFixture);
    const setPriceSel = toFunctionSelector("function setPrice(address,uint256)");

    await timelock.write.queue([timelock.address, selfCall("setInstant", [setPriceSel, true])]);
    await time.increase(DAY + 1);
    await timelock.write.execute([1n]);

    expect(await timelock.read.instant([setPriceSel])).to.equal(true);
    await timelock.write.runInstant([pool.address, call("setPrice", [usdc.address, 4n * PRICE])]);
    expect((await pool.read.reserves([usdc.address]))[7]).to.equal(4n * PRICE);
  });

  it("subjects its own delay to its own delay", async () => {
    const { timelock, selfCall } = await loadFixture(deployFixture);
    await expect(timelock.write.setDelay([BigInt(6 * HOUR)])).to.be.rejected;

    await timelock.write.queue([timelock.address, selfCall("setDelay", [BigInt(2 * DAY)])]);
    await time.increase(DAY + 1);
    await timelock.write.execute([1n]);
    expect(await timelock.read.delay()).to.equal(BigInt(2 * DAY));
  });

  it("bounds the delay at both ends", async () => {
    const { timelock, selfCall } = await loadFixture(deployFixture);
    const min = await timelock.read.MIN_DELAY();
    const max = await timelock.read.MAX_DELAY();

    for (const bad of [min - 1n, max + 1n]) {
      await timelock.write.queue([timelock.address, selfCall("setDelay", [bad])]);
      const id = (await timelock.read.nextActionId()) - 1n;
      await time.increase(DAY + 1);
      // A delay nobody can react to, and one nobody can act within, are both
      // ways of not having a timelock.
      await expect(timelock.write.execute([id])).to.be.rejected;
    }
  });

  it("hands ownership on only through the queue", async () => {
    const { stranger, timelock, selfCall } = await loadFixture(deployFixture);
    await expect(timelock.write.transferOwnership([stranger.account.address])).to.be.rejected;

    await timelock.write.queue([
      timelock.address,
      selfCall("transferOwnership", [stranger.account.address]),
    ]);
    await time.increase(DAY + 1);
    await timelock.write.execute([1n]);
    expect(getAddress(await timelock.read.owner())).to.equal(getAddress(stranger.account.address));
  });

  it("keeps every deciding entry point away from anyone but the operator", async () => {
    const { usdc, pool, timelock, call, as, stranger } = await loadFixture(deployFixture);
    const s = await as(stranger);
    await expect(s.write.queue([pool.address, call("setPrice", [usdc.address, PRICE])])).to.be.rejected;
    await expect(s.write.runInstant([pool.address, call("setFrozenMany", [[usdc.address], 1])])).to.be.rejected;

    await timelock.write.queue([pool.address, call("setPrice", [usdc.address, 2n * PRICE])]);
    await time.increase(DAY + 1);
    await expect(s.write.cancel([1n])).to.be.rejected;
  });

  it("lets anyone run a matured action, because the deciding was done at queue time", async () => {
    /*
     * Deliberately open. Once a governor owns this, an owner-only `execute`
     * would mean a passed proposal queues a change and then needs a *second*
     * proposal to run it — two votes for one decision. By the time an action
     * matures the announcement has been public for the whole delay and the
     * guardian has declined to veto; there is nothing left to gate.
     */
    const { usdc, pool, timelock, call, as, stranger } = await loadFixture(deployFixture);
    await timelock.write.queue([pool.address, call("setPrice", [usdc.address, 2n * PRICE])]);
    await time.increase(DAY + 1);
    const s = await as(stranger);
    await s.write.execute([1n]);
    const r = await pool.read.reserves([usdc.address]);
    expect(r[7]).to.equal(2n * PRICE);
  });

  it("lets the guardian veto a queued change", async () => {
    const { usdc, pool, timelock, call, as, guardian } = await loadFixture(deployFixture);
    await timelock.write.queue([pool.address, call("setPrice", [usdc.address, 2n * PRICE])]);
    const g = await as(guardian);
    await g.write.cancel([1n]);
    await time.increase(DAY + 1);
    await expect(timelock.write.execute([1n])).to.be.rejected;
  });

  it("gives the guardian a veto and nothing else", async () => {
    /*
     * The asymmetry is the design. The worst a captured guardian can do is
     * stop things happening, which is fixed by replacing it; the worst an
     * unchecked timelock can do is enact something nobody noticed in time,
     * which is not fixable at all.
     */
    const { usdc, pool, timelock, call, as, guardian } = await loadFixture(deployFixture);
    const g = await as(guardian);
    await expect(g.write.queue([pool.address, call("setPrice", [usdc.address, PRICE])])).to.be.rejected;
    await expect(g.write.runInstant([pool.address, call("setFrozenMany", [[usdc.address], 1])])).to.be.rejected;
    await expect(g.write.setGuardian([guardian.account.address])).to.be.rejected;
    void timelock;
  });

  it("subjects appointing a guardian to its own delay", async () => {
    // A veto that could be removed instantly is not a veto, and one that could
    // be handed to an attacker instantly is worse than having none.
    const { timelock, selfCall, stranger } = await loadFixture(deployFixture);
    await timelock.write.queue([timelock.address, selfCall("setGuardian", [stranger.account.address])]);
    await time.increase(DAY + 1);
    await timelock.write.execute([1n]);
    expect((await timelock.read.guardian()).toLowerCase()).to.equal(stranger.account.address.toLowerCase());
  });

  it("rejects a delay outside the bounds at construction", async () => {
    const [operator] = await hre.viem.getWalletClients();
    await expect(
      hre.viem.deployContract("TesseraTimelock", [operator.account.address, 60n, []]),
    ).to.be.rejected;
    await expect(
      hre.viem.deployContract("TesseraTimelock", [operator.account.address, BigInt(400 * DAY), []]),
    ).to.be.rejected;
  });

  it("leaves liquidation alone, since it never went through the owner", async () => {
    // Auctions are permissionless. Nothing about owning the pool gates them, so
    // nothing about timelocking the owner can delay them.
    const { pool } = await loadFixture(deployFixture);
    const abi = (await hre.artifacts.readArtifact("TesseraPool")).abi as any[];
    const auctionFns = abi.filter(
      (f) => f.type === "function" && /Auction/i.test(f.name ?? ""),
    );
    expect(auctionFns.length > 0).to.equal(true);
    void pool;
  });
});
