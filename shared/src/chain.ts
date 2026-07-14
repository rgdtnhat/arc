import { defineChain } from "viem";

/**
 * Arc testnet — Circle's stablecoin-native L1.
 * USDC is the native gas token: one asset exposed via a native 18-decimal view
 * (gas / msg.value) and a 6-decimal ERC-20 view (balances, transfers, display).
 *
 * Docs: https://docs.arc.io/arc/references/connect-to-arc
 */
export const ARC_CHAIN_ID = 5042002;

export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

/** Canonical ERC-20 view of USDC on Arc (6 decimals). */
export const ARC_USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000" as const;

/** USDC uses 6 decimals in its ERC-20 view. */
export const USDC_DECIMALS = 6;

/** Explorer link helper. */
export function arcscanTx(hash: string): string {
  return `https://testnet.arcscan.app/tx/${hash}`;
}

export function arcscanAddress(address: string): string {
  return `https://testnet.arcscan.app/address/${address}`;
}
