import type { Hex } from "viem";

/**
 * Testnet USDC faucet.
 *
 * On Arc, USDC is the gas token, so an agent needs testnet USDC to do anything.
 * This wraps getting it two ways:
 *  - **Circle Faucet API** (`POST /v1/faucet/drips`) when a Circle API key is
 *    configured — a real programmatic drip the agent can call autonomously.
 *  - **Manual** otherwise — returns the public faucet URL + the address to
 *    paste, so a human can top the agent up at https://faucet.circle.com/.
 *
 * The dashboard's "Get testnet USDC" button and the treasury's auto-top-up both
 * go through this interface.
 */
export const CIRCLE_FAUCET_URL = "https://faucet.circle.com/";
export const CIRCLE_FAUCET_API = "https://api.circle.com/v1/faucet/drips";

export interface FaucetResult {
  ok: boolean;
  /** True when no programmatic drip is available — a human must use the web faucet. */
  manual?: boolean;
  address: Hex;
  /** Web faucet URL to open when manual. */
  url?: string;
  txHash?: string;
  amountUsdc?: string;
  message: string;
}

export interface Faucet {
  readonly kind: string;
  request(address: Hex): Promise<FaucetResult>;
}

export interface CircleFaucetConfig {
  /** Drip endpoint; defaults to Circle's when an API key is present. */
  apiUrl?: string;
  apiKey?: string;
  /** Circle blockchain id, e.g. "ARC-TESTNET". */
  blockchain?: string;
  /**
   * Ask for the chain's *native* token as well as USDC. Off by default.
   *
   * It used to be sent unconditionally, and on Arc that is a contradiction:
   * USDC **is** the native gas token there, so there is no separate native
   * asset to drip and the whole request is rejected — the drip does not
   * degrade to "USDC only", it fails outright:
   *
   *     HTTP 400 {"code":2,"message":"The 'native token' token is not
   *     supported by 'ARC-TESTNET' blockchain"}
   *
   * Which is a good error and cost an evening anyway, because the request was
   * asking for something the chain cannot have. Chains that do have a separate
   * gas token can turn it back on with `CIRCLE_FAUCET_NATIVE=true`.
   */
  native?: boolean;
  fetchImpl?: typeof fetch;
}

/** Faucet for Arc testnet USDC via Circle (API drip, or manual instructions). */
export class CircleFaucet implements Faucet {
  readonly kind = "circle";
  constructor(private readonly cfg: CircleFaucetConfig = {}) {}

  async request(address: Hex): Promise<FaucetResult> {
    const apiUrl = this.cfg.apiUrl ?? (this.cfg.apiKey ? CIRCLE_FAUCET_API : undefined);
    if (!apiUrl) {
      return {
        ok: false,
        manual: true,
        address,
        url: CIRCLE_FAUCET_URL,
        message: `Open ${CIRCLE_FAUCET_URL}, pick Arc Testnet + USDC, and paste ${address}`,
      };
    }
    const doFetch = this.cfg.fetchImpl ?? fetch;
    try {
      const res = await doFetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          address,
          blockchain: this.cfg.blockchain ?? "ARC-SEPOLIA",
          // See `native` above: on Arc this must not be asked for at all.
          ...(this.cfg.native ? { native: true } : {}),
          usdc: true,
        }),
      });
      if (!res.ok) {
        /*
         * Carry the body, not just the status.
         *
         * The two things most likely to be wrong here are the API key and the
         * network identifier, and both come back as a 4xx with a sentence
         * saying which. Reporting only "HTTP 400" turns a one-line fix into
         * guesswork about a value the operator cannot look up from inside this
         * app — Circle names its chains its own way, and `ARC-TESTNET` and
         * `ARC-SEPOLIA` are not distinguishable by reasoning.
         */
        // Guarded: a `fetch` implementation is only obliged to give us what we
        // use, and reading the body must never turn a reportable HTTP error
        // into an unhandled one.
        const body = typeof res.text === "function" ? await res.text().catch(() => "") : "";
        const said = body.trim().slice(0, 200);
        return {
          ok: false,
          address,
          url: CIRCLE_FAUCET_URL,
          message:
            `Circle faucet API returned HTTP ${res.status}` +
            (said ? ` — ${said}` : "") +
            `. Check CIRCLE_API_KEY and CIRCLE_FAUCET_BLOCKCHAIN (currently ` +
            `"${this.cfg.blockchain ?? "ARC-SEPOLIA"}"), or use ${CIRCLE_FAUCET_URL}`,
        };
      }
      const json = (await res.json().catch(() => ({}))) as { txHash?: string; data?: { txHash?: string } };
      return {
        ok: true,
        address,
        txHash: json.txHash ?? json.data?.txHash,
        message: "Requested testnet USDC from the Circle faucet API",
      };
    } catch (err) {
      return {
        ok: false,
        address,
        url: CIRCLE_FAUCET_URL,
        message: `Circle faucet request failed (${String(err).slice(0, 80)}) — use ${CIRCLE_FAUCET_URL}`,
      };
    }
  }
}

/** Build a CircleFaucet from env (uses Circle's API when CIRCLE_API_KEY is set). */
export function faucetFromEnv(): CircleFaucet {
  const apiKey = process.env.CIRCLE_API_KEY;
  return new CircleFaucet({
    apiUrl: process.env.CIRCLE_FAUCET_API_URL,
    apiKey,
    blockchain: process.env.CIRCLE_FAUCET_BLOCKCHAIN ?? "ARC-SEPOLIA",
    // Opt-in, because the chain this app is built for does not have one.
    native: process.env.CIRCLE_FAUCET_NATIVE === "true",
  });
}
