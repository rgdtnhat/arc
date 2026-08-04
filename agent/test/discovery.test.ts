import test from "node:test";
import assert from "node:assert/strict";
import {
  trustOf,
  rankListings,
  decodeFindResult,
  endpointAllowed,
  type Listing,
} from "../src/discovery.ts";

const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const C = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

const listing = (o: Partial<Listing> = {}): Listing => ({
  provider: A,
  price: USDC(0.001),
  stake: 0n,
  fulfilled: 0n,
  failed: 0n,
  distinctBuyers: 0n,
  ...o,
});

// --- trust ------------------------------------------------------------------

test("a provider with no history scores as unknown, not as bad", () => {
  // Scoring newcomers at zero would encode 'nobody new is ever worth trying',
  // which forecloses the competition the registry exists to allow.
  assert.equal(trustOf(listing()), 0.5);
});

test("a perfect record across many buyers beats the same record across one", () => {
  const concentrated = trustOf(listing({ fulfilled: 100n, failed: 0n, distinctBuyers: 1n }));
  const broad = trustOf(listing({ fulfilled: 100n, failed: 0n, distinctBuyers: 40n }));
  assert.ok(broad > concentrated, `${broad} should beat ${concentrated}`);
});

test("failures pull the score down", () => {
  const clean = trustOf(listing({ fulfilled: 20n, failed: 0n, distinctBuyers: 10n }));
  const spotty = trustOf(listing({ fulfilled: 10n, failed: 10n, distinctBuyers: 10n }));
  assert.ok(spotty < clean);
});

test("stake helps, but stops helping past the cap", () => {
  const none = trustOf(listing({ fulfilled: 10n, failed: 0n, distinctBuyers: 5n, stake: 0n }));
  const some = trustOf(listing({ fulfilled: 10n, failed: 0n, distinctBuyers: 5n, stake: USDC(500) }));
  const lots = trustOf(listing({ fulfilled: 10n, failed: 0n, distinctBuyers: 5n, stake: USDC(1_000) }));
  const absurd = trustOf(listing({ fulfilled: 10n, failed: 0n, distinctBuyers: 5n, stake: USDC(1_000_000) }));
  assert.ok(some > none);
  assert.ok(lots > some);
  assert.equal(absurd, lots, "more stake past the cap says nothing further");
});

test("the score never leaves [0, 1]", () => {
  for (const l of [
    listing({ fulfilled: 0n, failed: 500n, distinctBuyers: 0n }),
    listing({ fulfilled: 10_000n, failed: 0n, distinctBuyers: 9_000n, stake: USDC(9_000_000) }),
  ]) {
    const s = trustOf(l);
    assert.ok(s >= 0 && s <= 1, `${s} out of range`);
  }
});

// --- ranking ----------------------------------------------------------------

test("does not simply pick the cheapest", () => {
  // The cheapest listing in an open registry is the one from an address that
  // just appeared and intends to take the money.
  const ranked = rankListings([
    listing({ provider: A, price: USDC(0.0001), fulfilled: 0n, failed: 0n }),
    listing({ provider: B, price: USDC(0.001), fulfilled: 200n, failed: 1n, distinctBuyers: 60n, stake: USDC(500) }),
  ]);
  assert.equal(ranked[0]!.provider, B);
});

test("prefers the cheaper of two equally trusted providers", () => {
  const common = { fulfilled: 50n, failed: 0n, distinctBuyers: 20n, stake: USDC(100) };
  const ranked = rankListings([
    listing({ provider: A, price: USDC(0.005), ...common }),
    listing({ provider: B, price: USDC(0.001), ...common }),
  ]);
  assert.equal(ranked[0]!.provider, B);
});

test("drops anything above the price ceiling rather than ranking it down", () => {
  const ranked = rankListings(
    [
      listing({ provider: A, price: USDC(1), fulfilled: 999n, distinctBuyers: 500n }),
      listing({ provider: B, price: USDC(0.001) }),
    ],
    { maxPrice: USDC(0.01) },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.provider, B);
});

test("honours an exclusion list whatever the score", () => {
  const ranked = rankListings(
    [listing({ provider: A, fulfilled: 500n, distinctBuyers: 200n }), listing({ provider: B })],
    { exclude: [A] },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.provider, B);
});

test("exclusion is case-insensitive, because addresses arrive both ways", () => {
  const ranked = rankListings([listing({ provider: A })], { exclude: [A.toLowerCase() as typeof A] });
  assert.equal(ranked.length, 0);
});

test("a minimum-history filter can be asked for when the buy is large", () => {
  const ranked = rankListings([listing({ provider: A }), listing({ provider: B, fulfilled: 20n, distinctBuyers: 8n })], {
    minFulfilled: 10n,
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.provider, B);
});

test("returns nothing rather than throwing when the market is empty", () => {
  assert.deepEqual(rankListings([]), []);
  assert.deepEqual(rankListings([listing()], { maxPrice: 0n }), []);
});

test("price weight of zero ignores price entirely", () => {
  const ranked = rankListings(
    [
      listing({ provider: A, price: USDC(10), fulfilled: 100n, failed: 0n, distinctBuyers: 50n }),
      listing({ provider: B, price: USDC(0.000001), fulfilled: 1n, failed: 5n, distinctBuyers: 1n }),
    ],
    { priceWeight: 0 },
  );
  assert.equal(ranked[0]!.provider, A);
});

test("explains itself", () => {
  const [top] = rankListings([listing({ fulfilled: 9n, failed: 1n, distinctBuyers: 4n, stake: USDC(50) })]);
  assert.ok(top!.reasons.some((r) => r.includes("9/10")));
  assert.ok(top!.reasons.some((r) => r.includes("50 USDC staked")));
});

// --- decoding ---------------------------------------------------------------

test("drops the padding the contract pads its page with", () => {
  // findByResource returns fixed-length arrays sized to the page plus a count;
  // reading past `found` would invent providers at the zero address.
  const { listings, nextStart } = decodeFindResult([
    [A, B, "0x0000000000000000000000000000000000000000"],
    [USDC(1), USDC(2), 0n],
    [0n, 0n, 0n],
    [1n, 2n, 0n],
    [0n, 0n, 0n],
    [1n, 1n, 0n],
    2n,
    3n,
  ] as any);
  assert.equal(listings.length, 2);
  assert.equal(listings[1]!.provider, B);
  assert.equal(nextStart, 3n);
});

// --- endpoint safety --------------------------------------------------------

test("refuses endpoints that would turn a listing into an SSRF primitive", () => {
  // The registry is permissionless: `endpoint` is a string a stranger chose,
  // and the agent is about to fetch it from inside our network.
  for (const bad of [
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:8545",
    "http://127.0.0.1/admin",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.9/",
    "http://172.31.255.1/",
    "file:///etc/passwd",
    "ftp://example.com/",
    "not a url",
    undefined,
  ]) {
    assert.equal(endpointAllowed(bad), false, `should refuse ${bad}`);
  }
});

test("allows an ordinary public endpoint", () => {
  for (const ok of ["https://api.example.com/weather", "http://provider.example:8080/x"]) {
    assert.equal(endpointAllowed(ok), true, `should allow ${ok}`);
  }
});

test("172.32 is public even though 172.16-31 is not", () => {
  assert.equal(endpointAllowed("https://172.32.0.1/"), true);
  assert.equal(endpointAllowed("https://172.15.0.1/"), true);
});
