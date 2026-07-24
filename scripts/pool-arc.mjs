// Deploy TesseraPool to Arc testnet: USDC (borrowable) + a mock wBTC (collateral)
// reserve, seed USDC liquidity, and open the agent's initial position.
// Reads keys from .env (DEPLOYER_PRIVATE_KEY, AGENT_PRIVATE_KEY).
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet,
  ARC_USDC_ADDRESS,
  erc20Abi,
  tesseraPoolAbi,
  tesseraPoolBytecode,
  mockTokenAbi,
  mockTokenBytecode,
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
const bal = async (who) => (await pub.readContract({ address: ARC_USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [who] }));

const ONLY_CHECK = process.argv.includes("--check");

async function main() {
  console.log("deployer", deployer.address, formatUsdc(await bal(deployer.address)), "USDC");
  console.log("agent   ", agent.address, formatUsdc(await bal(agent.address)), "USDC");
  if (ONLY_CHECK) return;

  // 1) MockToken wBTC (8 decimals)
  console.log("→ deploying MockToken wBTC…");
  let hash = await dWallet.deployContract({ abi: mockTokenAbi, bytecode: mockTokenBytecode, args: ["Mock BTC", "wBTC", 8], account: deployer, chain: arcTestnet });
  const wbtc = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  console.log("   wBTC", wbtc);
  await pace();

  // 2) TesseraPool (treasury = deployer)
  console.log("→ deploying TesseraPool…");
  hash = await dWallet.deployContract({ abi: tesseraPoolAbi, bytecode: tesseraPoolBytecode, args: [deployer.address], account: deployer, chain: arcTestnet });
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

  // 3) reserves
  console.log("→ addReserve USDC…");
  await dSend(pool, tesseraPoolAbi, "addReserve", [ARC_USDC_ADDRESS, 9000, 9500, 1000, true, 6, USD]);
  console.log("→ addReserve wBTC…");
  await dSend(pool, tesseraPoolAbi, "addReserve", [wbtc, 7000, 8000, 1000, false, 8, 30000n * USD]);

  // 4) seed USDC liquidity from the deployer
  const seed = 5_000_000n; // 5 USDC
  console.log("→ seeding 5 USDC liquidity…");
  await dSend(ARC_USDC_ADDRESS, erc20Abi, "approve", [pool, maxUint256]);
  await dSend(pool, tesseraPoolAbi, "supply", [ARC_USDC_ADDRESS, seed]);

  // 5) agent position: mint wBTC collateral, supply it, borrow 1 USDC
  console.log("→ minting 0.5 wBTC to the agent + opening its position…");
  await dSend(wbtc, mockTokenAbi, "mint", [agent.address, 50_000_000n]); // 0.5 wBTC
  const aSend = async (address, abi, fn, args) => {
    const { request } = await pub.simulateContract({ address, abi, functionName: fn, args, account: agent });
    const h = await aWallet.writeContract(request);
    await pub.waitForTransactionReceipt({ hash: h });
    await pace();
    return h;
  };
  await aSend(wbtc, mockTokenAbi, "approve", [pool, maxUint256]);
  await aSend(pool, tesseraPoolAbi, "supply", [wbtc, 50_000_000n]);
  await aSend(pool, tesseraPoolAbi, "borrow", [ARC_USDC_ADDRESS, 1_000_000n]); // 1 USDC credit line

  // 6) persist to deployments/arc.json
  const p = new URL("../deployments/arc.json", import.meta.url);
  const dep = JSON.parse(readFileSync(p, "utf8"));
  dep.tesseraPool = pool;
  dep.poolCollateral = wbtc;
  writeFileSync(p, JSON.stringify(dep, null, 2) + "\n");
  console.log("\n✅ Pool live on Arc:");
  console.log("   pool     ", pool);
  console.log("   wBTC     ", wbtc);
  console.log("   explorer ", `https://testnet.arcscan.app/address/${pool}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
