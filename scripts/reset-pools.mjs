#!/usr/bin/env node
/**
 * Reset the whole DeFi stack: fresh lending pool, vault, AMM and router, with
 * every existing position re-created in the new contracts.
 *
 * ## Why this exists
 * The contracts deployed on Arc today predate the Blend and Aqua work. The
 * lending pool has no backstop, no three-slope curve and no auctions — those
 * functions do not exist on it at all, so there is nothing to enable. Same for
 * the AMM's fee tiers and pair index. Getting the new behaviour live means new
 * contracts, and new contracts mean the positions in the old ones have to be
 * dealt with rather than abandoned.
 *
 * ## How positions move
 * They are **re-created, not transferred**. There is deliberately no admin
 * function anywhere in these contracts that moves someone else's position —
 * that primitive is a rug pull with better branding — so migration works the
 * only honest way it can: the operator pays in on each holder's behalf out of
 * their own funds, via `supplyFor` / `depositFor` / `addLiquidityFor`.
 *
 * Two consequences worth being clear about before running this:
 *
 *   1. **It costs the deployer real funds**, equal to the total being migrated.
 *      The pre-flight below refuses to start unless the balance covers it, per
 *      asset, so a run cannot strand half the holders.
 *   2. **The old contracts are untouched.** Everyone keeps their claim there
 *      too, and can withdraw from either. That is the honest outcome, and it is
 *      also why this is safe to run: nothing is taken from anyone.
 *
 * ## Resuming
 * Every completed leg is recorded in `deployments/reset-state.json` before the
 * next one starts. A run that dies halfway — a reverted call, a throttled RPC,
 * a dropped connection — is resumed by running the same command again, and
 * already-migrated holders are skipped. Paying someone twice is the failure
 * this file works hardest to avoid.
 *
 * Usage:
 *   npm run pools:reset                        # scan and report, change nothing
 *   npm run pools:reset -- --confirm           # do it
 *   npm run pools:reset -- --confirm --accept-partial
 *   npm run pools:reset -- --confirm --abandon # deploy fresh, migrate nobody
 */
import { createPublicClient, createWalletClient, getAddress, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  arcTestnet,
  pacedHttp,
  erc20Abi,
  ARC_USDC_ADDRESS,
  tesseraPoolAbi,
  tesseraPoolBytecode,
  tesseraVaultAbi,
  tesseraVaultBytecode,
  tesseraAmmAbi,
  tesseraAmmBytecode,
  tesseraRouterAbi,
  tesseraRouterBytecode,
  tesseraFeeCollectorAbi,
} from "@tessera/shared";
import { ArchiveScanner } from "../agent/src/archive-chain.ts";

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const CONFIRM = has("--confirm");
const ACCEPT_PARTIAL = has("--accept-partial");
const ABANDON = has("--abandon");
const INCLUDE_CONTRACTS = has("--include-contracts");
const AGAIN = has("--again");

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DEP_DIR = path.join(ROOT, "deployments");
const STATE_FILE = path.join(DEP_DIR, "reset-state.json");

const USD = 10n ** 8n;
const CIRBTC_ADDRESS = process.env.CIRBTC_ADDRESS ?? "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF";
const EURC_ADDRESS = process.env.EURC_ADDRESS ?? "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

/**
 * Reserve set for the new pool.
 *
 * `cFactor < liqFactor` is enforced by the contract and is the borrower's
 * buffer: borrow up to the first, get liquidated past the second. `lFactor`
 * weighs a debt in that asset against the limit.
 */
const RESERVES = [
  { symbol: "USDC", address: ARC_USDC_ADDRESS, decimals: 6, cFactor: 9000, liqFactor: 9300, lFactor: 9500, rf: 1000, price: 1n * USD, stable: true },
  { symbol: "EURC", address: EURC_ADDRESS, decimals: 6, cFactor: 8500, liqFactor: 8800, lFactor: 9000, rf: 1000, price: 108_000_000n, stable: true },
  { symbol: "cirBTC", address: CIRBTC_ADDRESS, decimals: 8, cFactor: 7000, liqFactor: 7800, lFactor: 8000, rf: 1000, price: 95_000n * USD, stable: false },
];

