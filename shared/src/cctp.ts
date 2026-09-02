/**
 * Circle's Cross-Chain Transfer Protocol (CCTP v2), as the way USDC gets *onto*
 * Arc in the first place.
 *
 * ## Why this exists
 * Everything else in this project assumes the agent already holds USDC on Arc.
 * Getting it there was left as an exercise, which is a strange gap in a system
 * whose whole claim is that an agent can fund itself and pay for what it needs:
 * the very first step was "a human bridges some money for you".
 *
 * CCTP is burn-and-mint, not a wrapped-asset bridge. The USDC that arrives on
 * Arc is canonical Circle USDC, not a claim on a pool that might be drained —
 * which matters here more than it would elsewhere, because on Arc that token is
 * also the gas.
 *
 * ## The shape of a transfer
 *
 *   1. `approve`         the TokenMessenger for the amount, on the source chain
 *   2. `depositForBurn`  burns it there, emitting a MessageSent log
 *   3. *wait*            Circle's attestation service signs the message
 *   4. `receiveMessage`  on Arc, minting the USDC to the recipient
 *
 * Step 3 is the one that shapes the code. Attestation is not instant and not
 * synchronous — it is an HTTP endpoint that answers `pending` until it answers
 * `complete`. So the interesting logic here is polling that endpoint safely:
 * with a deadline, with backoff, and without treating a slow answer as a
 * failure. A transfer that has burned but not yet minted is not lost; it is
 * waiting, and the message can be redeemed later by anyone holding it.
 *
 * ## What this module is
 * Pure helpers and a poller — no signing, no key handling, no network topology
 * assumptions beyond the addresses passed in. That keeps it testable without a
 * chain and keeps the domain/address tables in configuration where they belong,
 * since Circle publishes new domains as it adds chains and a hardcoded table
 * goes stale silently.
 */

/** CCTP identifies chains by its own small integer "domain", not by chain id. */
export type CctpDomain = number;

/**
 * The domains this project knows by name.
 *
 * Deliberately small, and deliberately not exhaustive: Circle adds domains over
 * time, and a stale table that looks complete is worse than one that obviously
 * needs an override. Anything missing can be passed as a number.
 *
 * Source: Circle's CCTP documentation, testnet domain list.
 */
export const CCTP_DOMAIN = {
  ethereumSepolia: 0,
  avalancheFuji: 1,
  opSepolia: 2,
  arbitrumSepolia: 3,
  baseSepolia: 6,
  polygonAmoy: 7,
} as const satisfies Record<string, CctpDomain>;

/** Where the attestation service lives. Testnet by default. */
export const CCTP_API_BASE =
  process.env.CCTP_API_BASE ?? "https://iris-api-sandbox.circle.com";

/** Minimal ABI for the source-chain burn. */
export const tokenMessengerAbi = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
    ],
    outputs: [{ name: "nonce", type: "uint64" }],
  },
] as const;

/** Minimal ABI for the destination-chain mint. */
export const messageTransmitterAbi = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "event",
    name: "MessageSent",
    inputs: [{ name: "message", type: "bytes", indexed: false }],
    anonymous: false,
  },
] as const;

/**
 * CCTP addresses a recipient as 32 bytes, not 20.
 *
 * The padding is on the *left* — an address is the low-order 20 bytes of the
 * word. Getting this backwards produces a syntactically valid `bytes32` that
 * mints to an address nobody controls, and the burn has already happened by
 * then, so it is worth doing in one place with a test.
 */
export function addressToBytes32(address: string): `0x${string}` {
  const hex = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`not an address: ${address}`);
  return `0x${"0".repeat(24)}${hex}` as `0x${string}`;
}

