/**
 * Live market and news feeds for the Agent workspace.
 *
 * ## The rule that shapes this file
 * **Never invent a number.** Every price, rate and headline here comes from a
 * named upstream source, and when a source is unreachable the feed reports
 * `ok: false` with a reason rather than a plausible-looking figure. A dashboard
 * that quietly shows a stale or fabricated price is worse than one that says it
 * doesn't know — someone might trade on it.
 *
 * ## Sources
 *  - **FX** — Frankfurter (European Central Bank reference rates), with Yahoo
 *    Finance as a fallback. ECB rates are published once per working day, so the
 *    payload carries the reference date and the UI shows it.
 *  - **Crypto** — CoinGecko public API, including 24h/7d/30d/1y changes.
 *  - **Stocks / indices / commodities** — Yahoo Finance chart API.
 *  - **Policy rates & central-bank balance sheets** — FRED (Federal Reserve
 *    Bank of St. Louis) series, read as CSV. Rate *decisions* are derived from
 *    the series itself: the effective date of the current setting is the day
 *    after the last day the series held a different value, and the size of the
 *    move is that difference. QE/QT direction is the sign of the change in total
 *    assets over 4/13/52 weeks. Both are arithmetic on published data — no
 *    forecast, no editorial reading of a statement.
 *  - **News** — public RSS feeds, one or more per topic.
 *
 * ## Caching
 * Every fetch is cached, because these are public endpoints with rate limits and
 * the dashboard polls. A cached value is served with its age attached so the UI
 * can show "as of"; a failed refresh keeps serving the last good value and says
 * it is stale rather than blanking the panel.
 */

const UA = "Mozilla/5.0 (compatible; Tessera/1.0; +https://github.com/rgdtnhat/arc)";

/** Fetch with a hard timeout — a hung upstream must never hang our request. */
async function get(url: string, timeoutMs = 9000, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "*/*", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res;
}
const getJson = async <T>(url: string, timeoutMs?: number): Promise<T> => (await get(url, timeoutMs)).json() as Promise<T>;
const getText = async (url: string, timeoutMs?: number): Promise<string> => (await get(url, timeoutMs)).text();

// --- cache -----------------------------------------------------------------

interface Entry<T> {
  value: T;
  at: number;
  /** Set when the most recent refresh failed and this is the previous value. */
  error?: string;
}
const cache = new Map<string, Entry<unknown>>();
let inflight = new Map<string, Promise<unknown>>();

