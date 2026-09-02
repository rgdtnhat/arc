/**
 * Turning bought answers into a recommendation.
 *
 * The complaint this addresses was that the agent's output was "meaningless" —
 * it bought weather and an FX quote and stopped. Buying an answer is only worth
 * anything if something acts on it, so these pin the part that does: that a
 * dangerous position escalates, that unsettled purchases are never used as
 * evidence, and that the advice cites what it is based on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { adviseFrom } from "../src/scenario.js";

const settled = (resource: string, data: unknown) => ({ resource, status: "settled", data });

test("a healthy position reads as healthy and says why", () => {
  const a = adviseFrom([
    settled("defi:yield-best", { best: { venue: "vault", asset: "USDC", aprPct: 4.2 } }),
    settled("defi:health", { band: "safe", healthFactor: 1.8, bufferPct: 44.4 }),
  ]);
  assert.equal(a.level, "ok");
  assert.equal(a.headline, "Treasury is healthy");
  assert.ok(a.lines.some((l) => /vault at 4.2% APR/.test(l)), "names the venue and the rate");
  assert.ok(a.lines.some((l) => /safe \(health factor 1.8\)/.test(l)));
});

test("a position near liquidation escalates to act, not to a note", () => {
  const a = adviseFrom([settled("defi:health", { band: "at-risk", healthFactor: 1.02, bufferPct: 1.96 })]);
  assert.equal(a.level, "act");
  assert.equal(a.headline, "Action needed on the treasury");
  assert.match(a.lines[0], /repay or add collateral now/);
  assert.match(a.lines[0], /1.96%/, "quotes the actual headroom");
});

test("a thinning position warns without crying wolf", () => {
  const a = adviseFrom([settled("defi:health", { band: "watch", healthFactor: 1.3, bufferPct: 18 })]);
  assert.equal(a.level, "watch");
  assert.match(a.lines[0], /thinning/);
});

test("the worst finding sets the level, not the last one", () => {
  // Ordering must not decide severity: a safe counterparty after an at-risk
  // position still leaves the run at "act".
  const a = adviseFrom([
    settled("defi:health", { band: "at-risk", healthFactor: 1.01, bufferPct: 1 }),
    settled("defi:reputation", { verdict: "good", settled: 30, failed: 0 }),
  ]);
  assert.equal(a.level, "act");
});

test("an unsettled purchase is not treated as evidence", () => {
  // A refunded call delivered nothing. Advising off it would be advising off a
  // response the agent explicitly rejected and got its money back for.
  const a = adviseFrom([
    { resource: "defi:health", status: "refunded", data: { band: "safe", healthFactor: 9 } },
    { resource: "defi:yield-best", status: "skipped" },
  ]);
  assert.ok(!a.lines.some((l) => /health factor/.test(l)), "the refunded answer was not used");
  assert.equal(a.headline, "Not enough was delivered to advise on");
});

test("refunds are reported as the rail working, not as a loss", () => {
  const a = adviseFrom([
    settled("defi:health", { band: "safe", healthFactor: 2, bufferPct: 50 }),
    { resource: "news:headlines", status: "refunded" },
  ]);
  assert.ok(a.lines.some((l) => /refunded on-chain — we paid nothing/.test(l)));
});

test("a poor counterparty is flagged, a good one is cleared", () => {
  const bad = adviseFrom([settled("defi:reputation", { verdict: "poor", settled: 6, failed: 4 })]);
  assert.equal(bad.level, "watch");
  assert.match(bad.lines[0], /6\/10 delivered/, "shows the counts behind the verdict");

  const good = adviseFrom([settled("defi:reputation", { verdict: "good", settled: 40, failed: 1 })]);
  assert.equal(good.level, "ok");
  assert.match(good.lines[0], /fine to deal with/);
});

test("a venue that cannot fill is stated plainly rather than omitted", () => {
  const a = adviseFrom([settled("defi:route", { best: null, legs: [] })]);
  assert.match(a.lines[0], /Neither the desk nor the AMM can fill/);
});

test("nothing bought yields no invented advice", () => {
  const a = adviseFrom([]);
  assert.deepEqual(a.lines, []);
  assert.equal(a.level, "ok");
  assert.equal(a.headline, "Not enough was delivered to advise on");
});

test("a zero-yield market is stated rather than dressed up", () => {
  const a = adviseFrom([settled("defi:yield-best", { best: null, venues: [] })]);
  assert.match(a.lines[0], /No venue is paying a positive rate/);
});