const FEE_TIER_STABLE = 10;
const FEE_TIER_STANDARD = 30;
/** Amplification for a pool whose two sides should trade near parity. */
const STABLE_AMP = 200;
/** A share of interest routed to the backstop, so first-loss capital is paid. */
const BACKSTOP_TAKE_BPS = 1500;
/** Both the vault and the AMM burn this many dead shares on a first deposit. */
const MINIMUM_LIQUIDITY = 1_000n;
/** Comfortably above the burn, small enough to be a rounding error. */
const PRIME_FLOOR = 20n * MINIMUM_LIQUIDITY;

// --- setup -------------------------------------------------------------------

const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key) {
  console.error("DEPLOYER_PRIVATE_KEY is required — it deploys, and it funds the migration.");
  process.exit(1);
}
const deployer = privateKeyToAccount(key);
const pub = createPublicClient({ chain: arcTestnet, transport: pacedHttp(RPC) });
const wallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: pacedHttp(RPC) });

function readDeployment() {
  for (const name of ["arc.local.json", "arc.json"]) {
    const p = path.join(DEP_DIR, name);
    try {
      return { file: p, data: JSON.parse(readFileSync(p, "utf8")) };
    } catch {
      /* next */
    }
  }
  throw new Error("No deployments/arc.json — nothing to reset.");
}

/**
 * Progress, written before each leg rather than after the run.
 *
 * The whole point is that a crashed run resumes instead of re-paying, so this
 * has to be durable at the granularity of a single `supplyFor`.
 */
function loadState() {
  if (!existsSync(STATE_FILE)) return { migrated: {}, deployed: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { migrated: {}, deployed: {} };
  }
}
const state = loadState();
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
/** A key unique to one holder's one position in one target contract. */
const legKey = (kind, target, who, asset = "") =>
  `${kind}:${String(target).toLowerCase()}:${String(who).toLowerCase()}:${String(asset).toLowerCase()}`;

const fmt = (raw, dec) => {
  const s = String(raw).padStart(dec + 1, "0");
  const i = s.slice(0, s.length - dec);
  const f = s.slice(s.length - dec).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
};

async function send(address, abi, functionName, args) {
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: deployer });
  const hash = await wallet.writeContract(request);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
}

