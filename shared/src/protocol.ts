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

  // --- Signed receipts (EIP-712) -------------------------------------------
  /** Provider → agent: provider's EIP-712 signature over the settlement receipt. */
  receiptSig: "x-tessera-receipt-sig",
  /** Provider → agent: unix seconds the receipt was issued at. */
  receiptIssued: "x-tessera-receipt-issued",
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

/**
 * EIP-712 typed data for a settlement receipt.
 *
 * The quote is signed, so the agent can prove what it was *promised*. Nothing
 * signed what it actually *got*. The chain records that a payment was fulfilled
 * and the hash the provider committed to, but not that this particular body is
 * the one behind that hash, and not who it was served to — so a dispute came
 * down to the agent's word against the provider's.
 *
 * A receipt closes that: the provider signs the payment, the payer, the amount,
 * the resource, and the hash of the bytes it served. Holding one, the agent can
 * show a third party exactly what it paid for and exactly what came back, and
 * the provider cannot later deny having served it. Bound to `paymentId`, so a
 * receipt cannot be replayed against a different payment.
 */
export function receiptTypedData(
  chainId: number,
  verifyingContract: `0x${string}`,
  receipt: {
    paymentId: bigint;
    provider: `0x${string}`;
    payer: `0x${string}`;
    amount: bigint;
    resource: string;
    responseHash: `0x${string}`;
    issuedAt: bigint;
  }
) {
  return {
    domain: { name: "Tessera", version: "1", chainId, verifyingContract },
    types: {
      Receipt: [
        { name: "paymentId", type: "uint256" },
        { name: "provider", type: "address" },
        { name: "payer", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "resource", type: "string" },
        { name: "responseHash", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
      ],
    },
    primaryType: "Receipt" as const,
    message: receipt,
  };
}

/** The fields of an escrow payment a receipt is built from. */
export interface EscrowPaymentView {
  /** The buyer — `agent` in TesseraEscrow's own naming. */
  agent: `0x${string}`;
  provider: `0x${string}`;
  amount: bigint;
  responseHash: `0x${string}`;
}

/**
 * Build receipt typed data straight from an escrow payment.
 *
 * The provider signs a receipt and the agent rebuilds it to verify. Those are
 * two places choosing where each field comes from, and they only have to
 * disagree once for every receipt to stop verifying — silently, since an
 * unverifiable receipt looks exactly like a provider that never sent one.
 * The trap is `amount`: the escrow requires only `amount >= price`, so a buyer
 * who overpays makes the quoted price and the escrowed amount differ, and a
 * rebuild from the quote breaks.
 *
 * Routing both sides through here means there is one answer to "which fields",
 * not two that happen to match today.
 */
export function receiptFromPayment(
  chainId: number,
  verifyingContract: `0x${string}`,
  paymentId: bigint,
  payment: EscrowPaymentView,
  resource: string,
  issuedAt: bigint
) {
  return receiptTypedData(chainId, verifyingContract, {
    paymentId,
    provider: payment.provider,
    payer: payment.agent,
    amount: payment.amount,
    resource,
    responseHash: payment.responseHash,
    issuedAt,
  });
}

/** A provider's non-repudiable statement of what it served, and to whom. */
export interface Receipt {
  paymentId: bigint;
  provider: `0x${string}`;
  payer: `0x${string}`;
  amount: bigint;
  resource: string;
  responseHash: `0x${string}`;
  issuedAt: bigint;
  /** The provider's EIP-712 signature over the fields above. */
  signature: `0x${string}`;
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
