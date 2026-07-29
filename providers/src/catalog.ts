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
  respondAsync?: (query: Record<string, string>, ctx: ServiceContext) => Promise<unknown>;
  /**
   * Refuse rather than degrade. A weather sample can serve a cached reading when
   * its upstream is down; an APR or a health factor cannot — the buyer acts on
   * it with money. When this is set the provider returns 503 and never records
   * delivery, so the escrow stays refundable instead of settling for an error.
   */
  liveOnly?: boolean;
}

/**
 * Produce a response body, honouring `liveOnly`.
 *
 * Shared by both billing paths so the escrow and tab flows can never drift into
 * answering differently — which is exactly how the tab feed ended up billing
 * for the "unavailable" placeholder.
 */
export async function produceBody(
  svc: ServiceDef,
  query: Record<string, string>,
  ctx: ServiceContext,
): Promise<{ ok: true; body: unknown; live: boolean } | { ok: false; error: string }> {
  if (!svc.respondAsync) return { ok: true, body: svc.respond(query), live: false };
  try {
    return { ok: true, body: await svc.respondAsync(query, ctx), live: true };
  } catch (err) {
    if (svc.liveOnly) return { ok: false, error: err instanceof Error ? err.message : String(err) };
    return { ok: true, body: svc.respond(query), live: false };
  }
}

/**
 * What a live service is handed at call time.
 *
 * `oracle` is optional on purpose: without it the DeFi services report
 * themselves unavailable instead of falling back to a plausible-looking number.
 * These answers are sold, and an agent moves money on them — a made-up APR is
 * worse than an error.
 */
export interface ServiceContext {
  oracle?: import("@tessera/shared").DefiOracle;
  chain: unknown;
  rpcUrl: string;
  escrowAddress: `0x${string}`;
}