async function deploy(label, abi, bytecode, args) {
  console.log(`→ deploying ${label}…`);
  const hash = await wallet.deployContract({ abi, bytecode, args, account: deployer, chain: arcTestnet });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${label} deployment reverted`);
  console.log(`   ${label} ${getAddress(r.contractAddress)}`);
  return getAddress(r.contractAddress);
}

/** Approve `spender` for everything, once per (token, spender). */
const approved = new Set();
async function ensureApproval(token, spender) {
  const k = `${token.toLowerCase()}:${spender.toLowerCase()}`;
  if (approved.has(k)) return;
  const current = await pub.readContract({
    address: token, abi: erc20Abi, functionName: "allowance", args: [deployer.address, spender],
  });
  if (current < maxUint256 / 2n) await send(token, erc20Abi, "approve", [spender, maxUint256]);
  approved.add(k);
}

// --- 1. scan what exists -----------------------------------------------------

const { file, data: dep } = readDeployment();
const oldPool = dep.tesseraPool;
const oldVault = dep.tesseraVault;
const oldAmm = dep.tesseraAmm;
const feeCollector = dep.tesseraFeeCollector;
const ammFeeCollector = dep.tesseraAmmFeeCollector;

/**
 * Refuse to reset into the contracts a previous run already produced.
 *
 * The trap is subtle and this script walked straight into it during testing. A
 * completed run rewrites `arc.local.json` with the new addresses — so on the
 * next run, the "old" contracts it reads from the record *are* the new ones. It
 * would then scan them, find the holders it just created, and re-create those
 * positions in the very same contracts, crediting everyone a second time.
 *
 * The per-leg state file caught the holders it had already paid, which is why
 * the damage in testing was limited to the deployer's own priming deposit. But
 * that is a second line of defence doing a first line's job: delete the state
 * file, or add a holder between runs, and the double-credit lands on a user.
 *
 * So a finished reset is a finished reset. Running it again against the same
 * record is a no-op, and doing it deliberately means pointing the record back at
 * the contracts to migrate *from*.
 */
const alreadyReset =
  state.deployed.pool &&
  String(state.deployed.pool).toLowerCase() === String(dep.tesseraPool ?? "").toLowerCase();
if (alreadyReset && !AGAIN) {
  console.log(
    `\nThis record already points at the contracts a previous reset produced:\n` +
      `   pool   ${dep.tesseraPool}\n   vault  ${dep.tesseraVault}\n   amm    ${dep.tesseraAmm}\n` +
      `   router ${dep.tesseraRouter}\n\n` +
      `Re-running would scan those, find the positions it just created, and credit them again.\n` +
      `Nothing was changed.\n\n` +
      `If the earlier run stopped part-way, run it again — it resumes from deployments/reset-state.json,\n` +
      `and the addresses above are reused rather than redeployed.\n` +
      `To reset a *different* deployment, point deployments/arc.local.json at it first.\n` +
      `To override this check anyway: --again (it will not protect you).`,
  );
  process.exit(0);
}

console.log(`\ndeployer      ${deployer.address}`);
console.log(`reading       ${path.relative(ROOT, file)}`);
console.log(`old pool      ${oldPool ?? "(none)"}`);
console.log(`old vault     ${oldVault ?? "(none)"}`);
console.log(`old amm       ${oldAmm ?? "(none)"}`);

const scanner = new ArchiveScanner(arcTestnet, RPC);

/**
 * Is this holder a contract?
 *
 * It matters more than it looks. The vault supplies into the pool, so the vault
 * *is* one of the pool's suppliers — and its position there is not its own, it
 * is the derived shadow of its depositors, whom this script is already
 * re-creating via `depositFor`. Migrating both pays for the same money twice.
 *
 * Worse, it pays it to an address that cannot use it: the old vault has no
 * function that withdraws from a pool it was never pointed at, so the position
 * would sit in the new pool credited to a contract with no idea it holds one.
 * The same reasoning covers the fee collector, which supplies but never
 * withdraws.
 *
 * So contract holders are skipped and named, rather than guessed at. Their claim
 * on the old contracts is untouched; what a given contract's accounting needs is
 * a question only its own code can answer.
 */
const isContractCache = new Map();
async function isContract(address) {
  const k = address.toLowerCase();
  if (isContractCache.has(k)) return isContractCache.get(k);
  const code = await pub.getCode({ address }).catch(() => "0x");
  const v = Boolean(code && code !== "0x");
  isContractCache.set(k, v);
  return v;
}

async function splitHolders(holders) {
  const people = [];
  const contracts = [];
  for (const h of holders) ((await isContract(h.address)) ? contracts : people).push(h);
  return INCLUDE_CONTRACTS ? { people: [...people, ...contracts], contracts: [] } : { people, contracts };
}

const assetMeta = RESERVES.map((r) => ({ address: r.address, symbol: r.symbol, decimals: r.decimals }));

/**
 * A venue can never be migrated into itself.
 *
 * The guard above should make this unreachable. It is here anyway because the
 * failure it prevents — reading a holder's balance and then crediting them that
 * much again in the same contract — is silent, doubles somebody's position, and
 * cannot be undone.
 */
const sameAddress = (a, b) => Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();

console.log("\nscanning the live contracts for positions (this walks their history)…");

const scans = { pool: null, vault: null, amm: [] };
let anyPartial = false;
const skippedContracts = [];

const report = (label, kind, total, split, partial) => {
  const extra = split.contracts.length ? `  (${split.contracts.length} contract holder(s) skipped)` : "";
  console.log(`  ${label} ${split.people.length}/${total} ${kind}${extra}${partial ? "  ⚠ PARTIAL SCAN" : ""}`);
  for (const c of split.contracts) skippedContracts.push({ where: label.trim(), address: c.address });
};

if (oldPool) {
  const raw = await scanner.scanPool(oldPool, assetMeta);
  anyPartial ||= raw.partial;
  const split = await splitHolders(raw.holders);
  report("pool  ", "supplier(s)", raw.holders.length, split, raw.partial);
  scans.pool = { ...raw, holders: split.people };
}
if (oldVault) {
  const vaultAsset =
    assetMeta.find((a) => a.address.toLowerCase() === String(dep.vaultAsset ?? ARC_USDC_ADDRESS).toLowerCase()) ??
    assetMeta[0];
  const raw = await scanner.scanVault(oldVault, vaultAsset);
  anyPartial ||= raw.partial;
  const split = await splitHolders(raw.holders);
  report("vault ", "depositor(s)", raw.holders.length, split, raw.partial);
  scans.vault = { ...raw, holders: split.people };
}
if (oldAmm) {
  const count = await pub.readContract({ address: oldAmm, abi: tesseraAmmAbi, functionName: "poolCount" }).catch(() => 0n);
  for (let i = 0n; i < count; i++) {
    const raw = await scanner.scanAmm(oldAmm, Number(i));
    anyPartial ||= raw.partial;
    const split = await splitHolders(raw.holders);
    report(`amm #${i}`, "provider(s)", raw.holders.length, split, raw.partial);
    scans.amm.push({ poolId: Number(i), ...raw, holders: split.people });
  }
}

