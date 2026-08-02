// Deploy TesseraPool to Arc testnet with three real Circle reserves — USDC + EURC
// (stablecoins) + cirBTC (Circle Wrapped Bitcoin) — all borrowable, seed liquidity
// from the deployer's real balances, and open the agent's cirBTC-collateralised
// position. Reads keys from .env (DEPLOYER_/AGENT_PRIVATE_KEY).
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet,
  ARC_USDC_ADDRESS,
  erc20Abi,
  tesseraPoolAbi,
  tesseraPoolBytecode,
  tesseraVaultAbi,
  tesseraVaultBytecode,
  tesseraRouterAbi,
  tesseraRouterBytecode,
  tesseraFeeCollectorAbi,
  tesseraFeeCollectorBytecode,
  tesseraAmmAbi,
  tesseraAmmBytecode,
  formatUsdc,
  pacedHttp,
} from "@tessera/shared";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);

// Breathing room between on-chain sends, because the public Arc RPC throttles.
// Configurable so an operator with a private endpoint isn't forced to wait, and
// so a test against a local fake node runs at full speed.
const PACE_MS = Number(process.env.TESSERA_PACE_MS ?? 6000);
// Lowering the pacing is a statement that this endpoint is fast, so receipt
// polling follows it down. Left alone it stays at viem's default, which is
// tuned for a shared public node.
const POLL_MS = PACE_MS >= 6000 ? undefined : Math.max(50, Math.round(PACE_MS / 4) || 50);

const pub = createPublicClient({ chain: arcTestnet, transport: pacedHttp(RPC), pollingInterval: POLL_MS });
const dWallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: pacedHttp(RPC), pollingInterval: POLL_MS });
const aWallet = createWalletClient({ account: agent, chain: arcTestnet, transport: pacedHttp(RPC), pollingInterval: POLL_MS });

const USD = 10n ** 8n;
const pace = (ms = PACE_MS) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const metaAbi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }];
const bal = async (who, token = ARC_USDC_ADDRESS) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

const ONLY_CHECK = process.argv.includes("--check");


// Real Circle assets on Arc (not mocks). Addresses can be overridden via env.
const CIRBTC_ADDRESS = process.env.CIRBTC_ADDRESS ?? "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF";
const EURC_ADDRESS = process.env.EURC_ADDRESS ?? "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

// Reserve set: USDC + EURC (stablecoins) + cirBTC — all borrowable. Prices are
// static USD (1e8); adjust later with setPrice or wire an oracle for mainnet.
const RESERVES = [
  { symbol: "USDC", address: ARC_USDC_ADDRESS, decimals: 6, cFactor: 9000, lFactor: 9500, rf: 1000, price: 1n * USD, seed: 5_000_000n },
  { symbol: "EURC", address: EURC_ADDRESS, decimals: 6, cFactor: 8500, lFactor: 9000, rf: 1000, price: 108_000_000n, seed: 5_000_000n },
  { symbol: "cirBTC", address: CIRBTC_ADDRESS, decimals: 8, cFactor: 7000, lFactor: 8000, rf: 1000, price: 95_000n * USD, seed: 20_000n },
];

/** Read the current deployment record, preferring the gitignored local override. */
function readDeployment() {
  for (const name of ["arc.local.json", "arc.json"]) {
    try {
      return { url: new URL(`../deployments/${name}`, import.meta.url), dep: JSON.parse(readFileSync(new URL(`../deployments/${name}`, import.meta.url), "utf8")) };
    } catch { /* next */ }
  }
  return { url: new URL("../deployments/arc.json", import.meta.url), dep: {} };
}
/**
 * Does this address hold contract code?
 *
 * Returns "yes" | "no" | "unknown". The distinction matters: an RPC failure must
 * NEVER be read as "no contract", because the caller would then deploy a
 * replacement and orphan a live deployment along with the funds inside it. The
 * read is retried, and a persistent failure surfaces as "unknown" so the caller
 * can stop instead of guessing.
 */
