/**
 * The public x402 gateway's endpoint allowlist.
 *
 * This exists because the gateway had a real, exploitable hole. It forwards two
 * things — `/catalog` and `/defi/*` — from a providers app that also serves
 * `/invoices`, the app's own accounting. The check was `startsWith("/defi/")`
 * against `req.path`, and the raw path was then concatenated into a `fetch`
 * URL. Express keeps `..` and percent-encoding verbatim; the URL parser inside
 * `fetch` normalises them. So `/x402/defi/../invoices` passed the allowlist and
 * then resolved to `/invoices` — 200, with the private data, unauthenticated.
 *
 * The bug class is validate-then-use: the string that was checked was not the
 * string that was requested. The fix normalises first and validates the result,
 * so both operate on one value by construction. These tests pin that property
 * against the traversal encodings, not just the one that was reported.
 */
import test from "node:test";
import assert from "node:assert/strict";

const PROVIDERS_ORIGIN = "http://127.0.0.1:8788";
const allowed = (p: string) => p === "/catalog" || p.startsWith("/defi/");

/** The gateway's resolver, mirrored exactly. */
function x402Target(rawPath: string): URL | null {
  let resolved: URL;
  try {
    resolved = new URL(decodeURIComponent(rawPath), PROVIDERS_ORIGIN);
  } catch {
    return null;
  }
  if (resolved.origin !== PROVIDERS_ORIGIN) return null;
  return allowed(resolved.pathname) ? resolved : null;
}

const reached = (p: string) => x402Target(p)?.pathname ?? null;

test("the public endpoints are still reachable", () => {
  assert.equal(reached("/catalog"), "/catalog");
  assert.equal(reached("/defi/yield/best"), "/defi/yield/best");
  assert.equal(reached("/defi/at-risk"), "/defi/at-risk");
});

test("the private endpoint is refused directly", () => {
  assert.equal(reached("/invoices"), null);
});

test("traversal cannot reach the private endpoint — the reported bypass", () => {
  // Each of these previously returned 200 with the invoice list.
  for (const p of [
    "/defi/../invoices",
    "/defi/%2e%2e/invoices",
    "/defi/%2E%2E/invoices",
    "/defi/../../invoices",
    "/defi/./../invoices",
    "/defi/a/b/../../../invoices",
  ]) {
    assert.notEqual(reached(p), "/invoices", `${p} still reaches /invoices`);
    assert.equal(reached(p), null, `${p} should be refused outright`);
  }
});

test("a path that normalises back inside /defi is still allowed", () => {
  // The guard must not be so blunt that it rejects legitimate requests: this
  // resolves to /defi/health, which is a public endpoint.
  assert.equal(reached("/defi/a/../health"), "/defi/health");
});

test("dot segments collapse, and empty ones stay harmlessly inside /defi", () => {
  assert.equal(reached("/defi/./yield/./best"), "/defi/yield/best");
  // WHATWG keeps empty path segments rather than collapsing them. That is fine
  // here: the path still resolves under /defi, so it cannot reach anything the
  // allowlist forbids — upstream simply 404s on a route it does not have.
  assert.equal(reached("/defi//yield///best"), "/defi//yield///best");
});

test("a leading double slash is treated as another host, not as a path", () => {
  // `new URL("//invoices", base)` is protocol-relative: it parses as
  // http://invoices/, a different origin entirely. The origin check is what
  // catches this — an allowlist alone would have seen a pathname of "/".
  assert.equal(reached("//invoices"), null);
  assert.equal(reached("//evil.example.com/defi/x"), null);
});

test("the request can never be pointed off loopback", () => {
  // A path that parses as its own origin must be refused, not forwarded.
  for (const p of [
    "//evil.example.com/invoices",
    "/\\evil.example.com/invoices",
    "https://evil.example.com/defi/x",
    "//127.0.0.1:9999/defi/x",
  ]) {
    const t = x402Target(p);
    assert.ok(t === null || t.origin === PROVIDERS_ORIGIN, `${p} escaped the providers origin`);
  }
});

test("malformed input is refused rather than throwing", () => {
  // A bare "%" is not valid percent-encoding; decodeURIComponent throws on it.
  for (const p of ["%", "%zz", "/defi/%"]) {
    assert.doesNotThrow(() => x402Target(p));
    assert.equal(reached(p), null);
  }
});

test("the allowlist does not accept a prefix that merely starts with the name", () => {
  // "/defiant" is not "/defi/..." — the trailing slash in the check matters.
  assert.equal(reached("/defiant"), null);
  assert.equal(reached("/catalogue"), null);
});