/** Every DeFi service refuses rather than guesses when it cannot read the chain. */
function needOracle(ctx: ServiceContext) {
  if (!ctx.oracle) {
    throw new Error(
      "This service reads live on-chain state and the reader is not configured on this deployment.",
    );
  }
  return ctx.oracle;
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

  // ==========================================================================
  // Tessera's own DeFi services, sold to outside agents over HTTP 402.
  //
  // These are not samples. Every one reads live chain state through the shared
  // `DefiOracle`, and every one refuses rather than guesses when it cannot —
  // an agent is going to move money on the answer. `respond` still exists as
  // the interface requires it, but for these it returns the reason the live
  // read is the only acceptable path, never a plausible-looking number.
  // ==========================================================================
  {
    resource: "defi:yield-best",
    path: "/defi/yield/best",
    name: "Tessera — best yield right now",
    tags: ["defi", "yield", "apr", "treasury", "lending", "vault"],
    price: usdc("0.001"),
    slaSeconds: 30,
    behavior: "reliable",
    liveOnly: true,
    respond: () => ({ error: "live read unavailable — this service does not serve cached rates" }),
    respondAsync: async (q, ctx) => {
      const answer = await needOracle(ctx).bestYield(q.asset);
      return {
        service: "yield/best",
        ...answer,
        // Say what the buyer is meant to do with it.
        actionable: answer.best
          ? `Supply ${answer.best.asset} to the ${answer.best.venue} venue for ${answer.best.aprPct}% APR.`
          : "No venue currently offers a positive rate with liquidity to withdraw against.",
      };
    },
  },
  {
    resource: "defi:route",
    path: "/defi/route",
    name: "Tessera — best swap route",
    tags: ["defi", "swap", "route", "amm", "execution"],
    price: usdc("0.001"),
    slaSeconds: 30,
    behavior: "reliable",
    liveOnly: true,
    respond: () => ({ error: "live read unavailable — this service does not serve cached quotes" }),
    respondAsync: async (q, ctx) => {
      const oracle = needOracle(ctx);
      if (!q.tokenIn || !q.tokenOut || !q.amountIn) {
        throw new Error("tokenIn, tokenOut and amountIn (base units) are required");
      }
      // Accept a symbol as well as an address. A caller who knows the pair by
      // name shouldn't have to look up a deployment-specific address first, and
      // an unknown symbol is named in the error rather than being sent on as a
      // malformed address that reverts somewhere less obvious.
      const resolve = (v: string): `0x${string}` => {
        if (/^0x[0-9a-fA-F]{40}$/.test(v)) return v as `0x${string}`;
        const hit = oracle.assets.find((a) => a.symbol.toLowerCase() === v.toLowerCase());
        if (!hit) {
          throw new Error(
            `unknown asset "${v}" — this deployment lists ${oracle.assets.map((a) => a.symbol).join(", ") || "nothing"}`,
          );
        }
        return hit.address;
      };
      const answer = await oracle.route(resolve(q.tokenIn), resolve(q.tokenOut), BigInt(q.amountIn));
      return {
        service: "route",
        ...answer,
        actionable: answer.best
          ? `Route through the ${answer.best.venue} for ${answer.best.amountOut} ${answer.tokenOut}.`
          : "Neither venue can fill this size right now.",
      };
    },
  },
  {
    resource: "defi:health",
    path: "/defi/health",
    name: "Tessera — liquidation risk for a position",
    tags: ["defi", "risk", "health", "liquidation", "lending"],
    price: usdc("0.001"),
    slaSeconds: 30,
    behavior: "reliable",
    liveOnly: true,
    respond: () => ({ error: "live read unavailable — this service does not serve cached positions" }),
    respondAsync: async (q, ctx) => {
      const oracle = needOracle(ctx);
      if (!q.account) throw new Error("account is required");
      const h = await oracle.health(q.account as `0x${string}`);
      return {
        service: "health",
        ...h,
        actionable:
          h.band === "liquidatable"
            ? "This position can be liquidated now."
            : h.bufferPct === null
              ? "No debt, so nothing to liquidate."
              : `Collateral can fall ${h.bufferPct}% before liquidation.`,
      };
    },
  },
  {
    resource: "defi:at-risk",
    path: "/defi/at-risk",
    name: "Tessera — liquidation feed (at-risk positions)",
    tags: ["defi", "liquidation", "keeper", "feed", "risk"],
    // Tab-billed: a keeper polls this continuously, and one escrow per poll
    // would cost more in gas than the data is worth.
    price: usdc("0.0004"),
    slaSeconds: 30,
    billing: "tab",
    behavior: "reliable",
    liveOnly: true,
    respond: () => ({ error: "live read unavailable — this feed does not serve cached positions" }),
    respondAsync: async (q, ctx) => {
      const oracle = needOracle(ctx);
      // The caller supplies the addresses to check. Enumerating every borrower
      // on chain is a log scan we will not do inside a per-tick call — a keeper
      // watches a watchlist, and this prices each tick honestly.
      const accounts = String(q.accounts ?? "")
        .split(",")
        .map((a) => a.trim())
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
        .slice(0, 25);
      if (!accounts.length) {
        throw new Error("accounts is required: a comma-separated list of addresses to watch (max 25)");
      }
      const rows = await Promise.all(
        accounts.map(async (a) => {
          try {
            return await oracle.health(a as `0x${string}`);
          } catch {
            return null;
          }
        }),
      );
      const seen = rows.filter((r): r is NonNullable<typeof r> => r !== null);
      const atRisk = seen
        .filter((r) => r.band === "at-risk" || r.band === "liquidatable")
        .sort((x, y) => (x.healthFactor ?? 99) - (y.healthFactor ?? 99));
      return {
        service: "at-risk",
        checked: seen.length,
        unreadable: accounts.length - seen.length,
        atRisk,
        // The keeper's edge is the liquidation bonus on the pool, not this feed.
        actionable: atRisk.length
          ? `${atRisk.length} position(s) at or past the liquidation threshold — call liquidate() on TesseraPool to claim the bonus.`
          : "Nothing at risk among the accounts checked.",
        asOf: new Date().toISOString(),
      };
    },
  },
  {
    resource: "defi:reputation",
    path: "/defi/reputation",
    name: "Tessera — counterparty reputation oracle",
    tags: ["reputation", "trust", "counterparty", "escrow", "risk"],
    price: usdc("0.0008"),
    slaSeconds: 30,
    behavior: "reliable",
    liveOnly: true,
    respond: () => ({ error: "live read unavailable — this service does not serve cached reputation" }),
    respondAsync: async (q, ctx) => {
      const oracle = needOracle(ctx);
      if (!q.provider) throw new Error("provider address is required");
      const r = await oracle.reputation(q.provider as `0x${string}`);
      return {
        service: "reputation",
        ...r,
        // The thresholds are published so a buyer can apply their own.
        rule:
          "unknown: no history · unproven: <5 settlements · poor: <70% · mixed: <95% · good: >=95%. " +
          "Counts and stake are included so you can apply your own threshold.",
        actionable:
          r.verdict === "good"
            ? "Settled record with a real sample. Reasonable to deal with."
            : r.verdict === "unknown" || r.verdict === "unproven"
              ? "Not enough history to judge — treat as a stranger and size accordingly."
              : "Failed deliveries on record. Require stake or avoid.",
      };
    },
  },
  {
    resource: "defi:treasury",
    path: "/defi/treasury",
    name: "Tessera — managed treasury for agents",
    tags: ["defi", "treasury", "vault", "yield", "managed"],
    price: usdc("0.001"),
    slaSeconds: 30,
    behavior: "reliable",
    liveOnly: true,
    respond: () => ({ error: "live read unavailable — this service does not serve cached vault state" }),
    respondAsync: async (q, ctx) => {
      const oracle = needOracle(ctx);
      const y = await oracle.bestYield("USDC");
      const vault = y.venues.find((v) => v.venue === "vault");
      return {
        service: "treasury",
        // What an outside agent needs in order to actually do it. `deposit` on
        // the vault is permissionless, so this is a real instruction, not a
        // sales pitch — the agent keeps custody of its shares throughout.
        vault: oracle.addresses.vault ?? null,
        netAprPct: vault?.aprPct ?? null,
        note: vault?.note ?? "Vault rate unavailable — do not deposit on an unknown rate.",
        howTo: [
          "approve(vault, amount) on USDC",
          "deposit(amount) on the vault — you receive shares, and they are yours",
          "withdraw(shares) any time up to the liquid reserve",
        ],
        custody:
          "Non-custodial: shares are held by your address, not by Tessera. The performance fee is " +
          "charged on yield only, never on principal.",
        asOf: new Date().toISOString(),
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