/**
 * Serve from cache while fresh; refresh otherwise. A failed refresh downgrades
 * to the last good value marked stale, so one bad poll never empties a panel.
 * Concurrent callers share one upstream request.
 */
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<Entry<T>> {
  const hit = cache.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs && !hit.error) return hit;
  const pending = inflight.get(key) as Promise<Entry<T>> | undefined;
  if (pending) return pending;

  const job = (async () => {
    try {
      const value = await load();
      const entry: Entry<T> = { value, at: Date.now() };
      cache.set(key, entry);
      return entry;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 120);
      if (hit) {
        // Keep the old value but mark it, so the UI can say "last updated at…"
        // instead of pretending the number is current.
        const stale: Entry<T> = { ...hit, error: msg };
        cache.set(key, stale);
        return stale;
      }
      throw new Error(msg);
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

export interface FeedResult<T> {
  ok: boolean;
  items: T;
  source: string;
  /** ISO timestamp of the data we are serving. */
  asOf: string;
  /** Seconds since the value was fetched. */
  ageSeconds: number;
  /** Present when the last refresh failed; the items are the previous good ones. */
  warning?: string;
  error?: string;
}

function wrap<T>(entry: Entry<T>, source: string, empty: T): FeedResult<T> {
  return {
    ok: !entry.error,
    items: entry.value ?? empty,
    source,
    asOf: new Date(entry.at).toISOString(),
    ageSeconds: Math.round((Date.now() - entry.at) / 1000),
    ...(entry.error ? { warning: `Live refresh failed (${entry.error}); showing the last values received.` } : {}),
  };
}

function failed<T>(source: string, empty: T, e: unknown): FeedResult<T> {
  return {
    ok: false,
    items: empty,
    source,
    asOf: new Date().toISOString(),
    ageSeconds: 0,
    error: `Couldn't reach ${source}: ${String((e as Error)?.message ?? e).slice(0, 120)}`,
  };
}

// --- FX ---------------------------------------------------------------------

export interface FxRate {
  pair: string;
  base: string;
  quote: string;
  rate: number;
  /** Percentage change vs the previous published reference rate. */
  changePct: number | null;
  /** Grouping for the table, so a long list stays navigable. */
  group: string;
}

/**
 * Pairs are grouped the way a dealing desk groups them, and every currency here
 * is one the ECB actually publishes a reference rate for — asking Frankfurter
 * for a currency outside its table would silently drop the row.
 */
const FX_GROUPS: { group: string; pairs: [string, string][] }[] = [
  {
    group: "Majors",
    pairs: [
      ["EUR", "USD"], ["GBP", "USD"], ["USD", "JPY"], ["AUD", "USD"],
      ["USD", "CHF"], ["USD", "CAD"], ["NZD", "USD"],
    ],
  },
  {
    group: "Crosses",
    pairs: [
      ["EUR", "GBP"], ["EUR", "JPY"], ["GBP", "JPY"], ["EUR", "CHF"],
      ["AUD", "JPY"], ["EUR", "AUD"], ["EUR", "CAD"], ["CHF", "JPY"],
      ["GBP", "AUD"], ["EUR", "NZD"],
    ],
  },
  {
    group: "Europe & Nordics",
    pairs: [
      ["EUR", "SEK"], ["EUR", "NOK"], ["EUR", "DKK"], ["EUR", "PLN"],
      ["EUR", "CZK"], ["EUR", "HUF"], ["USD", "SEK"], ["USD", "NOK"],
      ["USD", "TRY"], ["USD", "ISK"], ["EUR", "RON"], ["EUR", "BGN"],
    ],
  },
  {
    group: "Asia & Pacific",
    pairs: [
      ["USD", "CNY"], ["USD", "SGD"], ["USD", "INR"], ["USD", "HKD"],
      ["USD", "KRW"], ["USD", "THB"], ["USD", "IDR"], ["USD", "MYR"],
      ["USD", "PHP"], ["EUR", "CNY"], ["EUR", "INR"],
    ],
  },
  {
    group: "Americas, Middle East & Africa",
    pairs: [
      ["USD", "MXN"], ["USD", "BRL"], ["USD", "ZAR"], ["USD", "ILS"],
      ["EUR", "MXN"], ["EUR", "ZAR"], ["EUR", "BRL"],
    ],
  },
];

const FX_PAIRS: [string, string][] = FX_GROUPS.flatMap((g) => g.pairs);
const FX_GROUP_OF = new Map(
  FX_GROUPS.flatMap((g) => g.pairs.map(([b, q]) => [`${b}/${q}`, g.group] as const)),
);

/**
 * ECB reference rates via Frankfurter. One request for today and one for the
 * previous publication, so the change column is a real comparison rather than a
 * guess. ECB publishes on working days only — the payload's date says which.
 */
async function loadFx(): Promise<{ rates: FxRate[]; date: string; previousDate: string }> {
  const symbols = [...new Set(FX_PAIRS.flatMap(([a, b]) => [a, b]))].filter((s) => s !== "USD").join(",");
  // The rates themselves get a generous budget; the history used only for the
  // change column gets its own, and failing it must not lose the rates.
  const latest = await getJson<{ date: string; rates: Record<string, number> }>(
    `https://api.frankfurter.dev/v1/latest?base=USD&symbols=${symbols}`,
    20_000,
  );
  // Look back far enough to clear a weekend or holiday run.
  const from = new Date(Date.parse(latest.date) - 8 * 86_400_000).toISOString().slice(0, 10);
  let prev: Record<string, number> = {};
  let prevDate = "";
  try {
    const series = await getJson<{ rates: Record<string, Record<string, number>> }>(
      `https://api.frankfurter.dev/v1/${from}..${latest.date}?base=USD&symbols=${symbols}`,
      20_000,
    );
    const days = Object.keys(series.rates).sort();
    // The last entry is today's; the one before it is what we compare against.
    prevDate = days[days.length - 2] ?? "";
    prev = prevDate ? series.rates[prevDate] : {};
  } catch {
    /* No comparison available — the change column shows "—" rather than 0. */
  }

  const rateFor = (base: string, quote: string, table: Record<string, number>) => {
    if (base === "USD") return table[quote];
    if (quote === "USD") return table[base] ? 1 / table[base] : undefined;
    return table[base] && table[quote] ? table[quote] / table[base] : undefined;
  };

  const rates: FxRate[] = [];
  for (const [base, quote] of FX_PAIRS) {
    const now = rateFor(base, quote, latest.rates);
    if (now === undefined || !Number.isFinite(now)) continue;
    const before = rateFor(base, quote, prev);
    const pair = `${base}/${quote}`;
    rates.push({
      pair,
      base,
      quote,
      rate: now,
      changePct: before && Number.isFinite(before) ? ((now - before) / before) * 100 : null,
      group: FX_GROUP_OF.get(pair) ?? "Other",
    });
  }
  return { rates, date: latest.date, previousDate: prevDate };
}

/**
 * Fallback FX from Yahoo. Used only when the ECB feed is unreachable, and
 * labelled as such — the two are not the same thing (ECB publishes a daily
 * fixing, Yahoo is a live market quote) and conflating them silently would be
 * misleading about what the numbers mean.
 */
async function loadFxYahoo(): Promise<{ rates: FxRate[]; date: string; previousDate: string }> {
  const quotes = await loadQuotes(
    FX_PAIRS.map(([b, q]) => ({ symbol: `${b}${q}=X`, name: `${b}/${q}` })),
  );
  return {
    rates: quotes.map((q) => {
      const [base, quote] = q.name.split("/");
      return {
        pair: q.name,
        base,
        quote,
        rate: q.price,
        changePct: q.changePct,
        group: FX_GROUP_OF.get(q.name) ?? "Other",
      };
    }),
    date: new Date().toISOString().slice(0, 10),
    previousDate: "",
  };
}

export async function fx(): Promise<
  FeedResult<{ rates: FxRate[]; date: string; previousDate: string }>
> {
  const empty = { rates: [], date: "", previousDate: "" };
  try {
    return wrap(await cached("fx", 10 * 60_000, loadFx), "Frankfurter (ECB reference rates)", empty);
  } catch {
    try {
      const r = wrap(await cached("fx:yahoo", 5 * 60_000, loadFxYahoo), "Yahoo Finance (live quotes)", empty);
      return { ...r, warning: "ECB reference rates were unreachable; showing live market quotes instead." };
    } catch (e2) {
      return failed("Frankfurter and Yahoo", empty, e2);
    }
  }
}

// --- Crypto -----------------------------------------------------------------

export interface CryptoRow {
  id: string;
  symbol: string;
  name: string;
  price: number;
  marketCap: number;
  volume24h: number;
  changeDay: number | null;
  changeWeek: number | null;
  changeMonth: number | null;
  changeYear: number | null;
}

/**
 * CoinGecko ids, not tickers. An id that no longer exists is simply absent from
 * the response, so a renamed coin costs one missing row rather than an error —
 * which is why this list can be long without becoming fragile.
 */
const CRYPTO_IDS = [
  // majors
  "bitcoin", "ethereum", "solana", "ripple", "cardano", "binancecoin",
  "dogecoin", "avalanche-2", "tron", "the-open-network", "polkadot", "chainlink",
  // stablecoins and wrapped assets
  "usd-coin", "tether", "dai", "ethena-usde", "wrapped-bitcoin", "staked-ether",
  // layer 1 / layer 2
  "sui", "aptos", "near", "arbitrum", "optimism", "polygon-ecosystem-token",
  "cosmos", "algorand", "internet-computer", "hedera-hashgraph", "stellar",
  "litecoin", "bitcoin-cash", "ethereum-classic", "monero", "kaspa", "sei-network",
  // defi and infrastructure
  "uniswap", "aave", "maker", "lido-dao", "curve-dao-token", "the-graph",
  "injective-protocol", "render-token", "filecoin", "quant-network", "thorchain",
  // consumer and meme
  "shiba-inu", "pepe", "immutable-x", "the-sandbox", "decentraland", "chiliz",
];

async function loadCrypto(): Promise<CryptoRow[]> {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=" +
    CRYPTO_IDS.join(",") +
    "&order=market_cap_desc&sparkline=false&price_change_percentage=24h%2C7d%2C30d%2C1y";
  const raw = await getJson<Record<string, unknown>[]>(url, 12_000);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return raw.map((c) => ({
    id: String(c.id),
    symbol: String(c.symbol ?? "").toUpperCase(),
    name: String(c.name ?? ""),
    price: Number(c.current_price ?? 0),
    marketCap: Number(c.market_cap ?? 0),
    volume24h: Number(c.total_volume ?? 0),
    changeDay: num(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
    changeWeek: num(c.price_change_percentage_7d_in_currency),
    changeMonth: num(c.price_change_percentage_30d_in_currency),
    changeYear: num(c.price_change_percentage_1y_in_currency),
  }));
}

export async function crypto(): Promise<FeedResult<CryptoRow[]>> {
  try {
    return wrap(await cached("crypto", 90_000, loadCrypto), "CoinGecko", []);
  } catch (e) {
    return failed("CoinGecko", [] as CryptoRow[], e);
  }
}

// --- Quotes (stocks, indices, commodities) ----------------------------------

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  currency: string;
  changePct: number | null;
  changeAbs: number | null;
  previousClose: number | null;
  marketState: string;
  /** Grouping label for the table; empty when the caller didn't supply one. */
  sector: string;
}

/**
 * One Yahoo chart request per symbol, run with limited concurrency.
 *
 * `chart` rather than `quote`: the quote endpoint requires a crumb/cookie dance
 * that breaks without warning, while chart is stable and carries everything
 * needed. A symbol that fails is dropped from the list rather than shown at
 * zero — a price of 0.00 next to a real one is actively misleading.
 */
async function loadQuotes(
  symbols: { symbol: string; name: string; sector?: string }[],
): Promise<Quote[]> {
  const out: Quote[] = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ symbol, name, sector }) => {
        const j = await getJson<{
          chart: { result?: { meta: Record<string, unknown> }[]; error?: unknown };
        }>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, 9000);
        const meta = j.chart?.result?.[0]?.meta;
        if (!meta) throw new Error("no data");
        const price = Number(meta.regularMarketPrice);
        const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
        if (!Number.isFinite(price) || price <= 0) throw new Error("no price");
        const hasPrev = Number.isFinite(prev) && prev > 0;
        return {
          symbol,
          name,
          price,
          currency: String(meta.currency ?? "USD"),
          previousClose: hasPrev ? prev : null,
          changeAbs: hasPrev ? price - prev : null,
          changePct: hasPrev ? ((price - prev) / prev) * 100 : null,
          marketState: String(meta.marketState ?? ""),
          sector: sector ?? "",
        } as Quote;
      }),
    );
    for (const r of settled) if (r.status === "fulfilled") out.push(r.value);
  }
  if (!out.length) throw new Error("no symbols returned data");
  return out;
}

