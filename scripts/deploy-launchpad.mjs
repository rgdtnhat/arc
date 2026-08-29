/**
 * Deploy the NFT launchpad and record it.
 *
 * One contract, no dependencies beyond USDC and a treasury address, so this is
 * a small script rather than a stage of `pool:arc`. It is idempotent: a record
 * that already names a launchpad is reported and left alone unless `--replace`
 * says otherwise — redeploying would strand every drop and every minted token
 * at the old address, which is not something to do by re-running a command.
 *
 *   npm run nft:deploy                       # survey
 *   npm run nft:deploy -- --execute
 *   npm run nft:deploy -- --execute --fee 250 --treasury 0x…
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient } from "viem";
import { loadDeployer } from "./deployer.mjs";
import { arcTestnet as arcChain, pacedHttp, tesseraLaunchpadAbi, tesseraLaunchpadBytecode } from "@tessera/shared";

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const REPLACE = argv.includes("--replace");
const flag = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  if (hit) return hit.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const RECORD = new URL("../deployments/arc.json", import.meta.url);
const dep = JSON.parse(readFileSync(RECORD, "utf8"));

const { account: signer, address: deployerAddress } = loadDeployer({
  execute: EXECUTE, address: flag("deployer"), what: "nft:deploy",
});

const USDC = flag("usdc") ?? dep.usdc;
const TREASURY = flag("treasury") ?? dep.tesseraTimelock ?? deployerAddress;
/**
 * 2.5% by default, and the contract refuses anything above 10% whatever is
 * passed here — see `MAX_FEE_BPS`. A fee an admin can set to 100% is not a fee.
 */
const FEE_BPS = Number(flag("fee") ?? 250);

const pub = createPublicClient({ chain: arcChain, transport: pacedHttp(RPC) });

console.log(`\nNFT launchpad`);
console.log(`  USDC       ${USDC}`);
console.log(`  treasury   ${TREASURY}`);
console.log(`  fee        ${FEE_BPS} bps (${(FEE_BPS / 100).toFixed(2)}%)`);
console.log(`  deployer   ${deployerAddress}`);

const existing = dep.tesseraLaunchpad ?? null;
if (existing) {
  const code = await pub.getCode({ address: existing }).catch(() => null);
  const live = code && code !== "0x";
  console.log(`\n  already recorded at ${existing} ${live ? "(deployed)" : "(NO CODE AT THAT ADDRESS)"}`);
  if (live && !REPLACE) {
    console.log(
      "\n  Nothing to do. Redeploying would strand every drop and every minted token at the\n" +
        "  old address, so it takes --replace to say that is what you meant.\n",
    );
    process.exit(0);
  }
}

if (!EXECUTE) {
  console.log("\nSurvey only. Re-run with --execute to deploy.\n");
  process.exit(0);
}

const wallet = createWalletClient({ account: signer, chain: arcChain, transport: pacedHttp(RPC) });
process.stdout.write("\n  deploying … ");
const hash = await wallet.deployContract({
  abi: tesseraLaunchpadAbi,
  bytecode: tesseraLaunchpadBytecode,
  args: [USDC, TREASURY, FEE_BPS],
  account: signer,
  chain: arcChain,
});
const receipt = await pub.waitForTransactionReceipt({ hash });
const address = receipt.contractAddress;
console.log(`${hash}\n  at ${address}`);

dep.tesseraLaunchpad = address;
writeFileSync(RECORD, JSON.stringify(dep, null, 2) + "\n");
console.log(`\n  wrote tesseraLaunchpad to deployments/arc.json`);
console.log(
  "\n  Commit that file before the next ./scripts/deploy.sh — it discards local edits to\n" +
    "  deployments/ and takes the committed version, which would drop this address.\n",
);