if (skippedContracts.length) {
  console.log("\ncontract holders skipped — their positions are derived, not personal:");
  for (const c of skippedContracts) {
    const l = (a) => String(a ?? "").toLowerCase();
    const known =
      l(c.address) === l(oldVault) ? " (the old vault — its depositors are migrated instead)"
      : l(c.address) === l(feeCollector) ? " (the fee collector — it supplies but never withdraws)"
      : l(c.address) === l(ammFeeCollector) ? " (the AMM fee collector)"
      : "";
    console.log(`  ${c.where.padEnd(7)} ${c.address}${known}`);
  }
  console.log("  Pass --include-contracts to migrate them anyway, if you know their accounting needs it.");
}

// --- 2. price the migration --------------------------------------------------

/** Everything the deployer would have to pay in, per asset. */
const owed = new Map();
const add = (asset, amount) => owed.set(asset.toLowerCase(), (owed.get(asset.toLowerCase()) ?? 0n) + amount);

if (!ABANDON) {
  const all = [...(scans.pool?.holders ?? []), ...(scans.vault?.holders ?? []), ...scans.amm.flatMap((p) => p.holders)];
  for (const h of all) {
    for (const [asset, raw] of Object.entries(h.balances)) if (BigInt(raw) > 0n) add(asset, BigInt(raw));
  }
}

console.log("\nwhat the migration would cost the deployer:");
let short = false;
if (owed.size === 0) {
  console.log("  nothing — no positions to re-create");
} else {
  for (const [asset, amount] of owed) {
    const meta = assetMeta.find((a) => a.address.toLowerCase() === asset) ?? { symbol: asset.slice(0, 10), decimals: 6 };
    const held = await pub
      .readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] })
      .catch(() => 0n);
    const ok = held >= amount;
    if (!ok) short = true;
    console.log(
      `  ${meta.symbol.padEnd(7)} need ${fmt(amount, meta.decimals).padStart(16)}   have ${fmt(held, meta.decimals).padStart(16)}   ${ok ? "ok" : "SHORT"}`,
    );
  }
}

if (anyPartial) {
  console.log(
    "\n⚠ At least one scan was PARTIAL: the log window ran out before the contract's full history was read.\n" +
      "  A partial scan under-reports *who*, never *how much* — so some holders would silently be left behind.\n" +
      "  Re-run when the RPC is less throttled, or pass --accept-partial to migrate whoever was found.",
  );
}

if (!CONFIRM) {
  console.log(
    "\nNothing was changed. This was a dry run.\n" +
      "  To go ahead:            npm run pools:reset -- --confirm\n" +
      "  To skip the migration:  npm run pools:reset -- --confirm --abandon\n\n" +
      "The old contracts are never modified by this script. Whatever it re-creates is *additional* —\n" +
      "every holder keeps their claim on the old contracts and can still withdraw there.",
  );
  process.exit(0);
}

