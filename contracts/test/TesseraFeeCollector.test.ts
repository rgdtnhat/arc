import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const PRICE = 10n ** 8n;
const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

async function deployFixture() {
  const [deployer, agentWallet] = await hre.viem.getWalletClients();

  const usdc = await hre.viem.deployContract("MockUSDC");
  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  await pool.write.addReserve([usdc.address, 9000, 9500, 9500, 1000, true, 6, PRICE]);
  const vault = await hre.viem.deployContract("TesseraVault", [
    usdc.address,
    pool.address,
    deployer.account.address,
    8000,
    1500,
  ]);
  const swap = await hre.viem.deployContract("TesseraSwap", [pool.address, deployer.account.address, 30, 5000]);

  const collector = await hre.viem.deployContract("TesseraFeeCollector", [
    usdc.address,
    agentWallet.account.address,
    pool.address,
    vault.address,
    swap.address,
  ]);
  // The collector must own the swap desk to be able to seed it.
  await swap.write.transferOwnership([collector.address]);

  // Fund the collector with 100 USDC of "collected fees".
  await usdc.write.mint([collector.address, USDC("100")]);

  return { deployer, agentWallet, usdc, pool, vault, swap, collector };
}

describe("TesseraFeeCollector (fee allocation)", () => {
  it("defaults to a 20/20/20/20/20 split and a weekly cadence", async () => {
    const { collector } = await loadFixture(deployFixture);
    const s = await collector.read.shares();
    expect(s[0]).to.equal(2000); // agent
    expect(s[1]).to.equal(2000); // lending
    expect(s[2]).to.equal(2000); // vault
    expect(s[3]).to.equal(2000); // swap
    expect(s[4]).to.equal(2000); // retained
    expect(await collector.read.interval()).to.equal(7 * 24 * 3600);
  });

  it("allocates fees across agent, lending, vault, swap and retains the rest", async () => {
    const { agentWallet, usdc, pool, vault, swap, collector } = await loadFixture(deployFixture);
    await collector.write.allocateNow();

    // 20 USDC to the agent wallet.
    expect(await usdc.read.balanceOf([agentWallet.account.address])).to.equal(USDC("20"));
    // 20 USDC supplied to the pool as the app's own position.
    expect(await pool.read.supplyBalance([usdc.address, collector.address])).to.equal(USDC("20"));
    // 20 USDC deposited into the vault (collector holds shares).
    expect((await vault.read.sharesOf([collector.address])) > 0n).to.equal(true);
    // 20 USDC seeded into swap inventory.
    expect(await usdc.read.balanceOf([swap.address])).to.equal(USDC("20"));
    // ~20 USDC retained here.
    expect(await usdc.read.balanceOf([collector.address])).to.equal(USDC("20"));
  });

  it("rate-limits the permissionless allocate() to the configured interval", async () => {
    const { usdc, collector } = await loadFixture(deployFixture);
    // Freshly constructed: the interval has not elapsed yet.
    await expect(collector.write.allocate()).to.be.rejected;
    await time.increase(7 * 24 * 3600 + 1);
    await usdc.write.mint([collector.address, USDC("10")]);
    await collector.write.allocate(); // now permitted
    // Immediately again → too soon.
    await expect(collector.write.allocate()).to.be.rejected;
  });

  it("lets the owner retune the split, but only to exactly 100%", async () => {
    const { collector } = await loadFixture(deployFixture);
    await collector.write.setShares([5000, 2500, 2500, 0, 0]);
    const s = await collector.read.shares();
    expect(s[0]).to.equal(5000);
    expect(s[3]).to.equal(0);
    // Anything that doesn't total 100% is rejected.
    await expect(collector.write.setShares([5000, 2500, 2500, 0, 100])).to.be.rejected;
    await expect(collector.write.setShares([1000, 1000, 1000, 1000, 1000])).to.be.rejected;
  });

  it("accepts any cadence from a second to a year, and rejects the rest", async () => {
    const { collector } = await loadFixture(deployFixture);
    await collector.write.setInterval([1]); // every second
    expect(await collector.read.interval()).to.equal(1);
    await collector.write.setInterval([365 * 24 * 3600]); // yearly
    await expect(collector.write.setInterval([0])).to.be.rejected;
    await expect(collector.write.setInterval([365 * 24 * 3600 + 1])).to.be.rejected;
  });

  it("keeps funds safe when a sink is unset (retains instead of losing them)", async () => {
    const { deployer, usdc, collector } = await loadFixture(deployFixture);
    // Clear every sink; nothing can be delivered.
    await collector.write.setSinks([
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
    ]);
    await collector.write.allocateNow();
    // The whole balance is still here — nothing was burned.
    expect(await usdc.read.balanceOf([collector.address])).to.equal(USDC("100"));
    expect(deployer.account.address).to.be.a("string");
  });

  it("restricts admin functions to the owner", async () => {
    const { agentWallet, collector } = await loadFixture(deployFixture);
    const asOther = await hre.viem.getContractAt("TesseraFeeCollector", collector.address, {
      client: { wallet: agentWallet },
    });
    await expect(asOther.write.setShares([5000, 5000, 0, 0, 0])).to.be.rejected;
    await expect(asOther.write.setInterval([60])).to.be.rejected;
    await expect(asOther.write.allocateNow()).to.be.rejected;
    await expect(asOther.write.setAmm([collector.address, 0n])).to.be.rejected;
  });

  // The same contract, pointed at an AMM pool, is the AMM fee collector: the app's
  // half of every AMM swap fee is split 20% back into the pool / 20% lending /
  // 20% vault / 20% agent / 20% retained.
  it("funds an AMM pool with the swap leg when configured as the AMM collector", async () => {
    const { deployer, agentWallet, usdc, pool, vault, collector } = await loadFixture(deployFixture);
    const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin (mock)", "EURC", 6]);
    const amm = await hre.viem.deployContract("TesseraAMM", [collector.address]);
    await amm.write.createPool([[usdc.address, eurc.address], 30, 5000, "USDC / EURC"]);

    await usdc.write.mint([deployer.account.address, USDC("1000")]);
    await eurc.write.mint([deployer.account.address, USDC("1000")]);
    await usdc.write.approve([amm.address, USDC("1000")]);
    await eurc.write.approve([amm.address, USDC("1000")]);
    await amm.write.addLiquidity([0n, [USDC("1000"), USDC("1000")], 0n]);

    const sharesBefore = (await amm.read.poolInfo([0n]))[4];
    await collector.write.setAmm([amm.address, 0n]);
    await collector.write.allocateNow();

    const [, balances, , , sharesAfter] = await amm.read.poolInfo([0n]);
    expect(balances[0]).to.equal(USDC("1020")); // 20% funded into the pool
    expect(sharesAfter).to.equal(sharesBefore); // funding never mints shares
    // The other four legs behave exactly as before.
    expect(await usdc.read.balanceOf([agentWallet.account.address])).to.equal(USDC("20"));
    expect(await pool.read.supplyBalance([usdc.address, collector.address])).to.equal(USDC("20"));
    expect((await vault.read.sharesOf([collector.address])) > 0n).to.equal(true);
    expect(await usdc.read.balanceOf([collector.address])).to.equal(USDC("20"));
  });

  it("retains the swap leg when the configured AMM pool cannot take it", async () => {
    const { usdc, collector } = await loadFixture(deployFixture);
    const eurc = await hre.viem.deployContract("MockToken", ["Euro Coin (mock)", "EURC", 6]);
    const amm = await hre.viem.deployContract("TesseraAMM", [collector.address]);
    // Pool exists but has no liquidity yet, so `fund` reverts — the money must
    // stay in the collector rather than vanish or block the other legs.
    await amm.write.createPool([[usdc.address, eurc.address], 30, 5000, "empty"]);
    await collector.write.setAmm([amm.address, 0n]);
    await collector.write.allocateNow();
    expect(await usdc.read.balanceOf([amm.address])).to.equal(0n);
    expect(await usdc.read.balanceOf([collector.address])).to.equal(USDC("40")); // 20 retained + 20 undelivered
  });

  // --- reaching into the desk it owns -----------------------------------------

  it("can withdraw inventory from the swap desk it owns", async () => {
    const { deployer, usdc, swap, collector } = await loadFixture(deployFixture);
    // This is the trap the function exists for: deployment gives the collector
    // ownership so `seed` works, and `withdrawInventory` is owner-gated — so
    // without a forwarding path the desk's inventory is unreachable by anyone.
    await collector.write.allocateNow();
    const inDesk = await usdc.read.balanceOf([swap.address]);
    expect(inDesk > 0n).to.equal(true);
    expect((await swap.read.owner()).toLowerCase()).to.equal(collector.address.toLowerCase());

    const before = await usdc.read.balanceOf([deployer.account.address]);
    await collector.write.withdrawSwapInventory([usdc.address, inDesk, deployer.account.address]);
    expect(await usdc.read.balanceOf([swap.address])).to.equal(0n);
    expect(await usdc.read.balanceOf([deployer.account.address])).to.equal(before + inDesk);
  });

  it("only the collector's owner can pull from the desk", async () => {
    const { agentWallet, usdc, collector } = await loadFixture(deployFixture);
    const asOther = await hre.viem.getContractAt("TesseraFeeCollector", collector.address, {
      client: { wallet: agentWallet },
    });
    await expect(
      asOther.write.withdrawSwapInventory([usdc.address, 1n, agentWallet.account.address])
    ).to.be.rejected;
  });

  it("can point the desk it owns at an AMM pool", async () => {
    const { deployer, swap, collector } = await loadFixture(deployFixture);
    const amm = await hre.viem.deployContract("TesseraAMM", [deployer.account.address]);
    await collector.write.setSwapAmm([amm.address, 3n]);
    expect((await swap.read.amm()).toLowerCase()).to.equal(amm.address.toLowerCase());
    expect(await swap.read.ammPoolId()).to.equal(3n);
  });
});

