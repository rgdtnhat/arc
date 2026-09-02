/**
 * Tests for the live-feed layer.
 *
 * The upstreams are real public endpoints, so nothing here reaches the network:
 * `fetch` is stubbed and every assertion is about *our* arithmetic and parsing.
 * That is the part worth testing anyway — the promise this module makes is that
 * it never invents a number, and these check the paths where a number could get
 * invented: a missing observation read as zero, a stance derived from the wrong
 * comparison, a rate change dated from the wrong row.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  lastChange,
  changeOver,
  rates,
  fx,
  clearFeedCache,
  type Obs,
} from "../src/feeds.ts";

const obs = (rows: [string, number][]): Obs[] => rows.map(([date, value]) => ({ date, value }));

// --- lastChange -------------------------------------------------------------

test("lastChange dates a rate cut from the first day the new level appears", () => {
  const series = obs([
    ["2026-01-01", 4.0],
    ["2026-01-02", 4.0],
    ["2026-01-03", 3.75],
    ["2026-01-04", 3.75],
  ]);
  assert.deepEqual(lastChange(series), { since: "2026-01-03", moveBps: -25 });
});

test("lastChange reports a hike as a positive move", () => {
  const series = obs([
    ["2026-01-01", 3.5],
    ["2026-01-02", 4.0],
  ]);
  assert.deepEqual(lastChange(series), { since: "2026-01-02", moveBps: 50 });
});

test("lastChange returns nulls when the level never moved in the window", () => {
  const series = obs([
    ["2026-01-01", 2.25],
    ["2026-01-02", 2.25],
    ["2026-01-03", 2.25],
  ]);
  assert.deepEqual(lastChange(series), { since: null, moveBps: null });
});

test("lastChange finds the most recent change, not the first", () => {
  const series = obs([
    ["2026-01-01", 5.0],
    ["2026-02-01", 4.5],
    ["2026-03-01", 4.0],
  ]);
  assert.deepEqual(lastChange(series), { since: "2026-03-01", moveBps: -50 });
});

test("lastChange needs two observations to say anything", () => {
  assert.deepEqual(lastChange(obs([["2026-01-01", 3]])), { since: null, moveBps: null });
  assert.deepEqual(lastChange([]), { since: null, moveBps: null });
});

// --- changeOver -------------------------------------------------------------

test("changeOver measures against the nearest observation at or before the target", () => {
  const weekly = obs([
    ["2026-01-07", 100],
    ["2026-01-14", 110],
    ["2026-01-21", 120],
    ["2026-01-28", 130],
    ["2026-02-04", 140],
  ]);
  // Four weeks before 2026-02-04 is 2026-01-07 exactly.
  assert.equal(changeOver(weekly, 4), 40);
  assert.equal(changeOver(weekly, 1), 10);
});

test("changeOver returns null when the history doesn't reach back far enough", () => {
  const short = obs([
    ["2026-02-01", 100],
    ["2026-02-08", 110],
  ]);
  assert.equal(changeOver(short, 52), null);
});

// --- FRED parsing and derivation -------------------------------------------

/** A FRED CSV in the exact shape the graph endpoint returns. */
const csv = (id: string, rows: [string, string][]) =>
  `observation_date,${id}\n` + rows.map(([d, v]) => `${d},${v}`).join("\n") + "\n";

/** Weekly dates counting back from an anchor, oldest first. */
function weeks(anchor: string, n: number, from: number, step: number): [string, string][] {
  const out: [string, string][] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.parse(anchor) - i * 7 * 86_400_000).toISOString().slice(0, 10);
    out.push([d, String(from + (n - 1 - i) * step)]);
  }
  return out;
}

const ANCHOR = "2026-07-22";