if (short) {
  console.error(
    "\n❌ Stopping: the deployer cannot cover the migration.\n" +
      "   Top up the shortfall above (faucet.circle.com for USDC/EURC on Arc testnet) and re-run.\n" +
      "   Starting anyway would deploy new contracts and then strand the holders it ran out of funds for.",
  );
  process.exit(1);
}
if (anyPartial && !ACCEPT_PARTIAL && !ABANDON) {
  console.error("\n❌ Stopping on a partial scan. Re-run, or pass --accept-partial to proceed knowingly.");
  process.exit(1);
}

// --- 3. deploy ---------------------------------------------------------------

const treasury = feeCollector ?? deployer.address;

async function once(name, fn) {
  if (state.deployed[name]) {
    console.log(`   ${name} ${state.deployed[name]} (already deployed on an earlier run)`);
    return state.deployed[name];
  }
  const addr = await fn();
  state.deployed[name] = addr;
  saveState();
  return addr;
}

console.log("\ndeploying the replacement stack…");
const pool = await once("pool", () => deploy("TesseraPool", tesseraPoolAbi, tesseraPoolBytecode, [treasury]));
const vault = await once("vault", () =>
  deploy("TesseraVault", tesseraVaultAbi, tesseraVaultBytecode, [ARC_USDC_ADDRESS, pool, treasury, 8000, 1500]),
);
const amm = await once("amm", () =>
  deploy("TesseraAMM", tesseraAmmAbi, tesseraAmmBytecode, [ammFeeCollector ?? treasury]),
);
const router = await once("router", () =>
  deploy("TesseraRouter", tesseraRouterAbi, tesseraRouterBytecode, [amm, [ARC_USDC_ADDRESS]]),
);

// --- 4. configure ------------------------------------------------------------

console.log("\nregistering reserves…");
for (const r of RESERVES) {
  const already = await pub
    .readContract({ address: pool, abi: tesseraPoolAbi, functionName: "reserves", args: [r.address] })
    .then((x) => Boolean(x?.[0]))
    .catch(() => false);
  if (already) {
    console.log(`   ${r.symbol} already registered`);
    continue;
  }
  try {
    await send(pool, tesseraPoolAbi, "addReserve", [
      r.address, r.cFactor, r.liqFactor, r.lFactor, r.rf, true, r.decimals, r.price,
    ]);
    console.log(`   ${r.symbol.padEnd(7)} cFactor ${r.cFactor / 100}%  liq ${r.liqFactor / 100}%  lFactor ${r.lFactor / 100}%`);
  } catch (e) {
    console.warn(`   ⚠ ${r.symbol} failed: ${String(e.shortMessage ?? e.message).slice(0, 100)}`);
  }
}

// Pay the backstop out of interest, so first-loss capital has a reason to exist.
try {
  await send(pool, tesseraPoolAbi, "setBackstopTakeRate", [BACKSTOP_TAKE_BPS]);
  console.log(`   backstop take rate ${BACKSTOP_TAKE_BPS / 100}% of borrower interest`);
} catch (e) {
  console.warn(`   ⚠ backstop take rate: ${String(e.shortMessage ?? e.message).slice(0, 90)}`);
}

