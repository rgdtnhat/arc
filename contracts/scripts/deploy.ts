import hre from "hardhat";

/**
 * Deploy TesseraEscrow.
 *  - On Arc (arcTestnet): binds to the real USDC at 0x3600…0000.
 *  - On a local network: deploys MockUSDC first and mints to the deployer.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network arcTestnet
 *   npx hardhat run scripts/deploy.ts        (local)
 */
const ARC_USDC = "0x3600000000000000000000000000000000000000";

async function main() {
  const net = hre.network.name;
  const [deployer] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();

  let usdcAddress: `0x${string}`;
  if (net === "arcTestnet") {
    usdcAddress = ARC_USDC;
    console.log(`Using Arc native USDC at ${usdcAddress}`);
  } else {
    const usdc = await hre.viem.deployContract("MockUSDC");
    usdcAddress = usdc.address;
    console.log(`Deployed MockUSDC at ${usdcAddress}`);
    await usdc.write.mint([deployer.account.address, 1_000_000_000n]); // 1000 USDC
  }

  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdcAddress]);
  console.log(`Deployed TesseraEscrow at ${escrow.address}`);

  const tab = await hre.viem.deployContract("TesseraTab", [usdcAddress]);
  console.log(`Deployed TesseraTab at ${tab.address}`);

  console.log("\nAdd to your .env:");
  console.log(`TESSERA_ESCROW_ADDRESS=${escrow.address}`);
  console.log(`TESSERA_TAB_ADDRESS=${tab.address}`);
  if (net !== "arcTestnet") console.log(`ARC_USDC_ADDRESS=${usdcAddress}`);

  console.log(
    `\nChain: ${net} (${await pub.getChainId()})  ·  deployer: ${deployer.account.address}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
