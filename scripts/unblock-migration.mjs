#!/usr/bin/env node
/**
 * Clear the two things that stop a pool migration finishing.
 *
 * `migrate:pool` reproduces each supplier's position on the destination by
 * calling `supplyFor` with the operator's own tokens. Two things stop it, and
 * neither needs money from outside:
 *
 * **A dust debt blocks a whole position.** An account that owes anything keeps
 * its entire position on the old pool — collateral included — because moving
 * collateral out from under a loan would be unsecuring it. On this deployment
 * that is a rounding-dust debt of 1e-9 TSRA blocking 47,650 TSRA of supply.
 * The borrower usually holds far more of the token than it owes, so it can
 * simply repay itself.
 *
 * **The operator is short of a token.** It needs enough of each asset to
 * reproduce every position. Where the shortfall is a token the operator itself
 * has supplied to the old pool, it is already holding the answer — the old
 * pool still allows withdrawals — so it can withdraw its own position and use
 * that.
 *
 * Survey by default; `--execute` sends. Everything here is the operator's own
 * money moving between its own accounts: a repayment of its own debt, or a
 * withdrawal of its own deposit. Nothing touches anybody else's position.
 *
 *   npm run pool:unblock -- --from 0x… --to 0x…
 *   npm run pool:unblock -- --from 0x… --to 0x… --execute
 */
import { createPublicClient, createWalletClient, erc20Abi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet as arcChain, pacedHttp, tesseraPoolAbi } from "../shared/src/index.ts";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const flag = (n) => { const h = argv.find((a) => a.startsWith(`--${n}=`)) ?? argv[argv.indexOf(`--${n}`) + 1]; return h?.startsWith("--") ? null : (h?.includes("=") ? h.split("=").slice(1).join("=") : h) ?? null; };
const OLD = flag("from");
if (!OLD) { console.error("--from 0x… (the pool being retired) is required"); process.exit(1); }

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const dep = JSON.parse(readFileSync(new URL("../deployments/arc.json", import.meta.url), "utf8"));
const assets = dep.poolAssets ?? [];
const pub = createPublicClient({ chain: arcChain, transport: pacedHttp(RPC) });

/** Every key this deployment holds, so it can act for those accounts and no others. */
const keys = Object.entries({
  deployer: process.env.DEPLOYER_PRIVATE_KEY ?? process.env.OWNER_PRIVATE_KEY,
  agent: process.env.AGENT_PRIVATE_KEY,
}).flatMap(([name, k]) => (k ? [[name, privateKeyToAccount(k)]] : []));
if (!keys.length) { console.error("no keys in the environment — nothing can be signed"); process.exit(1); }

console.log(`Retiring pool ${OLD}`);
console.log(`Signing for   ${keys.map(([n, a]) => `${n} ${a.address}`).join("\n              ")}\n`);

const plan = [];

console.log("── Debts blocking a position ───────────────────────────");
for (const [name, acct] of keys) {
  for (const a of assets) {
    const owed = await pub.readContract({ address: OLD, abi: tesseraPoolAbi, functionName: "borrowBalance", args: [a.address, acct.address] });
    if (owed === 0n) continue;
    const held = await pub.readContract({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [acct.address] });
    const ok = held >= owed;
    console.log(`  ${name.padEnd(9)} owes ${formatUnits(owed, a.decimals).padEnd(24)} ${a.symbol.padEnd(7)} holds ${formatUnits(held, a.decimals)}`);
    if (ok) plan.push({ kind: "repay", name, acct, asset: a, amount: owed });
    else console.log(`            ✗ cannot repay itself — short ${formatUnits(owed - held, a.decimals)} ${a.symbol}`);
  }
}
if (!plan.length) console.log("  none for the accounts this deployment holds keys for");

console.log("\n── Tokens the operator is short of ─────────────────────");
const operator = keys.find(([n]) => n === "deployer")?.[1] ?? keys[0][1];
for (const a of assets) {
  const supplied = await pub.readContract({ address: OLD, abi: tesseraPoolAbi, functionName: "supplyBalance", args: [a.address, operator.address] });
  const held = await pub.readContract({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [operator.address] });
  if (supplied === 0n) continue;
  console.log(`  ${a.symbol.padEnd(7)} holds ${formatUnits(held, a.decimals).padEnd(24)} supplied on the old pool ${formatUnits(supplied, a.decimals)}`);
  if (held === 0n && supplied > 0n) {
    plan.push({ kind: "withdraw", name: "deployer", acct: operator, asset: a, amount: supplied });
  }
}

if (!plan.length) { console.log("\nNothing to unblock.\n"); process.exit(0); }

console.log(`\n── Plan ────────────────────────────────────────────────`);
for (const s of plan) {
  console.log(s.kind === "repay"
    ? `  ${s.name} repays ${formatUnits(s.amount, s.asset.decimals)} ${s.asset.symbol} of its own debt`
    : `  ${s.name} withdraws its own ${formatUnits(s.amount, s.asset.decimals)} ${s.asset.symbol} from the retired pool`);
}
if (!EXECUTE) { console.log("\nSurvey only. Re-run with --execute to send.\n"); process.exit(0); }

for (const s of plan) {
  const wallet = createWalletClient({ account: s.acct, chain: arcChain, transport: pacedHttp(RPC) });
  if (s.kind === "repay") {
    const allowance = await pub.readContract({ address: s.asset.address, abi: erc20Abi, functionName: "allowance", args: [s.acct.address, OLD] });
    if (allowance < s.amount) {
      process.stdout.write(`  approve ${s.asset.symbol} … `);
      const h = await wallet.writeContract({ address: s.asset.address, abi: erc20Abi, functionName: "approve", args: [OLD, s.amount] });
      await pub.waitForTransactionReceipt({ hash: h });
      console.log(h);
    }
    process.stdout.write(`  ${s.name} repay ${s.asset.symbol} … `);
    const h = await wallet.writeContract({ address: OLD, abi: tesseraPoolAbi, functionName: "repay", args: [s.asset.address, s.amount] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(h);
  } else {
    process.stdout.write(`  ${s.name} withdraw ${s.asset.symbol} … `);
    const h = await wallet.writeContract({ address: OLD, abi: tesseraPoolAbi, functionName: "withdraw", args: [s.asset.address, s.amount] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(h);
  }
}

console.log("\nRe-reading:");
for (const s of plan) {
  const owed = await pub.readContract({ address: OLD, abi: tesseraPoolAbi, functionName: "borrowBalance", args: [s.asset.address, s.acct.address] });
  const held = await pub.readContract({ address: s.asset.address, abi: erc20Abi, functionName: "balanceOf", args: [s.acct.address] });
  console.log(`  ${s.name.padEnd(9)} ${s.asset.symbol.padEnd(7)} owes ${formatUnits(owed, s.asset.decimals).padEnd(20)} holds ${formatUnits(held, s.asset.decimals)}`);
}
console.log("\nNow re-run the migration survey.\n");
