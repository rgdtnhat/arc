/**
 * Band an asset on the price guard, the way an operator would before listing it
 * borrowable. Two lines of work, in its own file so the rehearsal can put it
 * between two runs of the migration and watch the answer change.
 */
import hre from "hardhat";

async function main() {
  const guard = await hre.viem.getContractAt("TesseraPriceGuard", process.env.BAND_GUARD as `0x${string}`);
  // 5,000,000 at PRICE_SCALE = $0.05, matching the fixture's mark, with 10%
  // of tolerance either side — tight enough that a mark 50% off is refused.
  await guard.write.setPeg([process.env.BAND_ASSET as `0x${string}`, 5_000_000n, 1000]);
  console.log("banded");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
