/**
 * Tests for the app-fee aggregation.
 *
 * `aggregate` is the arithmetic behind the numbers an operator reads as "the app
 * took X and sent Y to the vault", so it is the part someone would reconcile
 * against the chain. These pin the day boundary, the decimal conversion, and the
 * treatment of an allocation whose block header could not be read — the three
 * ways a fee report goes quietly wrong.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, type Allocation } from "../src/fees.ts";

const USDC = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6));

/** `at` is seconds since the epoch, as a block header reports it. */
const alloc = (at: number | null, total: string, parts: Partial<Record<
  "toAgent" | "toLending" | "toVault" | "toSwap" | "retained", string>> = {}): Allocation => ({
  blockNumber: "1",
  txHash: "0x" + "0".repeat(64),
  at,
  total: USDC(total),
  toAgent: USDC(parts.toAgent ?? "0"),
  toLending: USDC(parts.toLending ?? "0"),
  toVault: USDC(parts.toVault ?? "0"),
  toSwap: USDC(parts.toSwap ?? "0"),
  retained: USDC(parts.retained ?? "0"),
});

const DAY = 86_400;
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

test("totals every sink across allocations", () => {
  const { totals } = aggregate(
    [
      alloc(at("2026-07-01T10:00:00Z"), "100", { toAgent: "20", toLending: "20", toVault: "20", toSwap: "20", retained: "20" }),
      alloc(at("2026-07-02T10:00:00Z"), "50", { toAgent: "10", toLending: "10", toVault: "10", toSwap: "10", retained: "10" }),
    ],
    6,
  );
  assert.equal(totals.total, USDC("150"));
  assert.equal(totals.toAgent, USDC("30"));
  assert.equal(totals.toLending, USDC("30"));
  assert.equal(totals.toVault, USDC("30"));
  assert.equal(totals.toSwap, USDC("30"));
  assert.equal(totals.retained, USDC("30"));
  // The split must account for the whole intake, or a sink is being missed.
  assert.equal(
    totals.toAgent + totals.toLending + totals.toVault + totals.toSwap + totals.retained,
    totals.total,
  );
});

test("buckets by UTC day and sums within a day", () => {
  const { daily } = aggregate(
    [
      alloc(at("2026-07-01T00:00:01Z"), "10", { toVault: "10" }),
      alloc(at("2026-07-01T23:59:59Z"), "5", { toVault: "5" }),
      alloc(at("2026-07-02T12:00:00Z"), "7", { toVault: "7" }),
    ],
    6,
  );
  assert.equal(daily.length, 2);
  assert.deepEqual(daily.map((d) => d.day), ["2026-07-01", "2026-07-02"]);
  assert.equal(daily[0].total, 15);
  assert.equal(daily[0].toVault, 15);
  assert.equal(daily[1].total, 7);
});

test("a day boundary is UTC midnight, not a local one", () => {
  // 23:30 UTC and 00:30 UTC the next day are different days, even though they
  // are half an hour apart and fall on the same local date in many zones.
  const { daily } = aggregate(
    [alloc(at("2026-07-01T23:30:00Z"), "1"), alloc(at("2026-07-02T00:30:00Z"), "1")],
    6,
  );
  assert.deepEqual(daily.map((d) => d.day), ["2026-07-01", "2026-07-02"]);
});

test("returns days oldest first, whatever order the logs arrived in", () => {
  // The scanner walks backwards, so its list is newest first. A chart plotted in
  // that order would run right to left.
  const { daily } = aggregate(
    [
      alloc(at("2026-07-05T10:00:00Z"), "3"),
      alloc(at("2026-07-01T10:00:00Z"), "1"),
      alloc(at("2026-07-03T10:00:00Z"), "2"),
    ],
    6,
  );
  assert.deepEqual(daily.map((d) => d.day), ["2026-07-01", "2026-07-03", "2026-07-05"]);
  assert.deepEqual(daily.map((d) => d.total), [1, 2, 3]);
});

test("counts an allocation with no timestamp in the totals but not in the chart", () => {
  // A block header that could not be read must not vanish from the money, and
  // must not be invented onto a date either.
  const { totals, daily } = aggregate(
    [alloc(at("2026-07-01T10:00:00Z"), "10"), alloc(null, "90")],
    6,
  );
  assert.equal(totals.total, USDC("100"), "the money is all there");
  assert.equal(daily.length, 1, "only the dated one is plotted");
  assert.equal(daily[0].total, 10);
});

test("converts by the asset's decimals", () => {
  // cirBTC is 8dp; reading it at 6 would report a hundredfold.
  const eight: Allocation = { ...alloc(at("2026-07-01T10:00:00Z"), "0"), total: 12_345_678n };
  const { daily } = aggregate([eight], 8);
  assert.equal(daily[0].total, 0.12345678);
});

test("handles an empty history without inventing a row", () => {
  const { totals, daily } = aggregate([], 6);
  assert.equal(totals.total, 0n);
  assert.deepEqual(daily, []);
});

test("does not merge distinct days that are exactly 24h apart", () => {
  const base = at("2026-07-01T06:00:00Z");
  const { daily } = aggregate([alloc(base, "1"), alloc(base + DAY, "2"), alloc(base + 2 * DAY, "3")], 6);
  assert.equal(daily.length, 3);
  assert.deepEqual(daily.map((d) => d.total), [1, 2, 3]);
});
