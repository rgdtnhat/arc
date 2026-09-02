import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAssetMeta, shortAddress } from "../src/holders.js";

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const KNOWN = [
  { address: USDC, symbol: "USDC", decimals: 6 },
  { address: EURC, symbol: "EURC", decimals: 6 },
];
const ok = (result: unknown) => ({ status: "success", result });
const failed = { status: "failure" };

test("the chain's answer wins when it gives one", () => {
  const m = resolveAssetMeta([USDC, EURC], [ok("USDC"), ok(6), ok("EURC"), ok(6)], []);
  assert.deepEqual(m.map((x) => x.symbol), ["USDC", "EURC"]);
  assert.deepEqual(m.map((x) => x.decimals), [6, 6]);
});

test("a throttled batch falls back to what the deployment knows", () => {
  /*
   * The reported bug. The public RPC returns 429, `allowFailure` hands back a
   * failure for every entry, and the table showed
   *   "1.5983 0x360000 · 0.625418 0x89B508"
   * where the symbols belong.
   */
  const m = resolveAssetMeta([USDC, EURC], [failed, failed, failed, failed], KNOWN);
  assert.deepEqual(m.map((x) => x.symbol), ["USDC", "EURC"]);
  assert.deepEqual(m.map((x) => x.decimals), [6, 6]);
  for (const a of m) assert.ok(!a.symbol.startsWith("0x"), `${a.symbol} is an address, not a symbol`);
});

test("a missing multicall result entirely is handled", () => {
  // `.catch(() => [])` means the array can simply be empty.
  const m = resolveAssetMeta([USDC, EURC], [], KNOWN);
  assert.deepEqual(m.map((x) => x.symbol), ["USDC", "EURC"]);
});

test("decimals never silently become 18 for a known asset", () => {
  // 18 against a 6-decimal token renders a balance as a millionth of itself.
  const m = resolveAssetMeta([USDC], [failed, failed], KNOWN);
  assert.equal(m[0].decimals, 6);
});

test("an asset nobody has named gets a legible address, not a substring", () => {
  const odd = "0x1234567890abcdef1234567890abcdef12345678";
  const m = resolveAssetMeta([odd], [failed, failed], KNOWN);
  assert.equal(m[0].symbol, "0x1234…5678");
  // The old fallback, for contrast: eight characters that read as corruption.
  assert.notEqual(m[0].symbol, odd.slice(0, 8));
  assert.equal(m[0].decimals, 18); // genuinely unknown, so the default stands
});

test("an empty string from the chain is not treated as a symbol", () => {
  // A token that returns "" would otherwise blank the column.
  const m = resolveAssetMeta([USDC], [ok(""), ok(6)], KNOWN);
  assert.equal(m[0].symbol, "USDC");
});

test("known assets match regardless of address casing", () => {
  const m = resolveAssetMeta([EURC.toLowerCase()], [failed, failed], KNOWN);
  assert.equal(m[0].symbol, "EURC");
});

test("shortAddress keeps both ends so an address stays identifiable", () => {
  assert.equal(shortAddress(USDC), "0x3600…0000");
  assert.equal(shortAddress("not an address"), "not an address");
});