/** The inverse, for reading a message back. */
export function bytes32ToAddress(word: string): `0x${string}` {
  const hex = word.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a bytes32: ${word}`);
  if (!/^0{24}/.test(hex)) throw new Error(`bytes32 is not a padded address: ${word}`);
  return `0x${hex.slice(24)}` as `0x${string}`;
}

/** The status the attestation service reports for a burn. */
export type AttestationStatus = "pending" | "complete" | "failed";

export interface Attestation {
  status: AttestationStatus;
  /** Present only when `status === "complete"`. */
  attestation?: `0x${string}`;
  /** The message bytes, echoed back by the v2 endpoint. */
  message?: `0x${string}`;
  /** Whatever the service said, when it said something unexpected. */
  raw?: unknown;
}

/**
 * Normalize the attestation service's answer.
 *
 * Split out from the polling so the parsing is testable without a network, and
 * because the two versions of the API disagree about shape: v1 answers
 * `{status, attestation}` for a message hash, v2 answers
 * `{messages: [{status, attestation, message}]}` for a transaction hash. Both
 * are accepted rather than picking one, since which endpoint is live depends on
 * the chain pair and not on anything this code controls.
 */
export function parseAttestation(body: unknown): Attestation {
  if (!body || typeof body !== "object") return { status: "pending", raw: body };
  const b = body as Record<string, unknown>;

  const entry = Array.isArray(b.messages) && b.messages.length ? (b.messages[0] as Record<string, unknown>) : b;

  const status = String(entry.status ?? "pending").toLowerCase();
  const attestation = typeof entry.attestation === "string" ? entry.attestation : undefined;
  const message = typeof entry.message === "string" ? entry.message : undefined;

  // "complete" only when there is actually something to submit. The service
  // briefly reports complete with a placeholder attestation of "PENDING", and
  // treating that as done would send an unusable transaction.
  if (status === "complete" && attestation && attestation.startsWith("0x") && attestation.length > 2) {
    return { status: "complete", attestation: attestation as `0x${string}`, message: message as `0x${string}` };
  }
  if (status === "failed") return { status: "failed", raw: body };
  return { status: "pending", message: message as `0x${string}` | undefined, raw: body };
}

export interface PollOptions {
  /** Give up after this long. A burn is not lost when this elapses — see below. */
  timeoutMs?: number;
  /** First gap between polls; doubles up to `maxIntervalMs`. */
  intervalMs?: number;
  maxIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Called before each wait, for progress reporting. */
  onPoll?: (attempt: number, status: AttestationStatus) => void;
  signal?: AbortSignal;
}

/**
 * Wait for Circle to attest a burn.
 *
 * @returns the completed attestation, or `null` on timeout.
 *
 * Timing out returns `null` rather than throwing, because a timeout here is not
 * an error: the burn is final and the message stays redeemable indefinitely.
 * Throwing would push callers toward treating a slow attestation as a failed
 * transfer, and the natural "handling" for a failed transfer — retry the burn —
 * would burn the money twice.
 */
export async function waitForAttestation(
  srcDomain: CctpDomain,
  txHash: string,
  opts: PollOptions = {},
): Promise<Attestation | null> {
  const {
    timeoutMs = 15 * 60_000,
    intervalMs = 2_000,
    maxIntervalMs = 30_000,
    fetchImpl = fetch,
    onPoll,
    signal,
  } = opts;

  const url = `${CCTP_API_BASE}/v2/messages/${srcDomain}?transactionHash=${txHash}`;
  const deadline = Date.now() + timeoutMs;
  let wait = intervalMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    attempt++;
    let parsed: Attestation = { status: "pending" };
    try {
      const res = await fetchImpl(url, { signal });
      // 404 is the service's way of saying "not indexed yet", which is the
      // normal state for the first few seconds after a burn.
      if (res.ok) parsed = parseAttestation(await res.json());
    } catch {
      // Network flake: indistinguishable from pending at this level, and the
      // deadline is what bounds us either way.
    }

    onPoll?.(attempt, parsed.status);
    if (parsed.status === "complete") return parsed;
    if (parsed.status === "failed") return parsed;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(wait, remaining)));
    wait = Math.min(wait * 2, maxIntervalMs);
  }
  return null;
}

/**
 * The plan for one transfer, as data.
 *
 * Returned rather than executed so a caller can show it, log it, or refuse it
 * before anything irreversible happens. `depositForBurn` cannot be undone.
 */
export interface BurnPlan {
  amount: bigint;
  destinationDomain: CctpDomain;
  mintRecipient: `0x${string}`;
  burnToken: `0x${string}`;
  tokenMessenger: `0x${string}`;
}

export function planBurn(args: {
  amount: bigint;
  destinationDomain: CctpDomain;
  recipient: string;
  burnToken: string;
  tokenMessenger: string;
}): BurnPlan {
  if (args.amount <= 0n) throw new Error("amount must be positive");
  return {
    amount: args.amount,
    destinationDomain: args.destinationDomain,
    mintRecipient: addressToBytes32(args.recipient),
    burnToken: args.burnToken as `0x${string}`,
    tokenMessenger: args.tokenMessenger as `0x${string}`,
  };
}