async function codeStatus(address) {
  if (!address) return "no";
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const c = await pub.getCode({ address });
      return c && c !== "0x" ? "yes" : "no";
    } catch (e) {
      lastErr = e;
      await pace(Math.min(3000, PACE_MS));
    }
  }
  console.warn(`   could not read code at ${address}: ${String(lastErr?.shortMessage ?? lastErr?.message).slice(0, 90)}`);
  return "unknown";
}

/**
 * Append-only history of every address this script has ever deployed, keyed by
 * component. Gitignored, so `git reset --hard` can't erase it.
 *
 * The deployment record itself can be lost (overwritten by a checkout, a wiped
 * volume, a fresh clone). Without a second source we would treat a missing vault
 * as "never deployed" and create a new one — stranding depositors' shares in the
 * old contract. History lets us recover the address instead.
 */
const HISTORY_URL = new URL("../deployments/arc.history.json", import.meta.url);
function readHistory() {
  try { return JSON.parse(readFileSync(HISTORY_URL, "utf8")); } catch { return {}; }
}
function recordHistory(label, address) {
  const h = readHistory();
  h[label] = [...new Set([...(h[label] ?? []), address])];
  try { writeFileSync(HISTORY_URL, JSON.stringify(h, null, 2) + "\n"); } catch { /* best effort */ }
}

/**
 * Resolve a contract for this run:
 *   1. the recorded address, when it still holds code;
 *   2. otherwise the newest address in history that holds code — this is the
 *      safety net that stops a lost record from stranding user funds;
 *   3. otherwise deploy, which for a fund-custody component (vault, AMM,
 *      fee collector) requires an explicit --fresh or --deploy-missing so it can
 *      never happen silently.
 * An unverifiable read aborts rather than guessing.
 */
async function adopt(label, recorded, fresh, deployFn, { custodial = false } = {}) {
  if (!fresh) {
    const candidates = [recorded, ...readHistory()[label] ?? []].filter(Boolean);
    const seen = new Set();
    for (const addr of candidates) {
      const key = String(addr).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const status = await codeStatus(addr);
      if (status === "yes") {
        const fromHistory = !recorded || String(recorded).toLowerCase() !== key;
        console.log(
          fromHistory
            ? `♻  recovered ${label} ${addr} from deployment history (the record had lost it)`
            : `♻  reusing existing ${label} ${addr}`,
        );
        return { address: addr, reused: true };
      }
      if (status === "unknown") {
        throw operatorError(
          `Could not verify whether ${label} at ${addr} still exists — the RPC kept failing.`,
          [
            "Deploying a replacement would orphan the existing contract and any funds in it, so this stops instead.",
            "Wait for the network to settle and re-run, or pass --fresh to deliberately deploy new contracts.",
          ],
        );
      }
    }
    if (candidates.length) console.log(`   no live ${label} among ${candidates.length} known address(es)`);
    // Nothing known and nothing live: deploying is only safe if the operator
    // meant to. Fund-custody components demand an explicit opt-in.
    if (custodial && !process.argv.includes("--deploy-missing")) {
      throw operatorError(
        `${label} has never been deployed on this host, and it holds funds.`,
        [
          candidates.length
            ? `${candidates.length} address(es) are known for it but none hold code, which is worth understanding before deploying over the top.`
            : `Nothing is recorded for it in deployments/arc.json, arc.local.json or arc.history.json.`,
          "First deployment?  npm run pool:arc:init      (adds --deploy-missing)",
          "Replacing an old one on purpose?  npm run pool:arc -- --fresh",
          `Expected an existing ${label}?  restore its address into deployments/arc.json first — do not deploy over it.`,
        ],
      );
    }
  }
  const address = await deployFn();
  recordHistory(label, address);
  return { address, reused: false };
}

/**
 * Every step this run chose not to do, and why. Printed as a block at the end so
 * a skip is visible rather than buried in the scroll.
 */
const skipped = [];

