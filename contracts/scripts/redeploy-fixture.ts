/**
 * A protocol for `redeploy-pool.mjs` to migrate, on a throwaway chain.
 *
 * Deliberately configured *away* from every default the deploy scripts use, so
 * a carry-over that silently falls back to a default is visible as a mismatch
 * rather than passing because both sides happened to agree. Odd collateral
 * factors, non-zero caps, a hand-set rate curve, a flash fee that is not 9bps,
 * a backstop take rate that is not zero.
 *
 * It prints one line of JSON — a deployment record in the shape the real
 * scripts read — which the runner writes to disk and points the migration at.
 */
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const U = (n: number, d = 6) => BigInt(Math.round(n * 10 ** d));

async function main() {
  const [deployer, alice, bob] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();

  const usdc = await hre.viem.deployContract("MockUSDC");
  // MockToken(name, symbol, decimals) — an 18-decimal stand-in for TSRA in the
  // pool, so the reserve carrying a non-6 decimals is exercised too.
  const tsra = await hre.viem.deployContract("MockToken", ["Tessera", "TSRA", 18]);

  const pool = await hre.viem.deployContract("TesseraPool", [deployer.account.address]);
  const amm = await hre.viem.deployContract("MockAmmPool");
  const guard = await hre.viem.deployContract("TesseraPriceGuard", [amm.address, pool.address]);

  await pool.write.setWiring([0, guard.address]);

  /*
   * Two reserves with parameters nobody would pick by accident. USDC is
   * borrowable already; TSRA is supply-only, and promoting it is the whole
   * reason the redeploy exists — so the rehearsal can check the promotion only
   * happens once the guard bands it.
   */
  await pool.write.addReserve([usdc.address, 8123, 8567, 9876, 1337, true, 6, 100_000_000n]);
  await pool.write.addReserve([tsra.address, 3111, 4222, 9111, 2500, false, 18, 5_000_000n]);

  await pool.write.setCaps([usdc.address, U(750_000), U(400_000)]);
  await pool.write.setCaps([tsra.address, U(9_000, 18), 0n]);
  // rBase, r1, r2, r3, targetUtil, reactivity — all off the defaults.
  await pool.write.setIrConfig([
    usdc.address, 3_000_000_000_000_000n, 40_000_000_000_000_000n,
    600_000_000_000_000_000n, 3_000_000_000_000_000_000n, 8100, 1_000_000_000n,
  ]);
  await pool.write.setBackstopTakeRate([1234]);
  await pool.write.setFlashFee([27]);

  /*
   * An outflow limiter, because the redeploy has to rewire *both* ends of it.
   *
   * The limiter trusts exactly one `consumer` and rejects everyone else with
   * `NotConsumer()`. Attaching it to the pool is a pool-side setting; the
   * limiter has its own. Setting only the first produced a live pool that
   * could not borrow or withdraw at all, and the rehearsal missed it entirely
   * because no limiter was ever in the fixture — so CI was green while the
   * real thing was broken.
   */
  const limiter = await hre.viem.deployContract("TesseraRateLimiter", [pool.address]);
  await limiter.write.setLimit([usdc.address, U(1_000_000), 3600n]);
  await pool.write.setWiring([2, limiter.address]);

  await pool.write.setEmodeCategory([1, 9000, 9300, 9950, true, "stables"]);
  await pool.write.setEmodeAsset([usdc.address, 1]);

  // Positions for the handoff to migrate: a plain supplier, and one who borrows.
  for (const w of [alice, bob]) {
    await usdc.write.mint([w.account.address, U(50_000)]);
    await tsra.write.mint([w.account.address, U(1_000, 18)]);
  }
  await usdc.write.mint([deployer.account.address, U(500_000)]);

  for (const w of [alice, bob]) {
    const u = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: w } });
    const p = await hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: w } });
    await u.write.approve([pool.address, U(50_000)]);
    await p.write.supply([usdc.address, U(10_000)]);
  }
  {
    const t = await hre.viem.getContractAt("MockToken", tsra.address, { client: { wallet: alice } });
    const p = await hre.viem.getContractAt("TesseraPool", pool.address, { client: { wallet: alice } });
    await t.write.approve([pool.address, U(1_000, 18)]);
    await p.write.supply([tsra.address, U(500, 18)]);
    await p.write.borrow([usdc.address, U(1_000)]);
  }

  // --- emissions, emitter, gauge -------------------------------------------
  /*
   * The emitter must exist before the token, because the token's constructor
   * mints the whole supply to the address it is handed — which is precisely the
   * constraint that makes `--emitter=replace` unimplementable.
   */
  const emitter = await hre.viem.deployContract("TesseraEmitter", [
    tsra.address, deployer.account.address, pool.address, amm.address, 1_000_000_000n, 10n ** 18n,
  ]);
  const emissions = await hre.viem.deployContract("TesseraEmissions", [pool.address, deployer.account.address]);
  await emissions.write.setRewardToken([tsra.address]);
  await emissions.write.setRates([usdc.address, 111n, 222n]);
  await emissions.write.setRate([usdc.address, 2, 333n]);
  /*
   * Check Alice in. `claimable` pays nothing to an address that has never been
   * checkpointed — you earn from the moment you check in, not from the moment
   * the stream opened — so without this she has a position and no reward, and
   * the migration's whole reason for chaining with `setPrior` has nothing to
   * carry. Every block after this one adds to what she is owed.
   */
  await emissions.write.checkpoint([alice.account.address, usdc.address, 0]);

  await tsra.write.mint([deployer.account.address, U(10_000, 18)]);
  await tsra.write.approve([emissions.address, U(10_000, 18)]);
  await emissions.write.fund([U(10_000, 18)]);

  /*
   * Book what Alice has earned before anything moves.
   *
   * Accrual is bounded by the pot: a holder may have, unclaimed, at most their
   * share of what the contract holds. So an *unbooked* balance is worth
   * whatever the pot can back at the moment somebody asks — and a migration
   * moves the pot to the new contract, which leaves nothing behind for the old
   * one's `claimable` to report. Checkpointing turns the entitlement into a
   * booked balance, which `setPrior` can carry.
   *
   * That is the operational rule this fixture exists to keep honest:
   * **checkpoint holders before you drain the old pot.** The app's keeper does
   * it continuously; a migration should not assume it just happened.
   */
  await time.increase(3600);
  await emissions.write.checkpoint([alice.account.address, usdc.address, 0]);

  await emitter.write.addSink([emissions.address, 1, 700n, "lending emissions"]);

  const gauge = await hre.viem.deployContract("TesseraGauge", [tsra.address, deployer.account.address, 604_800n]);
  await gauge.write.setEmissions([emissions.address, "0x0000000000000000000000000000000000000000"]);
  await emissions.write.setRateSetter([gauge.address]);

  const chainId = await pub.getChainId();
  console.log(
    "RECORD " +
      JSON.stringify({
        chainId,
        rpc: process.env.E2E_RPC,
        usdc: usdc.address,
        tesseraPool: pool.address,
        tesseraEmissions: emissions.address,
        tesseraEmitter: emitter.address,
        tesseraToken: tsra.address,
        tesseraGauge: gauge.address,
        tesseraAmm: amm.address,
        tesseraPriceGuard: guard.address,
        tesseraRateLimiter: limiter.address,
        poolAssets: [
          { symbol: "USDC", address: usdc.address, decimals: 6, borrowable: true },
          { symbol: "TSRA", address: tsra.address, decimals: 18, borrowable: false },
        ],
        holders: [alice.account.address, bob.account.address],
      }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
