#!/usr/bin/env node
/**
 * Replace the swap desk with one this deployment can actually manage.
 *
 * The desk on a long-lived deployment can end up unmanageable. Deployment hands
 * it to the fee collector so the collector's `seed` leg works; on a desk built
 * before the `admin` key existed, paired with a collector built before the
 * `withdrawSwapInventory` forwarder, `withdrawInventory` is owner-only and the
 * owner is a contract with no function that calls it. No key anyone holds can
 * reach the inventory, and the same vintage has no `amm()` either, so a trade
 * its balance cannot cover reverts instead of routing to AMM liquidity.
 *
 * This deploys a replacement owned *and* admin'd by the deployer, points it at
 * the AMM, records it, and reports what is left to do. It deliberately does
 * NOT:
 *
 *   - move the old desk's inventory. It cannot: that is the whole problem. The
 *     old inventory is the desk's trading stock and is recoverable by swapping
 *     into it, which is a decision about price and timing, not a migration.
 *   - restart the server. The running process keeps the old desk until it does,
 *     which is the safe order: nothing is mid-flight against a contract that
 *     just changed underneath it.
 *
 * Usage:  npm run swap:redeploy            # deploy, wire, record
 *         npm run swap:redeploy -- --check # report only, change nothing
 */
import { createPublicClient, createWalletClient, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  arcTestnet,
  pacedHttp,
  tesseraSwapAbi,
  tesseraSwapBytecode,
  tesseraAmmAbi,
  erc20Abi,
} from "@tessera/shared";

const CHECK_ONLY = process.argv.includes("--check");
const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DEP_DIR = path.join(ROOT, "deployments");

function readDeployment() {
  for (const name of ["arc.local.json", "arc.json"]) {
    try {
      return { file: path.join(DEP_DIR, name), data: JSON.parse(readFileSync(path.join(DEP_DIR, name), "utf8")) };
    } catch {
      /* try the next one */
    }
  }
  throw new Error("No deployments/arc.json — deploy the stack first.");
}

const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key) {
  console.error("DEPLOYER_PRIVATE_KEY is required — it becomes the new desk's owner and admin.");
  process.exit(1);
}

const deployer = privateKeyToAccount(key);
const pub = createPublicClient({ chain: arcTestnet, transport: pacedHttp(RPC) });
const wallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: pacedHttp(RPC) });

const { file, data: dep } = readDeployment();
const oldSwap = dep.tesseraSwap;
const pool = dep.tesseraPool;
const amm = dep.tesseraAmm;
const collector = dep.tesseraFeeCollector;

console.log(`\ndeployer   ${deployer.address}`);
console.log(`pool       ${pool ?? "(none)"}`);
console.log(`amm        ${amm ?? "(none)"}`);
console.log(`old desk   ${oldSwap ?? "(none)"}`);

if (!pool) {
  console.error("\nNo lending pool recorded — the desk prices from it and cannot be deployed without one.");
  process.exit(1);
}

/** What the old desk still holds, so nothing is written off by accident. */
async function reportOldInventory() {
  if (!oldSwap) return [];
  const assets = dep.poolAssets ?? [];
  const held = [];
  for (const a of assets) {
    const bal = await pub
      .readContract({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [oldSwap] })
      .catch(() => 0n);
    if (bal > 0n) held.push({ ...a, bal });
  }
  if (held.length) {
    console.log("\nthe old desk still holds:");
    for (const h of held) {
      console.log(`  ${(Number(h.bal) / 10 ** (h.decimals ?? 6)).toFixed(6)} ${h.symbol}`);
    }
    console.log(
      "  These are its trading stock, not a balance an admin can pull. Recover them by\n" +
        "  swapping into the desk at the oracle price before you switch over — after the\n" +
        "  switch the app points at the new desk and the old one is no longer offered.",
    );
  }
  return held;
}

const held = await reportOldInventory();

if (CHECK_ONLY) {
  console.log("\n--check: nothing was changed.");
  process.exit(0);
}

if (held.length) {
  console.log(
    "\nRefusing to switch while the old desk still holds inventory.\n" +
      "Drain it first (swap into it), or re-run with the balances accepted as written off:\n" +
      "  npm run swap:redeploy -- --abandon-inventory",
  );
  if (!process.argv.includes("--abandon-inventory")) process.exit(1);
  console.log("  --abandon-inventory given: continuing, the old balances stay where they are.");
}

console.log("\n→ deploying TesseraSwap (0.30% fee, 50% of it to the app)…");
const hash = await wallet.deployContract({
  abi: tesseraSwapAbi,
  bytecode: tesseraSwapBytecode,
  // treasury = the fee collector when there is one, else the deployer. Note this
  // is the *treasury*, not the owner: the constructor makes msg.sender both
  // owner and admin, which is what keeps withdrawals reachable.
  args: [pool, collector ?? deployer.address, 30, 5000],
  account: deployer,
  chain: arcTestnet,
});
const receipt = await pub.waitForTransactionReceipt({ hash });
const swap = receipt.contractAddress;
if (!swap || receipt.status !== "success") {
  console.error("Deployment reverted — nothing was recorded.");
  process.exit(1);
}
console.log(`   new desk   ${getAddress(swap)}`);

// Wire the AMM fallback while we still own it outright. Doing this through the
// collector, as the bootstrap script does, needs a collector that has the
// forwarder — which is exactly the dependency that left the old desk without one.
if (amm) {
  try {
    const h = await wallet.writeContract({
      address: swap,
      abi: tesseraSwapAbi,
      functionName: "setAmm",
      args: [amm, 0n],
      account: deployer,
      chain: arcTestnet,
    });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log("   AMM fallback wired to pool 0");
  } catch (e) {
    console.log(`   could not wire the AMM fallback: ${String(e).split("\n")[0].slice(0, 120)}`);
  }
} else {
  console.log("   no AMM recorded — the desk will fill from inventory only");
}

// Record it where the app reads addresses from. arc.local.json is gitignored and
// wins over arc.json, so a later `git reset --hard` cannot revert a running
// server to the desk it just replaced.
const next = { ...dep, tesseraSwap: getAddress(swap) };
delete next.explorer;
const outFile = path.join(DEP_DIR, "arc.local.json");
writeFileSync(outFile, JSON.stringify(next, null, 2) + "\n");
console.log(`   recorded in ${path.relative(ROOT, outFile)} (was reading ${path.relative(ROOT, file)})`);

console.log(
  `\nDone. Two things left, in this order:\n` +
    `  1. Restart the app so it picks up the new desk:  docker compose restart tessera\n` +
    `  2. Fund it — a new desk is empty, and a swap into an asset it does not hold reverts.\n` +
    `     Use "Add inventory" on the Swap desk tab.\n\n` +
    `Then confirm withdrawals are reachable:\n` +
    `  curl -s <your-host>/api/swap/authority\n`,
);
