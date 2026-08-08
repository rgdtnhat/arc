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
import { mergeDeployment } from "../agent/src/deployment.ts";

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

/*
 * The same merge the app uses, not a simpler one that disagrees with it.
 *
 * This used to return whichever file it found first, so a host with an
 * `arc.local.json` got that file *whole*. On this deployment the local record
 * predates TSRA's listing and carries three assets where the committed record
 * carries four — which meant a migration planned from it would have walked past
 * every TSRA supplier in silence and then reported success. An asset dropped
 * from the plan is not a smaller migration, it is people left behind in a pool
 * about to be retired.
 *
 * `mergeDeployment` is what `agent/src/deployment.ts` serves the dashboard
 * from: the committed file is the base, the local file wins only for keys it
 * names in `overrides`, and keys the committed file has never heard of are
 * taken regardless. One rule, one place.
 */
function readDeployment() {
  const read = (name) => {
    try {
      return JSON.parse(readFileSync(new URL(`../deployments/${name}`, import.meta.url), "utf8"));
    } catch {
      return null;
    }
  };
  const { merged, ignored } = mergeDeployment(read("arc.json"), read("arc.local.json"));
  if (ignored.length) {
    console.warn(
      `⚠  arc.local.json disagrees on ${ignored.join(", ")} without claiming ${ignored.length === 1 ? "it" : "them"} in\n` +
      `   "overrides", so the committed record wins — the same rule the app follows.\n`,
    );
  }
  return merged;
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
  /*
   * The source is the *retired* pool, and after a redeploy that is no longer
   * `tesseraPool`.
   *
   * `redeploy:pool --execute` rewrites the record: `tesseraPool` becomes the
   * replacement and the pool it superseded is filed under `tesseraPoolLegacy`.
   * Defaulting `--from` to `tesseraPool` therefore pointed this script at the
   * destination the moment it was most likely to be run — right after a
   * redeploy — so it would scan the new pool, find the positions it was about
   * to create, and report the whole migration as already done. Nothing lost,
   * but a convincing way to believe you had migrated when you had not.
   */
  const oldPool = (argOf("--from") ?? dep.tesseraPoolLegacy ?? dep.tesseraPool)?.toLowerCase();
  const newPool = (argOf("--to") ?? (dep.tesseraPoolLegacy ? dep.tesseraPool : undefined))?.toLowerCase();
  const assets = (dep.poolAssets ?? []).map((a) => ({ ...a, address: a.address.toLowerCase() }));

  if (!oldPool) throw new Error("No source pool: pass --from, or record tesseraPool in deployments/arc.json");
  if (!assets.length) throw new Error("No poolAssets in the deployment record — nothing to migrate");

  /*
   * Check the addresses before doing anything, not at the twentieth transaction.
   *
   * `--to 0xNEW` is the placeholder from the instructions, and it used to sail
   * straight through: the header printed "Destination 0xnew", the plan was
   * computed, the cost was quoted, and the failure only arrived per-position
   * once viem tried to build a transaction. Nothing was lost, because nothing
   * could be sent — but the operator watched a migration appear to run and then
   * report every position as not landed, which is a frightening way to learn you
   * mistyped an argument.
   *
   * Shape first, then code. An address that is well-formed but holds nothing is
   * the worse mistake of the two: a plan against it is valid, affordable, and
   * migrates everybody into a contract that does not exist.
   */
  const looksLikeAddress = (a) => /^0x[0-9a-f]{40}$/.test(String(a ?? "").toLowerCase());
  for (const [flag, value] of [["--from", oldPool], ["--to", newPool]]) {
    if (value === undefined) continue;
    if (!looksLikeAddress(value)) {
      throw new Error(
        `${flag} ${value} is not an address.\n` +
        `  It needs 0x followed by 40 hex characters. A value ending in "…" is a\n` +
        `  shortened address copied out of a console or a chat message — paste the\n` +
        `  whole forty-two characters, or leave the flag off entirely and let the\n` +
        `  deployment record supply it.`,
      );
    }
  }
  /*
   * Migrating a pool into itself.
   *
   * Reachable two ways: passing the same address twice, or omitting `--from`
   * before this script learned to prefer `tesseraPoolLegacy`. It is not
   * destructive — every position reads as already in place — but it prints a
   * clean bill of health for a migration that never happened, which is the one
   * output nobody double-checks.
   */
  if (oldPool && newPool && oldPool === newPool) {
    throw new Error(
      `--from and --to are the same pool (${oldPool}).\n` +
      `  Every position would read as already migrated and the run would report success\n` +
      `  without moving anything. After a redeploy the source is "tesseraPoolLegacy" in\n` +
      `  the deployment record and the destination is "tesseraPool".`,
    );
  }
  for (const [label, addr] of [["source pool", oldPool], ["destination pool", newPool]]) {
    if (!addr) continue;
    const code = await pub.getCode({ address: addr }).catch(() => null);
    if (code === null) throw new Error(`Could not check whether the ${label} exists — the RPC failed. Not guessing.`);
    if (code === "0x") {
      throw new Error(
        `The ${label} ${addr} holds no contract code.\n` +
        `  A migration into an address with nothing at it would report success and strand everyone.`,
      );
    }
  }

  console.log(`\nSource pool  ${oldPool}`);
  console.log(
    `Destination  ${newPool ?? "(none — run `npm run redeploy:pool -- --emitter=keep --execute` first, or pass --to)"}`,
  );
  console.log(`Assets       ${assets.map((a) => a.symbol).join(", ")}`);
  console.log(`Mode         ${EXECUTE ? "EXECUTE — this sends transactions" : "dry run — nothing will be sent"}\n`);

  // 1) Who has ever supplied to the old pool.
  /*
   * Say what is happening, because this step is the long one.
   *
   * There is no way to enumerate a Solidity mapping, so the supplier set comes
   * from event logs — and Arc caps `eth_getLogs` at ten thousand blocks, so the
   * pool's whole history is walked in windows, backwards, up to a few hundred
   * of them. On a throttled public RPC each window can sit in a retry backoff
   * for seconds. It used to print nothing at all between the header and the
   * result: several minutes of dead terminal, which reads as a hung process
   * rather than a working one. A hung-looking process gets killed, and a
   * half-scanned migration leaves people behind — the exact failure the scan
   * exists to prevent.
   */
  console.log("Scanning the old pool's history for suppliers.");
  console.log("  Arc caps eth_getLogs at 10k blocks, so this walks the pool's whole life in");
  console.log("  windows. On a throttled RPC it can take several minutes. Progress below.\n");
  const scanner = new ArchiveScanner(arcTestnet, RPC);
  const started = Date.now();
  let lastLine = 0;
  const scan = await scanner.scanPool(oldPool, assets, {
    onProgress: (p) => {
      // Every window would be hundreds of lines in a log file; every tenth (and
      // always the first) is enough to prove it is moving.
      if (p.windows !== 1 && p.windows - lastLine < 10) return;
      lastLine = p.windows;
      const left = p.from > p.floor ? p.from - p.floor : 0n;
      const secs = Math.round((Date.now() - started) / 1000);
      console.log(
        `  window ${String(p.windows).padStart(3)}/${p.maxWindows}  ` +
          `at block ${p.from}  ${left} to go  ` +
          `${p.found} address(es)  ${secs}s${p.partial ? "  ⚠ a window was refused" : ""}`,
      );
    },
  });
  console.log("");
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
