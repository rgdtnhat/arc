/**
 * Tests for the DeFi services Tessera sells over HTTP 402.
 *
 * The payment rail is covered elsewhere. What these check is the part that is
 * new and that a buyer is paying for: that each service reads live state, shapes
 * an answer an agent can act on, and — the one that matters most — **refuses
 * rather than guesses** when the chain cannot be read. A service that quietly
 * serves a plausible APR after a failed read is worse than one that errors,
 * because the buyer acts on it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG, produceBody, serviceByResource, type ServiceContext, type ServiceDef } from "@tessera/providers/catalog";

const DEFI = ["defi:yield-best", "defi:route", "defi:health", "defi:at-risk", "defi:reputation", "defi:treasury"];
const ACC = "0x000000000000000000000000000000000000dEaD";
const TOKEN_A = "0x0000000000000000000000000000000000000aaa";
const TOKEN_B = "0x0000000000000000000000000000000000000bbb";

/** A context with no oracle — the "cannot read the chain" case. */
const blind: ServiceContext = {
  oracle: undefined,
  chain: {},
  rpcUrl: "http://127.0.0.1:1",
  escrowAddress: "0x0000000000000000000000000000000000000001",
};

/** A context whose oracle answers with fixed, obviously-synthetic values. */
function stubbed(overrides: Record<string, unknown> = {}): ServiceContext {
  const oracle = {
    addresses: { vault: "0x00000000000000000000000000000000000000v1", pool: "0x0", swap: "0x0", amm: "0x0", escrow: "0x0" },
    assets: [],
    bestYield: async () => ({
      best: { venue: "vault", asset: "USDC", assetAddress: TOKEN_A, aprPct: 4.2, liquidity: 100, note: "derived" },
      venues: [
        { venue: "lending", asset: "USDC", assetAddress: TOKEN_A, aprPct: 3, liquidity: 100, note: "" },
        { venue: "vault", asset: "USDC", assetAddress: TOKEN_A, aprPct: 4.2, liquidity: 100, note: "derived" },
      ],
      asOf: "2026-01-01T00:00:00.000Z",
      unavailable: [],
    }),
    route: async () => ({
      tokenIn: "USDC", tokenOut: "EURC", amountIn: "100.00",
      best: { venue: "amm", amountOut: "92.50", amountOutNum: 92.5, note: "" },
      legs: [{ venue: "amm", amountOut: "92.50", amountOutNum: 92.5, note: "" }],
      asOf: "2026-01-01T00:00:00.000Z", unavailable: [],
    }),
    health: async (a: string) => ({
      account: a, suppliedUsd: 1000, borrowedUsd: 500, borrowLimitUsd: 900,
      healthFactor: a.endsWith("1") ? 1.02 : 1.8,
      bufferPct: a.endsWith("1") ? 1.96 : 44.4,
      band: a.endsWith("1") ? "at-risk" : "safe",
      asOf: "2026-01-01T00:00:00.000Z",
    }),
    reputation: async (p: string) => ({
      provider: p, settled: 19, failed: 1, total: 20, successRate: 0.95,
      stakeUsdc: "0.050000", verdict: "good", asOf: "2026-01-01T00:00:00.000Z",
    }),
    ...overrides,
  };
  return { ...blind, oracle: oracle as never };
}

// --- the catalog ------------------------------------------------------------

