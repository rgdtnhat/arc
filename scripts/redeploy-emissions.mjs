/**
 * Replace the lending emissions contract, and nothing else.
 *
 * ## Why this exists next to `redeploy-pool.mjs`
 * That script replaces the *pool* and rebuilds emissions as a consequence. It
 * is the right tool when the pool's code changes and the wrong one when only
 * the emission rule does: it freezes the live pool, re-creates every position
 * with `supplyFor` out of the operator's own funds, and permanently stops the
 * emitter's activity figure growing. None of that is needed to change how
 * rewards accrue, and all of it is risk.
 *
 * So this replaces exactly one contract, against the pool that is already
 * live.
 *
 * ## What it deliberately does not do
 * **It does not chain the new contract to the old.** `setPrior` + `migrate`
 * exist to carry balances across, and carrying is right when the old balances
 * were backed. These are not: the live contract books 558,057 TSRA against a
 * pot of 18,382 — thirty times what exists — precisely the over-promise the
 * new accrual rule is here to end. Importing it would put the new contract in
 * the same hole on its first block.
 *
 * Nothing payable is taken away by leaving it. `free = held - owed` is zero, so
 * there is nothing to sweep: the old contract keeps its whole 18,382 pot *and*
 * its book, and every existing balance stays claimable there, first come first
 * served, exactly as it is today. What changes is that new emission goes to a
 * contract where a holder can only accrue what the pot can back — so the next
 * top-up is shared by whoever holds then, instead of disappearing into a queue
 * nobody behind the front of could ever reach.
 *
 * **It does not touch the AMM's liquidity emissions.** That contract owes
 * nothing at all (`totalOwed` is 0), so it has no over-promise to unwind, and
 * it has no `setPrior` — replacing it would strand balances for no gain. It
 * picks up the new rule whenever it is next deployed for a reason of its own.
 *
 * ## Usage
 *   node scripts/redeploy-emissions.mjs              # survey; sends nothing
 *   node scripts/redeploy-emissions.mjs --execute
 *   node scripts/redeploy-emissions.mjs --execute --use=0x…   # resume
 *
 * `--use` exists because the first live run died half way: the deploy and every
 * rate landed, then one emitter call reverted on what turned out to be a
 * transient failure — it simulated clean a minute later. Re-running from the
 * top would have deployed a second contract and orphaned the first. Point it at
 * the contract that already exists and it picks up where it stopped, skipping
 * the steps whose result it can read back from the chain.
 */
import { createPublicClient, createWalletClient, http, defineChain, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { tesseraEmissionsAbi, tesseraEmitterAbi, tesseraGaugeAbi } from "../shared/src/abi.ts";
import { erc20Abi } from "../shared/src/usdc.ts";
import { tesseraEmissionsBytecode } from "../shared/src/bytecode.ts";

const EXECUTE = process.argv.includes("--execute");
const USE = (process.argv.find((a) => a.startsWith("--use=")) || "").slice("--use=".length) || null;
const FILE = new URL("../deployments/arc.json", import.meta.url);
const dep = JSON.parse(readFileSync(FILE, "utf8"));

const chain = defineChain({
  id: dep.chainId,
  name: "Arc testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || dep.rpc] } },
});
const pub = createPublicClient({ chain, transport: http() });
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key) {
  console.error("DEPLOYER_PRIVATE_KEY is not set — this replaces a contract the deployer owns.");
  process.exit(1);
}
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http() });

