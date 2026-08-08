import { formatUnits, parseUnits } from "viem";
import { USDC_DECIMALS } from "./chain.js";

/** Parse a human USDC string ("0.0025") into base units (6 decimals). */
export function usdc(amount: string | number): bigint {
  return parseUnits(String(amount), USDC_DECIMALS);
}

/** Format base-unit USDC into a human string. */
export function formatUsdc(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS);
}

/**
 * The ERC-20 surface this codebase actually reads.
 *
 * It used to be four functions — the ones the escrow needed — and that was a
 * trap, because reaching for a fifth does not fail loudly. viem matches by
 * name, finds nothing, and the call errors in a way every `.catch` in the
 * building turns into a plausible value. `symbol` was missing once and
 * `tokenMeta` rendered a contract address where a ticker belonged; `totalSupply`
 * was missing this week and the oracle's circulating-supply figure would have
 * silently read null.
 *
 * So the metadata trio and `totalSupply` are here now. They are cheap — an ABI
 * entry is a few bytes of TypeScript and no on-chain cost — and their absence
 * is expensive in exactly the way this codebase keeps paying for.
 *
 * `symbol` and `name` are typed as `string`. A handful of very old tokens
 * return `bytes32` instead and will fail to decode; that is the correct
 * outcome here, since a caller that silently guessed would be back to the
 * original problem.
 */
export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;
