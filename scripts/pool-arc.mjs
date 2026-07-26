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
  tesseraSwapAbi,
  tesseraSwapBytecode,
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
const pub = createPublicClient({ chain: arcTestnet, transport: pacedHttp(RPC) });
const dWallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: pacedHttp(RPC) });
const aWallet = createWalletClient({ account: agent, chain: arcTestnet, transport: pacedHttp(RPC) });

const USD = 10n ** 8n;
const pace = (ms = 6000) => new Promise((r) => setTimeout(r, ms));
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
      await pace(3000);
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
 *   3. otherwise deploy, which for a fund-custody component (vault, swap desk,
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
        throw new Error(
          `Could not verify whether ${label} at ${addr} still exists (the RPC kept failing). ` +
            `Refusing to deploy a replacement, because that would orphan the existing deployment and any funds in it. ` +
            `Retry when the network settles, or pass --fresh to deliberately deploy new contracts.`,
        );
      }
    }
    if (candidates.length) console.log(`   no live ${label} among ${candidates.length} known address(es)`);
    // Nothing known and nothing live: deploying is only safe if the operator
    // meant to. Fund-custody components demand an explicit opt-in.
    if (custodial && !process.argv.includes("--deploy-missing")) {
      throw new Error(
        `No ${label} is recorded or found in history, so a NEW one would be deployed. ` +
          `${label} holds funds, so this needs an explicit opt-in: re-run with --deploy-missing ` +
          `(first deployment) or --fresh (deliberately abandon the old one). If you expected an existing ` +
          `${label}, restore deployments/arc.json (or arc.local.json) with its address first.`,
      );
    }
  }
  const address = await deployFn();
  recordHistory(label, address);
  return { address, reused: false };
}

