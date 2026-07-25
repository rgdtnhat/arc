#!/usr/bin/env node
/**
 * One-command Arc testnet bootstrap:
 *
 *   npx tsx scripts/arc-bootstrap.mjs
 *
 * 1. Generates deployer/agent/provider keys into .env (gitignored) if missing.
 * 2. Prints the deployer address and waits for you to fund it at
 *    https://faucet.circle.com (select Arc Testnet).
 * 3. Deploys TesseraEscrow + TesseraTab bound to Arc's native USDC.
 * 4. Funds the agent and provider wallets from the deployer, bonds the
 *    provider's stake, and writes addresses to .env + deployments/arc.json.
 *
 * Afterwards:
 *   node --env-file=.env --import tsx providers/src/server.ts   # providers
 *   node --env-file=.env --import tsx agent/src/run-arc.ts      # the agent
 *
 * Overrides (mainly for testing the script itself against a local chain):
 *   ARC_RPC_URL, ARC_USDC_ADDRESS, ARC_CHAIN_ID, MIN_FUNDING_USDC
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  parseUnits,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  tesseraEscrowAbi,
  tesseraEscrowBytecode,
  tesseraTabAbi,
  tesseraTabBytecode,
  erc20Abi,
  pacedHttp,
} from "../shared/src/index.ts";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const envPath = path.join(root, ".env");

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);
const USDC = (process.env.ARC_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000");
const MIN_FUNDING = parseUnits(process.env.MIN_FUNDING_USDC ?? "5", 6);

const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 5042002 ? "Arc Testnet" : `chain-${CHAIN_ID}`,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: pacedHttp(RPC) });

// --- .env helpers ------------------------------------------------------------
function readEnv() {
  const out = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  }
  return out;
}
function writeEnv(vars) {
  const existing = readEnv();
  const merged = { ...existing, ...vars };
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(envPath, body + "\n");
}

const fmt = (v) => formatUnits(v, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReceipt(hash) {
  return pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
}

async function usdcBalance(addr) {
  return pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
}

async function main() {
  console.log(`\n🎟  Tessera Arc bootstrap — RPC ${RPC} (chainId ${CHAIN_ID})\n`);
  const liveChainId = await pub.getChainId();
  if (liveChainId !== CHAIN_ID) {
    throw new Error(`RPC reports chainId ${liveChainId}, expected ${CHAIN_ID}`);
  }

  // 1) Keys ---------------------------------------------------------------
  const env = readEnv();
  const keys = {
    DEPLOYER_PRIVATE_KEY: env.DEPLOYER_PRIVATE_KEY || generatePrivateKey(),
    AGENT_PRIVATE_KEY: env.AGENT_PRIVATE_KEY || generatePrivateKey(),
    PROVIDER_PRIVATE_KEY: env.PROVIDER_PRIVATE_KEY || generatePrivateKey(),
  };
  writeEnv({ ...keys, ARC_RPC_URL: RPC, ARC_USDC_ADDRESS: USDC });

  const deployer = privateKeyToAccount(keys.DEPLOYER_PRIVATE_KEY);
  const agent = privateKeyToAccount(keys.AGENT_PRIVATE_KEY);
  const provider = privateKeyToAccount(keys.PROVIDER_PRIVATE_KEY);
  const wallet = createWalletClient({ account: deployer, chain, transport: pacedHttp(RPC) });

  console.log(`deployer: ${deployer.address}`);
  console.log(`agent:    ${agent.address}`);
  console.log(`provider: ${provider.address}`);

  // 2) Funding ------------------------------------------------------------
  let balance = await usdcBalance(deployer.address);
  if (balance < MIN_FUNDING) {
    console.log(`\n💧 Fund the deployer with testnet USDC (need ≥ ${fmt(MIN_FUNDING)}):`);
    console.log(`   https://faucet.circle.com  → network: Arc Testnet`);
    console.log(`   address: ${deployer.address}\n`);
    process.stdout.write("   waiting for funds ");
    while (balance < MIN_FUNDING) {
      await sleep(6000);
      process.stdout.write(".");
      balance = await usdcBalance(deployer.address);
    }
    console.log("");
  }
  console.log(`✅ deployer balance: ${fmt(balance)} USDC`);

  // 3) Deploy ---------------------------------------------------------------
  const existingEscrow = env.TESSERA_ESCROW_ADDRESS;
  let escrowAddress = existingEscrow;
  let tabAddress = env.TESSERA_TAB_ADDRESS;
  if (!escrowAddress) {
    console.log("\n📦 Deploying TesseraEscrow…");
    const h1 = await wallet.deployContract({ abi: tesseraEscrowAbi, bytecode: tesseraEscrowBytecode, args: [USDC] });
    escrowAddress = (await waitReceipt(h1)).contractAddress;
    console.log(`   TesseraEscrow: ${escrowAddress}`);

    console.log("📦 Deploying TesseraTab…");
    const h2 = await wallet.deployContract({ abi: tesseraTabAbi, bytecode: tesseraTabBytecode, args: [USDC] });
    tabAddress = (await waitReceipt(h2)).contractAddress;
    console.log(`   TesseraTab:    ${tabAddress}`);
  } else {
    console.log(`\n📦 Reusing deployed contracts from .env (escrow ${escrowAddress})`);
  }

  // 4) Disperse + stake -----------------------------------------------------
  const agentTarget = parseUnits("2", 6);
  const providerTarget = parseUnits("1", 6);
  if ((await usdcBalance(agent.address)) < agentTarget) {
    console.log(`\n💸 Funding agent with ${fmt(agentTarget)} USDC…`);
    await waitReceipt(
      await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [agent.address, agentTarget] })
    );
  }
  if ((await usdcBalance(provider.address)) < providerTarget) {
    console.log(`💸 Funding provider with ${fmt(providerTarget)} USDC…`);
    await waitReceipt(
      await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [provider.address, providerTarget] })
    );
  }

  const stakeTarget = parseUnits("0.05", 6);
  const staked = await pub.readContract({ address: escrowAddress, abi: tesseraEscrowAbi, functionName: "stakeOf", args: [provider.address] });
  if (staked < stakeTarget) {
    console.log(`🔒 Provider bonding ${fmt(stakeTarget)} USDC stake…`);
    const pw = createWalletClient({ account: provider, chain, transport: pacedHttp(RPC) });
    await waitReceipt(
      await pw.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [escrowAddress, stakeTarget] })
    );
    await waitReceipt(
      await pw.writeContract({ address: escrowAddress, abi: tesseraEscrowAbi, functionName: "stake", args: [stakeTarget] })
    );
  }

  // 5) Persist ----------------------------------------------------------------
  writeEnv({
    TESSERA_ESCROW_ADDRESS: escrowAddress,
    TESSERA_TAB_ADDRESS: tabAddress,
    PROVIDERS_URL: "http://127.0.0.1:8788",
  });
  const depDir = path.join(root, "deployments");
  fs.mkdirSync(depDir, { recursive: true });
  const depBody = JSON.stringify(
    {
      chainId: CHAIN_ID,
      rpc: RPC,
      usdc: USDC,
      tesseraEscrow: escrowAddress,
      tesseraTab: tabAddress,
      agent: agent.address,
      provider: provider.address,
      deployedAt: new Date().toISOString(),
    },
    null,
    2
  );
  fs.writeFileSync(path.join(depDir, "arc.json"), depBody);
  // Gitignored override the app prefers — survives `git reset --hard`.
  fs.writeFileSync(path.join(depDir, "arc.local.json"), depBody);

  const explorer = CHAIN_ID === 5042002 ? "https://testnet.arcscan.app/address/" : "";
  console.log(`\n✅ Bootstrap complete. Addresses saved to .env and deployments/arc.json`);
  if (explorer) {
    console.log(`   escrow: ${explorer}${escrowAddress}`);
    console.log(`   tab:    ${explorer}${tabAddress}`);
  }
  console.log(`\nNext:`);
  console.log(`   node --env-file=.env --import tsx providers/src/server.ts   # terminal 1`);
  console.log(`   node --env-file=.env --import tsx agent/src/run-arc.ts      # terminal 2\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
