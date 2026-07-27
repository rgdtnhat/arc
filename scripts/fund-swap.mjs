// Top up the TesseraSwap desk's inventory on Arc.
//
// ## Why this exists
// `pool:arc` prints `(skip swap inventory — the desk is owned by 0x…, not the
// deployer)`. That is accurate but it reads like a dead end, and it isn't:
// `TesseraSwap.swap` measures inventory as `balanceOf(address(this))`, with no
// internal ledger. So *any* sender can add fillable inventory. The owner-only
// `seed` was never the only route — it was just the only route that emits an
// event.
//
// This script takes whichever route the deployed desk supports:
//   · `fund(token, amount)` when the deployed bytecode has it (emits
//     InventoryChanged, so the top-up is visible to indexers), or
//   · a plain ERC-20 `transfer` otherwise — which is the case for a desk that
//     was deployed before `fund` existed, including the one live right now.
//
// Inventory is app-owned. Funding the desk is a donation to it, not a deposit
// you can withdraw: only the owner can call `withdrawInventory`, and there are no
// shares. If you want a position you can pull back out with a share of the fees,
// add liquidity to TesseraAMM instead.
//
// Usage:
//   npm run swap:fund                 # top every reserve up to its target
//   npm run swap:fund -- --check      # report inventory, send nothing
//   npm run swap:fund -- USDC=5 EURC=2 cirBTC=0.0002
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, ARC_USDC_ADDRESS, erc20Abi, tesseraSwapAbi, pacedHttp } from "@tessera/shared";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain: arcTestnet, transport: pacedHttp(RPC) });
const wallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: pacedHttp(RPC) });

const CHECK = process.argv.includes("--check");
const PACE_MS = Number(process.env.TESSERA_PACE_MS ?? 6000);
const pace = (ms = PACE_MS) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Default target inventory per asset, in whole units. */
const TARGETS = { USDC: "5", EURC: "5", cirBTC: "0.0002" };

/** `SYMBOL=amount` arguments override the defaults. */
for (const arg of process.argv.slice(2)) {
  const m = /^([A-Za-z]+)=([0-9.]+)$/.exec(arg);
  if (m) TARGETS[m[1]] = m[2];
}

function readDeployment() {
  for (const name of ["arc.local.json", "arc.json"]) {
    try {
      return JSON.parse(readFileSync(new URL(`../deployments/${name}`, import.meta.url), "utf8"));
    } catch { /* next */ }
  }
  throw new Error("No deployments/arc.json — run `npm run pool:arc:init` first.");
}

const bal = (token, who) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

async function send(address, abi, functionName, args) {
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: deployer });
  const hash = await wallet.writeContract(request);
  await pub.waitForTransactionReceipt({ hash });
  await pace();
  return hash;
}

/** `fund(address,uint256)`. */
const FUND_SELECTOR = "7b1837de";

/**
 * Does the deployed desk have `fund`?
 *
 * Read from the bytecode, not from a simulated call. Simulating cannot answer it:
 * `fund` returns nothing, so an `eth_call` that comes back with empty data is a
 * valid success — indistinguishable from the empty data a node returns for a
 * selector that isn't there. Solidity's dispatcher embeds each selector as a
 * PUSH4 constant, so the code either contains it or does not.
 */
async function hasFund(swap) {
  const code = await pub.getCode({ address: swap });
  return typeof code === "string" && code.toLowerCase().includes(FUND_SELECTOR);
}

async function main() {
  const dep = readDeployment();
  const swap = dep.tesseraSwap;
  if (!swap) throw new Error("No tesseraSwap in the deployment record — run `npm run pool:arc:init`.");

  const assets = (dep.poolAssets ?? []).length
    ? dep.poolAssets
    : [{ symbol: "USDC", address: ARC_USDC_ADDRESS, decimals: 6 }];

  console.log(`swap desk  ${swap}`);
  const owner = await pub.readContract({ address: swap, abi: tesseraSwapAbi, functionName: "owner" });
  console.log(`owner      ${owner}${owner.toLowerCase() === deployer.address.toLowerCase() ? " (the deployer)" : " (the fee collector — irrelevant here, see below)"}`);
  console.log(`funding as ${deployer.address}\n`);

  // Report first, always. Even a --check run should be useful.
  const rows = [];
  for (const a of assets) {
    const [have, held] = await Promise.all([bal(a.address, swap), bal(a.address, deployer.address)]);
    const target = TARGETS[a.symbol] ? parseUnits(TARGETS[a.symbol], a.decimals) : 0n;
    rows.push({ ...a, have, held, target, need: target > have ? target - have : 0n });
  }
  console.log("asset    desk inventory        target        deployer holds");
  for (const r of rows) {
    console.log(
      `${r.symbol.padEnd(8)} ${formatUnits(r.have, r.decimals).padEnd(20)} ` +
        `${formatUnits(r.target, r.decimals).padEnd(13)} ${formatUnits(r.held, r.decimals)}`,
    );
  }
  if (CHECK) return;

  const toFund = rows.filter((r) => r.need > 0n);
  if (!toFund.length) {
    console.log("\n✅ every asset is at or above its target — nothing to do.");
    return;
  }

  // One probe, not one per asset: the answer is a property of the bytecode.
  const useFund = await hasFund(swap);
  console.log(
    `\nroute: ${useFund
      ? "fund() — emits InventoryChanged"
      : "plain ERC-20 transfer — this desk predates fund(); the swap reads its balance, so it counts all the same"}`,
  );

  let funded = 0;
  for (const r of toFund) {
    const amount = r.need < r.held ? r.need : r.held;
    if (amount === 0n) {
      console.log(`   (skip ${r.symbol} — the deployer holds none; fund the deployer wallet first)`);
      continue;
    }
    try {
      if (useFund) {
        await send(r.address, erc20Abi, "approve", [swap, amount]);
        await send(swap, tesseraSwapAbi, "fund", [r.address, amount]);
      } else {
        await send(r.address, erc20Abi, "transfer", [swap, amount]);
      }
      const now = await bal(r.address, swap);
      // Verify against the chain rather than trusting the receipt.
      if (now <= r.have) throw new Error("the desk's balance did not increase");
      console.log(`   ✓ ${r.symbol}: ${formatUnits(r.have, r.decimals)} → ${formatUnits(now, r.decimals)}`);
      funded++;
    } catch (e) {
      console.warn(`   ⚠ ${r.symbol}: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 100)}`);
    }
  }
  console.log(`\n${funded ? "✅" : "⚠"} funded ${funded}/${toFund.length} asset(s). The desk can now fill swaps in those.`);
  console.log(`   explorer https://testnet.arcscan.app/address/${swap}`);
}

main().catch((e) => {
  console.error(`\n❌ swap:fund stopped: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]}`);
  process.exit(1);
});
