#!/usr/bin/env node
/**
 * Deploy TesseraRouter against the AMM this deployment already runs.
 *
 * This is the migration off the old inventory swap desk. The desk is gone from
 * the source tree; what replaces it is a router that holds nothing and fills
 * every trade out of AMM pool liquidity. Nothing about the AMM has to change —
 * the router discovers pools through `poolsForPair` when the AMM has that index
 * and by walking `poolCount` when it does not, so an AMM deployed before the
 * index existed works unmodified and the liquidity providers in it are never
 * asked to migrate.
 *
 * What this does NOT do:
 *
 *   - touch the old desk. Its inventory is its trading stock and the only way
 *     out of it was always to trade into it. Once the app stops offering the
 *     desk, that stock simply sits there; it is testnet float, and moving it is
 *     a decision about price and timing rather than a deployment step.
 *   - restart the server. The running process keeps pointing at whatever it
 *     loaded until it does, which is the safe order — nothing is mid-flight
 *     against a contract that changed underneath it.
 *
 * Usage:  npm run router:deploy            # deploy, wire, record
 *         npm run router:deploy -- --check # report only, change nothing
 */
import { createPublicClient, createWalletClient, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  arcTestnet,
  pacedHttp,
  tesseraRouterAbi,
  tesseraRouterBytecode,
  tesseraAmmAbi,
  ARC_USDC_ADDRESS,
} from "@tessera/shared";

const CHECK_ONLY = process.argv.includes("--check");
const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DEP_DIR = path.join(ROOT, "deployments");

function readDeployment() {
  for (const name of ["arc.local.json", "arc.json"]) {
    try {
      return {
        file: path.join(DEP_DIR, name),
        data: JSON.parse(readFileSync(path.join(DEP_DIR, name), "utf8")),
      };
    } catch {
      /* try the next one */
    }
  }
  throw new Error("No deployments/arc.json — deploy the stack first.");
}

const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key) {
  console.error("DEPLOYER_PRIVATE_KEY is required — it becomes the router's owner.");
  process.exit(1);
}

const deployer = privateKeyToAccount(key);
const pub = createPublicClient({ chain: arcTestnet, transport: pacedHttp(RPC) });
const wallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: pacedHttp(RPC) });

const { file, data: dep } = readDeployment();
const amm = dep.tesseraAmm;

console.log(`\ndeployer     ${deployer.address}`);
console.log(`amm          ${amm ?? "(none)"}`);
console.log(`old desk     ${dep.tesseraSwap ?? "(none — already removed)"}`);
console.log(`current      ${dep.tesseraRouter ?? "(no router yet)"}`);

if (!amm) {
  console.error("\nNo AMM recorded. The router fills every trade from AMM liquidity and cannot run without one.");
  process.exit(1);
}

/** Pools the router will have to work with, so an empty AMM is caught here. */
async function reportPools() {
  const count = await pub
    .readContract({ address: amm, abi: tesseraAmmAbi, functionName: "poolCount" })
    .catch(() => 0n);
  console.log(`\n${count} AMM pool(s):`);
  let funded = 0;
  for (let i = 0n; i < count; i++) {
    const info = await pub
      .readContract({ address: amm, abi: tesseraAmmAbi, functionName: "poolInfo", args: [i] })
      .catch(() => null);
    if (!info) continue;
    const [, balances, , , , frozen, name] = info;
    const live = balances.every((b) => b > 0n);
    if (live && !frozen) funded++;
    console.log(`  #${i} ${name || "(unnamed)"}${frozen ? " [frozen]" : ""}${live ? "" : " [empty side]"}`);
  }
  return funded;
}

const funded = await reportPools();
if (funded === 0) {
  console.log(
    "\nNo pool currently has liquidity on both sides. The router will deploy fine but every\n" +
      "quote returns 'no route' until liquidity is added on the Liquidity pool tab.",
  );
}

if (CHECK_ONLY) {
  console.log("\n--check: nothing was changed.");
  process.exit(0);
}

// USDC is the hub every other pool is paired against on this deployment, which
// is what makes a two-hop route (say EURC → USDC → cirBTC) findable at all. Kept
// as an explicit list rather than inferred, so the router never routes through
// an asset nobody chose.
const hubs = [ARC_USDC_ADDRESS];

console.log("\n→ deploying TesseraRouter…");
const hash = await wallet.deployContract({
  abi: tesseraRouterAbi,
  bytecode: tesseraRouterBytecode,
  args: [amm, hubs],
  account: deployer,
  chain: arcTestnet,
});
const receipt = await pub.waitForTransactionReceipt({ hash });
const router = receipt.contractAddress;
if (!router || receipt.status !== "success") {
  console.error("Deployment reverted — nothing was recorded.");
  process.exit(1);
}
console.log(`   router     ${getAddress(router)}`);
console.log(`   hub token  ${ARC_USDC_ADDRESS} (USDC)`);

// Record it where the app reads addresses from. arc.local.json is gitignored and
// wins over arc.json, so a later `git reset --hard` cannot revert a running
// server to a router it just replaced.
const next = { ...dep, tesseraRouter: getAddress(router) };
delete next.tesseraSwap; // the desk is not part of this app any more
delete next.explorer;
const outFile = path.join(DEP_DIR, "arc.local.json");
writeFileSync(outFile, JSON.stringify(next, null, 2) + "\n");
console.log(`   recorded in ${path.relative(ROOT, outFile)} (was reading ${path.relative(ROOT, file)})`);

console.log(
  `\nDone. One thing left:\n` +
    `  Restart the app so it picks up the router:  docker compose restart tessera\n\n` +
    `Then confirm it quotes:\n` +
    `  curl -s '<your-host>/api/swap/quote?tokenIn=<usdc>&tokenOut=<eurc>&amountIn=1000000'\n\n` +
    `A router needs no funding — it holds nothing. If a quote comes back with no route,\n` +
    `the answer is liquidity in the AMM pool, not inventory in the router.\n`,
);
