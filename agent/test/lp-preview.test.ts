import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * How much liquidity am I actually moving?
 *
 * The add/withdraw form asked for a number per asset and told you nothing back.
 * The hint said "deposit every asset in proportion" and "withdrawing returns a
 * proportional slice" — both true, neither an answer. What is the other side of
 * this pair, how many shares does it buy, and how much of what I typed buys
 * nothing at all.
 *
 * That last one costs money. `_addLiquidity` credits the *smallest* ratio:
 *
 *     shares = min_i(amounts[i] * totalShares / reserves[i])
 *
 * so anything above that ratio is added to the reserves and mints nothing — a
 * silent donation to every other provider. The preview has to agree with that
 * arithmetic exactly, so the helpers are lifted out of the shipped `app.js` and
 * run for real here rather than being re-typed.
 */

const app = readFileSync(new URL("../../dashboard/public/app.js", import.meta.url), "utf8");

function grab(name: string): string {
  const start = app.indexOf(`      function ${name}(`);
  assert.notEqual(start, -1, `${name} is not a shared helper in app.js`);
  const end = app.indexOf("\n      }\n", start);
  assert.notEqual(end, -1, `${name} has no closing brace at the shared level`);
  return app.slice(start, end + "\n      }".length);
}

const api = new Function(`
  const AMM_MINIMUM_LIQUIDITY = 1000n;
  ${grab("lpReserves")}
  ${grab("lpPairFor")}
  ${grab("lpAddPreview")}
  ${grab("lpRemovePreview")}
  return { lpPairFor, lpAddPreview, lpRemovePreview };
`)() as {
  lpPairFor: (p: unknown, i: number, raw: bigint) => bigint[] | null;
  lpAddPreview: (p: unknown, typed: bigint[]) => any;
  lpRemovePreview: (p: unknown, shares: bigint) => { out: bigint[]; shares: bigint } | null;
};

/** The live USDC/EURC pool, exactly as `/api/state` reported it. */
const POOL = {
  id: 0,
  totalShares: "38746710",
  myShares: "4000000",
  assets: [
    { symbol: "USDC", address: "0x36", decimals: 6, raw: "171165762" },
    { symbol: "EURC", address: "0x89", decimals: 6, raw: "161000000" },
  ],
};

/** The contract's own arithmetic, as an independent check. */
const mintedBy = (typed: bigint[], reserves: bigint[], total: bigint) =>
  typed.reduce<bigint | null>((best, v, i) => {
    const m = (v * total) / reserves[i];
    return best === null || m < best ? m : best;
  }, null)!;

test("the pair is the pool's own ratio", () => {
  const pair = api.lpPairFor(POOL, 0, 10_000_000n); // 10 USDC
  assert.ok(pair);
  assert.equal(pair![0], 10_000_000n);
  // 10 USDC × 161000000 / 171165762
  assert.equal(pair![1], (10_000_000n * 161_000_000n) / 171_165_762n);
});

test("a balanced deposit donates nothing, and mints what the contract would", () => {
  const pair = api.lpPairFor(POOL, 0, 10_000_000n)!;
  const pre = api.lpAddPreview(POOL, pair);
  assert.equal(pre.balanced, true);
  assert.deepEqual(pre.donated, [0n, 0n]);
  assert.equal(
    pre.shares,
    mintedBy(pair, [171_165_762n, 161_000_000n], 38_746_710n),
    "the preview and the contract disagree about shares",
  );
});

test("an unbalanced deposit names exactly what mints nothing", () => {
  /*
   * The defect this exists for: two numbers that look reasonable, and one of
   * them is a donation. 10 USDC pairs with ~9.406 EURC here; supplying 20 EURC
   * hands over 10.59 for nothing.
   */
  const typed = [10_000_000n, 20_000_000n];
  const pre = api.lpAddPreview(POOL, typed);
  assert.equal(pre.balanced, false);
  // The USDC side is the binding one, so none of it is donated.
  assert.equal(pre.donated[0], 0n);
  assert.ok(pre.donated[1] > 0n, "the excess EURC was not reported");
  // Credited at the smallest ratio — the same number the contract mints.
  assert.equal(pre.shares, mintedBy(typed, [171_165_762n, 161_000_000n], 38_746_710n));
  // And the excess is what is left after the credited ratio is taken out.
  const credited = (pre.shares * 161_000_000n) / 38_746_710n;
  assert.equal(pre.donated[1], 20_000_000n - credited);
});

test("withdrawing returns each asset in proportion", () => {
  const pre = api.lpRemovePreview(POOL, 4_000_000n)!;
  // The contract divides by the total *before* the burn.
  assert.equal(pre.out[0], (171_165_762n * 4_000_000n) / 38_746_710n);
  assert.equal(pre.out[1], (161_000_000n * 4_000_000n) / 38_746_710n);
});

test("a pool with no ratio yet has no pair to offer", () => {
  const empty = { ...POOL, totalShares: "0", assets: POOL.assets.map((a) => ({ ...a, raw: "0" })) };
  assert.equal(api.lpPairFor(empty, 0, 1_000_000n), null);
  // …and the first deposit mints the sum, less the burned minimum.
  const pre = api.lpAddPreview(empty, [1_000_000n, 2_000_000n]);
  assert.equal(pre.first, true);
  assert.equal(pre.shares, 3_000_000n - 1000n);
});

test("a first deposit below the burn mints nothing, and says so", () => {
  const empty = { ...POOL, totalShares: "0", assets: POOL.assets.map((a) => ({ ...a, raw: "0" })) };
  const pre = api.lpAddPreview(empty, [400n, 500n]);
  assert.equal(pre.tooSmall, true);
  assert.equal(pre.shares, 0n);
});

test("nothing typed, or zero typed, previews nothing", () => {
  assert.equal(api.lpAddPreview(POOL, [0n, 0n]), null);
  assert.equal(api.lpRemovePreview(POOL, 0n), null);
  assert.equal(api.lpPairFor(POOL, 0, 0n), null);
});

test("the share percentage is of the pool after the deposit, not before", () => {
  /*
   * Dividing by the pre-deposit total overstates it — a deposit doubling the
   * pool would read as 100% rather than 50%.
   */
  const pair = api.lpPairFor(POOL, 0, 171_165_762n)!; // double the pool
  const pre = api.lpAddPreview(POOL, pair);
  assert.ok(pre.sharePct > 49 && pre.sharePct < 51, `got ${pre.sharePct}%`);
});

test("flooring dust is not reported as a donation, but a real excess still is", () => {
  /*
   * Both `shares` and the credited amounts are floored, so an exactly matched
   * pair comes out a few base units "unbalanced". Reporting that would put
   * "0.000006 USDC mints nothing" under a perfectly balanced deposit and teach
   * the reader to ignore the one warning here that costs real money. The bound
   * is derived from the two floors — `res/total + 2` — not picked.
   */
  const pair = api.lpPairFor(POOL, 0, 10_000_000n)!;
  assert.deepEqual(api.lpAddPreview(POOL, pair).donated, [0n, 0n]);

  // One base unit over the bound on the EURC side is still dust.
  const dust = 161_000_000n / 38_746_710n + 2n;
  assert.deepEqual(api.lpAddPreview(POOL, [pair[0], pair[1] + dust]).donated, [0n, 0n]);
  // Comfortably past it is a real donation and must be named.
  const over = api.lpAddPreview(POOL, [pair[0], pair[1] + dust + 1_000n]).donated;
  assert.ok(over[1] > 0n, "a genuine excess was swallowed as dust");
});