function stubFred(overrides: Record<string, string> = {}) {
  const bodies: Record<string, string> = {
    DFEDTARU: csv("DFEDTARU", [
      ["2026-05-01", "4.00"],
      ["2026-06-01", "3.75"],
      ["2026-07-01", "3.75"],
    ]),
    DFEDTARL: csv("DFEDTARL", [
      ["2026-05-01", "3.75"],
      ["2026-06-01", "3.50"],
      ["2026-07-01", "3.50"],
    ]),
    ECBDFR: csv("ECBDFR", [
      ["2026-06-01", "2.25"],
      ["2026-07-01", "2.25"],
    ]),
    // Deliberately carries FRED's missing-value marker.
    ECBMRRFR: csv("ECBMRRFR", [
      ["2026-06-01", "2.40"],
      ["2026-06-02", "."],
      ["2026-07-01", "2.40"],
    ]),
    IUDSOIA: csv("IUDSOIA", [["2026-07-22", "3.7303"]]),
    IRSTCI01JPM156N: csv("IRSTCI01JPM156N", [["2026-06-01", "0.84100"]]),
    // Falling 10,000 per week: -130,000 over 13 weeks on a ~5.9tn base, well
    // outside the ±1% band, so unambiguously contracting.
    WALCL: csv("WALCL", weeks(ANCHOR, 60, 7_000_000, -10_000)),
    // Falling only 500 per week: -6,500 over 13 weeks on a ~6.5tn base is 0.1%,
    // inside the band. This is the case the band exists for.
    WSHOSHO: csv("WSHOSHO", weeks(ANCHOR, 60, 6_500_000, -500)),
    // Perfectly flat.
    WSHOMCB: csv("WSHOMCB", weeks(ANCHOR, 60, 1_944_788, 0)),
    // Rising 10,000 per week: +130,000 over 13 weeks on a ~5.9tn base — 2.2%.
    ECBASSETSW: csv("ECBASSETSW", weeks(ANCHOR, 60, 5_900_000, 10_000)),
    DGS10: csv("DGS10", [["2026-07-16", "4.60"], ["2026-07-23", "4.71"]]),
    DGS2: csv("DGS2", [["2026-07-16", "4.30"], ["2026-07-23", "4.37"]]),
    T10Y2Y: csv("T10Y2Y", [["2026-07-16", "0.30"], ["2026-07-23", "0.34"]]),
    T10YIE: csv("T10YIE", [["2026-07-23", "2.28"]]),
    RRPONTSYD: csv("RRPONTSYD", [["2026-07-23", "0.904"]]),
    ...overrides,
  };
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const id = new URL(url).searchParams.get("id") ?? "";
    const body = bodies[id];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return calls;
}

test("rates() reads FRED series and derives policy, balance sheets and market rates", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; clearFeedCache(); });
  clearFeedCache();
  stubFred();

  const r = await rates();
  assert.equal(r.ok, true);

  // --- policy rates ---
  const fed = r.items.policy.find((p) => p.bank === "Federal Reserve");
  assert.ok(fed, "Fed policy rate present");
  // Shown as the range it actually is, from the two published series.
  assert.equal(fed.display, "3.50–3.75%");
  assert.equal(fed.value, 3.75);
  assert.equal(fed.since, "2026-06-01");
  assert.equal(fed.moveBps, -25);
  assert.ok(fed.heldDays !== null && fed.heldDays > 0);

  // The policy table holds administered decisions only. SONIA and the Japan
  // call rate are market-set and drift daily, so deriving a "last move" from
  // them would manufacture a decision — they belong with the market rates.
  assert.equal(r.items.policy.some((p) => /SONIA|call money/i.test(p.instrument)), false);
  const sonia = r.items.market.find((m) => /SONIA/.test(m.label));
  assert.ok(sonia, "SONIA reported as a market rate");
  assert.match(sonia.note, /not the decision itself/);

  // A series that never moved reports no change rather than inventing one.
  const ecb = r.items.policy.find((p) => p.instrument === "Deposit facility rate");
  assert.ok(ecb);
  assert.equal(ecb.since, null);
  assert.equal(ecb.moveBps, null);

  // --- balance sheets ---
  const walcl = r.items.sheets.find((s) => s.label === "Total assets");
  assert.ok(walcl);
  assert.equal(walcl.stance, "contracting");
  assert.equal(walcl.change4w, -40_000);
  assert.equal(walcl.change13w, -130_000);
  assert.equal(walcl.change52w, -520_000);

  // Shrinking, but by 0.1% of the total over a quarter — that is runoff timing,
  // not a stance, and the ±1% band is what stops it being reported as one.
  const ust = r.items.sheets.find((s) => s.label === "Treasury securities held");
  assert.ok(ust);
  assert.ok(ust.change13w! < 0, "the series is falling");
  assert.equal(ust.stance, "broadly flat");

  const mbs = r.items.sheets.find((s) => s.label === "Mortgage-backed securities held");
  assert.ok(mbs);
  assert.equal(mbs.stance, "broadly flat");

  const ecbSheet = r.items.sheets.find((s) => s.bank === "European Central Bank");
  assert.ok(ecbSheet);
  assert.equal(ecbSheet.stance, "expanding");

  // --- market rates ---
  const curve = r.items.market.find((m) => m.label === "10-year minus 2-year");
  assert.ok(curve);
  assert.equal(curve.value, 0.34);
  assert.ok(Math.abs(curve.change! - 0.04) < 1e-9);
  // The date compared against is reported, not assumed to be exactly a week.
  assert.equal(curve.changeFrom, "2026-07-16");
});

