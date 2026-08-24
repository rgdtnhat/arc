#!/usr/bin/env node
/**
 * Put a price band on every asset that backs a loan.
 *
 * ## What this is for
 * `TesseraPriceGuard.check` returns "fine" for any price of an asset whose feed
 * is disabled. For an asset nobody borrows against that is the right default —
 * turning it on for a thin-pool feed would block price updates the moment the
 * pool thinned. It is the wrong default the moment the asset carries a
 * collateral factor, because the price is then what decides how much can be
 * borrowed against it, and nothing is checking it.
 *
 * The audit found exactly that on the live deployment: cirBTC at a 70%
 * collateral factor with its guard switched off, while USDC, EURC and TSRA all
 * had one. Nothing was wrong with the price. Nothing would have caught it.
 *
 * ## What it does
 * Surveys every pool reserve, and for each one with `cFactor > 0` and no guard
 * it proposes a band:
 *
 *   · a **peg** for an asset whose price is not a market question, and
 *   · a **pool average** (TWAP + deviation band) for anything else, when an AMM
 *     pool exists deep enough to be a reference.
 *
 * An asset with neither is reported, not guessed at: the honest options there
 * are to add liquidity or to drop the collateral factor, and both are decisions
 * rather than defaults.
 *
 * Survey by default; `--execute` sends. Nothing here can move funds — the only
 * calls are `setPeg` and `setFeed`, both owner-only on the guard.
 *
 *   npm run pool:guard-collateral                 # survey
 *   npm run pool:guard-collateral -- --execute
 *   npm run pool:guard-collateral -- --asset=cirBTC --peg=78906 --band=1500
 */
import { createPublicClient, createWalletClient, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet as arcChain, pacedHttp, tesseraPoolAbi, tesseraPriceGuardAbi } from "../shared/src/index.ts";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : true;
};
const EXECUTE = Boolean(flag("execute", false));
const ONLY = flag("asset", null);
const PEG = flag("peg", null);          // in whole dollars, e.g. 78906
const BAND = Number(flag("band", 1500)); // bps; 15% by default for a volatile asset

const rpc = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const deployment = JSON.parse(readFileSync(new URL("../deployments/arc.json", import.meta.url), "utf8"));
const pool = deployment.tesseraPool;
const guard = deployment.tesseraPriceGuard;
const amm = deployment.tesseraAmm;
if (!pool || !guard) {
  console.error("this deployment has no pool or no price guard — nothing to configure");
  process.exit(1);
}

const pub = createPublicClient({ chain: arcChain, transport: pacedHttp(rpc) });
const assets = deployment.poolAssets ?? [
  { symbol: "USDC", address: deployment.usdc },
];

console.log(`price guard ${guard}`);
console.log(`pool        ${pool}\n`);

const todo = [];
for (const a of assets) {
  if (ONLY && a.symbol.toLowerCase() !== String(ONLY).toLowerCase()) continue;
  const r = await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "reserves", args: [a.address] });
  const [enabled, , , cFactor] = [r[0], r[1], r[2], Number(r[3])];
  const priceE8 = r[7];
  const feed = await pub.readContract({ address: guard, abi: tesseraPriceGuardAbi, functionName: "feeds", args: [a.address] })
    .catch(() => null);
  const guarded = feed ? Boolean(feed[0]) : false;
  const band = feed ? Number(feed[5]) : 0;

  const backsLoans = enabled && cFactor > 0;
  const state = !backsLoans ? "backs no loans" : guarded ? `guarded, band ${band}bps` : "NO GUARD";
  console.log(
    `  ${a.symbol.padEnd(8)} cFactor ${String(cFactor).padStart(5)}  ` +
    `price $${Number(formatUnits(priceE8, 8)).toLocaleString()}  ${state}`,
  );
  if (backsLoans && !guarded) todo.push({ ...a, cFactor, priceE8 });
}

if (!todo.length) {
  console.log("\nEvery asset that backs a loan has a price band. Nothing to do.");
  process.exit(0);
}

console.log(`\n${todo.length} asset(s) back loans with no band:\n`);
for (const t of todo) {
  const peg = PEG !== null ? BigInt(Math.round(Number(PEG) * 1e8)) : t.priceE8;
  console.log(`  ${t.symbol}: setPeg(${peg} = $${Number(formatUnits(peg, 8)).toLocaleString()}, ${BAND}bps)`);
  console.log(
    `    A peg is the blunt instrument and the honest one here: it bands the price around a number\n` +
    `    an operator chose, and it cannot go missing the way a thin pool's average can. For an asset\n` +
    `    that trades, move to setFeed(poolId, quote, band, window, minLiquidity) once a pool of that\n` +
    `    pair is deep enough to be a reference — ${amm ? `the AMM is at ${amm}` : "no AMM is deployed"}.`,
  );
}

if (!EXECUTE) {
  console.log("\nSurvey only. Re-run with --execute to send, or set --peg / --band first.");
  console.log("Check the price above against a source you trust before you band anything to it.");
  process.exit(0);
}

const key = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.OWNER_PRIVATE_KEY;
if (!key) { console.error("\nset DEPLOYER_PRIVATE_KEY to send"); process.exit(1); }
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: arcChain, transport: pacedHttp(rpc) });

const owner = await pub.readContract({ address: guard, abi: tesseraPriceGuardAbi, functionName: "owner" });
if (String(owner).toLowerCase() !== account.address.toLowerCase()) {
  console.error(`\n${account.address} does not own the guard (${owner} does) — nothing sent`);
  process.exit(1);
}

for (const t of todo) {
  const peg = PEG !== null ? BigInt(Math.round(Number(PEG) * 1e8)) : t.priceE8;
  process.stdout.write(`  setPeg ${t.symbol} … `);
  const hash = await wallet.writeContract({
    address: guard, abi: tesseraPriceGuardAbi, functionName: "setPeg", args: [t.address, peg, BAND],
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(hash);
}

console.log("\nRe-reading to prove it took:");
for (const t of todo) {
  const feed = await pub.readContract({ address: guard, abi: tesseraPriceGuardAbi, functionName: "feeds", args: [t.address] });
  console.log(`  ${t.symbol.padEnd(8)} enabled ${feed[0]}  peg $${Number(formatUnits(feed[1], 8)).toLocaleString()}  band ${Number(feed[5])}bps  requireReference ${feed[2]}`);
}