const T = (v) => `${formatUnits(v, 18)} TSRA`;
const say = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`);
const ok = (s) => console.log(`   \x1b[32mok\x1b[0m   ${s}`);
const note = (s) => console.log(`   \x1b[33mnote\x1b[0m ${s}`);
const die = (s) => { console.error(`\n\x1b[31mSTOPPED\x1b[0m ${s}\n`); process.exit(1); };

/**
 * Send, with the gas margin the rest of this repo learned to add.
 *
 * `eth_estimateGas` binary-searches for a limit the call survives, and a limit
 * that *just* survives the search is not always one that survives execution —
 * a `try` forwards only 63/64 of the gas remaining, so the last inner call in a
 * chain can come up short at exactly the estimated limit. The emitter is the
 * contract where this bites, because `setSinkWeight` releases to eleven sinks
 * on the way through, and it bit here: two live attempts reverted on a call
 * that simulated clean a minute later. `OwnerClient` has carried this margin
 * for the same reason; a migration script that skips it is a migration script
 * that fails half way.
 */
async function send(label, to, abi, functionName, args) {
  if (!EXECUTE) { console.log(`   would ${label}`); return null; }
  const { request } = await pub.simulateContract({ address: to, abi, functionName, args, account });
  let gas;
  try {
    const est = await pub.estimateContractGas({ address: to, abi, functionName, args, account });
    gas = (est * 3n) / 2n + 50_000n;
  } catch {
    // A call that will not estimate will not send either; let the send produce
    // the real error rather than inventing a limit for it.
  }
  const hash = await wallet.writeContract({ ...request, ...(gas ? { gas } : {}) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") die(`${label} reverted (${hash})`);
  ok(`${label} — ${hash}`);
  return hash;
}

const OLD = dep.tesseraEmissions;
const read = (fn, args = []) =>
  pub.readContract({ address: OLD, abi: tesseraEmissionsAbi, functionName: fn, args });

say("What is live now");
const [owner, reward, setter, pausedNow, owed, pool] = await Promise.all([
  read("owner"), read("rewardToken"), read("rateSetter"), read("paused"), read("totalOwed"), read("pool"),
]);
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  die(`the emissions owner is ${owner}, not ${account.address}`);
}
const held = await pub.readContract({ address: reward, abi: erc20Abi, functionName: "balanceOf", args: [OLD] });
console.log(`   old contract  ${OLD}`);
console.log(`   pool          ${pool}`);
console.log(`   pot           ${T(held)}`);
console.log(`   owed          ${T(owed)}`);
console.log(`   over-promised ${owed > held ? T(owed - held) : "0 TSRA"}`);
console.log(`   paused ${pausedNow} · rate setter ${setter}`);

/*
 * Read the rates before anything moves, and carry them verbatim.
 *
 * The gauge rewrites these every epoch, so a rate that arrives at the new
 * contract as a default rather than as today's number is a change nobody voted
 * for, quietly attributed to the migration.
 */
say("Rates to carry");
const assetCount = await read("streamedAssetCount");
const rates = [];
for (let i = 0n; i < assetCount; i++) {
  const asset = await read("streamedAssets", [i]);
  for (const side of [0, 1, 2]) {
    const s = await read("streams", [asset, side]);
    if (s[0] > 0n || s[3] > 0n) rates.push({ asset, side, rate: s[0], endsAt: s[3] });
  }
}
for (const r of rates) console.log(`   ${r.asset} side ${r.side} → ${r.rate}/s${r.endsAt ? ` until ${r.endsAt}` : ""}`);
if (!rates.length) note("no rates set — the new contract starts idle");

say(EXECUTE ? "Deploying" : "What would happen");
if (!EXECUTE) {
  console.log("   would deploy TesseraEmissions against the live pool");
  console.log("   would set the reward token, carry every rate, and restore the gauge as rate setter");
  console.log("   would retire the old emitter sink and add the new contract at the same weight");
  console.log("   would point the gauge at the new contract");
  console.log("   would record it in deployments/arc.json, keeping the old as tesseraEmissionsLegacy");
  console.log("\n   The old contract keeps its pot and its book: every balance stays claimable there.");
  console.log("   Re-run with --execute to send.\n");
  process.exit(0);
}

let NEW = USE;
if (NEW) {
  const itsPool = await pub.readContract({ address: NEW, abi: tesseraEmissionsAbi, functionName: "pool" });
  if (String(itsPool).toLowerCase() !== String(pool).toLowerCase()) {
    die(`${NEW} reads pool ${itsPool}, not the live ${pool}`);
  }
  ok(`resuming with ${NEW}`);
} else {
  const hash = await wallet.deployContract({
    abi: tesseraEmissionsAbi,
    bytecode: tesseraEmissionsBytecode,
    args: [pool, account.address],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  NEW = receipt.contractAddress;
  if (!NEW) die("the deployment produced no address");
  ok(`deployed ${NEW}`);
}

const readNew = (fn, args = []) =>
  pub.readContract({ address: NEW, abi: tesseraEmissionsAbi, functionName: fn, args });

say("Wiring it up");
// Every step below checks the chain first, so resuming re-does nothing.
if (String(await readNew("rewardToken")).toLowerCase() !== String(reward).toLowerCase()) {
  await send("set the reward token", NEW, tesseraEmissionsAbi, "setRewardToken", [reward]);
} else ok("the reward token is already set");
for (const r of rates) {
  const have = await readNew("streams", [r.asset, r.side]);
  if (have[0] === r.rate && have[3] === r.endsAt) {
    ok(`${r.asset} side ${r.side} already carries ${r.rate}/s`);
    continue;
  }
  if (r.endsAt > 0n) {
    await send(`carry ${r.asset} side ${r.side} (${r.rate}/s until ${r.endsAt})`,
      NEW, tesseraEmissionsAbi, "setRateUntil", [r.asset, r.side, r.rate, r.endsAt]);
  } else {
    await send(`carry ${r.asset} side ${r.side} (${r.rate}/s)`,
      NEW, tesseraEmissionsAbi, "setRate", [r.asset, r.side, r.rate]);
  }
}
if (pausedNow && !(await readNew("paused"))) {
  // A paused emission stays paused: whoever paused it did so for a reason, and
  // a migration is not consent to resume.
  await send("keep it paused, as the old one is", NEW, tesseraEmissionsAbi, "setPaused", [true]);
}

say("Redirecting the emission");
const emitter = dep.tesseraEmitter;
let sinkCount = 0n;
try { sinkCount = await pub.readContract({ address: emitter, abi: tesseraEmitterAbi, functionName: "sinkCount" }); }
catch { note("the emitter does not report a sink count — skipping the sink swap"); }
let swapped = false;
for (let i = 0n; i < sinkCount; i++) {
  const sink = await pub.readContract({ address: emitter, abi: tesseraEmitterAbi, functionName: "sinks", args: [i] });
  if (String(sink[0]).toLowerCase() !== OLD.toLowerCase() || sink[2] === 0n) continue;
  const weight = sink[2];
  await send(`retire the old sink (#${i})`, emitter, tesseraEmitterAbi, "setSinkWeight", [i, 0n]);
  await send(`add the new contract as a sink at weight ${weight}`, emitter, tesseraEmitterAbi,
    "addSink", [NEW, 1, weight, "lending emissions"]);
  swapped = true;
}
if (!swapped) note("the old contract is not a live emitter sink — nothing to redirect");

if (setter && setter !== "0x0000000000000000000000000000000000000000") {
  const gauge = dep.tesseraGauge;
  const lp = await pub.readContract({ address: gauge, abi: tesseraGaugeAbi, functionName: "lpEmissions" })
    .catch(() => dep.tesseraLpEmissions);
  const pointed = await pub.readContract({ address: gauge, abi: tesseraGaugeAbi, functionName: "lendingEmissions" })
    .catch(() => null);
  if (String(pointed).toLowerCase() !== String(NEW).toLowerCase()) {
    await send("point the gauge at the new contract", gauge, tesseraGaugeAbi, "setEmissions", [NEW, lp]);
  } else ok("the gauge already points at the new contract");
  if (String(await readNew("rateSetter")).toLowerCase() !== String(setter).toLowerCase()) {
    await send("restore the gauge as rate setter", NEW, tesseraEmissionsAbi, "setRateSetter", [setter]);
  } else ok("the rate setter is already restored");
}

say("Recording it");
dep.tesseraEmissionsLegacy = OLD;
dep.tesseraEmissions = NEW;
dep.emissionsRedeployedAt = new Date().toISOString();
writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");
ok("deployments/arc.json updated — old address kept as tesseraEmissionsLegacy");

say("Done");
console.log(`   new emissions ${NEW}`);
console.log(`   old emissions ${OLD} — keeps ${T(held)} and every balance owed against it`);
console.log("\n   Existing balances stay claimable on the old contract. New emission accrues on the");
console.log("   new one, bounded by what the pot can pay, so a top-up is shared by whoever holds.\n");
console.log("   Restart the app so it reads the new address:  ./scripts/deploy.sh\n");
