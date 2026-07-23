import { defineChain } from "viem";

/**
 * Arc chain config.
 *
 * Defaults to Arc **testnet** (Circle's stablecoin-native L1). Every field is
 * overridable from the environment, so migrating to mainnet — or any other Arc
 * network — is a config change, not a code fork:
 *
 *   ARC_CHAIN_ID       chain id           (default 5042002, Arc testnet)
 *   ARC_RPC_URL        RPC endpoint       (default https://rpc.testnet.arc.network)
 *   ARC_EXPLORER_URL   block explorer     (default https://testnet.arcscan.app)
 *   ARC_CHAIN_NAME     display name       (default "Arc Testnet")
 *   ARC_IS_TESTNET     "false" for mainnet
 *
 * USDC is the native gas token: one asset exposed via a native 18-decimal view
 * (gas / msg.value) and a 6-decimal ERC-20 view (balances, transfers, display).
 *
 * Docs: https://docs.arc.io/arc/references/connect-to-arc
 */
const env = (k: string): string | undefined =>
  typeof process !== "undefined" ? process.env?.[k] : undefined;

/** Testnet chain id; the default when ARC_CHAIN_ID is unset. */
export const ARC_TESTNET_CHAIN_ID = 5042002;

/** Active chain id (env-overridable for mainnet migration). */
export const ARC_CHAIN_ID = Number(env("ARC_CHAIN_ID") ?? ARC_TESTNET_CHAIN_ID);

const ARC_RPC_URL = env("ARC_RPC_URL") ?? "https://rpc.testnet.arc.network";
const ARC_EXPLORER_URL = env("ARC_EXPLORER_URL") ?? "https://testnet.arcscan.app";
const ARC_CHAIN_NAME =
  env("ARC_CHAIN_NAME") ?? (ARC_CHAIN_ID === ARC_TESTNET_CHAIN_ID ? "Arc Testnet" : "Arc");
const ARC_IS_TESTNET = env("ARC_IS_TESTNET") !== "false" && ARC_CHAIN_ID === ARC_TESTNET_CHAIN_ID;

/** The active Arc chain (testnet by default; env-configurable for mainnet). */
export const arcChain = defineChain({
  id: ARC_CHAIN_ID,
  name: ARC_CHAIN_NAME,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [ARC_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: ARC_EXPLORER_URL },
  },
  testnet: ARC_IS_TESTNET,
});

/**
 * Back-compat alias. Existing call sites import `arcTestnet`; it now resolves to
 * whichever Arc network the environment selects (testnet unless overridden).
 */
export const arcTestnet = arcChain;

/** Canonical ERC-20 view of USDC on Arc (6 decimals). */
export const ARC_USDC_ADDRESS =
  (env("ARC_USDC_ADDRESS") ?? "0x3600000000000000000000000000000000000000") as `0x${string}`;

/** USDC uses 6 decimals in its ERC-20 view. */
export const USDC_DECIMALS = 6;

/** Explorer link helper (respects ARC_EXPLORER_URL). */
export function arcscanTx(hash: string): string {
  return `${ARC_EXPLORER_URL}/tx/${hash}`;
}

export function arcscanAddress(address: string): string {
  return `${ARC_EXPLORER_URL}/address/${address}`;
}
