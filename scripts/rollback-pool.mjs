#!/usr/bin/env node
/**
 * Put the app back on a working pool, now.
 *
 * A pool redeploy runs in stages. Between "freeze the old pool" and "the app
 * reads the new one" there is a window where the deployment the app serves is
 * frozen against new supply and new borrowing — deliberately, because a
 * retiring pool should not take new money. If the migration then stops for any
 * reason, that window stays open: every deposit, every borrow, and every
 * scheduled task that does either fails, while withdrawals and repayments keep
 * working.
 *
 * That is what happened here. The record the app reads still names the old
 * pool, the old pool is frozen at mask 5 (`FREEZE_SUPPLY | FREEZE_BORROW`), and
 * the replacement is wired but empty and referenced by nothing.
 *
 * This reverses the freeze so the pool the app actually serves works again. It
 * is not an undo of the migration — the new pool stays exactly where it is, and
 * the migration can be finished later. It is a way to stop being half way
 * through one while people are using the site.
 *
 * Optionally it also puts the outflow limiter back, because the redeploy
 * handed it to the replacement and a pool serving traffic should have one.
 *
 *   npm run pool:rollback -- --pool 0x…              # survey
 *   npm run pool:rollback -- --pool 0x… --execute
 *   npm run pool:rollback -- --pool 0x… --limiter --execute
 */
import { createPublicClient, createWalletClient, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet as arcChain, pacedHttp, tesseraPoolAbi, tesseraRateLimiterAbi } from "../shared/src/index.ts";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const WITH_LIMITER = argv.includes("--limiter");
const flag = (n) => { const i = argv.indexOf(`--${n}`); if (i >= 0 && argv[i+1] && !argv[i+1].startsWith("--")) return argv[i+1];
  const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=").slice(1).join("=") : null; };

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const dep = JSON.parse(readFileSync(new URL("../deployments/arc.json", import.meta.url), "utf8"));
const POOL = flag("pool") ?? dep.tesseraPool;
const LIMITER = flag("limiter-address") ?? dep.tesseraRateLimiter;
const assets = dep.poolAssets ?? [];
if (!POOL) { console.error("--pool 0x… is required"); process.exit(1); }

const pub = createPublicClient({ chain: arcChain, transport: pacedHttp(RPC) });
const NAMES = { 1: "supply", 2: "withdraw", 4: "borrow", 8: "repay" };
const describe = (m) => Object.entries(NAMES).filter(([b]) => Number(m) & Number(b)).map(([, n]) => n).join(" + ") || "nothing";

console.log(`Pool ${POOL}`);
console.log(`This is the pool the deployment record names, so it is the one the app serves.\n`);

console.log("── Frozen actions ──────────────────────────────────────");
const frozen = [];
for (const a of assets) {
  const mask = await pub.readContract({ address: POOL, abi: tesseraPoolAbi, functionName: "frozenActions", args: [a.address] });
  console.log(`  ${a.symbol.padEnd(7)} mask ${String(mask).padEnd(3)} frozen: ${describe(mask)}`);
  if (Number(mask) !== 0) frozen.push(a);
}
if (!frozen.length) console.log("  nothing is frozen");

let limiterStep = null;
if (WITH_LIMITER && LIMITER) {
  const attached = await pub.readContract({ address: POOL, abi: tesseraPoolAbi, functionName: "rateLimiter" }).catch(() => null);
  const consumer = await pub.readContract({ address: LIMITER, abi: tesseraRateLimiterAbi, functionName: "consumer" }).catch(() => null);
  console.log("\n── Outflow limiter ─────────────────────────────────────");
  console.log(`  pool has     ${attached}`);
  console.log(`  limiter trusts ${consumer}`);
  if (String(attached).toLowerCase() !== LIMITER.toLowerCase() || String(consumer).toLowerCase() !== POOL.toLowerCase()) {
    limiterStep = { attached, consumer };
    console.log("  → would re-attach it to this pool and point it back here");
  } else console.log("  → already this pool's");
}

if (!frozen.length && !limiterStep) { console.log("\nNothing to do.\n"); process.exit(0); }

console.log("\n── Plan ────────────────────────────────────────────────");
if (frozen.length) console.log(`  unfreeze ${frozen.map((a) => a.symbol).join(", ")} — supply and borrow work again`);
if (limiterStep) console.log(`  re-attach the outflow limiter and point it back at this pool`);
console.log("\n  What this does NOT do: the replacement pool is left exactly where it is,");
console.log("  configured and empty. Finishing the migration later is unaffected.");

if (!EXECUTE) { console.log("\nSurvey only. Re-run with --execute to send.\n"); process.exit(0); }

const key = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.OWNER_PRIVATE_KEY;
if (!key) { console.error("\nset DEPLOYER_PRIVATE_KEY to send"); process.exit(1); }
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: arcChain, transport: pacedHttp(RPC) });
const owner = await pub.readContract({ address: POOL, abi: tesseraPoolAbi, functionName: "owner" });
if (String(owner).toLowerCase() !== account.address.toLowerCase()) {
  console.error(`\n${account.address} does not own ${POOL} (${owner} does) — nothing sent`);
  process.exit(1);
}

if (frozen.length) {
  process.stdout.write(`  unfreeze ${frozen.length} reserve(s) … `);
  const h = await wallet.writeContract({
    address: POOL, abi: tesseraPoolAbi, functionName: "setFrozenMany",
    args: [frozen.map((a) => a.address), 0],
  });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(h);
}
if (limiterStep) {
  // The pool first, then the limiter: neither is ever pointing at something
  // that will refuse it.
  process.stdout.write("  attach the limiter to this pool … ");
  let h = await wallet.writeContract({ address: POOL, abi: tesseraPoolAbi, functionName: "setWiring", args: [2, LIMITER] })
    .catch(async () => wallet.writeContract({
      address: POOL, abi: [{ type:"function", name:"setRateLimiter", stateMutability:"nonpayable", inputs:[{type:"address"}], outputs:[] }],
      functionName: "setRateLimiter", args: [LIMITER],
    }));
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(h);
  process.stdout.write("  point the limiter back here … ");
  h = await wallet.writeContract({ address: LIMITER, abi: tesseraRateLimiterAbi, functionName: "setConsumer", args: [POOL] });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(h);
}

console.log("\nRe-reading:");
for (const a of assets) {
  const mask = await pub.readContract({ address: POOL, abi: tesseraPoolAbi, functionName: "frozenActions", args: [a.address] });
  console.log(`  ${a.symbol.padEnd(7)} mask ${mask} — frozen: ${describe(mask)}`);
}
console.log("\nRestart the app so its caches clear:  ./scripts/deploy.sh\n");
