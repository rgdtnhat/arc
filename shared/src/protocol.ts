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

  // --- Nanopayments (tab / payment-channel billing) -------------------------
  /** Agent → provider: the on-chain tabId opened in TesseraTab. */
  tab: "x-tessera-tab",
  /** Agent → provider: cumulative USDC (base units) authorized so far. */
  voucher: "x-tessera-voucher",
  /** Agent → provider: agent's signature over voucherHash(tabId, cumulative). */
  voucherSig: "x-tessera-voucher-sig",
  /** Provider → agent (on 402): "escrow" (default) or "tab". */
  billing: "x-tessera-billing",

  // --- Signed quotes (EIP-712) ---------------------------------------------
  /** Provider → agent: random 32-byte nonce binding the quote. */
  quoteNonce: "x-tessera-quote-nonce",
  /** Provider → agent: unix seconds after which the quote is no longer valid. */
  quoteExpiry: "x-tessera-quote-expiry",
  /** Provider → agent: provider's EIP-712 signature over the quote. */
  quoteSig: "x-tessera-quote-sig",
} as const;

/**
 * EIP-712 typed data for a price quote. The provider signs it so the agent can
 * prove the price, resource and expiry are authentic and untampered before it
 * escrows any USDC — non-repudiable, and safe over an untrusted transport.
 */
export function quoteTypedData(
  chainId: number,
  verifyingContract: `0x${string}`,
  quote: {
    provider: `0x${string}`;
    price: bigint;
    resource: string;
    nonce: `0x${string}`;
    expiry: bigint;
  }
) {
  return {
    domain: { name: "Tessera", version: "1", chainId, verifyingContract },
    types: {
      Quote: [
        { name: "provider", type: "address" },
        { name: "price", type: "uint256" },
        { name: "resource", type: "string" },
        { name: "nonce", type: "bytes32" },
        { name: "expiry", type: "uint64" },
      ],
    },
    primaryType: "Quote" as const,
    message: quote,
  };
}

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
