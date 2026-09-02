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
const EMITTER = (flag("emitter") ?? dep.tesseraEmitter ?? "").toLowerCase() || null;
/*
 * Only the four emitter views this needs. `tesseraEmitterAbi` in @tessera/shared
 * is the whole contract and would be re-exported here for three getters and one
 * setter; naming them makes the blast radius of this script legible.
 */
const emitterAbi = [
  { type: "function", name: "sinkCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalWeight", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function", name: "sinks", stateMutability: "view", inputs: [{ type: "uint256" }],
    // Declaration order of the struct: to, kind, weight, label. Reading them in
    // any other order silently returns the wrong field — `kind` decodes as a
    // plausible-looking weight, which is exactly how a 58.8% share first read
    // as 0.98%.
    outputs: [{ type: "address" }, { type: "uint8" }, { type: "uint96" }, { type: "string" }],
  },
  {
    type: "function", name: "setSinkWeight", stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [],
  },
];
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

/*
 * The other half of the same half-finished redeploy: the emitter's weight.
 *
 * `redeploy:pool` step [4] deploys a replacement TesseraEmissions, chains it to
 * the old one, adds it as an emitter sink and moves the weight across. Step [6]
 * rewrites the deployment record. A run that does the first and not the second
 * leaves the app reading a contract the emitter no longer funds — which starves
 * silently and with certainty: on this deployment the served contract sat at
 * weight 0 with a pot of 214.4798 TSRA against 214.4798 owed, so the guard
 * paused it and the claim panel read "0 TSRA" while the replacement held 1.1M.
 *
 * Nothing about that is visible from the pool, so unfreezing alone would have
 * restored borrowing and left rewards dead. It is the same undo, so it belongs
 * in the same command.
 */
const EMISSIONS = (flag("emissions-address") ?? dep.tesseraEmissions ?? "").toLowerCase();
let weightStep = null;
if (EMITTER && EMISSIONS) {
  const n = await pub.readContract({ address: EMITTER, abi: emitterAbi, functionName: "sinkCount" }).catch(() => 0n);
  const total = await pub.readContract({ address: EMITTER, abi: emitterAbi, functionName: "totalWeight" }).catch(() => 0n);
  const sinks = [];
  for (let i = 0n; i < n; i++) {
    const sk = await pub.readContract({ address: EMITTER, abi: emitterAbi, functionName: "sinks", args: [i] }).catch(() => null);
    if (sk) sinks.push({ i, to: String(sk[0]).toLowerCase(), weight: sk[2], label: sk[3] });
  }
  const served = sinks.find((x) => x.to === EMISSIONS);
  if (served) {
    console.log("\n── Emitter funding ─────────────────────────────────────");
    const pct = (w) => (Number(total) ? `${((Number(w) / Number(total)) * 100).toFixed(1)}%` : "—");
    console.log(`  sink ${served.i}  weight ${served.weight} (${pct(served.weight)})  ${served.to}  ← the record's emissions`);
    if (served.weight === 0n) {
      /*
       * Who took the weight. Only a sink carrying the same label, because
       * "some other sink has weight" is true of the AMM's and of the keeper's
       * tip jar, and moving the lending share onto either of those would be a
       * far worse outcome than leaving it where it is.
       */
      const heir = sinks.find((x) => x.weight > 0n && x.label === served.label && x.to !== served.to);
      if (heir) {
        weightStep = { served, heir };
        console.log(`  sink ${heir.i}  weight ${heir.weight} (${pct(heir.weight)})  ${heir.to}  ← has it instead`);
        console.log("  → would move the weight back, so the contract the app serves is funded again");
      } else {
        console.log("  → it is unfunded and no sink with the same label holds the weight.");
        console.log("    Not guessing which one should: set it by hand on the emitter.");
      }
    } else {
      console.log("  → already funded");
    }
  }
}

if (!frozen.length && !limiterStep && !weightStep) { console.log("\nNothing to do.\n"); process.exit(0); }

console.log("\n── Plan ────────────────────────────────────────────────");
if (frozen.length) console.log(`  unfreeze ${frozen.map((a) => a.symbol).join(", ")} — supply and borrow work again`);
if (limiterStep) console.log(`  re-attach the outflow limiter and point it back at this pool`);
if (weightStep) {
  console.log(
    `  move the emitter's lending weight (${weightStep.heir.weight}) from sink ${weightStep.heir.i} ` +
      `back to sink ${weightStep.served.i} — rewards start accruing again on the served contract`,
  );
}
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

if (weightStep) {
  /*
   * The heir goes to zero first.
   *
   * `setSinkWeight` calls `_release()` before changing the split, so each call
   * settles everything owed at the weights that were in force. Raising the
   * served sink first would briefly put both on the payroll, which is not
   * harmful but does hand the retired one a slice it is about to give back.
   * Zero first, then restore, and no release happens at a split nobody meant.
   */
  const emitterOwner = await pub.readContract({ address: EMITTER, abi: emitterAbi, functionName: "owner" }).catch(() => null);
  if (String(emitterOwner).toLowerCase() !== account.address.toLowerCase()) {
    console.error(`\n  ${account.address} does not own the emitter (${emitterOwner} does) — weight left alone`);
  } else {
    const w = weightStep.heir.weight;
    process.stdout.write(`  retire sink ${weightStep.heir.i} … `);
    let h = await wallet.writeContract({
      address: EMITTER, abi: emitterAbi, functionName: "setSinkWeight", args: [weightStep.heir.i, 0n],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(h);
    process.stdout.write(`  restore sink ${weightStep.served.i} to weight ${w} … `);
    h = await wallet.writeContract({
      address: EMITTER, abi: emitterAbi, functionName: "setSinkWeight", args: [weightStep.served.i, w],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(h);
  }
}

console.log("\nRe-reading:");
for (const a of assets) {
  const mask = await pub.readContract({ address: POOL, abi: tesseraPoolAbi, functionName: "frozenActions", args: [a.address] });
  console.log(`  ${a.symbol.padEnd(7)} mask ${mask} — frozen: ${describe(mask)}`);
}
console.log("\nRestart the app so its caches clear:  ./scripts/deploy.sh\n");
