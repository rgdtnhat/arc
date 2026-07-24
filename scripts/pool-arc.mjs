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

async function main() {
  console.log("deployer", deployer.address, formatUsdc(await bal(deployer.address)), "USDC");
  console.log("agent   ", agent.address, formatUsdc(await bal(agent.address)), "USDC");
  if (ONLY_CHECK) return;

  // Confirm on-chain decimals for real tokens (fall back to the config value).
  for (const r of RESERVES) {
    try { r.decimals = Number(await pub.readContract({ address: r.address, abi: metaAbi, functionName: "decimals" })); } catch {}
  }

  // 1) TesseraPool (treasury = deployer → receives the reserveFactor cut)
  console.log("→ deploying TesseraPool…");
  const hash = await dWallet.deployContract({ abi: tesseraPoolAbi, bytecode: tesseraPoolBytecode, args: [deployer.address], account: deployer, chain: arcTestnet });
  const pool = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  console.log("   pool", pool);
  await pace();

  const dSend = async (address, abi, fn, args, account = deployer, wallet = dWallet) => {
    const { request } = await pub.simulateContract({ address, abi, functionName: fn, args, account });
    const h = await wallet.writeContract(request);
    await pub.waitForTransactionReceipt({ hash: h });
    await pace();
    return h;
  };
  const aSend = async (address, abi, fn, args) => dSend(address, abi, fn, args, agent, aWallet);

  // 2) Register each reserve (all borrowable).
  for (const r of RESERVES) {
    console.log(`→ addReserve ${r.symbol} (${r.decimals}d, borrowable)…`);
    await dSend(pool, tesseraPoolAbi, "addReserve", [r.address, r.cFactor, r.lFactor, r.rf, true, r.decimals, r.price]);
  }

  // 3) Seed liquidity from the deployer's real balances (skip what it can't fund).
  for (const r of RESERVES) {
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
    console.log(`→ funding agent ${collateral} cirBTC + opening its position…`);
    await dSend(CIRBTC_ADDRESS, erc20Abi, "transfer", [agent.address, collateral]);
    await aSend(CIRBTC_ADDRESS, erc20Abi, "approve", [pool, maxUint256]);
    await aSend(pool, tesseraPoolAbi, "supply", [CIRBTC_ADDRESS, collateral]);
    const usdcLiquidity = await bal(pool, ARC_USDC_ADDRESS);
    if (usdcLiquidity >= 1_000_000n) {
      await aSend(pool, tesseraPoolAbi, "borrow", [ARC_USDC_ADDRESS, 1_000_000n]); // 1 USDC
    }
  } else {
    console.log("   (skip agent position — no cirBTC to use as collateral; supply from the dashboard once funded)");
  }

  // 5) TesseraVault over USDC: 20% liquid reserve buffer, 15% performance fee.
  console.log("→ deploying TesseraVault (USDC, 20% reserve, 15% perf fee)…");
  let vh = await dWallet.deployContract({
    abi: tesseraVaultAbi,
    bytecode: tesseraVaultBytecode,
    args: [ARC_USDC_ADDRESS, pool, deployer.address, 2000, 1500],
    account: deployer,
    chain: arcTestnet,
  });
  const vault = (await pub.waitForTransactionReceipt({ hash: vh })).contractAddress;
  console.log("   vault", vault);
  await pace();

  // 6) TesseraSwap: 0.30% fee, half of it to the app treasury. Seed inventory.
  console.log("→ deploying TesseraSwap (0.30% fee, 50% to treasury)…");
  let sh = await dWallet.deployContract({
    abi: tesseraSwapAbi,
    bytecode: tesseraSwapBytecode,
    args: [pool, deployer.address, 30, 5000],
    account: deployer,
    chain: arcTestnet,
  });
  const swap = (await pub.waitForTransactionReceipt({ hash: sh })).contractAddress;
  console.log("   swap", swap);
  await pace();
  // Seed the swap desk with a slice of each asset the deployer still holds.
  for (const r of RESERVES) {
    const held = await bal(deployer.address, r.address);
    const want = r.symbol === "cirBTC" ? 10_000n : 2_000_000n; // 0.0001 cirBTC or 2 units
    const seed = want < held ? want : held;
    if (seed > 0n) {
      await dSend(r.address, erc20Abi, "approve", [swap, maxUint256]);
      await dSend(swap, tesseraSwapAbi, "seed", [r.address, seed]);
      console.log(`   seeded swap ${seed} ${r.symbol}`);
    }
  }

  // 7) Persist to deployments/arc.json (multi-asset + vault + swap).
  const p = new URL("../deployments/arc.json", import.meta.url);
  const dep = JSON.parse(readFileSync(p, "utf8"));
  dep.tesseraPool = pool;
  dep.tesseraVault = vault;
  dep.vaultAsset = ARC_USDC_ADDRESS;
  dep.tesseraSwap = swap;
  dep.poolAssets = RESERVES.map((r) => ({ symbol: r.symbol, address: r.address, decimals: r.decimals, borrowable: true }));
  delete dep.poolCollateral; // no more mock collateral
  writeFileSync(p, JSON.stringify(dep, null, 2) + "\n");
  console.log("\n✅ Pool + Vault + Swap live on Arc:");
  console.log("   pool     ", pool);
  console.log("   vault    ", vault);
  console.log("   swap     ", swap);
  for (const r of RESERVES) console.log(`   ${r.symbol.padEnd(7)} ${r.address}`);
  console.log("   explorer ", `https://testnet.arcscan.app/address/${pool}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
