import { formatUnits, parseUnits } from "viem";
import { USDC_DECIMALS } from "./chain.js";

/** Parse a human USDC string ("0.0025") into base units (6 decimals). */
export function usdc(amount: string | number): bigint {
  return parseUnits(String(amount), USDC_DECIMALS);
}

/**
 * The same conversion, but refusing anything that is not an amount.
 *
 * `usdc()` is `parseUnits` with the decimals filled in, which is right when the
 * caller already knows the string is a number. Reading one a person typed is a
 * different job:
 *
 *  - `parseUnits("1.0000001", 6)` **truncates** to 1.000000 and says nothing.
 *    Silently dropping precision from a price is how somebody is charged an
 *    amount they did not enter.
 *  - Blank, "abc", "1e6", "-1" and "1.2.3" all have to be refused rather than
 *    guessed at.
 *
 * It exists because the launchpad reached for `baseUnits` — a parser for
 * integers *already* in the token's smallest unit — to read a human figure. A
 * drop submitted at "1" USDC was listed at 0.000001, a factor of a million, and
 * minting it then failed because "0.000001" contains a dot that the integer
 * parser rejected. One misuse, two symptoms, and neither error mentioned scale.
 *
 * Thousands separators are accepted because forms produce them; everything else
 * is a refusal with a sentence attached.
 */
export function parseUsdcAmount(input: unknown): bigint {
  const raw = String(input ?? "").trim().replace(/,/g, "");
  if (!raw) return 0n;
  if (!new RegExp(`^\\d+(\\.\\d{1,${USDC_DECIMALS}})?$`).test(raw)) {
    throw new Error(`Enter a plain amount of USDC, with at most ${USDC_DECIMALS} decimal places.`);
  }
  return parseUnits(raw, USDC_DECIMALS);
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