test("every DeFi service is in the catalog with a price and a route", () => {
  for (const r of DEFI) {
    const svc = serviceByResource(r);
    assert.ok(svc, `${r} is catalogued`);
    assert.ok(svc.price > 0n, `${r} has a price`);
    assert.match(svc.path, /^\/defi\//, `${r} is served under /defi`);
    assert.ok(svc.tags.length > 0, `${r} is discoverable by tag`);
    assert.equal(svc.behavior, "reliable", `${r} is not one of the deliberately flaky samples`);
  }
});

test("the liquidation feed is tab-billed, because a keeper polls it", () => {
  // One escrow per poll would cost more gas than the tick is worth.
  assert.equal(serviceByResource("defi:at-risk")?.billing, "tab");
  // The per-call services are not.
  assert.notEqual(serviceByResource("defi:health")?.billing, "tab");
});

test("no DeFi service is priced above a cent — these are per-call reads", () => {
  for (const r of DEFI) {
    assert.ok(serviceByResource(r)!.price <= 10_000n, `${r} is nano-priced`);
  }
});

// --- refusing to guess ------------------------------------------------------

test("every DeFi service refuses when the chain cannot be read", async () => {
  // The whole promise of these answers is that they are live. Serving a cached
  // or synthesised number here would be the product being actively wrong.
  for (const r of DEFI) {
    const svc = serviceByResource(r)!;
    await assert.rejects(
      () => svc.respondAsync!({ account: ACC, provider: ACC, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1", accounts: ACC }, blind),
      /not configured/i,
      `${r} refuses without a chain reader`,
    );
  }
});

test("the synchronous fallback never serves a number either", () => {
  // `respond` exists because the interface requires it. For these services it
  // must not look like an answer — the provider falls back to it when
  // `respondAsync` throws, and a fabricated APR would ship straight to a buyer.
  for (const r of DEFI) {
    const body = serviceByResource(r)!.respond({}) as Record<string, unknown>;
    assert.ok("error" in body, `${r}'s fallback is an error, not data`);
    assert.match(String(body.error), /unavailable/i);
  }
});

// --- required inputs --------------------------------------------------------

test("services that need an argument say so instead of answering about nothing", async () => {
  const ctx = stubbed();
  await assert.rejects(() => serviceByResource("defi:health")!.respondAsync!({}, ctx), /account is required/);
  await assert.rejects(() => serviceByResource("defi:reputation")!.respondAsync!({}, ctx), /provider address is required/);
  await assert.rejects(() => serviceByResource("defi:route")!.respondAsync!({}, ctx), /required/);
  await assert.rejects(() => serviceByResource("defi:at-risk")!.respondAsync!({}, ctx), /accounts is required/);
});

test("the at-risk feed ignores malformed addresses and caps the batch", async () => {
  const ctx = stubbed();
  const many = Array.from({ length: 40 }, (_, i) =>
    "0x" + String(i).padStart(40, "0")).join(",");
  const body = (await serviceByResource("defi:at-risk")!.respondAsync!(
    { accounts: `not-an-address,${many}` }, ctx)) as { checked: number };
  assert.ok(body.checked <= 25, `batch capped at 25, got ${body.checked}`);
});

// --- the answers ------------------------------------------------------------

test("yield/best returns the ranked venue plus something to do about it", async () => {
  const body = (await serviceByResource("defi:yield-best")!.respondAsync!({}, stubbed())) as
    { best: { venue: string }; venues: unknown[]; actionable: string };
  assert.equal(body.best.venue, "vault");
  assert.equal(body.venues.length, 2, "the runners-up are shown, not just the winner");
  assert.match(body.actionable, /Supply USDC to the vault venue for 4.2% APR/);
});

test("yield/best says so plainly when nothing is worth doing", async () => {
  const ctx = stubbed({
    bestYield: async () => ({ best: null, venues: [], asOf: "", unavailable: ["lending", "vault"] }),
  });
  const body = (await serviceByResource("defi:yield-best")!.respondAsync!({}, ctx)) as
    { best: null; actionable: string; unavailable: string[] };
  assert.equal(body.best, null);
  assert.match(body.actionable, /No venue currently offers/);
  assert.deepEqual(body.unavailable, ["lending", "vault"], "what could not be read is named");
});

test("health turns a position into a band and a buffer", async () => {
  const body = (await serviceByResource("defi:health")!.respondAsync!({ account: ACC }, stubbed())) as
    { band: string; actionable: string };
  assert.equal(body.band, "safe");
  assert.match(body.actionable, /Collateral can fall 44.4% before liquidation/);
});

test("the at-risk feed returns only the risky ones, worst first", async () => {
  const ctx = stubbed();
  const safe = "0x" + "0".repeat(39) + "2";
  const risky = "0x" + "0".repeat(39) + "1";
  const body = (await serviceByResource("defi:at-risk")!.respondAsync!(
    { accounts: `${safe},${risky}` }, ctx)) as
    { checked: number; atRisk: { account: string }[]; actionable: string };
  assert.equal(body.checked, 2);
  assert.equal(body.atRisk.length, 1, "the safe position is not in the feed");
  assert.equal(body.atRisk[0].account, risky);
  assert.match(body.actionable, /liquidate\(\) on TesseraPool/, "points at where the keeper's money is");
});

test("reputation ships the rule and the raw counts, not just a verdict", async () => {
  const body = (await serviceByResource("defi:reputation")!.respondAsync!({ provider: ACC }, stubbed())) as
    { verdict: string; rule: string; settled: number; failed: number; actionable: string };
  assert.equal(body.verdict, "good");
  assert.equal(body.settled, 19);
  assert.equal(body.failed, 1);
  assert.match(body.rule, /unproven/, "the thresholds are published so a buyer can apply their own");
  assert.match(body.actionable, /Reasonable to deal with/);
});

test("the treasury service quotes the vault the app actually uses, and states custody", async () => {
  const body = (await serviceByResource("defi:treasury")!.respondAsync!({}, stubbed())) as
    { vault: string; netAprPct: number; howTo: string[]; custody: string };
  assert.ok(body.vault, "an address to deposit to");
  assert.equal(body.netAprPct, 4.2);
  assert.ok(body.howTo.length >= 3, "the steps to actually do it");
  assert.match(body.custody, /Non-custodial/, "says who holds the shares");
  assert.match(body.custody, /never on principal/);
});

test("the treasury service refuses to quote a rate it could not read", async () => {
  const ctx = stubbed({ bestYield: async () => ({ best: null, venues: [], asOf: "", unavailable: ["vault"] }) });
  const body = (await serviceByResource("defi:treasury")!.respondAsync!({}, ctx)) as
    { netAprPct: number | null; note: string };
  assert.equal(body.netAprPct, null);
  assert.match(body.note, /do not deposit on an unknown rate/i);
});

// --- what the provider actually serves --------------------------------------
//
// Both billing paths funnel through `produceBody`. They used to duplicate the
// logic, and the tab path never learned about `respondAsync` — so a keeper paid
// a voucher and received the "unavailable" placeholder as if it were the feed.
// These pin the shared behaviour so the two paths can't drift apart again.

const CTX = blind;

test("a liveOnly service fails closed instead of serving its placeholder", async () => {
  for (const r of DEFI) {
    const svc = serviceByResource(r)!;
    assert.equal(svc.liveOnly, true, `${r} is declared live-only`);
    const out = await produceBody(svc, { account: ACC }, CTX);
    assert.equal(out.ok, false, `${r} refuses rather than degrading`);
  }
});

test("a service that may degrade still falls back to its cached answer", async () => {
  // The weather sample exists to show graceful degradation — a stale reading is
  // fine there. Only the money-moving reads fail closed.
  const svc = serviceByResource("weather:live")!;
  assert.notEqual(svc.liveOnly, true);
  const failing: ServiceDef = { ...svc, respondAsync: async () => { throw new Error("upstream down"); } };
  const out = await produceBody(failing, { city: "Lisbon" }, CTX);
  assert.equal(out.ok, true);
  assert.equal((out as { live: boolean }).live, false, "the answer is labelled as not-live");
  assert.match(JSON.stringify((out as { body: unknown }).body), /fallback/);
});

test("produceBody reports whether the answer came from a live read", async () => {
  const ok = await produceBody(serviceByResource("defi:yield-best")!, {}, stubbed());
  assert.equal(ok.ok, true);
  assert.equal((ok as { live: boolean }).live, true);

  // A service with no async responder is never claimed to be live.
  const sync = await produceBody(serviceByResource("fx:quote")!, { pair: "EURUSD" }, CTX);
  assert.equal(sync.ok, true);
  assert.equal((sync as { live: boolean }).live, false);
});

test("the sample services are still there — this did not replace them", () => {
  assert.ok(CATALOG.length > DEFI.length);
  assert.ok(serviceByResource("weather:current"), "the escrow-refund demo path is intact");
});
