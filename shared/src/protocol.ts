/**
 * The Tessera 402 protocol — headers exchanged between an agent and a provider.
 *
 * A provider answers an unpaid request with `402 Payment Required` plus a quote.
 * The agent escrows USDC on Arc, then retries the request carrying the on-chain
 * paymentId. The provider verifies the escrow on-chain and returns the data.
 */
export const HEADERS = {
  /** Provider's payout address (also its reputation identity). */
  provider: "x-tessera-provider",
  /** Price in USDC base units (6 decimals), as a decimal string. */
  price: "x-tessera-price",
  /** keccak256(provider, price, resourceId, nonce) — binds the quote. */
  quote: "x-tessera-quote",
  /** Seconds the provider commits to deliver within (its SLA). */
  deadline: "x-tessera-deadline",
  /** A stable id for the resource being sold (e.g. "weather:current"). */
  resource: "x-tessera-resource",
  /** Agent → provider: the on-chain paymentId proving escrow is funded. */
  payment: "x-tessera-payment",
} as const;

/** What an agent parses out of a 402 response. */
export interface Quote {
  provider: `0x${string}`;
  /** USDC base units (6 decimals). */
  price: bigint;
  quoteHash: `0x${string}`;
  /** SLA window in seconds. */
  deadlineSeconds: number;
  resource: string;
  /** Full URL the agent will re-request once paid. */
  url: string;
}

/** Mirrors TesseraEscrow.Status. */
export enum PaymentStatus {
  None = 0,
  Escrowed = 1,
  Fulfilled = 2,
  Settled = 3,
  Refunded = 4,
}