describe("TesseraFeeCollector (a failed leg leaves nothing behind)", () => {
  /**
   * Each allocation leg approves its sink and then calls it inside `try`, so one
   * misconfigured sink cannot block the others. The catch used to zero the
   * reported amount and nothing else — which left a live allowance to that sink
   * for money it never took.
   *
   * No sink can act on such an allowance today (they all pull from `msg.sender`,
   * never from an arbitrary holder), so this was never drainable. But an
   * allowance nobody intended to grant should not be resting on that staying
   * true through the next refactor, and "the leg did not happen" should mean the
   * chain looks like it did not happen.
   */
  it("clears the approval for a sink whose call reverted", async () => {
    const { deployer, usdc, pool, vault, collector } = await loadFixture(deployFixture);

    // Freeze supply on the pool's reserve so the lending leg reverts inside its
    // `try`. The vault leg fails with it: its deposit supplies the same pool.
    const FREEZE_SUPPLY = 1;
    await pool.write.setFrozen([usdc.address, FREEZE_SUPPLY]);

    await time.increase(7 * 24 * 60 * 60 + 1);
    await collector.write.allocateNow();

    expect(await usdc.read.allowance([collector.address, pool.address])).to.equal(0n);
    expect(await usdc.read.allowance([collector.address, vault.address])).to.equal(0n);

    // And the money is still here — a failed leg retains, it does not burn.
    // chai's numeric matchers don't take bigint; compare directly.
    expect(await usdc.read.balanceOf([collector.address]) > 0n).to.equal(true);
    void deployer;
  });

  it("still leaves no standing allowance when every leg succeeds", async () => {
    // The success path consumes the allowance rather than clearing it; assert it
    // lands at zero either way, so the invariant is "never a resting allowance".
    const { usdc, pool, vault, collector } = await loadFixture(deployFixture);
    await time.increase(7 * 24 * 60 * 60 + 1);
    await collector.write.allocateNow();

    expect(await usdc.read.allowance([collector.address, pool.address])).to.equal(0n);
    expect(await usdc.read.allowance([collector.address, vault.address])).to.equal(0n);
  });
});
