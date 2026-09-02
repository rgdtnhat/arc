/**
 * The two pieces of the holder leaderboard that quietly go wrong.
 *
 * Ranking and paging are both arithmetic over values that routinely exceed
 * 2^53 (share counts) or that the UI will happily render as a blank table (an
 * out-of-range page). Neither failure announces itself — a leaderboard with the
 * biggest holder in the wrong place, or a page 4 of 3 showing nothing, both look
 * like plausible screens. So they get pinned here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { percentOf, paginate } from "../src/holders.js";

// --- percentOf --------------------------------------------------------------

test("percentOf splits a total into shares that add back up", () => {
  const total = 1000n;
  assert.equal(percentOf(250n, total), 25);
  assert.equal(percentOf(750n, total), 75);
  assert.equal(percentOf(1000n, total), 100);
});

test("percentOf keeps precision past 2^53, where floats would not", () => {
  // Share counts are 18-decimal. Converting to Number first collapses these two
  // into the same value and the leaderboard shows a tie that isn't there.
  const total = 10n ** 24n;
  const a = 10n ** 24n / 3n;
  const b = a + 10n ** 18n;
  assert.ok(percentOf(b, total) > percentOf(a, total), "a larger position ranks higher");
  assert.equal(percentOf(a, total), 33.3333);
});

test("percentOf treats an empty venue as zero, not a division by zero", () => {
  assert.equal(percentOf(0n, 0n), 0);
  assert.equal(percentOf(5n, 0n), 0);
});

// --- paginate ---------------------------------------------------------------

const rows = Array.from({ length: 23 }, (_, i) => i + 1);

test("paginate slices the requested page", () => {
  const p = paginate(rows, 2, 10);
  assert.deepEqual(p.rows, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(p.page, 2);
  assert.equal(p.pages, 3);
  assert.equal(p.total, 23);
});

test("the last page is the remainder, not a full page padded out", () => {
  const p = paginate(rows, 3, 10);
  assert.deepEqual(p.rows, [21, 22, 23]);
});

test("a page past the end clamps to the last one instead of rendering blank", () => {
  // Reachable by shrinking the page size while sitting on a high page number.
  const p = paginate(rows, 99, 10);
  assert.equal(p.page, 3);
  assert.equal(p.rows.length, 3);
});

test("a page below the first clamps up", () => {
  assert.equal(paginate(rows, 0, 10).page, 1);
  assert.equal(paginate(rows, -5, 10).page, 1);
});

test("an empty list is one page, not zero — the pager still has to render", () => {
  const p = paginate([], 1, 10);
  assert.equal(p.pages, 1);
  assert.equal(p.page, 1);
  assert.equal(p.total, 0);
  assert.deepEqual(p.rows, []);
});

test("a nonsense page size falls back to something renderable", () => {
  assert.equal(paginate(rows, 1, 0).size, 10);
  assert.equal(paginate(rows, 1, Number.NaN).size, 10);
  assert.equal(paginate(rows, 1, -3).size, 1);
});

test("changing the page size repaginates rather than dropping rows", () => {
  const small = paginate(rows, 1, 5);
  assert.equal(small.pages, 5);
  assert.equal(small.rows.length, 5);
  // Every row is reachable across the pages — nothing falls off the end.
  const seen = [];
  for (let i = 1; i <= small.pages; i++) seen.push(...paginate(rows, i, 5).rows);
  assert.deepEqual(seen, rows);
});