async function main() {
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
        await dSend(pool, tesseraPoolAbi, "addReserve", [r.address, r.cFactor, r.lFactor, r.rf, true, r.decimals, r.price]);
      } catch (e) {
        console.warn(`   addReserve ${r.symbol} failed: ${String(e.shortMessage ?? e.message).slice(0, 90)}`);
      }
      r.registered = await isRegistered(r.address);
      if (r.registered) break;
      await pace(8000); // give the throttled RPC room before retrying
    }
    console.log(`   ${r.symbol}: ${r.registered ? "registered ✓" : "NOT registered ✗ (omitted from the deployment)"}`);
  }
  const LIVE_RESERVES = RESERVES.filter((r) => r.registered);
  if (!LIVE_RESERVES.length) throw new Error("No reserves registered — aborting before writing a deployment.");

  // 3) Seed liquidity from the deployer's real balances (skip what it can't fund).
  for (const r of LIVE_RESERVES) {
    const held = await bal(deployer.address, r.address);
    const seed = r.seed < held ? r.seed : held;
    if (seed > 0n) {
      console.log(`→ seeding ${seed} ${r.symbol} liquidity…`);
      await dSend(r.address, erc20Abi, "approve", [pool, maxUint256]);
      await dSend(pool, tesseraPoolAbi, "supply", [r.address, seed]);
    } else {
      console.log(`   (skip seeding ${r.symbol} — deployer holds none; fund it, then supply from the dashboard)`);
    }
  }

  // 4) Agent position: use real cirBTC as collateral, then draw a small USDC line.
  const cirHeldByDeployer = await bal(deployer.address, CIRBTC_ADDRESS);
  const collateral = cirHeldByDeployer >= 40_000n ? 40_000n : cirHeldByDeployer; // ~0.0004 cirBTC
  if (collateral > 0n) {
    // Also best-effort: an already-open position, or a frozen reserve, must not
    // stop the contracts that come after this from being deployed.
    try {
      console.log(`→ funding agent ${collateral} cirBTC + opening its position…`);
      await dSend(CIRBTC_ADDRESS, erc20Abi, "transfer", [agent.address, collateral]);
      await aSend(CIRBTC_ADDRESS, erc20Abi, "approve", [pool, maxUint256]);
      await aSend(pool, tesseraPoolAbi, "supply", [CIRBTC_ADDRESS, collateral]);
      const usdcLiquidity = await bal(pool, ARC_USDC_ADDRESS);
      if (usdcLiquidity >= 1_000_000n) {
        await aSend(pool, tesseraPoolAbi, "borrow", [ARC_USDC_ADDRESS, 1_000_000n]); // 1 USDC
      }
    } catch (e) {
      console.warn(`   (skip agent position: ${String(e.shortMessage ?? e.message).slice(0, 80)})`);
    }
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

  // 6) TesseraSwap: 0.30% fee, half of it to the app treasury. Seed inventory.
  const swapRes = await adopt("TesseraSwap", existing.tesseraSwap, FRESH, async () => {
    console.log("→ deploying TesseraSwap (0.30% fee, 50% to treasury)…");
    const sh = await dWallet.deployContract({
      abi: tesseraSwapAbi,
      bytecode: tesseraSwapBytecode,
      args: [pool, deployer.address, 30, 5000],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: sh })).contractAddress;
    console.log("   swap", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const swap = swapRes.address;
  // Seed the swap desk with a slice of each asset the deployer still holds.
  //
  // Best-effort on purpose. `seed` is owner-only, and on any run after the first
  // the fee collector owns the swap desk — so this reverts, and when it was
  // un-caught it aborted the whole script before the AMM was ever deployed.
  // Inventory is a nice-to-have; the deployment is not.
  for (const r of LIVE_RESERVES) {
    const held = await bal(deployer.address, r.address);
    const want = r.symbol === "cirBTC" ? 10_000n : 2_000_000n; // 0.0001 cirBTC or 2 units
    const seed = want < held ? want : held;
    if (seed > 0n) {
      try {
        await dSend(r.address, erc20Abi, "approve", [swap, maxUint256]);
        await dSend(swap, tesseraSwapAbi, "seed", [r.address, seed]);
        console.log(`   seeded swap ${seed} ${r.symbol}`);
      } catch (e) {
        console.warn(
          `   (skip seeding swap ${r.symbol}: ${String(e.shortMessage ?? e.message).slice(0, 70)}` +
            ` — the collector owns the desk, so seed from its allocation instead)`,
        );
      }
    }
  }

  // 6b) TesseraFeeCollector: every app fee lands here, then gets allocated
  //     20/20/20/20/20 (agent / lending / vault / swap / retained), weekly.
  const feeRes = await adopt("TesseraFeeCollector", existing.tesseraFeeCollector, FRESH, async () => {
    console.log("→ deploying TesseraFeeCollector (20/20/20/20/20, weekly)…");
    const fh = await dWallet.deployContract({
      abi: tesseraFeeCollectorAbi,
      bytecode: tesseraFeeCollectorBytecode,
      args: [ARC_USDC_ADDRESS, agent.address, pool, vault, swap],
      account: deployer,
      chain: arcTestnet,
    });
    return (await pub.waitForTransactionReceipt({ hash: fh })).contractAddress;
  }, { custodial: true });
  const feeCollector = feeRes.address;
  if (!feeRes.reused) {
    console.log("   feeCollector", feeCollector);
    await pace();
    // The collector needs to own the swap desk so its `seed` leg can run, and it
    // becomes the treasury for both the pool and the vault so fees flow to it.
    // Each is best-effort: on a reused deployment these may already be set, and
    // a revert here must not abort the whole run.
    for (const [label, fn] of [
      ["swap ownership", () => dSend(swap, tesseraSwapAbi, "transferOwnership", [feeCollector])],
      ["pool treasury", () => dSend(pool, tesseraPoolAbi, "setTreasury", [feeCollector])],
      ["vault treasury", () => dSend(vault, tesseraVaultAbi, "setTreasury", [feeCollector])],
    ]) {
      try { await fn(); } catch (e) { console.warn(`   ${label} not set: ${String(e.shortMessage ?? e.message).slice(0, 80)}`); }
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
  let ammPools = 0n;
  try {
    ammPools = await pub.readContract({ address: amm, abi: tesseraAmmAbi, functionName: "poolCount" });
  } catch (e) {
    console.warn(`   AMM pool count unreadable: ${String(e.shortMessage ?? e.message).slice(0, 80)}`);
  }
  if (ammPools === 0n) {
    // One pool per non-USDC reserve, paired against USDC: 0.30% fee, 50% to LPs.
    for (const r of LIVE_RESERVES.filter((x) => x.address.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase())) {
      try {
        await dSend(amm, tesseraAmmAbi, "createPool", [[ARC_USDC_ADDRESS, r.address], 30, 5000, `USDC / ${r.symbol}`]);
        console.log(`   AMM pool USDC / ${r.symbol}`);
      } catch (e) {
        console.warn(`   AMM pool USDC / ${r.symbol} not created: ${String(e.shortMessage ?? e.message).slice(0, 80)}`);
      }
    }
    // Point the AMM collector's swap leg at pool 0 so app fees cycle back in.
    try { await dSend(ammFeeCollector, tesseraFeeCollectorAbi, "setAmm", [amm, 0n]); }
    catch (e) { console.warn(`   AMM collector not linked: ${String(e.shortMessage ?? e.message).slice(0, 80)}`); }
  } else {
    console.log(`   AMM already has ${ammPools} pool(s)`);
  }

  // 7) Persist. Merge into whatever record we adopted so escrow/tab and any
  //     other recorded addresses survive.
  const dep = { ...existing };
  dep.tesseraPool = pool;
  dep.tesseraVault = vault;
  dep.vaultAsset = ARC_USDC_ADDRESS;
  dep.tesseraSwap = swap;
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
  console.log("\n✅ Pool + Vault + Swap live on Arc:");
  console.log("   pool     ", pool);
  console.log("   vault    ", vault);
  console.log("   swap     ", swap);
  console.log("   fees     ", feeCollector);
  console.log("   amm      ", amm);
  console.log("   amm fees ", ammFeeCollector);
  for (const r of LIVE_RESERVES) console.log(`   ${r.symbol.padEnd(7)} ${r.address}`);
  console.log("   explorer ", `https://testnet.arcscan.app/address/${pool}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
