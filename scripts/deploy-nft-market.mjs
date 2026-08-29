/**
 * Deploy the NFT marketplace and record it.
 *
 * One contract, no dependencies beyond USDC and a treasury address, so this is
 * a small script rather than a stage of `pool:arc`. It is idempotent: a record
 * that already names a launchpad is reported and left alone unless `--replace`
 * says otherwise — redeploying would strand every drop and every minted token
 * at the old address, which is not something to do by re-running a command.
 *
 *   npm run nft:market                       # survey
 *   npm run nft:market -- --execute
 *   npm run nft:market -- --execute --fee 250 --treasury 0x…
 *   npm run nft:market -- --find             # recover a lost address
 *
 * ## Where the address is written, and why it is written twice
 * `deployments/arc.json` is tracked by git, and `scripts/deploy.sh` discards
 * local edits to `deployments/` in favour of the committed copy — deliberately,
 * because a stale record there blocks every future pull. So an address written
 * only to that file survives exactly until the next deploy, which is how a
 * launchpad that had been deployed came back reading "not deployed on this
 * network yet".
 *
 * The address therefore also goes to `STATE_DIR/arc.local.json`, which lives on
 * the container's own volume and is nothing to do with git. `mergeDeployment`
 * applies a key the committed record has never heard of without needing to be
 * asked, so the local copy carries the deployment until the committed one
 * catches up — and once it does, the two agree and the local one is ignored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient } from "viem";
import { loadDeployer } from "./deployer.mjs";
import { arcTestnet as arcChain, pacedHttp, tesseraNftMarketAbi, tesseraNftMarketBytecode } from "@tessera/shared";
import path from "node:path";

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
  execute: EXECUTE, address: flag("deployer"), what: "nft:market",
});

const USDC = flag("usdc") ?? dep.usdc;
const TREASURY = flag("treasury") ?? dep.tesseraTimelock ?? deployerAddress;
/**
 * 2.5% by default, and the contract refuses anything above 10% whatever is
 * passed here — see `MAX_FEE_BPS`. A fee an admin can set to 100% is not a fee.
 */
const FEE_BPS = Number(flag("fee") ?? 250);

const pub = createPublicClient({ chain: arcChain, transport: pacedHttp(RPC) });

console.log(`\nNFT marketplace`);
console.log(`  USDC       ${USDC}`);
console.log(`  treasury   ${TREASURY}`);
console.log(`  fee        ${FEE_BPS} bps (${(FEE_BPS / 100).toFixed(2)}%)`);
console.log(`  deployer   ${deployerAddress}`);

/**
 * Recover an address the record lost.
 *
 * A contract's address is `keccak(rlp([deployer, nonce]))`, so every address the
 * deployer has ever created can be recomputed without an indexer, an explorer,
 * or a log scan. Walk the recent nonces, ask for code, and compare it against
 * this build's own runtime bytecode.
 */
if (argv.includes("--find")) {
  const { getContractAddress } = await import("viem");
  const runtime = (await import("@tessera/shared")).tesseraNftMarketDeployedBytecode?.toLowerCase() ?? null;
  const depth = Math.max(1, Number(flag("depth") ?? 2000));
  const nonce = await pub.getTransactionCount({ address: deployerAddress });
  console.log(`
  searching ${depth} nonces back from ${nonce} for a launchpad deployed by ${deployerAddress}
`);
  const hits = [];
  for (let hi = nonce - 1; hi >= Math.max(0, nonce - depth); hi -= 10) {
    const batch = [];
    for (let n = hi; n > hi - 10 && n >= 0; n--) batch.push(n);
    const out = await Promise.all(batch.map(async (n) => {
      const address = getContractAddress({ from: deployerAddress, nonce: BigInt(n) });
      const code = await pub.getCode({ address }).catch(() => null);
      return { n, address, code };
    }));
    for (const r of out) {
      if (!r.code || r.code === "0x") continue;
      /*
       * Byte-for-byte only when this build matches what was deployed. A
       * launchpad deployed before a source change is still a launchpad, so it
       * is reported as a candidate rather than skipped — the views below are
       * what actually identify it.
       */
      const exact = runtime !== null && r.code.toLowerCase() === runtime;
      let identified = false;
      try {
        // The market has no name(); `listingCount` is the view only it has.
        await pub.readContract({ address: r.address, abi: tesseraNftMarketAbi, functionName: "listingCount" });
        identified = true;
      } catch { /* not this contract */ }
      if (identified) {
        hits.push({ ...r, exact });
        console.log(`  nonce ${String(r.n).padStart(6)}  ${r.address}  ${exact ? "this build" : "an EARLIER build"}`);
      }
    }
  }
  if (!hits.length) console.log("  nothing found. Try a larger --depth, or deploy a fresh one with --execute.\n");
  else {
    console.log(`\n  Add the one you want to deployments/arc.json as "tesseraNftMarket", commit it,`);
    console.log(`  and redeploy the app.\n`);
  }
  process.exit(0);
}

const existing = dep.tesseraNftMarket ?? null;
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
  abi: tesseraNftMarketAbi,
  bytecode: tesseraNftMarketBytecode,
  args: [USDC, TREASURY, FEE_BPS],
  account: signer,
  chain: arcChain,
});
const receipt = await pub.waitForTransactionReceipt({ hash });
const address = receipt.contractAddress;
console.log(`${hash}\n  at ${address}`);

dep.tesseraNftMarket = address;
writeFileSync(RECORD, JSON.stringify(dep, null, 2) + "\n");
console.log(`\n  wrote tesseraLaunchpad to deployments/arc.json`);

/*
 * And to the state volume, which `deploy.sh` cannot discard.
 *
 * The tracked record is the one that should end up carrying this, but it only
 * does once somebody commits it — and `deploy.sh` throws away local edits to
 * `deployments/` in the meantime. Writing here as well means the address
 * survives the very next deploy rather than the next commit.
 */
const stateDir = process.env.STATE_DIR ?? null;
if (stateDir) {
  const localPath = path.join(stateDir, "arc.local.json");
  let local = {};
  try { local = JSON.parse(readFileSync(localPath, "utf8")); } catch { /* first write */ }
  local.tesseraNftMarket = address;
  try {
    writeFileSync(localPath, JSON.stringify(local, null, 2) + "\n");
    console.log(`  wrote tesseraLaunchpad to ${localPath} (survives ./scripts/deploy.sh)`);
  } catch (e) {
    console.log(`  could not write ${localPath}: ${String(e).slice(0, 100)}`);
  }
} else {
  console.log("  STATE_DIR is unset, so nothing was written to the state volume.");
}

console.log(
  "\n  Commit deployments/arc.json when you can — the state-volume copy keeps the app\n" +
    "  working until then, and the two agree once it lands.\n",
);