console.log("\ncreating AMM pools…");
const existingPools = Number(
  await pub.readContract({ address: amm, abi: tesseraAmmAbi, functionName: "poolCount" }).catch(() => 0n),
);
if (existingPools > 0) {
  console.log(`   ${existingPools} pool(s) already exist on this AMM — not creating duplicates`);
} else {
  for (const r of RESERVES.filter((x) => x.address.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase())) {
    // A stable pair takes the cheap tier; a volatile one pays the standard tier
    // because its volatility has to pay for itself.
    const tier = r.stable ? FEE_TIER_STABLE : FEE_TIER_STANDARD;
    try {
      await send(amm, tesseraAmmAbi, "createPool", [[ARC_USDC_ADDRESS, r.address], tier, 5000, `USDC / ${r.symbol}`]);
      console.log(`   USDC / ${r.symbol} at ${tier / 100}%`);
    } catch (e) {
      console.warn(`   ⚠ USDC / ${r.symbol}: ${String(e.shortMessage ?? e.message).slice(0, 90)}`);
    }
  }
  // Amplify the pairs that should trade near parity. Constant product prices a
  // USDC/EURC pool as if the two were unrelated, which is simply the wrong shape.
  const count = Number(await pub.readContract({ address: amm, abi: tesseraAmmAbi, functionName: "poolCount" }).catch(() => 0n));
  for (let i = 0; i < count; i++) {
    const info = await pub.readContract({ address: amm, abi: tesseraAmmAbi, functionName: "poolInfo", args: [BigInt(i)] }).catch(() => null);
    if (!info) continue;
    const stable = info[0].every((a) => RESERVES.find((r) => r.address.toLowerCase() === a.toLowerCase())?.stable);
    if (info[0].length === 2 && stable) {
      await send(amm, tesseraAmmAbi, "setAmp", [BigInt(i), STABLE_AMP]).then(
        () => console.log(`   pool #${i} amplified (A=${STABLE_AMP}) — near-parity curve`),
        (e) => console.warn(`   ⚠ amp on #${i}: ${String(e.shortMessage ?? e.message).slice(0, 80)}`),
      );
    }
  }
}

// --- 5. migrate --------------------------------------------------------------

