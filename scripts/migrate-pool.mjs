/**
 * Move every supplier from a pool that cannot be governed into one that can.
 *
 * ## Why this exists
 * The live pool predates the operator risk controls. It has no `price`, no
 * `setPrice`, no `setFrozen`, no `setPriceFeed`, and no way to attach the risk
 * oracle or the outflow limiter. It still values collateral internally, so
 * borrow limits and health factors are self-consistent — but if a collateral
 * asset's real price moves away from the number baked in at deployment, there is
 * no lever to respond with. Not a stale display: a pool that cannot be steered.
 *
 * The pool holds no upgrade hook by design. There is no proxy and no admin
 * function that moves an existing supplier's shares, because that primitive is
 * indistinguishable from a rug pull. The price of that choice is this script.
 *
 * ## What it does, and what it refuses to do
 * It calls `supplyFor` — the operator pays, the user receives the position.
 * Nobody's balance is moved by anyone but them, and the old pool is left
 * completely untouched, so every original deposit stays withdrawable there
 * whether or not this succeeds.
 *
 * It will not migrate an account that owes anything. Creating debt for somebody
 * in a new contract without their consent is not a migration, it is signing a
 * loan in their name. Borrowers are listed so they can be asked to repay; their
 * position stays intact on the old pool, which keeps working for exactly that.
 *
 * ## Order of operations
 * The old pool cannot be frozen — that is the whole problem — so suppliers can
 * keep depositing into it while this runs. Repoint the app *first*, so the set
 * stops growing, then migrate. A second pass catches anything that arrived in
 * between; the plan is computed from both chains' live state every time, so
 * re-running tops up the difference and never doubles a position.
 *
 * ## Usage
 *
 * Through npm, always — this file imports TypeScript modules, so bare `node`
 * cannot load it and fails with ERR_UNKNOWN_FILE_EXTENSION. The script entry
 * supplies `--import tsx` and the env file, exactly as `pool:arc` does.
 *
 *   npm run migrate:pool                                  # survey: plan, cost, blockers
 *   npm run migrate:pool -- --to 0xNEW                    # dry run against a destination
 *   npm run migrate:pool -- --to 0xNEW --execute
 *   npm run migrate:pool -- --to 0xNEW --execute --verify-only
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, erc20Abi, tesseraPoolAbi, pacedHttp, formatUsdc } from "@tessera/shared";
import { planMigration, affordability, verifyMigration } from "../agent/src/migrate.ts";
import { ArchiveScanner } from "../agent/src/archive-chain.ts";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const PACE_MS = Number(process.env.TESSERA_PACE_MS ?? 6000);
const pace = (ms = PACE_MS) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const EXECUTE = process.argv.includes("--execute");
const VERIFY_ONLY = process.argv.includes("--verify-only");
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain: arcTestnet, transport: pacedHttp(RPC), batch: { multicall: true } });
const wallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: pacedHttp(RPC) });

function readDeployment() {
  for (const name of ["arc.local.json", "arc.json"]) {
    try {
      return JSON.parse(readFileSync(new URL(`../deployments/${name}`, import.meta.url), "utf8"));
    } catch { /* next */ }
  }
  return {};
}

const send = async (address, abi, functionName, args) => {
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: deployer });
  const hash = await wallet.writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  await pace();
  return hash;
};

/**
 * Every account that has ever touched the old pool, and its position now.
 *
 * The address set comes from `Supply` logs — there is no on-chain enumeration of
 * suppliers, because the pool stores shares per address and nothing walks them.
 * A partial log scan is reported rather than quietly treated as a complete one:
 * the cost of missing somebody is that they are left behind, and they are not
 * the one running this.
 */
