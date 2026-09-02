import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { HEADERS, quoteTypedData, usdc, arcTestnet } from "@tessera/shared";
import { createProviderApp, tabKey } from "../src/app.ts";
import { quoteHash, responseHash, randomNonce } from "../src/quote.ts";
import { CATALOG } from "../src/catalog.ts";
import { quotePrice, LoadMeter, MAX_MULTIPLIER } from "../src/pricing.ts";

/**
 * The provider is the counterparty in every payment, and had no tests of its
 * own — 1,300 lines reached only sideways, from the agent's suite.
 *
 * What matters here is not that a service returns a number. It is that the
 * three things the buyer relies on hold: a quote is bound to its terms so it
 * cannot be edited in flight, the signature over it is the provider's, and the
 * price a buyer is quoted can never be talked *down* by anything the buyer
 * says about itself.
 */

const provider = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const escrow = "0x0000000000000000000000000000000000000abc" as const;
const RESOURCE = "weather:current";
const svc = CATALOG.find((c) => c.resource === RESOURCE)!;

/** The app, with no chain behind it — the 402 path must not need one. */
function app() {
  return createProviderApp({
    chain: arcTestnet,
    // Deliberately unroutable: a quote that reaches for the chain would hang
    // here, and that is worth knowing.
    rpcUrl: "http://127.0.0.1:1",
    escrowAddress: escrow,
    providerKeys: Object.fromEntries(CATALOG.map((c) => [c.resource, provider.key ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"])) as never,
  });
}

/** One request against the app, without binding a port. */
async function get(path: string, headers: Record<string, string> = {}) {
  const server = app().listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/* ---- the quote binding ---------------------------------------------------- */

test("a quote hash is bound to every one of its terms", () => {
  const nonce = randomNonce();
  const base = quoteHash(provider.address, usdc("0.0025"), RESOURCE, nonce);
  // Change any single term and the commitment changes. That is what stops a
  // quote being edited between the 402 and the escrow.
  assert.notEqual(base, quoteHash("0x4D31637a6F3d53Debb214C1363556Ab748004205", usdc("0.0025"), RESOURCE, nonce));
  assert.notEqual(base, quoteHash(provider.address, usdc("0.0026"), RESOURCE, nonce));
  assert.notEqual(base, quoteHash(provider.address, usdc("0.0025"), "weather:live", nonce));
  assert.notEqual(base, quoteHash(provider.address, usdc("0.0025"), RESOURCE, randomNonce()));
  // And it is stable for identical terms.
  assert.equal(base, quoteHash(provider.address, usdc("0.0025"), RESOURCE, nonce));
});

test("a response hash commits to the body, not to its shape", () => {
  const body = { city: "Lisbon", tempC: 21 };
  assert.equal(responseHash(body), responseHash({ city: "Lisbon", tempC: 21 }));
  assert.notEqual(responseHash(body), responseHash({ city: "Lisbon", tempC: 22 }));
});

test("a nonce is 32 bytes and does not repeat", () => {
  const seen = new Set(Array.from({ length: 200 }, () => randomNonce()));
  assert.equal(seen.size, 200, "nonces collided");
  for (const n of seen) assert.match(n, /^0x[0-9a-f]{64}$/);
});

/* ---- the 402 itself ------------------------------------------------------- */

test("an unpaid request is answered with a 402 carrying the terms", async () => {
  const r = await get(svc.path);
  assert.equal(r.status, 402);
  assert.equal(r.headers.get(HEADERS.provider)?.toLowerCase(), provider.address.toLowerCase());
  assert.match(r.headers.get(HEADERS.price) ?? "", /^\d+$/, "the price is not base units");
  assert.match(r.headers.get(HEADERS.quote) ?? "", /^0x[0-9a-f]{64}$/);
  assert.match(r.headers.get(HEADERS.deadline) ?? "", /^\d+$/);
});

test("the quote is signed by the provider it names", async () => {
  /*
   * The agent checks this before it escrows anything. A signature that verifies
   * against some other key proves only that somebody signed something.
   */
  const r = await get(svc.path);
  const price = BigInt(r.headers.get(HEADERS.price)!);
  const typed = quoteTypedData(arcTestnet.id, escrow, {
    provider: r.headers.get(HEADERS.provider) as `0x${string}`,
    price,
    resource: RESOURCE,
    nonce: r.headers.get(HEADERS.quoteNonce) as `0x${string}`,
    expiry: BigInt(r.headers.get(HEADERS.quoteExpiry)!),
  });
  const ok = await verifyTypedData({
    address: provider.address,
    signature: r.headers.get(HEADERS.quoteSig) as `0x${string}`,
    ...typed,
  });
  assert.equal(ok, true, "the 402's signature is not the named provider's");
});

test("the quote's hash matches the terms it was served with", async () => {
  const r = await get(svc.path);
  const rebuilt = quoteHash(
    r.headers.get(HEADERS.provider) as `0x${string}`,
    BigInt(r.headers.get(HEADERS.price)!),
    RESOURCE,
    r.headers.get(HEADERS.quoteNonce) as `0x${string}`,
  );
  assert.equal(r.headers.get(HEADERS.quote), rebuilt, "the served hash does not commit to the served terms");
});

test("a quote expires, and not in the distant future", async () => {
  const r = await get(svc.path);
  const expiry = Number(r.headers.get(HEADERS.quoteExpiry));
  const now = Math.floor(Date.now() / 1000);
  assert.ok(expiry > now, "the quote was born expired");
  assert.ok(expiry < now + 3600, `a quote good for ${expiry - now}s is not a quote, it is a standing offer`);
});

test("an unknown resource is not quoted", async () => {
  const r = await get("/nothing-here");
  assert.notEqual(r.status, 402, "it quoted a price for a service it does not have");
});

/* ---- what a buyer says about itself --------------------------------------- */

test("claiming to be somebody else can never buy a discount", () => {
  /*
   * The buyer is identified by the address it says it is paying from, and that
   * is unauthenticated. The surcharge is therefore only ever allowed to raise:
   * lying gets you the base price, the same as a newcomer, and never less.
   */
  const clean = { settled: 100, disputed: 0 };
  const awful = { settled: 1, disputed: 99 };
  const base = usdc("0.001");
  const asNewcomer = quotePrice({ basePrice: base }).price;
  assert.ok(quotePrice({ basePrice: base, buyer: clean }).price >= asNewcomer,
    "a spotless record priced below the base — that is a discount for a claim nobody checked");
  assert.ok(quotePrice({ basePrice: base, buyer: awful }).price > asNewcomer,
    "a bad record was not surcharged");
});

test("the surcharge is bounded, so load cannot price a service out of reach", () => {
  const base = usdc("0.001");
  const hammered = quotePrice({
    basePrice: base,
    load: { callsPerMinute: 100_000, comfortableRate: 1 },
    buyer: { settled: 0, disputed: 1000 },
  });
  assert.ok(hammered.price <= base * BigInt(MAX_MULTIPLIER), `priced at ${hammered.multiplier}x, above the cap`);
});

test("a price never rounds down to nothing", () => {
  // A service given away by accident is the one rounding error nobody notices.
  const smallest = quotePrice({ basePrice: 1n, load: { callsPerMinute: 0, comfortableRate: 1000 } });
  assert.ok(smallest.price > 0n);
});

test("the load meter forgets, so yesterday's spike is not today's price", () => {
  const m = new LoadMeter(60_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 50; i++) m.record("x", t0);
  assert.equal(m.ratePerMinute("x", t0), 50);
  assert.equal(m.ratePerMinute("x", t0 + 61_000), 0, "the window never rolled");
});

/* ---- tab keys ------------------------------------------------------------- */

test("a tab key is accepted only in the form it is meant to take", () => {
  assert.equal(tabKey(undefined), null);
  assert.equal(tabKey(""), null);
  assert.equal(tabKey("   "), null);
  assert.equal(typeof tabKey("42"), "string");
});
