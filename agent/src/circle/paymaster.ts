/**
 * Circle Paymaster seam (gasless first call).
 *
 * On Arc, USDC is the gas token — elegant, but a brand-new agent with a zero
 * balance can't send its very first transaction (no USDC to pay gas). Circle
 * Paymaster sponsors that first operation so an agent can bootstrap from nothing
 * and start earning.
 *
 * Full sponsorship routes the agent's first `approve` + `open` through an
 * ERC-4337 UserOperation whose `paymasterAndData` points at Circle's Paymaster,
 * submitted by a bundler — which requires a smart-account agent wallet and a
 * Circle Paymaster endpoint (credential-gated). This module is the configuration
 * seam the runtime consults: it detects whether a Paymaster is wired and
 * describes the gas mode. Without it, the agent simply pays gas in USDC (today).
 */
export interface PaymasterConfig {
  /** Circle Paymaster / bundler endpoint. */
  paymasterUrl: string;
  /** Circle API key, if the endpoint requires one. */
  apiKey?: string;
  /** How many of the agent's first operations to sponsor. */
  sponsorFirstN: number;
}

/** Read a Paymaster config from env, or null if none is configured. */
export function paymasterFromEnv(): PaymasterConfig | null {
  const paymasterUrl = process.env.CIRCLE_PAYMASTER_URL;
  if (!paymasterUrl) return null;
  return {
    paymasterUrl,
    apiKey: process.env.CIRCLE_API_KEY,
    sponsorFirstN: Number(process.env.CIRCLE_PAYMASTER_SPONSOR_N ?? 1),
  };
}

/** Human-readable description of the active gas mode, for logs / the dashboard. */
export function describeGasMode(pm: PaymasterConfig | null): string {
  if (!pm) return "USDC-gas (native Arc; agent pays its own gas in USDC)";
  let host = pm.paymasterUrl;
  try {
    host = new URL(pm.paymasterUrl).host;
  } catch {
    // keep the raw string if it isn't a full URL
  }
  return `Paymaster-sponsored first ${pm.sponsorFirstN} op(s) via ${host}`;
}

/** Whether the agent's Nth operation (0-indexed) should be gas-sponsored. */
export function shouldSponsor(pm: PaymasterConfig | null, opIndex: number): boolean {
  return pm != null && opIndex < pm.sponsorFirstN;
}
