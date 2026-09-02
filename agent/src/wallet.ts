import { privateKeyToAccount } from "viem/accounts";
import type { Account, Hex } from "viem";
import { createDcwAccount, dcwConfigFromEnv, type DcwConfig } from "./circle/dcw.js";

/**
 * Unified account (signer) construction for the agent and providers.
 *
 * `key`    — a raw private key from env (today's default).
 * `circle` — a Circle Developer-Controlled Wallet; signer-identical downstream.
 *
 * This is the single seam the DCW / Circle Wallets integration plugs into: the
 * rest of the codebase only ever sees a viem `Account`, so switching custody is
 * a construction change here and nowhere else.
 */
export type WalletMode = "key" | "circle";

export interface BuildAccountOptions {
  /** Defaults to $WALLET_MODE, then "key". */
  mode?: WalletMode;
  /** Private key for `key` mode (defaults per-role via env in callers). */
  privateKey?: Hex;
  /** Explicit DCW config for `circle` mode (else read from env by role). */
  dcw?: DcwConfig | null;
  /** Env role prefix used to resolve a DCW config (AGENT / PROVIDER). */
  role?: string;
}

/** Construct the signer for a role. Default path is unchanged from before. */
export function buildAccount(opts: BuildAccountOptions = {}): Account {
  const mode = opts.mode ?? (process.env.WALLET_MODE as WalletMode | undefined) ?? "key";

  if (mode === "circle") {
    const dcw = opts.dcw ?? dcwConfigFromEnv(opts.role ?? "AGENT");
    if (!dcw) {
      throw new Error(
        "WALLET_MODE=circle needs CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, " +
          `${opts.role ?? "AGENT"}_WALLET_ID and ${opts.role ?? "AGENT"}_ADDRESS`
      );
    }
    return createDcwAccount(dcw);
  }

  const key = opts.privateKey;
  if (!key) throw new Error("no private key provided for key-mode wallet");
  return privateKeyToAccount(key);
}