test("a monthly series reports the date it actually compared with", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; clearFeedCache(); });
  clearFeedCache();
  stubFred({
    // Monthly. A "one week" lookback lands on the previous month, so saying
    // "on the week" would be wrong — the row has to name the date.
    IRSTCI01JPM156N: csv("IRSTCI01JPM156N", [
      ["2026-05-01", "0.72"],
      ["2026-06-01", "0.84"],
    ]),
  });

  const r = await rates();
  const jp = r.items.market.find((m) => /Japan call money/.test(m.label));
  assert.ok(jp);
  assert.equal(jp.asOf, "2026-06-01");
  assert.equal(jp.changeFrom, "2026-05-01");
  assert.ok(Math.abs(jp.change! - 0.12) < 1e-9);
});

test("rates() ignores FRED's '.' missing-value marker rather than reading it as zero", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; clearFeedCache(); });
  clearFeedCache();
  stubFred();

  const r = await rates();
  const mro = r.items.policy.find((p) => p.instrument === "Main refinancing rate");
  assert.ok(mro);
  assert.equal(mro.value, 2.4);
  // The middle row was ".", so it must not register as a move down to 0 and back.
  assert.equal(mro.moveBps, null);
});

test("rates() still reports what it could reach when some series fail", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; clearFeedCache(); });
  clearFeedCache();
  // Only the Fed range resolves; everything else 404s.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const id = new URL(String(input)).searchParams.get("id") ?? "";
    if (id === "DFEDTARU") return new Response(csv("DFEDTARU", [["2026-07-01", "3.75"]]), { status: 200 });
    if (id === "DFEDTARL") return new Response(csv("DFEDTARL", [["2026-07-01", "3.50"]]), { status: 200 });
    return new Response("nope", { status: 500 });
  }) as typeof fetch;

  const r = await rates();
  assert.equal(r.ok, true);
  assert.equal(r.items.policy.length, 1);
  assert.equal(r.items.sheets.length, 0);
  assert.equal(r.items.market.length, 0);
});

test("rates() reports an error rather than empty tables when FRED is unreachable", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; clearFeedCache(); });
  clearFeedCache();
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;

  const r = await rates();
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /FRED/);
  assert.deepEqual(r.items, { policy: [], sheets: [], market: [] });
});

// --- FX grouping ------------------------------------------------------------

test("fx() labels every pair with the group the table renders it under", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; clearFeedCache(); });
  clearFeedCache();

  const table = { EUR: 0.92, GBP: 0.78, JPY: 155.2, SEK: 10.5, CNY: 7.1, MXN: 17.4, CHF: 0.88 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/latest")) {
      return new Response(JSON.stringify({ date: "2026-07-24", rates: table }), { status: 200 });
    }
    // Range query for the previous fixing.
    return new Response(
      JSON.stringify({ rates: { "2026-07-23": { ...table, EUR: 0.93 }, "2026-07-24": table } }),
      { status: 200 },
    );
  }) as typeof fetch;

  const r = await fx();
  assert.equal(r.ok, true);
  const byPair = new Map(r.items.rates.map((x) => [x.pair, x]));

  assert.equal(byPair.get("EUR/USD")?.group, "Majors");
  assert.equal(byPair.get("EUR/JPY")?.group, "Crosses");
  assert.equal(byPair.get("EUR/SEK")?.group, "Europe & Nordics");
  assert.equal(byPair.get("USD/CNY")?.group, "Asia & Pacific");
  assert.equal(byPair.get("USD/MXN")?.group, "Americas, Middle East & Africa");
  // Nothing falls through to the catch-all bucket.
  assert.equal(r.items.rates.filter((x) => x.group === "Other").length, 0);

  // A pair whose currency the source didn't return is dropped, not zero-filled.
  assert.equal(byPair.has("USD/BRL"), false);

  // EUR/USD: 1/0.92 today against 1/0.93 yesterday — the euro strengthened.
  const eur = byPair.get("EUR/USD")!;
  assert.ok(eur.changePct !== null && eur.changePct > 0);
});
