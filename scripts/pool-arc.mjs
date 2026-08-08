// Deploy TesseraPool to Arc testnet with three real Circle reserves — USDC + EURC
// (stablecoins) + cirBTC (Circle Wrapped Bitcoin) — all borrowable, seed liquidity
// from the deployer's real balances, and open the agent's cirBTC-collateralised
// position. Reads keys from .env (DEPLOYER_/AGENT_PRIVATE_KEY).
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, maxUint256, toFunctionSelector } from "viem";
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
  tesseraPriceGuardAbi,
  tesseraPriceGuardBytecode,
  tesseraStreamAbi,
  tesseraStreamBytecode,
  tesseraSubscriptionAbi,
  tesseraSubscriptionBytecode,
  tesseraSpendPolicyAbi,
  tesseraSpendPolicyBytecode,
  tesseraLpTokenAbi,
  tesseraLpTokenBytecode,
  tesseraTimelockAbi,
  tesseraTimelockBytecode,
  tesseraEscrowAbi,
  tesseraOracleAbi,
  tesseraOracleBytecode,
  tesseraRegistryAbi,
  tesseraRegistryBytecode,
  tesseraRateLimiterAbi,
  tesseraRateLimiterBytecode,
  tesseraArbiterAbi,
  tesseraArbiterBytecode,
  tesseraReceiptAnchorAbi,
  tesseraReceiptAnchorBytecode,
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
  { symbol: "USDC", address: ARC_USDC_ADDRESS, decimals: 6, cFactor: 9000, lFactor: 9500, rf: 1000, price: 1n * USD, seed: 5_000_000n, outflowPerHour: 250_000_000n },
  { symbol: "EURC", address: EURC_ADDRESS, decimals: 6, cFactor: 8500, lFactor: 9000, rf: 1000, price: 108_000_000n, seed: 5_000_000n, outflowPerHour: 250_000_000n },
  { symbol: "cirBTC", address: CIRBTC_ADDRESS, decimals: 8, cFactor: 7000, lFactor: 8000, rf: 1000, price: 95_000n * USD, seed: 20_000n, outflowPerHour: 500_000n },
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

  // 6e) TesseraPriceGuard: a sanity band around the pool's manual prices.
  //
  //     The pool takes prices from an owner call. That is fine until the call is
  //     wrong — a fat-fingered decimal re-marks every position at once, and the
  //     first thing that happens is a wave of liquidations at a price nobody
  //     traded at. The guard compares each new price against the AMM's TWAP and
  //     rejects anything outside the band.
  const guardRes = await adopt("TesseraPriceGuard", existing.tesseraPriceGuard, FRESH, async () => {
    console.log("→ deploying TesseraPriceGuard (TWAP sanity band on manual prices)…");
    const h = await dWallet.deployContract({
      abi: tesseraPriceGuardAbi,
      bytecode: tesseraPriceGuardBytecode,
      args: [amm, pool],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   guard", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const priceGuard = guardRes.address;

  // 6e-bis) TesseraOracle: risk pricing that a single moved feed cannot bend.
  //
  //     The pool used one number per asset for both collateral and debt, which
  //     is what makes a manipulated price profitable in either direction —
  //     inflate a collateral mark and over-borrow against it, or deflate one and
  //     liquidate somebody at a price nobody traded at. The oracle quotes
  //     collateral at the lowest usable source and debt at the highest, and
  //     stops the pool entirely when its sources disagree.
  const oracleRes = await adopt("TesseraOracle", existing.tesseraOracle, FRESH, async () => {
    console.log("→ deploying TesseraOracle (directional risk pricing)…");
    const h = await dWallet.deployContract({
      abi: tesseraOracleAbi,
      bytecode: tesseraOracleBytecode,
      args: [deployer.address, priceGuard],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   oracle", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const riskOracle = oracleRes.address;

  // Seed each reserve. 10% per update and a 30-minute floor between them make
  // walking a price somewhere useful slow and visible; 5% divergence is the
  // point at which the sources are treated as disagreeing rather than merely
  // differing.
  for (const r of LIVE_RESERVES) {
    await optional(`configuring the oracle for ${r.symbol}`, () =>
      dSend(riskOracle, tesseraOracleAbi, "configureAsset", [
        r.address,
        r.price,
        "0x0000000000000000000000000000000000000000", // no Chainlink feed on Arc testnet yet
        3600,
        1000,  // maxMoveBps: 10% per update
        1800,  // minUpdateInterval: 30 minutes
        500,   // maxDivergenceBps: 5%
        7 * 24 * 3600, // maxAge: a week
      ]),
    );
  }

  // Arming is opt-in for the same reason the timelock handover is: the guard
  // refuses new borrowing whenever its sources disagree, and on a fresh
  // deployment the TWAP has no history to agree with yet.
  if (process.argv.includes("--arm-oracle")) {
    await optional("arming the pool's risk oracle", () =>
      dSend(pool, tesseraPoolAbi, "setRiskOracle", [riskOracle]),
    );
  } else {
    console.log("   (skip arming the risk oracle — pass --arm-oracle once the TWAP has history)");
  }

  // Point each non-USDC reserve at the AMM pool that prices it. A reserve with
  // no feed is simply unguarded — the guard answers "ok" rather than blocking,
  // so a missing feed can never be the reason an asset's price freezes.
  {
    let poolId = 0n;
    for (const r of LIVE_RESERVES.filter((x) => x.address.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase())) {
      const id = poolId++;
      await optional(`pointing the price guard at ${r.symbol} (AMM pool ${id})`, () =>
        // 25% band over a 30-minute window: wide enough that ordinary
        // volatility does not block an honest re-mark, tight enough to catch a
        // decimal slip.
        //
        // Plus 1,000 USDC of quote-side depth before the average is trusted at
        // all. A TWAP over a thin pool is not a safer price, only a slower one
        // to forge — which is how YieldBlox lost $10.2m in February 2026. Below
        // the floor the feed reports no price, so a thin pool stops guarding
        // the manual mark rather than starting to dictate it.
        dSend(priceGuard, tesseraPriceGuardAbi, "setFeed", [r.address, id, ARC_USDC_ADDRESS, 2500, 1800, 1_000_000_000n]),
      );
    }
  }
  await optional("arming the pool's price guard", () =>
    dSend(pool, tesseraPoolAbi, "setPriceGuard", [priceGuard]),
  );

  // 6f) Exposure caps. Every other control in the pool is a ratio; none of them
  //     bound how large a single reserve can get. Sized generously — these exist
  //     to stop a runaway, not to shape ordinary use.
  for (const r of LIVE_RESERVES) {
    const isUsdc = r.address.toLowerCase() === ARC_USDC_ADDRESS.toLowerCase();
    const unit = 10n ** BigInt(r.decimals);
    // USDC is the unit of account here and carries the least price risk, so it
    // gets the loosest cap; everything else is held to a tighter line.
    const supplyCap = isUsdc ? 5_000_000n * unit : 250_000n * unit;
    const borrowCap = isUsdc ? 4_000_000n * unit : 100_000n * unit;
    await optional(`capping ${r.symbol} exposure`, () =>
      dSend(pool, tesseraPoolAbi, "setCaps", [r.address, supplyCap, borrowCap]),
    );
  }

  // 6g) The two payment shapes the rail was missing: streaming (pay by the
  //     second, for work measured in time) and subscriptions (prepaid credit an
  //     agent can draw on while its funder is offline). Neither takes an owner —
  //     they hold only what their users put in them.
  const streamRes = await adopt("TesseraStream", existing.tesseraStream, FRESH, async () => {
    console.log("→ deploying TesseraStream (pay by the second)…");
    const h = await dWallet.deployContract({
      abi: tesseraStreamAbi,
      bytecode: tesseraStreamBytecode,
      args: [],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   stream", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const stream = streamRes.address;

  const subRes = await adopt("TesseraSubscription", existing.tesseraSubscription, FRESH, async () => {
    console.log("→ deploying TesseraSubscription (prepaid credit, capped per period)…");
    const h = await dWallet.deployContract({
      abi: tesseraSubscriptionAbi,
      bytecode: tesseraSubscriptionBytecode,
      args: [],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   subs  ", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const subscription = subRes.address;

  // 6h) TesseraSpendPolicy: the agent's spending limit, on chain.
  //
  //     The app enforced its cap in a Node process, which bounds a well-behaved
  //     agent and nothing else — a holder of the agent key could ignore it
  //     entirely. Here the funds sit in the policy and the agent calls `spend`,
  //     so the limit is a property of the money rather than of the software
  //     asking for it. The guardian must not be the agent, which the constructor
  //     enforces: a limit you can raise yourself is not a limit.
  const policyRes = await adopt("TesseraSpendPolicy", existing.tesseraSpendPolicy, FRESH, async () => {
    console.log("→ deploying TesseraSpendPolicy (agent limit enforced on chain)…");
    const h = await dWallet.deployContract({
      abi: tesseraSpendPolicyAbi,
      bytecode: tesseraSpendPolicyBytecode,
      args: [
        deployer.address, // guardian
        agent.address,
        {
          periodSeconds: 86400,
          periodCap: 50n * 10n ** 6n, // 50 USDC/day
          perCounterpartyCap: 10n * 10n ** 6n, // 10 USDC to any one provider
          allowlistOnly: false,
          expiresAt: 0n,
        },
      ],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   policy", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const spendPolicy = policyRes.address;

  // Point the policy at the escrow, or it is deployed and unreachable: every
  // `openPayment` reverts with NoEscrow and the agent silently falls back to
  // paying from its own key — which is the exact "deployed but bypassed" state
  // the policy was written to end.
  //
  // Read from the record rather than deployed here: the escrow is created by
  // the bootstrap, and a pool run that has not seen one yet should say so
  // rather than invent an address.
  if (existing.tesseraEscrow) {
    await optional("pointing the spend policy at the escrow", () =>
      dSend(spendPolicy, tesseraSpendPolicyAbi, "setEscrow", [existing.tesseraEscrow]),
    );
  } else {
    console.log("   (skip wiring the spend policy — no escrow in the deployment record yet)");
  }

  // 6i) TesseraLpToken: AMM pool 0's shares as an ordinary ERC-20.
  //
  //     Wrapping is what lets an LP position be listed as a pool reserve, and
  //     what the vault's sleeve holds. Pool 0 because that is the one the fee
  //     collectors cycle into, so it is the position with depth.
  const lpRes = await adopt("TesseraLpToken", existing.tesseraLpToken, FRESH, async () => {
    console.log("→ deploying TesseraLpToken (AMM pool 0 shares as ERC-20)…");
    const h = await dWallet.deployContract({
      abi: tesseraLpTokenAbi,
      bytecode: tesseraLpTokenBytecode,
      args: [amm, 0n, "Tessera LP (pool 0)", "tLP0"],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   lpToken", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const lpToken = lpRes.address;

  // 6i-bis) TesseraRegistry: where a provider says it exists.
  //
  //     Until this, the seller list was a hardcoded array on the buyer's side,
  //     so the set of providers an agent could reach was decided by whoever
  //     deployed the agent. A provider now stakes and lists itself.
  const registryRes = await adopt("TesseraRegistry", existing.tesseraRegistry, FRESH, async () => {
    console.log("→ deploying TesseraRegistry (permissionless provider discovery)…");
    const h = await dWallet.deployContract({
      abi: tesseraRegistryAbi,
      bytecode: tesseraRegistryBytecode,
      // 1 USDC to list. High enough that a thousand spam listings cost a
      // thousand dollars of working capital, low enough that an independent
      // provider is not priced out — and it is returned on unlisting, so an
      // honest lister pays only the time value.
      args: [ARC_USDC_ADDRESS, 1_000_000n],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   registry", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const registry = registryRes.address;

  // The registry keeps no reputation of its own — it points at the escrow's,
  // which is a byproduct of real settlements and cannot be written directly.
  if (existing.tesseraEscrow) {
    await optional("pointing the registry at the escrow's reputation", () =>
      dSend(registry, tesseraRegistryAbi, "setEscrow", [existing.tesseraEscrow]),
    );
  } else {
    console.log("   (skip wiring the registry — no escrow in the deployment record yet)");
  }

  // 6i-ter) TesseraRateLimiter: a ceiling on how fast value leaves.
  const limiterRes = await adopt("TesseraRateLimiter", existing.tesseraRateLimiter, FRESH, async () => {
    console.log("→ deploying TesseraRateLimiter (outflow metering)…");
    const h = await dWallet.deployContract({
      abi: tesseraRateLimiterAbi,
      bytecode: tesseraRateLimiterBytecode,
      args: [pool],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   limiter", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const rateLimiter = limiterRes.address;

  // A bucket per reserve, sized so ordinary use never touches it and a drain
  // takes hours. Deliberately generous: a limit that bites in normal operation
  // is an outage, and the first thing an operator does with one is remove it.
  for (const r of LIVE_RESERVES) {
    await optional(`metering outflow for ${r.symbol}`, () =>
      dSend(rateLimiter, tesseraRateLimiterAbi, "setLimit", [r.address, r.outflowPerHour, 3600n]),
    );
  }

  /*
   * Armed by default. Opting *out* is the decision now, not opting in.
   *
   * This was opt-in on the reasoning that it is the one control here that can
   * block an honest withdrawal. That reasoning had the risk backwards. The
   * limiter starts full, refills on a clock nobody controls, and the pool can
   * unhook it in a single transaction — so the worst it does is delay somebody
   * by minutes. Unarmed, a compromised deployer key empties the reserve as fast
   * as blocks will carry it, which is how Drift lost $285m in April 2026 to
   * credentials rather than to a contract bug.
   *
   * A protection that has to be remembered is a protection that is off.
   */
  if (process.argv.includes("--no-arm-limiter")) {
    console.log("   (outflow limiter deployed but NOT armed — --no-arm-limiter was passed)");
    skipped.push({
      step: "arming the outflow limiter",
      why: "--no-arm-limiter was passed; the pool will not meter withdrawals",
    });
  } else {
    await optional("arming the pool's outflow limiter", () =>
      dSend(pool, tesseraPoolAbi, "setRateLimiter", [rateLimiter]),
    );
  }

  // 6i-quater) TesseraArbiter: somebody to decide when 'it hashed' is disputed.
  //
  //     Skipped entirely without an escrow: the arbiter's address is baked in at
  //     construction, so deploying one pointed at nothing would have to be
  //     replaced rather than rewired.
  const arbiterRes = !existing.tesseraEscrow ? { address: null } : await adopt("TesseraArbiter", existing.tesseraArbiter, FRESH, async () => {
    console.log("→ deploying TesseraArbiter (dispute resolution)…");
    const h = await dWallet.deployContract({
      abi: tesseraArbiterAbi,
      bytecode: tesseraArbiterBytecode,
      args: [ARC_USDC_ADDRESS, existing.tesseraEscrow, 100_000_000n], // 100 USDC to sit on the panel
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   arbiter", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const arbiter = arbiterRes.address;

  if (!arbiter) {
    console.log("   (skip the arbiter — no escrow in the deployment record yet)");
  } else if (process.argv.includes("--arm-arbiter")) {
    // Opt-in: with no registered arbitrators, escalation would freeze a payment
    // until the escrow's own 24h timeout released it to the provider. Correct,
    // but a worse experience than not offering escalation at all.
    await optional("pointing the escrow at the arbiter", () =>
      dSend(existing.tesseraEscrow, tesseraEscrowAbi, "setArbiter", [arbiter]),
    );
  } else {
    console.log("   (skip arming the arbiter — pass --arm-arbiter once a panel is registered)");
  }

  // 6i-quinquies) TesseraReceiptAnchor: an agent's spending, provable to an outsider.
  const anchorRes = await adopt("TesseraReceiptAnchor", existing.tesseraReceiptAnchor, FRESH, async () => {
    console.log("→ deploying TesseraReceiptAnchor (auditable spend statements)…");
    const h = await dWallet.deployContract({
      abi: tesseraReceiptAnchorAbi,
      bytecode: tesseraReceiptAnchorBytecode,
      args: [],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   anchor", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const receiptAnchor = anchorRes.address;

  // 6j) TesseraTimelock, and the handover.
  //
  //     Every risk parameter moved the instant the deployer key signed. The
  //     timelock puts a delay and a public announcement in front of that, with
  //     freezing exempt so the emergency brake still works instantly.
  //
  //     The handover is LAST and deliberately so: everything above needs owner
  //     calls, and doing it earlier would mean queueing and waiting for each of
  //     them on a fresh deployment.
  // Freezing is the only power that skips the delay — see TesseraTimelock for
  // why. Derived from the signatures rather than pasted as hex so a change to
  // either function cannot leave a stale selector silently unlisted.
  const FREEZE_SEL = toFunctionSelector("function setFrozen(address,uint8)");
  const FREEZE_MANY_SEL = toFunctionSelector("function setFrozenMany(address[],uint8)");
  const timelockRes = await adopt("TesseraTimelock", existing.tesseraTimelock, FRESH, async () => {
    console.log("→ deploying TesseraTimelock (24h on risk changes, instant freeze)…");
    const h = await dWallet.deployContract({
      abi: tesseraTimelockAbi,
      bytecode: tesseraTimelockBytecode,
      // The guardian starts as the deployer: a veto is only useful if somebody
      // holds it, and appointing a separate one is a governance decision that
      // now has to go through the queue anyway.
      args: [deployer.address, deployer.address, 86400n, [FREEZE_SEL, FREEZE_MANY_SEL]],
      account: deployer,
      chain: arcTestnet,
    });
    const addr = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
    console.log("   timelock", addr);
    await pace();
    return addr;
  }, { custodial: true });
  const timelock = timelockRes.address;

  // Only hand the pool over once, and only when asked. An operator running this
  // against a live pool mid-configuration would otherwise find every subsequent
  // step queued behind a day.
  if (process.argv.includes("--handover")) {
    await optional("handing the pool to the timelock", async () => {
      const current = await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "owner" });
      if (String(current).toLowerCase() === timelock.toLowerCase()) {
        console.log("   pool already owned by the timelock");
        return;
      }
      await dSend(pool, tesseraPoolAbi, "transferOwnership", [timelock]);
      console.log("   pool owner → timelock (risk changes now take 24h)");
    });
  } else {
    console.log("   (skip pool handover — pass --handover to put the timelock in charge)");
  }

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
  dep.tesseraPriceGuard = priceGuard;
  dep.tesseraOracle = riskOracle;
  dep.tesseraStream = stream;
  dep.tesseraSubscription = subscription;
  dep.tesseraSpendPolicy = spendPolicy;
  dep.tesseraLpToken = lpToken;
  dep.tesseraTimelock = timelock;
  dep.tesseraRegistry = registry;
  dep.tesseraRateLimiter = rateLimiter;
  if (arbiter) dep.tesseraArbiter = arbiter;
  dep.tesseraReceiptAnchor = receiptAnchor;
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
  console.log("   guard    ", priceGuard);
  console.log("   oracle   ", riskOracle);
  console.log("   stream   ", stream);
  console.log("   subs     ", subscription);
  console.log("   policy   ", spendPolicy);
  console.log("   lpToken  ", lpToken);
  console.log("   timelock ", timelock);
  console.log("   registry ", registry);
  console.log("   limiter  ", rateLimiter);
  if (arbiter) console.log("   arbiter  ", arbiter);
  console.log("   anchor   ", receiptAnchor);
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