/**
 * Each symbol costs one upstream request, so these lists are a deliberate
 * trade: wide enough to be a real market view, short enough that a refresh
 * finishes inside the cache window without Yahoo throttling us. `sector` is
 * only a label for grouping the table.
 */
const STOCKS = [
  { symbol: "AAPL", name: "Apple", sector: "Technology" },
  { symbol: "MSFT", name: "Microsoft", sector: "Technology" },
  { symbol: "NVDA", name: "NVIDIA", sector: "Technology" },
  { symbol: "AVGO", name: "Broadcom", sector: "Technology" },
  { symbol: "AMD", name: "AMD", sector: "Technology" },
  { symbol: "ORCL", name: "Oracle", sector: "Technology" },
  { symbol: "CRM", name: "Salesforce", sector: "Technology" },
  { symbol: "ARM", name: "Arm Holdings", sector: "Technology" },
  { symbol: "TSM", name: "TSMC", sector: "Technology" },
  { symbol: "ASML", name: "ASML", sector: "Technology" },
  { symbol: "GOOGL", name: "Alphabet", sector: "Communication" },
  { symbol: "META", name: "Meta", sector: "Communication" },
  { symbol: "NFLX", name: "Netflix", sector: "Communication" },
  { symbol: "DIS", name: "Disney", sector: "Communication" },
  { symbol: "AMZN", name: "Amazon", sector: "Consumer" },
  { symbol: "TSLA", name: "Tesla", sector: "Consumer" },
  { symbol: "WMT", name: "Walmart", sector: "Consumer" },
  { symbol: "MCD", name: "McDonald's", sector: "Consumer" },
  { symbol: "KO", name: "Coca-Cola", sector: "Consumer" },
  { symbol: "NKE", name: "Nike", sector: "Consumer" },
  { symbol: "JPM", name: "JPMorgan Chase", sector: "Financials" },
  { symbol: "BAC", name: "Bank of America", sector: "Financials" },
  { symbol: "GS", name: "Goldman Sachs", sector: "Financials" },
  { symbol: "V", name: "Visa", sector: "Financials" },
  { symbol: "MA", name: "Mastercard", sector: "Financials" },
  { symbol: "BRK-B", name: "Berkshire Hathaway", sector: "Financials" },
  { symbol: "COIN", name: "Coinbase", sector: "Digital assets" },
  { symbol: "MSTR", name: "Strategy", sector: "Digital assets" },
  { symbol: "PYPL", name: "PayPal", sector: "Digital assets" },
  { symbol: "XOM", name: "ExxonMobil", sector: "Energy & industrials" },
  { symbol: "CVX", name: "Chevron", sector: "Energy & industrials" },
  { symbol: "CAT", name: "Caterpillar", sector: "Energy & industrials" },
  { symbol: "BA", name: "Boeing", sector: "Energy & industrials" },
  { symbol: "LLY", name: "Eli Lilly", sector: "Healthcare" },
  { symbol: "UNH", name: "UnitedHealth", sector: "Healthcare" },
  { symbol: "JNJ", name: "Johnson & Johnson", sector: "Healthcare" },
];

