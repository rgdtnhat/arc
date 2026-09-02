import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { coverRange, isCovered } from "../src/archive-chain.ts";

/**
 * A throttled endpoint must not mean a scan that can never finish.
 *
 * `migrate:pool` finds suppliers by walking the pool's whole life in 10k-block
 * windows. A window the endpoint refuses is a hole in the holder set, and a
 * partial scan now blocks `--execute` — because whoever is missing would be
 * left behind on a pool the migration is about to have frozen.
 *
 * Those two together were a dead end: nothing was kept between runs, so every
 * attempt re-fought the same windows and a busy RPC produced the same partial
 * answer for ever. Observed on the live deployment — eleven minutes in, most
 * windows refused, and no way through.
 *
 * Blocks are immutable, so a range read once never needs reading again. With
 * that written down each run fills holes instead of reopening them.
 */

test("touching ranges merge, so no seam is re-read for ever", () => {
  // [1,10] and [11,20] are one range. A gap of zero blocks is not a gap, and
  // treating it as one means re-reading that seam on every future run.
  const merged = coverRange([[1n, 10n]], [11n, 20n]);
  assert.deepEqual(merged, [[1n, 20n]]);
});

test("overlapping and disjoint ranges both land correctly", () => {
  assert.deepEqual(coverRange([[1n, 10n]], [5n, 15n]), [[1n, 15n]]);
  assert.deepEqual(coverRange([[1n, 10n]], [20n, 30n]), [[1n, 10n], [20n, 30n]]);
  // Out of order in, sorted out.
  assert.deepEqual(coverRange([[20n, 30n]], [1n, 10n]), [[1n, 10n], [20n, 30n]]);
});

test("a hole between two runs is filled by a third", () => {
  /*
   * The shape of the problem: two runs each read part of the range and each
   * misses a middle window. The third reads only what is still missing.
   */
  let done: [bigint, bigint][] = [];
  done = coverRange(done, [200n, 300n]);   // run 1
  done = coverRange(done, [1n, 99n]);      // run 2, refused 100–199
  assert.equal(isCovered(done, 100n, 199n), false, "the hole reads as covered");
  done = coverRange(done, [100n, 199n]);   // run 3
  assert.deepEqual(done, [[1n, 300n]]);
  assert.equal(isCovered(done, 100n, 199n), true);
});

test("coverage is only claimed for a range fully inside one read", () => {
  const done: [bigint, bigint][] = [[100n, 200n], [300n, 400n]];
  assert.equal(isCovered(done, 120n, 180n), true);
  assert.equal(isCovered(done, 100n, 200n), true, "the exact range is covered");
  // Straddling two ranges is not covered: the gap between them was never read.
  assert.equal(isCovered(done, 150n, 350n), false);
  assert.equal(isCovered(done, 50n, 150n), false, "a range starting before the read is covered");
  assert.equal(isCovered([], 1n, 2n), false);
});

test("the scanner asks again before calling a window a hole", () => {
  const src = readFileSync(new URL("../src/archive-chain.ts", import.meta.url), "utf8");
  const loop = src.slice(src.indexOf("while (to > floor)"), src.indexOf("saveCache();\n    return"));
  assert.match(loop, /attempt < Math\.max\(1, opts\.attempts \?\? 3\)/, "a refused window is dropped on the first no");
  assert.match(loop, /setTimeout\(r, 500 \* \(attempt \+ 1\)\)/, "it retries without giving the endpoint room");
  // And a window it did read is recorded immediately, not only at the end —
  // a run killed part way should still leave progress behind.
  assert.match(loop, /covered = coverRange\(covered, \[from, to\]\);\s*\n\s*saveCache\(\);/);
});

test("a covered window is skipped rather than re-read", () => {
  const src = readFileSync(new URL("../src/archive-chain.ts", import.meta.url), "utf8");
  const loop = src.slice(src.indexOf("while (to > floor)"), src.indexOf("saveCache();\n    return"));
  assert.match(loop, /isCovered\(covered, from, to\)/, "the cache is written but never read");
  assert.match(loop, /cached: true/, "a cached window is indistinguishable from a fresh read");
});

test("the cache is keyed so two scans cannot contaminate each other", () => {
  const src = readFileSync(new URL("../src/archive-chain.ts", import.meta.url), "utf8");
  // Same pool, different event, different ground covered.
  assert.match(src, /const key = `\$\{address\}:\$\{event\.name \?\? "event"\}:\$\{field\}`/);
});

test("the migration hands the scanner somewhere to keep it", () => {
  const script = readFileSync(new URL("../../scripts/migrate-pool.mjs", import.meta.url), "utf8");
  assert.match(script, /cacheFile: scanCache/, "the scan still starts from nothing every run");
  assert.match(script, /\.tessera-log-scan\.json/);
  // And says so, because an invisible cache is one nobody trusts.
  assert.match(script, /re-run to fill any refused windows/);
});