async function readPositions(pool, assets, users) {
  const rows = [];
  for (const asset of assets) {
    const [supplied, borrowed] = await Promise.all([
      pub.multicall({
        contracts: users.map((u) => ({
          address: pool, abi: tesseraPoolAbi, functionName: "supplyBalance", args: [asset.address, u],
        })),
      }),
      pub.multicall({
        contracts: users.map((u) => ({
          address: pool, abi: tesseraPoolAbi, functionName: "borrowBalance", args: [asset.address, u],
        })),
      }),
    ]);
    for (let i = 0; i < users.length; i++) {
      const s = supplied[i]?.status === "success" ? supplied[i].result : 0n;
      const b = borrowed[i]?.status === "success" ? borrowed[i].result : 0n;
      if (s === 0n && b === 0n) continue;
      rows.push({ user: users[i], asset: asset.address, supplied: s, borrowed: b });
    }
  }
  return rows;
}

const fmt = (v, dp) => (Number(v) / 10 ** dp).toLocaleString(undefined, { maximumFractionDigits: dp });

async function main() {
  const dep = readDeployment();
  const oldPool = (argOf("--from") ?? dep.tesseraPool)?.toLowerCase();
  const newPool = argOf("--to")?.toLowerCase();
  const assets = (dep.poolAssets ?? []).map((a) => ({ ...a, address: a.address.toLowerCase() }));

  if (!oldPool) throw new Error("No source pool: pass --from, or record tesseraPool in deployments/arc.json");
  if (!assets.length) throw new Error("No poolAssets in the deployment record — nothing to migrate");

  console.log(`\nSource pool  ${oldPool}`);
  console.log(`Destination  ${newPool ?? "(none — pass --to 0x… ; deploy one with `npm run pool:arc -- --fresh` first)"}`);
  console.log(`Assets       ${assets.map((a) => a.symbol).join(", ")}`);
  console.log(`Mode         ${EXECUTE ? "EXECUTE — this sends transactions" : "dry run — nothing will be sent"}\n`);

  // 1) Who has ever supplied to the old pool.
  const scanner = new ArchiveScanner(arcTestnet, RPC);
  const scan = await scanner.scanPool(oldPool, assets);
  const users = [...new Set((scan.holders ?? []).map((h) => (h.address ?? h).toLowerCase()))];
  if (scan.partial) {
    console.warn(
      "⚠  The log scan was incomplete — some windows were throttled or refused.\n" +
      "   Anybody missing from it will be left behind, so re-run until this line is gone\n" +
      "   before treating the migration as finished.\n",
    );
  }
  console.log(`Found ${users.length} address(es) with history on the old pool.`);
  if (!users.length) { console.log("Nothing to migrate.\n"); return; }

  // 2) The two sides, read live. Never from a checkpoint file, which can drift
  //    from the chain it claims to describe.
  const source = await readPositions(oldPool, assets, users);
  const destination = newPool ? await readPositions(newPool, assets, users) : [];

  const plan = planMigration(source, destination);
  const bySymbol = Object.fromEntries(assets.map((a) => [a.address, a]));

  console.log(`\n── Plan ────────────────────────────────────────────────`);
  console.log(`  ${plan.steps.length} position(s) to move`);
  console.log(`  ${plan.alreadyDone} already in place`);
  console.log(`  ${plan.skippedDust} skipped as dust`);
  console.log(`  ${plan.blockedByDebt.length} blocked by debt\n`);

  for (const step of plan.steps.slice(0, 40)) {
    const a = bySymbol[step.asset];
    console.log(`  ${step.user}  +${fmt(step.topUp, a?.decimals ?? 6).padStart(14)} ${a?.symbol ?? "?"}`);
  }
  if (plan.steps.length > 40) console.log(`  … and ${plan.steps.length - 40} more`);

  if (plan.blockedByDebt.length) {
    console.log(`\n── Blocked by debt ─────────────────────────────────────`);
    console.log("  These accounts owe money on the old pool. Their whole position stays");
    console.log("  there — collateral included — until they repay. Nothing here is lost;");
    console.log("  the old pool keeps working for repayment and withdrawal.\n");
    for (const b of plan.blockedByDebt) {
      const a = bySymbol[b.asset];
      console.log(`  ${b.user}  owes ${fmt(b.borrowed, a?.decimals ?? 6)} ${a?.symbol ?? "?"}`);
    }
  }

  // 3) Can the operator pay for it?
  const balances = new Map();
  for (const a of assets) {
    balances.set(
      a.address,
      await pub.readContract({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] }),
    );
  }
  const afford = affordability(plan, balances);
  console.log(`\n── Cost to the operator ────────────────────────────────`);
  for (const [asset, need] of plan.cost) {
    const a = bySymbol[asset];
    console.log(`  ${(a?.symbol ?? asset).padEnd(8)} need ${fmt(need, a?.decimals ?? 6).padStart(14)}   hold ${fmt(balances.get(asset) ?? 0n, a?.decimals ?? 6)}`);
  }
  if (!afford.ok) {
    console.log("\n✗ Not enough to finish. Fund the deployer and re-run:");
    for (const s of afford.shortfalls) {
      const a = bySymbol[s.asset];
      console.log(`    short ${fmt(s.short, a?.decimals ?? 6)} ${a?.symbol ?? s.asset}`);
    }
  }

  if (!EXECUTE) {
    console.log("\nDry run only. Re-run with --execute to send these transactions.\n");
    return;
  }
  if (!newPool) throw new Error("--execute needs --to 0x… (the destination pool)");

  if (!VERIFY_ONLY) {
    // Stop rather than start something that cannot finish: a half-migrated set is
    // recoverable but it is the confusing state worth not creating.
    if (!afford.ok) throw new Error("Refusing to start a migration the deployer cannot finish.");

    console.log(`\n── Executing ───────────────────────────────────────────`);
    let done = 0;
    for (const step of plan.steps) {
      const a = bySymbol[step.asset];
      try {
        const allowance = await pub.readContract({
          address: step.asset, abi: erc20Abi, functionName: "allowance", args: [deployer.address, newPool],
        });
        if (allowance < step.topUp) {
          await send(step.asset, erc20Abi, "approve", [newPool, (1n << 256n) - 1n]);
        }
        await send(newPool, tesseraPoolAbi, "supplyFor", [step.asset, step.user, step.topUp]);
        done++;
        console.log(`  ✓ ${step.user}  ${fmt(step.topUp, a?.decimals ?? 6)} ${a?.symbol ?? ""}  (${done}/${plan.steps.length})`);
      } catch (e) {
        // One failure must not abandon the rest. The run is resumable, so the
        // right response is to record it and continue.
        console.error(`  ✗ ${step.user}  ${String(e?.shortMessage ?? e?.message).slice(0, 120)}`);
      }
    }
  }

  // 4) Did it actually land? Re-read rather than trusting that a transaction
  //    which did not throw did what it meant to.
  console.log(`\n── Verifying ───────────────────────────────────────────`);
  const after = await readPositions(newPool, assets, users);
  const check = verifyMigration(source, after);
  if (check.ok) {
    console.log("  ✓ every in-scope position is present in the destination\n");
    console.log("  Next: point the app at the new pool (deployments/arc.local.json → tesseraPool),");
    console.log("  restart, and keep the old pool listed as an archive so suppliers who were");
    console.log("  blocked by debt can still repay and withdraw there.\n");
  } else {
    console.log(`  ✗ ${check.missing.length} position(s) did not land:\n`);
    for (const m of check.missing.slice(0, 20)) {
      const a = bySymbol[m.asset];
      console.log(`    ${m.user}  expected ${fmt(m.expected, a?.decimals ?? 6)} ${a?.symbol ?? ""}, has ${fmt(m.actual, a?.decimals ?? 6)}`);
    }
    console.log("\n  Re-run the same command — the plan tops up the difference.\n");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`\n✗ ${e?.shortMessage ?? e?.message ?? e}\n`);
  process.exit(1);
});
