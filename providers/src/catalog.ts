import { usdc } from "@tessera/shared";

/**
 * A provider's honesty profile — drives the SLA outcomes (settle vs. refund).
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
  /** If set, the provider publishes a payment request (invoice) for this service. */
  invoice?: { memo: string };
  behavior: Behavior;
  /** Produces the response body for a given query. */
  respond: (query: Record<string, string>) => unknown;
  /**
   * Optional async responder that fetches a REAL upstream API. If it throws
   * (e.g. the network is unavailable), the provider falls back to `respond`,
   * so the service degrades gracefully offline while being genuinely live when it can.
   */
  respondAsync?: (query: Record<string, string>) => Promise<unknown>;
}

/**
 * The service catalog: services one of which (news) is deliberately flaky
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
    resource: "weather:live",
    path: "/weather/live",
    name: "AtmosFeed Live — real weather (Open-Meteo)",
    tags: ["weather", "climate", "forecast", "temperature", "live"],
    price: usdc("0.003"),
    slaSeconds: 30,
    behavior: "reliable",
    // Charges an agent, in USDC, for a call to a real public weather API.
    respondAsync: async (q) => {
      const geo: Record<string, [number, number]> = {
        lisbon: [38.72, -9.14], london: [51.51, -0.13], lagos: [6.52, 3.38],
        tokyo: [35.68, 139.76], "new york": [40.71, -74.01],
      };
      const city = (q.city ?? "Lisbon").toLowerCase();
      const [lat, lon] = geo[city] ?? geo["lisbon"];
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error("upstream " + r.status);
        const j = (await r.json()) as any;
        return {
          city: q.city ?? "Lisbon",
          tempC: j.current?.temperature_2m,
          humidity: j.current?.relative_humidity_2m,
          weatherCode: j.current?.weather_code,
          source: "Open-Meteo (live)",
        };
      } finally {
        clearTimeout(timer);
      }
    },
    respond: (q) => ({
      city: q.city ?? "Lisbon",
      tempC: 20,
      humidity: 60,
      note: "offline fallback",
      source: "AtmosFeed cache",
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
    slaSeconds: 8, // short window so the SLA-timeout path resolves quickly
    // Flaky on purpose: it takes payment but returns empty junk, so the agent's
    // quality check fails and it reclaims the escrow.
    behavior: "bad-data",
    respond: () => ({ headlines: [], note: "service degraded" }),
  },
  {
    resource: "subscription:fx",
    path: "/subscription/fx",
    name: "ParityDesk — FX Pro subscription",
    tags: ["subscription"],
    price: usdc("0.004"),
    slaSeconds: 30,
    behavior: "reliable",
    invoice: { memo: "Monthly FX Pro data subscription renewal" },
    respond: () => ({
      renewed: true,
      plan: "FX Pro",
      until: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
      source: "ParityDesk",
    }),
  },
  {
    resource: "subscription:news",
    path: "/subscription/news",
    name: "WireScoop — news digest subscription",
    tags: ["subscription"],
    price: usdc("0.0035"),
    slaSeconds: 30,
    behavior: "bad-data",
    invoice: { memo: "News digest subscription renewal" },
    respond: () => ({ renewed: false, note: "service degraded" }),
  },
  {
    resource: "alpha:report",
    path: "/alpha",
    name: "AlphaSignal — premium market analysis",
    tags: ["analysis", "premium", "alpha", "research"],
    // Deliberately priced above the default policy's auto-approve cap, so buying
    // it requires the guardian's co-signature (LOBSTR-Vault-style escalation).
    price: usdc("0.008"),
    slaSeconds: 30,
    behavior: "reliable",
    respond: (q) => ({
      subject: q.subject ?? "EUR macro",
      stance: "cautiously bullish",
      confidence: 0.72,
      drivers: ["ECB pause priced in", "EURUSD momentum", "energy costs easing"],
      source: "AlphaSignal",
    }),
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

/** Tiny deterministic string hash for stable sample data. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function serviceByResource(resource: string): ServiceDef | undefined {
  return CATALOG.find((s) => s.resource === resource);
}