const INDICES = [
  { symbol: "^GSPC", name: "S&P 500", sector: "United States" },
  { symbol: "^IXIC", name: "Nasdaq Composite", sector: "United States" },
  { symbol: "^DJI", name: "Dow Jones Industrial", sector: "United States" },
  { symbol: "^RUT", name: "Russell 2000", sector: "United States" },
  { symbol: "^FTSE", name: "FTSE 100", sector: "Europe" },
  { symbol: "^GDAXI", name: "DAX", sector: "Europe" },
  { symbol: "^FCHI", name: "CAC 40", sector: "Europe" },
  { symbol: "^STOXX50E", name: "Euro Stoxx 50", sector: "Europe" },
  { symbol: "^N225", name: "Nikkei 225", sector: "Asia-Pacific" },
  { symbol: "^HSI", name: "Hang Seng", sector: "Asia-Pacific" },
  { symbol: "^AXJO", name: "ASX 200", sector: "Asia-Pacific" },
  { symbol: "^KS11", name: "KOSPI", sector: "Asia-Pacific" },
  { symbol: "^BSESN", name: "BSE Sensex", sector: "Asia-Pacific" },
  { symbol: "^VIX", name: "VIX (volatility)", sector: "Rates & volatility" },
  { symbol: "^TNX", name: "US 10-year yield", sector: "Rates & volatility" },
  { symbol: "DX-Y.NYB", name: "US dollar index", sector: "Rates & volatility" },
];

const COMMODITIES = [
  { symbol: "GC=F", name: "Gold", sector: "Precious metals" },
  { symbol: "SI=F", name: "Silver", sector: "Precious metals" },
  { symbol: "PL=F", name: "Platinum", sector: "Precious metals" },
  { symbol: "PA=F", name: "Palladium", sector: "Precious metals" },
  { symbol: "HG=F", name: "Copper", sector: "Industrial metals" },
  { symbol: "ALI=F", name: "Aluminium", sector: "Industrial metals" },
  { symbol: "CL=F", name: "Crude oil (WTI)", sector: "Energy" },
  { symbol: "BZ=F", name: "Brent crude", sector: "Energy" },
  { symbol: "NG=F", name: "Natural gas", sector: "Energy" },
  { symbol: "RB=F", name: "RBOB gasoline", sector: "Energy" },
  { symbol: "HO=F", name: "Heating oil", sector: "Energy" },
  { symbol: "ZC=F", name: "Corn", sector: "Agriculture" },
  { symbol: "ZW=F", name: "Wheat", sector: "Agriculture" },
  { symbol: "ZS=F", name: "Soybeans", sector: "Agriculture" },
  { symbol: "KC=F", name: "Coffee", sector: "Softs" },
  { symbol: "SB=F", name: "Sugar", sector: "Softs" },
  { symbol: "CC=F", name: "Cocoa", sector: "Softs" },
  { symbol: "CT=F", name: "Cotton", sector: "Softs" },
];

export async function stocks(): Promise<FeedResult<{ stocks: Quote[]; indices: Quote[] }>> {
  const empty = { stocks: [], indices: [] };
  try {
    // Three minutes rather than two: the list is wider now, and these are daily
    // closes plus an intraday last — a slightly older cache costs nothing and
    // keeps us well inside what a public endpoint will tolerate.
    const entry = await cached("stocks", 180_000, async () => ({
      stocks: await loadQuotes(STOCKS),
      indices: await loadQuotes(INDICES),
    }));
    return wrap(entry, "Yahoo Finance", empty);
  } catch (e) {
    return failed("Yahoo Finance", empty, e);
  }
}

export async function commodities(): Promise<FeedResult<Quote[]>> {
  try {
    return wrap(await cached("commodities", 180_000, () => loadQuotes(COMMODITIES)), "Yahoo Finance", []);
  } catch (e) {
    return failed("Yahoo Finance", [] as Quote[], e);
  }
}

// --- Central banks: policy rates and balance sheets --------------------------

/**
 * A FRED observation series, oldest first. `.` is FRED's missing-value marker
 * and those rows are dropped rather than read as zero.
 */
export interface Obs {
  date: string;
  value: number;
}

