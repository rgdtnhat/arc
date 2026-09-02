import { toAccount } from "viem/accounts";
import {
  hashMessage,
  hashTypedData,
  keccak256,
  serializeTransaction,
  type Account,
  type Hex,
} from "viem";

/**
 * Circle Developer-Controlled Wallets (DCW) signer.
 *
 * Instead of holding a raw private key in `.env`, the agent's keys live in
 * Circle's infrastructure and signing happens over Circle's API. This adapter
 * produces a viem `Account` whose `signMessage` / `signTypedData` /
 * `signTransaction` call Circle — so nothing downstream (escrow, tab vouchers,
 * EIP-712 quote verification) changes; the protocol verifies by address, not by
 * how a signature was produced.
 *
 * The request/response mapping targets Circle's `w3s/developer/sign/*`
 * endpoints and is activated by credentials (a Circle API key + entity secret).
 * `fetchImpl` is injectable so the adapter is unit-testable without a network.
 */
export interface DcwConfig {
  /** Circle API key. */
  apiKey: string;
  /** Registered entity-secret ciphertext used to authorize signing. */
  entitySecret: string;
  /** The DCW wallet id that holds this signer's key. */
  walletId: string;
  /** The wallet's on-chain address (what counterparties verify against). */
  address: Hex;
  /** API base; defaults to Circle production. */
  baseUrl?: string;
  /** Injectable fetch (tests, proxied environments). */
  fetchImpl?: typeof fetch;
}

interface CircleSignResponse {
  data?: { signature?: string };
  signature?: string;
}

/** Build a viem `Account` backed by a Circle Developer-Controlled Wallet. */
export function createDcwAccount(cfg: DcwConfig): Account {
  const base = (cfg.baseUrl ?? "https://api.circle.com").replace(/\/+$/, "");
  const doFetch = cfg.fetchImpl ?? fetch;

  async function sign(kind: "message" | "typedData" | "transaction", payload: Record<string, unknown>): Promise<Hex> {
    const res = await doFetch(`${base}/v1/w3s/developer/sign/${kind}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        walletId: cfg.walletId,
        entitySecretCiphertext: cfg.entitySecret,
        ...payload,
      }),
    });
    if (!res.ok) {
      throw new Error(`Circle DCW sign ${kind} failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as CircleSignResponse;
    const sig = json.data?.signature ?? json.signature;
    if (!sig) throw new Error(`Circle DCW sign ${kind}: no signature in response`);
    return (sig.startsWith("0x") ? sig : `0x${sig}`) as Hex;
  }

  return toAccount({
    address: cfg.address,
    async signMessage({ message }) {
      // Send both the raw message (when it's a string) and the EIP-191 digest,
      // so Circle can sign whichever form its API expects.
      return sign("message", {
        message: typeof message === "string" ? message : undefined,
        digest: hashMessage(message),
      });
    },
    async signTypedData(typedData) {
      return sign("typedData", {
        typedData: JSON.stringify(typedData),
        digest: hashTypedData(typedData as Parameters<typeof hashTypedData>[0]),
      });
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      const serialized = serializer(transaction as Parameters<typeof serializeTransaction>[0]);
      return sign("transaction", {
        rawTransaction: serialized,
        digest: keccak256(serialized),
      });
    },
  });
}

/** Read a DCW config from env for a given role (AGENT / PROVIDER). Null if unset. */
export function dcwConfigFromEnv(role = "AGENT"): DcwConfig | null {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const walletId = process.env[`${role}_WALLET_ID`];
  const address = process.env[`${role}_ADDRESS`] as Hex | undefined;
  if (!apiKey || !entitySecret || !walletId || !address) return null;
  return {
    apiKey,
    entitySecret,
    walletId,
    address,
    baseUrl: process.env.CIRCLE_API_BASE_URL,
  };
}