if (ABANDON) {
  console.log("\n--abandon: no positions were re-created. Holders keep their claim on the old contracts.");
} else {
  /**
   * Take the first deposit in each fresh venue, so the dead-share burn lands on
   * the deployer rather than on a user.
   *
   * `TesseraVault` and `TesseraAMM` both burn `MINIMUM_LIQUIDITY` shares on the
   * very first deposit — the standard defence against first-depositor share
   * inflation, and correct. But during a migration the "first depositor" is
   * whichever holder happens to be re-created first, and they silently end up
   * with less than they had. Measured on a test migration it was exactly 1000
   * raw units each: economically nothing, but it is somebody else's money being
   * rounded away by an implementation detail.
   *
   * For the AMM this has a second job. The first deposit also *sets the pool's
   * ratio*, so priming at a ratio taken from the old pool is what stops the
   * migrated providers from being credited against a price nobody chose.
   */
  console.log("\npriming the fresh venues so their dead-share burn lands here, not on a user…");

  if ((scans.vault?.holders.length ?? 0) > 0) {
    const shares = await pub
      .readContract({ address: vault, abi: tesseraVaultAbi, functionName: "totalShares" })
      .catch(() => 0n);
    if (shares === 0n) {
      await ensureApproval(ARC_USDC_ADDRESS, vault);
      await send(vault, tesseraVaultAbi, "deposit", [PRIME_FLOOR]);
      console.log(`   vault primed with ${fmt(PRIME_FLOOR, 6)} USDC`);
    }
  }

  for (const p of scans.amm) {
    if (!p.holders.length) continue;
    const info = await pub
      .readContract({ address: amm, abi: tesseraAmmAbi, functionName: "poolInfo", args: [BigInt(p.poolId)] })
      .catch(() => null);
    if (!info || info[4] > 0n) continue; // no such pool, or already primed
    const oldInfo = await pub
      .readContract({ address: oldAmm, abi: tesseraAmmAbi, functionName: "poolInfo", args: [BigInt(p.poolId)] })
      .catch(() => null);
    if (!oldInfo) continue;
    const order = info[0].map((a) => a.toLowerCase());
    const oldByAsset = new Map(oldInfo[0].map((a, i) => [a.toLowerCase(), oldInfo[1][i] ?? 0n]));
    const ratio = order.map((a) => oldByAsset.get(a) ?? 0n);
    if (ratio.some((x) => x === 0n)) continue;
    // Scale the old ratio down until the smallest side is just over the burn.
    const smallest = ratio.reduce((m, x) => (x < m ? x : m));
    const amounts = ratio.map((x) => (x * PRIME_FLOOR) / smallest);
    for (const a of order) await ensureApproval(a, amm);
    try {
      await send(amm, tesseraAmmAbi, "addLiquidity", [BigInt(p.poolId), amounts, 0n]);
      const shown = amounts.map((x, i) => fmt(x, p.assets[i]?.decimals ?? 6)).join(" / ");
      console.log(`   pool #${p.poolId} primed at the old ratio (${shown})`);
    } catch (e) {
      console.warn(`   ⚠ could not prime pool #${p.poolId}: ${String(e.shortMessage ?? e.message).slice(0, 80)}`);
    }
  }

  console.log("\nre-creating positions (paid for by the deployer)…");
  let moved = 0;
  let skipped = 0;

  if (sameAddress(oldPool, pool)) throw new Error("refusing to migrate the lending pool into itself");
  if (sameAddress(oldVault, vault)) throw new Error("refusing to migrate the vault into itself");
  if (sameAddress(oldAmm, amm)) throw new Error("refusing to migrate the AMM into itself");

  for (const h of scans.pool?.holders ?? []) {
    for (const [asset, raw] of Object.entries(h.balances)) {
      const amount = BigInt(raw);
      if (amount === 0n) continue;
      const k = legKey("pool", pool, h.address, asset);
      if (state.migrated[k]) { skipped++; continue; }
      const meta = assetMeta.find((a) => a.address.toLowerCase() === asset);
      if (!meta) continue;
      await ensureApproval(meta.address, pool);
      await send(pool, tesseraPoolAbi, "supplyFor", [meta.address, h.address, amount]);
      state.migrated[k] = true;
      saveState();
      moved++;
      console.log(`   pool  ${h.address.slice(0, 10)}…  ${fmt(amount, meta.decimals)} ${meta.symbol}`);
    }
  }

  for (const h of scans.vault?.holders ?? []) {
    const asset = Object.keys(h.balances)[0];
    const amount = BigInt(h.balances[asset] ?? "0");
    if (amount === 0n) continue;
    const k = legKey("vault", vault, h.address, asset);
    if (state.migrated[k]) { skipped++; continue; }
    const meta = assetMeta.find((a) => a.address.toLowerCase() === asset);
    if (!meta) continue;
    await ensureApproval(meta.address, vault);
    await send(vault, tesseraVaultAbi, "depositFor", [h.address, amount]);
    state.migrated[k] = true;
    saveState();
    moved++;
    console.log(`   vault ${h.address.slice(0, 10)}…  ${fmt(amount, meta.decimals)} ${meta.symbol}`);
  }

  for (const p of scans.amm) {
    if (!p.holders.length) continue;
    // Match the old pool's asset order to the new pool's: `addLiquidityFor`
    // takes amounts positionally, so a mismatched order would credit the wrong
    // side and quietly hand someone a different position from the one they had.
    const newInfo = await pub
      .readContract({ address: amm, abi: tesseraAmmAbi, functionName: "poolInfo", args: [BigInt(p.poolId)] })
      .catch(() => null);
    if (!newInfo) {
      console.warn(`   ⚠ no pool #${p.poolId} on the new AMM — skipping its ${p.holders.length} provider(s)`);
      continue;
    }
    const order = newInfo[0].map((a) => a.toLowerCase());
    const oldOrder = p.assets.map((a) => a.address.toLowerCase());
    if (order.length !== oldOrder.length || !order.every((a) => oldOrder.includes(a))) {
      console.warn(`   ⚠ pool #${p.poolId} holds different assets on the new AMM — skipping, migrate it by hand`);
      continue;
    }
    const decOf = (a) => p.assets.find((x) => x.address.toLowerCase() === a)?.decimals ?? 6;
    for (const h of p.holders) {
      const k = legKey("amm", `${amm}#${p.poolId}`, h.address);
      if (state.migrated[k]) { skipped++; continue; }
      const amounts = order.map((a) => BigInt(h.balances[a] ?? "0"));
      if (amounts.some((x) => x === 0n)) {
        // A proportional deposit needs every side. A provider whose slice rounds
        // to zero on one asset cannot be re-created proportionally.
        console.warn(`   ⚠ ${h.address.slice(0, 10)}… has a zero side in pool #${p.poolId} — skipped`);
        continue;
      }
      for (const a of order) await ensureApproval(a, amm);
      await send(amm, tesseraAmmAbi, "addLiquidityFor", [BigInt(p.poolId), h.address, amounts, 0n]);
      state.migrated[k] = true;
      saveState();
      moved++;
      console.log(`   amm#${p.poolId} ${h.address.slice(0, 10)}…  ${amounts.map((x, i) => fmt(x, decOf(order[i]))).join(" / ")}`);
    }
  }
  console.log(`\n   ${moved} position(s) re-created${skipped ? `, ${skipped} already done on an earlier run` : ""}`);
}

