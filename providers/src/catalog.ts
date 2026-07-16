import { usdc } from "@tessera/shared";

/**
 * A provider's honesty profile — drives the demo's SLA scenarios.
 *  - "reliable":   returns good data and fulfills on-chain  -> agent settles
 *  - "bad-data":   fulfills on-chain but returns junk        -> agent rejects (refund)
 *  - "no-fulfill": returns data but never fulfills on-chain  -> agent times out (refund)
 */
export type Behavior = "reliable" | "bad-data" | "no-fulfill";

export interface ServiceDef {
  /** Stable resource id, also used in the quote hash. */
  resource: string;
  /** HTTP route. */
  path: string;
  /** Human name shown in the dashboard. */
  name: string;
  /** Category the agent matches against its task. */
  tags: string[];
  /** Price per call (or per tick for tab billing), USDC base units (6 decimals). */
  price: bigint;
  /** SLA window in seconds the provider commits to. */
  slaSeconds: number;
  /** "escrow" = one escrow per call (default); "tab" = nanopayments via TesseraTab vouchers. */
  billing?: "escrow" | "tab";
  behavior: Behavior;
  /** Produces the response body for a given query. */
  respond: (query: Record<string, string>) => unknown;
}

/**
 * The demo catalog: three services, one of which (news) is deliberately flaky
 * so the escrow's SLA refund path is exercised end to end.
 */
export const CATALOG: ServiceDef[] = [
  {
    resource: "weather:current",
    path: "/weather",
    name: "AtmosFeed — current weather",
    tags: ["weather", "climate", "forecast", "temperature"],
    price: usdc("0.0025"),
    slaSeconds: 30,
    behavior: "reliable",
    respond: (q) => ({
      city: q.city ?? "Lisbon",
      tempC: 21 + (hash(q.city ?? "Lisbon") % 8),
      condition: ["clear", "cloudy", "rain", "windy"][hash(q.city ?? "x") % 4],
      humidity: 40 + (hash((q.city ?? "") + "h") % 40),
      source: "AtmosFeed",
    }),
  },
  {
    resource: "fx:quote",
    path: "/fx",
    name: "ParityDesk — FX spot quote",
    tags: ["fx", "forex", "exchange", "currency", "finance", "price"],
    price: usdc("0.004"),
    slaSeconds: 30,
    behavior: "reliable",
    respond: (q) => {
      const pair = (q.pair ?? "EURUSD").toUpperCase();
      const base = 1 + (hash(pair) % 50) / 100;
      return {
        pair,
        rate: Number(base.toFixed(4)),
        spread: 0.0002,
        ts: Date.now(),
        source: "ParityDesk",
      };
    },
  },
  {
    resource: "news:headlines",
    path: "/news",
    name: "WireScoop — market headlines",
    tags: ["news", "headlines", "media", "sentiment", "finance"],
    price: usdc("0.003"),
    slaSeconds: 8, // short window so the demo's timeout path is quick
    // Flaky on purpose: it takes payment but returns empty junk, so the agent's
    // quality check fails and it reclaims the escrow.
    behavior: "bad-data",
    respond: () => ({ headlines: [], note: "service degraded" }),
  },
  {
    resource: "ticker:stream",
    path: "/ticker",
    name: "PulseWire — live USDC/EUR ticks",
    tags: ["ticker", "stream", "realtime", "price"],
    price: usdc("0.0002"), // per tick — a true nanopayment
    slaSeconds: 30,
    billing: "tab",
    behavior: "reliable",
    respond: (q) => {
      const n = Number(q.n ?? 0);
      const base = 0.9214;
      const wobble = Math.sin(n * 1.7) * 0.0008 + (hash(String(n)) % 100) / 1_000_000;
      return {
        pair: "USDC/EUR",
        tick: n,
        price: Number((base + wobble).toFixed(6)),
        ts: Date.now(),
        source: "PulseWire",
      };
    },
  },
];

/** Tiny deterministic string hash for stable demo data. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function serviceByResource(resource: string): ServiceDef | undefined {
  return CATALOG.find((s) => s.resource === resource);
}