/**
 * A stop that the operator can act on, as opposed to a crash.
 *
 * These carry the fix, and the top-level handler prints them without a stack
 * trace — a stack tells you where in this file the check lives, which is not the
 * question. The question is "what do I run now", and that is `next`.
 */
function operatorError(message, next) {
  const e = new Error(message);
  e.operator = true;
  e.next = next;
  return e;
}

/**
 * Run a step whose failure must not stop the deployment.
 *
 * This exists because the script kept dying at the wrong altitude. Seeding
 * liquidity, opening the agent's demo position, topping up pool liquidity —
 * none of those are the deployment. They are decoration on top of it. But an
 * uncaught revert in any one of them aborted `main()` before later contracts
 * were deployed, so a run that failed to move 2 USDC of pool liquidity left the
 * AMM undeployed and the app showing "AMM not deployed yet".
 *
 * The rule now: a step is fatal only if a later step depends on it. Deploying a
 * contract, registering reserves and persisting the record are fatal. Moving
 * tokens around is not.
 */
async function optional(label, fn) {
  try {
    return await fn();
  } catch (e) {
    const why = String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 110);
    console.warn(`   ⚠ skipped ${label}: ${why}`);
    skipped.push(`${label} — ${why}`);
    return undefined;
  }
}

async function main() {
  // A version marker, so it is obvious from the log whether a host is running
  // this build or an older checkout that still aborts on an optional step.
  console.log("pool:arc — optional steps are non-fatal (deploy-resilient build)");
  console.log("deployer", deployer.address, formatUsdc(await bal(deployer.address)), "USDC");
  console.log("agent   ", agent.address, formatUsdc(await bal(agent.address)), "USDC");
  if (ONLY_CHECK) return;

  // Confirm on-chain decimals for real tokens (fall back to the config value).
  for (const r of RESERVES) {
    try { r.decimals = Number(await pub.readContract({ address: r.address, abi: metaAbi, functionName: "decimals" })); } catch {}
  }

  // 1) TesseraPool — REUSE the recorded pool when one is already live.
  //
  //     Re-running this script used to deploy a brand-new pool every time, which
  //     silently orphaned the previous pool and every deposit inside it. Now it
  //     adopts the existing deployment and only fills in what's missing. Pass
  //     --fresh to deliberately start over (the old contracts and any funds in
  //     them stay on-chain but are no longer used by the app).
  const FRESH = process.argv.includes("--fresh");
  const { url: depUrl, dep: existing } = readDeployment();
  const poolRes = await adopt("TesseraPool", existing.tesseraPool, FRESH, async () => {
    console.log("→ deploying TesseraPool…");
    const hash = await dWallet.deployContract({ abi: tesseraPoolAbi, bytecode: tesseraPoolBytecode, args: [deployer.address], account: deployer, chain: arcTestnet });
    const addr = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
    console.log("   pool", addr);
    await pace();
    return addr;
  });
  const pool = poolRes.address;

  const dSend = async (address, abi, fn, args, account = deployer, wallet = dWallet) => {
    const { request } = await pub.simulateContract({ address, abi, functionName: fn, args, account });
    const h = await wallet.writeContract(request);
    await pub.waitForTransactionReceipt({ hash: h });
    await pace();
    return h;
  };
  const aSend = async (address, abi, fn, args) => dSend(address, abi, fn, args, agent, aWallet);

  // 2) Register each reserve (all borrowable), then VERIFY it landed.
  //     A throttled RPC can drop one of these mid-deploy; recording an asset
  //     that isn't actually registered leaves the app listing a reserve whose
  //     reads all revert, so retry once and only keep verified reserves.
  const isRegistered = async (asset) => {
    try {
      const r = await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "reserves", args: [asset] });
      return r[0] === true; // enabled
    } catch {
      return false;
    }
  };
  for (const r of RESERVES) {
    // Already there (e.g. an earlier partial run)? Leave it alone.
    r.registered = await isRegistered(r.address);
    if (r.registered) {
      console.log(`   ${r.symbol}: already registered ✓`);
      continue;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`→ addReserve ${r.symbol} (${r.decimals}d, borrowable)${attempt > 1 ? ` — retry ${attempt - 1}` : ""}…`);
      try {
        // liqFactor sits between cFactor and lFactor: borrow up to cFactor, get
        // liquidated past liqFactor. The gap is the borrower's buffer.
        await dSend(pool, tesseraPoolAbi, "addReserve", [
          r.address, r.cFactor, r.liqFactor ?? r.lFactor, r.lFactor, r.rf, true, r.decimals, r.price,
        ]);
      } catch (e) {
        console.warn(`   addReserve ${r.symbol} failed: ${String(e.shortMessage ?? e.message).slice(0, 90)}`);
      }
      r.registered = await isRegistered(r.address);
      if (r.registered) break;
      await pace(PACE_MS ? 8000 : 0); // give the throttled RPC room before retrying
    }
    console.log(`   ${r.symbol}: ${r.registered ? "registered ✓" : "NOT registered ✗ (omitted from the deployment)"}`);
  }
  const LIVE_RESERVES = RESERVES.filter((r) => r.registered);
  if (!LIVE_RESERVES.length) throw new Error("No reserves registered — aborting before writing a deployment.");

  // 3) Seed liquidity from the deployer's real balances (skip what it can't fund).
  //     Per reserve, so one frozen or misbehaving asset costs only its own row.
  for (const r of LIVE_RESERVES) {
    const held = await bal(deployer.address, r.address);
    const seed = r.seed < held ? r.seed : held;
    if (seed > 0n) {
      await optional(`seeding ${r.symbol} pool liquidity`, async () => {
        console.log(`→ seeding ${seed} ${r.symbol} liquidity…`);
        await dSend(r.address, erc20Abi, "approve", [pool, maxUint256]);
        await dSend(pool, tesseraPoolAbi, "supply", [r.address, seed]);
      });
    } else {
      console.log(`   (skip seeding ${r.symbol} — deployer holds none; fund it, then supply from the dashboard)`);
    }
  }

  // 4) Agent position: use real cirBTC as collateral, then draw a small USDC line.
  const cirHeldByDeployer = await bal(deployer.address, CIRBTC_ADDRESS);
  const collateral = cirHeldByDeployer >= 40_000n ? 40_000n : cirHeldByDeployer; // ~0.0004 cirBTC
  if (collateral > 0n) {
    await optional("the agent's starting position", async () => {
      console.log(`→ funding agent ${collateral} cirBTC + opening its position…`);
      await dSend(CIRBTC_ADDRESS, erc20Abi, "transfer", [agent.address, collateral]);
      await aSend(CIRBTC_ADDRESS, erc20Abi, "approve", [pool, maxUint256]);
      await aSend(pool, tesseraPoolAbi, "supply", [CIRBTC_ADDRESS, collateral]);
      const usdcLiquidity = await bal(pool, ARC_USDC_ADDRESS);
      if (usdcLiquidity >= 1_000_000n) {
        await aSend(pool, tesseraPoolAbi, "borrow", [ARC_USDC_ADDRESS, 1_000_000n]); // 1 USDC
      }
    });
  } else {
    console.log("   (skip agent position — no cirBTC to use as collateral; supply from the dashboard once funded)");
  }

  // 5) TesseraVault over USDC: 80% liquid reserve (contract floor + default).
  //     Reused when already deployed, so depositors keep their shares.
  const vaultRes = await adopt("TesseraVault", existing.tesseraVault, FRESH, async () => {
    console.log("→ deploying TesseraVault (USDC, 80% reserve floor, 15% perf fee)…");
    const vh = await dWallet.deployContract({
      abi: tesseraVaultAbi,
      bytecode: tesseraVaultBytecode,
      args: [ARC_USDC_ADDRESS, pool, deployer.address, 8000, 1500],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: vh })).contractAddress;
    console.log("   vault", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const vault = vaultRes.address;

  // 6b) TesseraFeeCollector: every app fee lands here, then gets allocated
  //     20/20/20/20/20 (agent / lending / vault / liquidity / retained), weekly.
  const feeRes = await adopt("TesseraFeeCollector", existing.tesseraFeeCollector, FRESH, async () => {
    console.log("→ deploying TesseraFeeCollector (20/20/20/20/20, weekly)…");
    const fh = await dWallet.deployContract({
      abi: tesseraFeeCollectorAbi,
      bytecode: tesseraFeeCollectorBytecode,
      args: [ARC_USDC_ADDRESS, agent.address, pool, vault, "0x0000000000000000000000000000000000000000"],
      account: deployer,
      chain: arcTestnet,
    });
    return (await pub.waitForTransactionReceipt({ hash: fh })).contractAddress;
  }, { custodial: true });
  const feeCollector = feeRes.address;
  if (!feeRes.reused) {
    console.log("   feeCollector", feeCollector);
    await pace();
    // The collector becomes the treasury for both the pool and the vault so fees
    // flow to it. Each is best-effort: on a reused deployment these may already
    // be set, and a revert here must not abort the whole run.
    for (const [label, fn] of [
      ["pointing the pool's treasury at the fee collector", () => dSend(pool, tesseraPoolAbi, "setTreasury", [feeCollector])],
      ["pointing the vault's treasury at the fee collector", () => dSend(vault, tesseraVaultAbi, "setTreasury", [feeCollector])],
    ]) {
      await optional(label, fn);
    }
  }

  // 6c) TesseraAMM + its own fee collector. Users provide liquidity and keep 50%
  //     of every swap fee (a floor the contract enforces); the app's half lands in
  //     the AMM collector, which splits it 20% back into the AMM pool / 20% lending
  //     / 20% vault / 20% agent / 20% retained.
  const ammCollectorRes = await adopt("TesseraAmmFeeCollector", existing.tesseraAmmFeeCollector, FRESH, async () => {
    console.log("→ deploying AMM fee collector (20/20/20/20/20, weekly)…");
    const h = await dWallet.deployContract({
      abi: tesseraFeeCollectorAbi,
      bytecode: tesseraFeeCollectorBytecode,
      args: [ARC_USDC_ADDRESS, agent.address, pool, vault, "0x0000000000000000000000000000000000000000"],
      account: deployer,
      chain: arcTestnet,
    });
    return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
  }, { custodial: true });
  const ammFeeCollector = ammCollectorRes.address;

  const ammRes = await adopt("TesseraAMM", existing.tesseraAmm, FRESH, async () => {
    console.log("→ deploying TesseraAMM…");
    const h = await dWallet.deployContract({
      abi: tesseraAmmAbi,
      bytecode: tesseraAmmBytecode,
      args: [ammFeeCollector],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   amm", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const amm = ammRes.address;

  // Seed the pools from what's actually on chain, not from whether this run
  // happened to deploy the AMM. A previous run could have deployed the contract
  // and then died before creating any pool — reusing that address and skipping
  // this block would leave a permanently empty AMM that no later run repairs.
  const ammPools = await optional("reading the AMM pool count", () =>
    pub.readContract({ address: amm, abi: tesseraAmmAbi, functionName: "poolCount" }),
  );
  if (ammPools === undefined) {
    // Unknown, not zero. Creating pools on a failed read would duplicate
    // whatever is already there, and a duplicate pool splits liquidity.
    console.log("   (skip AMM pool creation — the pool count could not be read, so creating would risk duplicates)");
  } else if (ammPools === 0n) {
    // One pool per non-USDC reserve, paired against USDC: 0.30% fee, 50% to LPs.
    for (const r of LIVE_RESERVES.filter((x) => x.address.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase())) {
      await optional(`creating the AMM pool USDC / ${r.symbol}`, async () => {
        await dSend(amm, tesseraAmmAbi, "createPool", [[ARC_USDC_ADDRESS, r.address], 30, 5000, `USDC / ${r.symbol}`]);
        console.log(`   AMM pool USDC / ${r.symbol}`);
      });
    }
    // Point the AMM collector's swap leg at pool 0 so app fees cycle back in.
    await optional("linking the AMM collector to pool 0", () =>
      dSend(ammFeeCollector, tesseraFeeCollectorAbi, "setAmm", [amm, 0n]),
    );
  } else {
    console.log(`   AMM already has ${ammPools} pool(s)`);
  }

  // 6d) TesseraRouter: the swap surface. It holds no inventory — every trade is
  //     filled out of the AMM pools above, with a min-out guard and a deadline,
  //     and it can chain two hops through USDC when no direct pool exists.
  //
  //     Point the app's main fee collector's liquidity leg at the AMM too, so
  //     protocol fees cycle back into the same pools the router trades against
  //     rather than sitting in a desk nobody swaps with.
  const routerRes = await adopt("TesseraRouter", existing.tesseraRouter, FRESH, async () => {
    console.log("→ deploying TesseraRouter (AMM-backed swaps, USDC hub)…");
    const h = await dWallet.deployContract({
      abi: tesseraRouterAbi,
      bytecode: tesseraRouterBytecode,
      args: [amm, [ARC_USDC_ADDRESS]],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   router", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const router = routerRes.address;

  await optional("cycling protocol fees back into AMM pool 0", () =>
    dSend(feeCollector, tesseraFeeCollectorAbi, "setAmm", [amm, 0n]),
  );

  // 7) Persist. Merge into whatever record we adopted so escrow/tab and any
  //     other recorded addresses survive.
  const dep = { ...existing };
  dep.tesseraPool = pool;
  dep.tesseraVault = vault;
  dep.vaultAsset = ARC_USDC_ADDRESS;
  dep.tesseraRouter = router;
  delete dep.tesseraSwap; // the inventory desk is no longer part of the app
  dep.tesseraFeeCollector = feeCollector;
  dep.tesseraAmm = amm;
  dep.tesseraAmmFeeCollector = ammFeeCollector;
  dep.poolAssets = LIVE_RESERVES.map((r) => ({ symbol: r.symbol, address: r.address, decimals: r.decimals, borrowable: true }));
  delete dep.poolCollateral; // no more mock collateral
  const body = JSON.stringify(dep, null, 2) + "\n";
  writeFileSync(new URL("../deployments/arc.json", import.meta.url), body);
  // Also write the gitignored override the app prefers, so a later
  // `git reset --hard` can't revert this server to older addresses.
  writeFileSync(new URL("../deployments/arc.local.json", import.meta.url), body);
  if (depUrl) { /* adopted record merged above */ }
  console.log("\n✅ Pool + Vault + AMM + Router live on Arc:");
  console.log("   pool     ", pool);
  console.log("   vault    ", vault);
  console.log("   router   ", router);
  console.log("   fees     ", feeCollector);
  console.log("   amm      ", amm);
  console.log("   amm fees ", ammFeeCollector);
  for (const r of LIVE_RESERVES) console.log(`   ${r.symbol.padEnd(7)} ${r.address}`);
  console.log("   explorer ", `https://testnet.arcscan.app/address/${pool}`);

  if (skipped.length) {
    console.log(`\n⚠  ${skipped.length} optional step(s) skipped — the deployment above is complete regardless:`);
    for (const s of skipped) console.log(`   · ${s}`);
    console.log("   Anything here can be done from the dashboard once the wallets are funded.");
  }
}

main().catch((e) => {
  // A fatal error means a contract could not be deployed or the record could not
  // be written. Lead with the one-line reason: a raw viem error includes the
  // whole ABI, which buries it.
  console.error(`\n❌ pool:arc stopped: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]}`);
  if (e?.operator) {
    // A deliberate stop with a known fix. No stack — it would only point at the
    // guard inside this script, which is not what the operator needs.
    for (const line of e.next ?? []) console.error(`   ${line}`);
  } else {
    console.error(e);
  }
  if (skipped.length) {
    console.error(`\n   ${skipped.length} optional step(s) had already been skipped before this:`);
    for (const s of skipped) console.error(`   · ${s}`);
  }
  process.exit(1);
});