// --- 6. repoint the fee collectors ------------------------------------------

console.log("\nrepointing the fee collectors…");
for (const [label, collector] of [["app", feeCollector], ["amm", ammFeeCollector]]) {
  if (!collector) continue;
  const owner = await pub
    .readContract({ address: collector, abi: tesseraFeeCollectorAbi, functionName: "owner" })
    .catch(() => null);
  if (!owner || owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(`   ⚠ ${label} collector ${collector} is owned by ${owner ?? "?"} — repoint it by hand`);
    continue;
  }
  await send(collector, tesseraFeeCollectorAbi, "setSinks", [dep.agent ?? deployer.address, pool, vault, amm]).then(
    () => console.log(`   ${label} collector sinks → new pool / vault / amm`),
    (e) => console.warn(`   ⚠ ${label} setSinks: ${String(e.shortMessage ?? e.message).slice(0, 80)}`),
  );
  await send(collector, tesseraFeeCollectorAbi, "setAmm", [amm, 0n]).then(
    () => console.log(`   ${label} collector liquidity leg → AMM pool 0`),
    (e) => console.warn(`   ⚠ ${label} setAmm: ${String(e.shortMessage ?? e.message).slice(0, 80)}`),
  );
}

// --- 7. record ---------------------------------------------------------------

const next = {
  ...dep,
  tesseraPool: pool,
  tesseraVault: vault,
  vaultAsset: ARC_USDC_ADDRESS,
  tesseraAmm: amm,
  tesseraRouter: router,
  poolAssets: RESERVES.map((r) => ({ symbol: r.symbol, address: r.address, decimals: r.decimals, borrowable: true })),
  // Keep a breadcrumb to the contracts this replaced. Holders still have a claim
  // there, and a record with no pointer to it is how that claim gets lost.
  replaced: {
    at: new Date().toISOString(),
    tesseraPool: oldPool ?? null,
    tesseraVault: oldVault ?? null,
    tesseraAmm: oldAmm ?? null,
    tesseraSwap: dep.tesseraSwap ?? null,
  },
};
delete next.tesseraSwap;
delete next.explorer;
writeFileSync(path.join(DEP_DIR, "arc.local.json"), JSON.stringify(next, null, 2) + "\n");
console.log(`\nrecorded in ${path.relative(ROOT, path.join(DEP_DIR, "arc.local.json"))}`);

console.log(
  `\n✅ Reset complete.\n` +
    `   pool     ${pool}\n` +
    `   vault    ${vault}\n` +
    `   amm      ${amm}\n` +
    `   router   ${router}\n\n` +
    `Next:\n` +
    `  1. Restart the app so it picks these up:  docker compose restart tessera\n` +
    `  2. Seed the AMM pools with liquidity — a pool with an empty side quotes no route.\n` +
    `  3. Optionally put up backstop cover on the Lending tab, so first-loss capital exists.\n\n` +
    `The old contracts still hold everyone's original position, including yours. Nothing was taken\n` +
    `from them and nothing needs to be — this is additive. Withdraw from them at your leisure, or\n` +
    `leave them; the app no longer points at them either way.\n\n` +
    `deployments/reset-state.json records what was migrated. Keep it until you are satisfied the\n` +
    `new contracts look right: deleting it and re-running would pay every holder a second time.\n`,
);
