import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  tesseraEscrowAbi,
  tesseraEscrowBytecode,
  tesseraTabAbi,
  tesseraTabBytecode,
  mockUsdcAbi,
  mockUsdcBytecode,
  usdc,
} from "@tessera/shared";

/**
 * Well-known Hardhat dev accounts (mnemonic "test test ... junk"). These keys
 * are PUBLIC and for LOCAL TESTING ONLY — never use them on a real network.
 */
export const DEV_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  agent: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  weather: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  fx: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  news: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  ticker: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  alpha: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
} as const satisfies Record<string, Hex>;

export const localChain = defineChain({
  id: 31337,
  name: "Hardhat Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

const contractsDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../contracts");

/** Spawn `hardhat node` and resolve once its RPC answers (reuse if already up). */
export async function startLocalNode(): Promise<ChildProcess | null> {
  const probe = createPublicClient({ chain: localChain, transport: http() });
  try {
    await probe.getChainId();
    return null; // a node is already listening; reuse it
  } catch {
    // fall through and start one
  }
  const child = spawn("npx", ["hardhat", "node"], {
    cwd: contractsDir,
    stdio: "ignore",
    env: process.env,
  });
  const client = createPublicClient({ chain: localChain, transport: http() });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await client.getChainId();
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  child.kill();
  throw new Error("Local Hardhat node did not become ready in time");
}

export interface LocalDeployment {
  usdcAddress: Hex;
  escrowAddress: Hex;
  tabAddress: Hex;
}

/** Deploy MockUSDC + TesseraEscrow + TesseraTab and mint USDC to the agent. */
export async function deployLocal(agentAddress: Hex, mint = usdc("1")): Promise<LocalDeployment> {
  const deployer = privateKeyToAccount(DEV_KEYS.deployer);
  const wallet = createWalletClient({ account: deployer, chain: localChain, transport: http() });
  const pub = createPublicClient({ chain: localChain, transport: http() });

  const usdcHash = await wallet.deployContract({
    abi: mockUsdcAbi,
    bytecode: mockUsdcBytecode,
    account: deployer,
    chain: localChain,
  });
  const usdcAddress = (await pub.waitForTransactionReceipt({ hash: usdcHash })).contractAddress!;

  const escrowHash = await wallet.deployContract({
    abi: tesseraEscrowAbi,
    bytecode: tesseraEscrowBytecode,
    args: [usdcAddress],
    account: deployer,
    chain: localChain,
  });
  const escrowAddress = (await pub.waitForTransactionReceipt({ hash: escrowHash })).contractAddress!;

  const tabHash = await wallet.deployContract({
    abi: tesseraTabAbi,
    bytecode: tesseraTabBytecode,
    args: [usdcAddress],
    account: deployer,
    chain: localChain,
  });
  const tabAddress = (await pub.waitForTransactionReceipt({ hash: tabHash })).contractAddress!;

  const mintHash = await wallet.writeContract({
    address: usdcAddress,
    abi: mockUsdcAbi,
    functionName: "mint",
    args: [agentAddress, mint],
    account: deployer,
    chain: localChain,
  });
  await pub.waitForTransactionReceipt({ hash: mintHash });

  return { usdcAddress, escrowAddress, tabAddress };
}

/** Mint MockUSDC to an address — the local-chain stand-in for a testnet faucet. */
export async function mintUsdc(
  deployment: LocalDeployment,
  to: Hex,
  amount: bigint
): Promise<Hex> {
  const deployer = privateKeyToAccount(DEV_KEYS.deployer);
  const wallet = createWalletClient({ account: deployer, chain: localChain, transport: http() });
  const pub = createPublicClient({ chain: localChain, transport: http() });
  const hash = await wallet.writeContract({
    address: deployment.usdcAddress,
    abi: mockUsdcAbi,
    functionName: "mint",
    args: [to, amount],
    account: deployer,
    chain: localChain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

/** Fund a provider with USDC and bond it as stake in the escrow. */
export async function stakeProvider(
  deployment: LocalDeployment,
  providerKey: Hex,
  amount: bigint
): Promise<void> {
  const account = privateKeyToAccount(providerKey);
  const wallet = createWalletClient({ account, chain: localChain, transport: http() });
  const pub = createPublicClient({ chain: localChain, transport: http() });

  const mintHash = await wallet.writeContract({
    address: deployment.usdcAddress,
    abi: mockUsdcAbi,
    functionName: "mint",
    args: [account.address, amount],
    account,
    chain: localChain,
  });
  await pub.waitForTransactionReceipt({ hash: mintHash });

  const approveHash = await wallet.writeContract({
    address: deployment.usdcAddress,
    abi: mockUsdcAbi,
    functionName: "approve",
    args: [deployment.escrowAddress, amount],
    account,
    chain: localChain,
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });

  const stakeHash = await wallet.writeContract({
    address: deployment.escrowAddress,
    abi: tesseraEscrowAbi,
    functionName: "stake",
    args: [amount],
    account,
    chain: localChain,
  });
  await pub.waitForTransactionReceipt({ hash: stakeHash });
}
