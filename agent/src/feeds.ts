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
}

const FX_PAIRS: [string, string][] = [
  ["EUR", "USD"], ["GBP", "USD"], ["USD", "JPY"], ["AUD", "USD"],
  ["USD", "CHF"], ["USD", "CAD"], ["NZD", "USD"], ["USD", "CNY"],
  ["USD", "SGD"], ["USD", "INR"],
];

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
    rates.push({
      pair: `${base}/${quote}`,
      base,
      quote,
      rate: now,
      changePct: before && Number.isFinite(before) ? ((now - before) / before) * 100 : null,
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
      return { pair: q.name, base, quote, rate: q.price, changePct: q.changePct };
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

const CRYPTO_IDS = [
  "bitcoin", "ethereum", "solana", "ripple", "cardano",
  "usd-coin", "tether", "binancecoin", "dogecoin", "avalanche-2",
  "chainlink", "polkadot",
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
}

/**
 * One Yahoo chart request per symbol, run with limited concurrency.
 *
 * `chart` rather than `quote`: the quote endpoint requires a crumb/cookie dance
 * that breaks without warning, while chart is stable and carries everything
 * needed. A symbol that fails is dropped from the list rather than shown at
 * zero — a price of 0.00 next to a real one is actively misleading.
 */
async function loadQuotes(symbols: { symbol: string; name: string }[]): Promise<Quote[]> {
  const out: Quote[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ symbol, name }) => {
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
        } as Quote;
      }),
    );
    for (const r of settled) if (r.status === "fulfilled") out.push(r.value);
  }
  if (!out.length) throw new Error("no symbols returned data");
  return out;
}

const STOCKS = [
  { symbol: "AAPL", name: "Apple" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "NVDA", name: "NVIDIA" },
  { symbol: "GOOGL", name: "Alphabet" },
  { symbol: "AMZN", name: "Amazon" },
  { symbol: "META", name: "Meta" },
  { symbol: "TSLA", name: "Tesla" },
  { symbol: "JPM", name: "JPMorgan Chase" },
  { symbol: "V", name: "Visa" },
  { symbol: "COIN", name: "Coinbase" },
];

const INDICES = [
  { symbol: "^GSPC", name: "S&P 500" },
  { symbol: "^IXIC", name: "Nasdaq Composite" },
  { symbol: "^DJI", name: "Dow Jones" },
  { symbol: "^FTSE", name: "FTSE 100" },
  { symbol: "^N225", name: "Nikkei 225" },
  { symbol: "^VIX", name: "VIX (volatility)" },
];

const COMMODITIES = [
  { symbol: "GC=F", name: "Gold" },
  { symbol: "SI=F", name: "Silver" },
  { symbol: "HG=F", name: "Copper" },
  { symbol: "CL=F", name: "Crude oil (WTI)" },
  { symbol: "BZ=F", name: "Brent crude" },
  { symbol: "NG=F", name: "Natural gas" },
  { symbol: "ZC=F", name: "Corn" },
  { symbol: "ZW=F", name: "Wheat" },
  { symbol: "KC=F", name: "Coffee" },
];

export async function stocks(): Promise<FeedResult<{ stocks: Quote[]; indices: Quote[] }>> {
  const empty = { stocks: [], indices: [] };
  try {
    const entry = await cached("stocks", 120_000, async () => ({
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
    return wrap(await cached("commodities", 120_000, () => loadQuotes(COMMODITIES)), "Yahoo Finance", []);
  } catch (e) {
    return failed("Yahoo Finance", [] as Quote[], e);
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
  const [c, s, cm, f] = await Promise.all([crypto(), stocks(), commodities(), fx()]);
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
      "Every line above is computed from the prices in the other tabs — counts, averages and " +
      "differences, nothing forecast or inferred. Sources: " + basis.join(", ") + ".",
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