async function loadFredSeries(id: string, sinceISO: string): Promise<Obs[]> {
  const csv = await getText(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${sinceISO}`,
    15_000,
  );
  const out: Obs[] = [];
  for (const line of csv.split("\n").slice(1)) {
    const [date, raw] = line.trim().split(",");
    if (!date || !raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue; // FRED writes "." for no observation
    out.push({ date, value });
  }
  if (!out.length) throw new Error(`no observations for ${id}`);
  return out;
}

/** Every series in one shot, with the same limited concurrency as the quotes. */
async function loadFred(ids: string[], sinceISO: string): Promise<Record<string, Obs[]>> {
  const out: Record<string, Obs[]> = {};
  const CONCURRENCY = 5;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((id) => loadFredSeries(id, sinceISO)));
    settled.forEach((r, k) => { if (r.status === "fulfilled") out[batch[k]] = r.value; });
  }
  if (!Object.keys(out).length) throw new Error("no FRED series was reachable");
  return out;
}

export interface PolicyRate {
  bank: string;
  /** What the number actually is. Never "the policy rate" when it is a proxy. */
  instrument: string;
  /** Formatted for display, e.g. "3.50–3.75%". */
  display: string;
  /** The comparable single number (the top of a range). */
  value: number;
  /** ISO date of the latest observation. */
  asOf: string;
  /** ISO date this level took effect, derived from the series. */
  since: string | null;
  /** Size of the move onto this level, in basis points. */
  moveBps: number | null;
  /** How long the level has held, in days. */
  heldDays: number | null;
  source: string;
}

export interface BalanceSheet {
  bank: string;
  label: string;
  /** Millions of the currency named in `unit`. */
  latest: number;
  unit: string;
  asOf: string;
  change4w: number | null;
  change13w: number | null;
  change52w: number | null;
  /** Sign of the 13-week change: what the balance sheet is actually doing. */
  stance: "expanding" | "contracting" | "broadly flat";
  source: string;
}

export interface MarketRate {
  label: string;
  value: number;
  unit: string;
  asOf: string;
  /** Change since `changeFrom`, which is *about* a week back but not exactly. */
  change: number | null;
  /** The observation date the change was measured against, or null. */
  changeFrom: string | null;
  note: string;
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/**
 * When did the current level take effect, and how big was the step onto it?
 *
 * Walk backwards from the latest observation to the first one that differs.
 * The observation *after* that is when the level began — which for a daily
 * policy-rate series is the effective date of the decision, and the difference
 * is the size of the cut or hike. This is measurement, not interpretation: we
 * are reading the rate the central bank set, not what its statement said.
 */
export function lastChange(obs: Obs[]): { since: string | null; moveBps: number | null } {
  if (obs.length < 2) return { since: null, moveBps: null };
  const current = obs[obs.length - 1].value;
  for (let i = obs.length - 2; i >= 0; i--) {
    if (Math.abs(obs[i].value - current) > 1e-9) {
      return { since: obs[i + 1].date, moveBps: Math.round((current - obs[i].value) * 100) };
    }
  }
  return { since: null, moveBps: null }; // unchanged across the whole window
}

/**
 * Change over roughly N weeks, and the observation it was measured against.
 *
 * The comparison date is returned rather than assumed because these series do
 * not share a frequency: asking a monthly series for a one-week change lands on
 * last month's value, and reporting that as "on the week" would be wrong. The
 * caller shows the date it actually compared with.
 */
export function changeDetail(obs: Obs[], weeks: number): { change: number | null; from: string | null } {
  const latest = obs[obs.length - 1];
  const target = Date.parse(latest.date) - weeks * 7 * DAY;
  let best: Obs | null = null;
  for (const o of obs) {
    if (Date.parse(o.date) <= target) best = o;
    else break;
  }
  return best ? { change: latest.value - best.value, from: best.date } : { change: null, from: null };
}

/** Change over roughly N weeks, for the series where the frequency is known. */
export function changeOver(obs: Obs[], weeks: number): number | null {
  return changeDetail(obs, weeks).change;
}

const POLICY_SERIES = ["DFEDTARU", "DFEDTARL", "ECBDFR", "ECBMRRFR", "IUDSOIA", "IRSTCI01JPM156N"];
const SHEET_SERIES = ["WALCL", "WSHOSHO", "WSHOMCB", "ECBASSETSW"];
const MARKET_SERIES = ["DGS10", "DGS2", "T10Y2Y", "T10YIE", "RRPONTSYD"];

async function loadRates(): Promise<{
  policy: PolicyRate[];
  sheets: BalanceSheet[];
  market: MarketRate[];
}> {
  // Two years of history: enough to date a policy change that has held for a
  // long time, and enough for a 52-week balance-sheet comparison.
  const since = new Date(Date.now() - 760 * DAY).toISOString().slice(0, 10);
  const s = await loadFred([...POLICY_SERIES, ...SHEET_SERIES, ...MARKET_SERIES], since);
  const SRC = "FRED (Federal Reserve Bank of St. Louis)";
  const today = new Date().toISOString().slice(0, 10);

  const policy: PolicyRate[] = [];
  const push = (
    bank: string,
    instrument: string,
    obs: Obs[] | undefined,
    display: (v: number) => string,
  ) => {
    if (!obs?.length) return;
    const latest = obs[obs.length - 1];
    const { since: from, moveBps } = lastChange(obs);
    policy.push({
      bank,
      instrument,
      display: display(latest.value),
      value: latest.value,
      asOf: latest.date,
      since: from,
      moveBps,
      heldDays: from ? daysBetween(from, today) : null,
      source: SRC,
    });
  };

  // The Fed publishes the range as two series; show it as the range it is.
  const up = s.DFEDTARU;
  const lo = s.DFEDTARL;
  if (up?.length && lo?.length) {
    const { since: from, moveBps } = lastChange(up);
    policy.push({
      bank: "Federal Reserve",
      instrument: "Federal funds target range",
      display: `${lo[lo.length - 1].value.toFixed(2)}–${up[up.length - 1].value.toFixed(2)}%`,
      value: up[up.length - 1].value,
      asOf: up[up.length - 1].date,
      since: from,
      moveBps,
      heldDays: from ? daysBetween(from, today) : null,
      source: SRC,
    });
  }
  push("European Central Bank", "Deposit facility rate", s.ECBDFR, (v) => `${v.toFixed(2)}%`);
  push("European Central Bank", "Main refinancing rate", s.ECBMRRFR, (v) => `${v.toFixed(2)}%`);
  // The UK and Japan appear further down, among the market-set rates. FRED has
  // no live Bank Rate or BoJ policy-rate series, only realised overnight market
  // rates. Those drift by fractions of a basis point every day, so running the
  // "last change" derivation over them produces a meaningless "0 bp move
  // yesterday" — and putting them in this table at all would imply a decision
  // nobody made. This table holds administered rates only.

  const sheets: BalanceSheet[] = [];
  const sheet = (bank: string, label: string, id: string, unit: string) => {
    const obs = s[id];
    if (!obs?.length) return;
    const latest = obs[obs.length - 1];
    const c4 = changeOver(obs, 4);
    const c13 = changeOver(obs, 13);
    const c52 = changeOver(obs, 52);
    // "Broadly flat" is anything inside ±1% of the total over a quarter.
    // A central bank's balance sheet moves for reasons that are not policy —
    // reinvestment timing, currency swap lines, a Treasury cash balance shift —
    // and calling a 0.5% quarterly drift "quantitative easing" would be reading
    // a decision into noise. The band is wide on purpose.
    const threshold = latest.value * 0.01;
    sheets.push({
      bank,
      label,
      latest: latest.value,
      unit,
      asOf: latest.date,
      change4w: c4,
      change13w: c13,
      change52w: c52,
      stance:
        c13 === null || Math.abs(c13) < threshold
          ? "broadly flat"
          : c13 > 0
            ? "expanding"
            : "contracting",
      source: SRC,
    });
  };
  sheet("Federal Reserve", "Total assets", "WALCL", "USD millions");
  sheet("Federal Reserve", "Treasury securities held", "WSHOSHO", "USD millions");
  sheet("Federal Reserve", "Mortgage-backed securities held", "WSHOMCB", "USD millions");
  sheet("European Central Bank", "Total assets (Eurosystem)", "ECBASSETSW", "EUR millions");

  const market: MarketRate[] = [];
  const mkt = (label: string, id: string, unit: string, note: string) => {
    const obs = s[id];
    if (!obs?.length) return;
    const latest = obs[obs.length - 1];
    const { change, from } = changeDetail(obs, 1);
    market.push({ label, value: latest.value, unit, asOf: latest.date, change, changeFrom: from, note });
  };
  mkt("US 2-year Treasury", "DGS2", "%", "The maturity that tracks expected policy most closely.");
  mkt("US 10-year Treasury", "DGS10", "%", "The long end — growth and term premium, not just policy.");
  mkt("10-year minus 2-year", "T10Y2Y", "pp", "Negative is an inverted curve.");
  mkt("10-year breakeven inflation", "T10YIE", "%", "Inflation the bond market is pricing in over ten years.");
  mkt("Overnight reverse repo", "RRPONTSYD", "USD billions", "Cash parked at the Fed; a drain from bank reserves.");
  mkt("SONIA (UK overnight)", "IUDSOIA", "%", "Realised sterling overnight rate — the closest live proxy for Bank Rate, not the decision itself.");
  mkt("Japan call money (overnight)", "IRSTCI01JPM156N", "%", "Realised interbank overnight rate in Japan; monthly, and not the BoJ's policy rate.");

  return { policy, sheets, market };
}

export async function rates(): Promise<
  FeedResult<{ policy: PolicyRate[]; sheets: BalanceSheet[]; market: MarketRate[] }>
> {
  const empty = { policy: [], sheets: [], market: [] };
  try {
    // These series update daily at best and weekly for the balance sheets, so a
    // six-hour cache is still fresher than the data.
    return wrap(await cached("rates", 6 * 3600_000, loadRates), "FRED (St. Louis Fed)", empty);
  } catch (e) {
    return failed("FRED (St. Louis Fed)", empty, e);
  }
}

// --- News -------------------------------------------------------------------

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  topic: string;
  publishedAt: number;
}

/**
 * Topic → RSS feeds. Kept broad on purpose: the request was for a wide sweep of
 * subjects, and a topic whose feeds are all unreachable simply contributes
 * nothing rather than breaking the tab.
 */
export const NEWS_TOPICS: Record<string, string[]> = {
  general: ["https://feeds.bbci.co.uk/news/world/rss.xml"],
  economic: ["https://feeds.bbci.co.uk/news/business/rss.xml"],
  technology: ["https://feeds.arstechnica.com/arstechnica/technology-lab", "https://hnrss.org/frontpage"],
  science: ["https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", "https://phys.org/rss-feed/"],
  crypto: ["https://cointelegraph.com/rss", "https://www.coindesk.com/arc/outboundfeeds/rss/"],
  investment: ["https://feeds.content.dowjones.io/public/rss/mw_topstories"],
  trading: ["https://feeds.content.dowjones.io/public/rss/mw_marketpulse"],
  life: ["https://feeds.bbci.co.uk/news/health/rss.xml"],
  sport: ["https://feeds.bbci.co.uk/sport/rss.xml"],
  tips: ["https://lifehacker.com/feed/rss"],
  book: ["https://www.theguardian.com/books/rss"],
  exploring: ["https://feeds.bbci.co.uk/news/world/rss.xml"],
  security: ["https://krebsonsecurity.com/feed/", "https://www.bleepingcomputer.com/feed/"],
  space: ["https://www.nasa.gov/rss/dyn/breaking_news.rss", "https://phys.org/rss-feed/space-news/"],
  ai: ["https://hnrss.org/newest?q=AI+OR+LLM+OR+agent", "https://phys.org/rss-feed/technology-news/machine-learning-ai/"],
  agent: ["https://hnrss.org/newest?q=AI+agent+OR+autonomous"],
  universe: ["https://phys.org/rss-feed/space-news/astronomy/"],
  psychology: ["https://phys.org/rss-feed/science-news/social-sciences/"],
  spirituality: ["https://www.theguardian.com/world/religion/rss"],
  environment: ["https://feeds.bbci.co.uk/news/science_and_environment/rss.xml"],
  biology: ["https://phys.org/rss-feed/biology-news/"],
};

const decodeEntities = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();

/**
 * Minimal RSS/Atom extraction.
 *
 * A full XML parser is not worth a dependency here: we want four fields, and
 * anything we fail to parse is simply skipped. Nothing from these documents is
 * ever rendered as markup — the client escapes every field — so a malformed or
 * hostile feed can produce a missing headline at worst.
 */
function parseFeed(xml: string, source: string, topic: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const b of blocks.slice(0, 30)) {
    const title = decodeEntities((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 300));
    // RSS puts the URL in <link>text</link>; Atom puts it in href.
    const link =
      decodeEntities(b.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? "") ||
      decodeEntities(b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ?? "");
    const dateRaw =
      b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] ??
      b.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i)?.[1] ??
      b.match(/<published[^>]*>([\s\S]*?)<\/published>/i)?.[1] ??
      "";
    const ts = Date.parse(decodeEntities(dateRaw));
    if (!title || !/^https?:\/\//i.test(link)) continue;
    items.push({
      title,
      link,
      source,
      topic,
      publishedAt: Number.isFinite(ts) ? ts : Date.now(),
    });
  }
  return items;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

async function loadTopic(topic: string): Promise<NewsItem[]> {
  const urls = NEWS_TOPICS[topic] ?? [];
  const settled = await Promise.allSettled(
    urls.map(async (u) => parseFeed(await getText(u, 9000), hostOf(u), topic)),
  );
  const items = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!items.length) throw new Error("no feed reachable for this topic");
  return items;
}

export async function news(topics: string[]): Promise<FeedResult<NewsItem[]>> {
  const wanted = topics.filter((t) => t in NEWS_TOPICS);
  const list = wanted.length ? wanted : Object.keys(NEWS_TOPICS);
  const settled = await Promise.allSettled(
    list.map(async (t) => (await cached(`news:${t}`, 10 * 60_000, () => loadTopic(t))).value),
  );
  const items = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const failedTopics = list.filter((_, i) => settled[i].status === "rejected");

  // De-duplicate by link: the same story shows up under several topics.
  const seen = new Set<string>();
  const unique = items
    .filter((i) => (seen.has(i.link) ? false : (seen.add(i.link), true)))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 120);

  return {
    ok: unique.length > 0,
    items: unique,
    source: "Public RSS feeds",
    asOf: new Date().toISOString(),
    ageSeconds: 0,
    ...(failedTopics.length
      ? { warning: `No feed reachable for: ${failedTopics.join(", ")}.` }
      : {}),
    ...(unique.length ? {} : { error: "No news feed was reachable from this server." }),
  };
}

// --- Market analysis --------------------------------------------------------

export interface AnalysisLine {
  label: string;
  detail: string;
  tone: "up" | "down" | "flat" | "info";
}

/**
 * Analysis derived arithmetically from the figures already fetched — breadth,
 * leaders and laggards, the volatility index, dollar direction.
 *
 * Deliberately **not** opinion or a forecast. Everything below is a statement
 * about numbers that are on screen, so a reader can check it. Anything else
 * would be invented commentary dressed up as analysis.
 */
export async function analysis(): Promise<FeedResult<{ lines: AnalysisLine[]; basis: string[] }>> {
  const empty = { lines: [], basis: [] };
  const [c, s, cm, f, r] = await Promise.all([crypto(), stocks(), commodities(), fx(), rates()]);
  const lines: AnalysisLine[] = [];
  const basis: string[] = [];
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

  const breadth = (rows: { name: string; changePct: number | null }[], label: string) => {
    const withChange = rows.filter((r) => r.changePct !== null) as { name: string; changePct: number }[];
    if (!withChange.length) return;
    const up = withChange.filter((r) => r.changePct > 0).length;
    const best = withChange.reduce((a, b) => (b.changePct > a.changePct ? b : a));
    const worst = withChange.reduce((a, b) => (b.changePct < a.changePct ? b : a));
    lines.push({
      label: `${label} breadth`,
      detail: `${up} of ${withChange.length} advancing. Leader ${best.name} ${pct(best.changePct)}, laggard ${worst.name} ${pct(worst.changePct)}.`,
      tone: up * 2 > withChange.length ? "up" : up * 2 < withChange.length ? "down" : "flat",
    });
  };

  // --- monetary policy: the decision, then the balance sheet ---------------
  // Ordered first among the derived lines because everything below it is priced
  // off the policy rate and the size of the central bank's balance sheet.
  if (r.ok && (r.items.policy.length || r.items.sheets.length)) {
    basis.push("FRED (St. Louis Fed)");
    for (const p of r.items.policy) {
      const move =
        p.moveBps === null || p.since === null
          ? "No change inside the two-year window read here."
          : `Last move ${p.moveBps > 0 ? "+" : ""}${p.moveBps} bp, effective ${p.since}` +
            (p.heldDays !== null ? ` — held ${p.heldDays} day${p.heldDays === 1 ? "" : "s"}.` : ".");
      lines.push({
        label: `${p.bank} — ${p.instrument}`,
        detail: `${p.display} as of ${p.asOf}. ${move}`,
        // A cut is stimulus for risk assets, a hike is a headwind; that is the
        // only directional claim here and it follows from the sign alone.
        tone: p.moveBps === null ? "flat" : p.moveBps < 0 ? "up" : "down",
      });
    }
    for (const b of r.items.sheets) {
      const tn = (v: number | null) =>
        v === null ? "n/a" : `${v >= 0 ? "+" : "−"}${(Math.abs(v) / 1_000_000).toFixed(3)}tn`;
      lines.push({
        label: `${b.bank} — ${b.label}`,
        detail:
          `${(b.latest / 1_000_000).toFixed(3)}tn ${b.unit.split(" ")[0]} as of ${b.asOf}: ` +
          `${b.stance}${b.stance === "expanding" ? " (asset purchases outpacing runoff)" : b.stance === "contracting" ? " (quantitative tightening)" : ""}. ` +
          `Change ${tn(b.change4w)} over 4 weeks, ${tn(b.change13w)} over 13, ${tn(b.change52w)} over 52.`,
        tone: b.stance === "expanding" ? "up" : b.stance === "contracting" ? "down" : "flat",
      });
    }
    const curve = r.items.market.find((m) => m.label === "10-year minus 2-year");
    const be = r.items.market.find((m) => m.label === "10-year breakeven inflation");
    if (curve) {
      lines.push({
        label: "Yield curve",
        detail:
          `10-year minus 2-year at ${(curve.value * 100).toFixed(0)} bp (${curve.asOf})` +
          (curve.change !== null
            ? `, ${curve.change >= 0 ? "+" : ""}${(curve.change * 100).toFixed(0)} bp since ${curve.changeFrom}`
            : "") +
          `. ${curve.value < 0 ? "Inverted." : "Positively sloped."}` +
          (be ? ` Ten-year breakeven inflation ${be.value.toFixed(2)}%.` : ""),
        tone: curve.value < 0 ? "down" : "up",
      });
    }
  }
  if (s.ok && s.items.stocks.length) {
    breadth(s.items.stocks, "Large-cap equity");
    basis.push("Yahoo Finance equities");
    const vix = s.items.indices.find((i) => i.symbol === "^VIX");
    if (vix) {
      lines.push({
        label: "Volatility",
        detail:
          `VIX at ${vix.price.toFixed(2)}` +
          (vix.changePct !== null ? ` (${pct(vix.changePct)} on the day)` : "") +
          `. Below 20 is historically calm; above 30 is stressed.`,
        tone: vix.price > 30 ? "down" : vix.price < 20 ? "up" : "flat",
      });
    }
  }
  if (c.ok && c.items.length) {
    breadth(c.items.map((r) => ({ name: r.symbol, changePct: r.changeDay })), "Crypto");
    basis.push("CoinGecko");
    const btc = c.items.find((r) => r.id === "bitcoin");
    if (btc && btc.changeWeek !== null && btc.changeMonth !== null) {
      lines.push({
        label: "Bitcoin trend",
        detail: `${pct(btc.changeWeek)} over the week, ${pct(btc.changeMonth)} over the month${btc.changeYear !== null ? `, ${pct(btc.changeYear)} over the year` : ""}.`,
        tone: btc.changeWeek > 0 ? "up" : btc.changeWeek < 0 ? "down" : "flat",
      });
    }
  }
  if (cm.ok && cm.items.length) {
    breadth(cm.items, "Commodity");
    basis.push("Yahoo Finance futures");
    const gold = cm.items.find((q) => q.symbol === "GC=F");
    const oil = cm.items.find((q) => q.symbol === "CL=F");
    if (gold && oil && gold.changePct !== null && oil.changePct !== null) {
      lines.push({
        label: "Gold vs oil",
        detail: `Gold ${pct(gold.changePct)}, WTI crude ${pct(oil.changePct)} on the day.`,
        tone: gold.changePct > oil.changePct ? "up" : "down",
      });
    }
  }
  if (f.ok && f.items.rates.length) {
    basis.push("ECB reference rates");
    const withChange = f.items.rates.filter((r) => r.changePct !== null) as (FxRate & { changePct: number })[];
    if (withChange.length) {
      // "Dollar stronger" = USD-quoted pairs falling, USD-base pairs rising.
      const usdMoves = withChange.map((r) => (r.quote === "USD" ? -r.changePct : r.changePct));
      const avg = usdMoves.reduce((a, b) => a + b, 0) / usdMoves.length;
      lines.push({
        label: "US dollar",
        detail: `Averaging ${pct(avg)} against the majors since the previous ECB fixing (${f.items.previousDate || "n/a"} → ${f.items.date}).`,
        tone: avg > 0.05 ? "up" : avg < -0.05 ? "down" : "flat",
      });
    }
  }

  if (!lines.length) {
    return {
      ...empty,
      ok: false,
      source: "Derived from live feeds",
      asOf: new Date().toISOString(),
      ageSeconds: 0,
      error: "No market feed was reachable, so there is nothing to analyse.",
    } as FeedResult<{ lines: AnalysisLine[]; basis: string[] }>;
  }
  lines.push({
    label: "How this is produced",
    detail:
      "Every line above is computed from published figures — counts, averages and differences over " +
      "the prices in the other tabs and the central-bank series in the tables below. Nothing here " +
      "is forecast, and no policy statement is interpreted: a rate change is dated by finding where " +
      "the published series changed. Sources: " + basis.join(", ") + ".",
    tone: "info",
  });
  return {
    ok: true,
    items: { lines, basis },
    source: "Derived from live feeds",
    asOf: new Date().toISOString(),
    ageSeconds: 0,
  };
}

/** Test seam: drop every cached value. */
export function clearFeedCache() {
  cache.clear();
  inflight = new Map();
}
