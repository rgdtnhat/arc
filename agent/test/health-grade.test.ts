import test from "node:test";
import assert from "node:assert/strict";
import { gradeUndelivered, gradeLastPoke } from "../src/health-grade.ts";

/**
 * The two ways `/api/health/protocol` was lying, pinned as a table.
 *
 * Both were live at once on this deployment, and between them they are why a
 * pool frozen for supply and borrow ran for days without the health panel
 * saying anything useful: one check screamed at a healthy fifteen-minute cycle,
 * so the page's overall status was `fail` and `fail` stopped meaning anything;
 * the other slept through a keeper that had been cold for seventeen days.
 */

const ROUND = 15 * 60; // the keeper's default interval, in seconds

test("a healthy cycle between two rounds is not a failure", () => {
  /*
   * The measured numbers. The emitter released and the keeper distributed at
   * 14:31 and again at 14:46 — fifteen minutes apart, exactly as configured —
   * and in between the pending total reached 1,359 TSRA. The old rule
   * (`tokens > 500 → fail`) called that a failure, twice an hour, forever.
   */
  const g = gradeUndelivered({ tokens: 1359.83, sinceDistribute: 8 * 60, roundSeconds: ROUND, canDistribute: true });
  assert.equal(g.status, "ok", g.detail);
});

test("a handle nobody is turning still fails, however small the pile", () => {
  const g = gradeUndelivered({ tokens: 12, sinceDistribute: ROUND * 5, roundSeconds: ROUND, canDistribute: true });
  assert.equal(g.status, "fail");
  assert.match(g.detail, /nobody is turning the handle/);
});

test("one missed round warns rather than failing", () => {
  const g = gradeUndelivered({ tokens: 800, sinceDistribute: ROUND * 3, roundSeconds: ROUND, canDistribute: true });
  assert.equal(g.status, "warn", g.detail);
});

test("nothing waiting is never late", () => {
  const g = gradeUndelivered({ tokens: 0, sinceDistribute: ROUND * 99, roundSeconds: ROUND, canDistribute: true });
  assert.equal(g.status, "ok");
});

test("a server with no key to distribute with says so instead of claiming health", () => {
  // `distribute` is permissionless, so this is not broken — but nothing here
  // will turn it, and "ok" would promise a handle that is not being turned.
  const g = gradeUndelivered({ tokens: 900, sinceDistribute: null, roundSeconds: ROUND, canDistribute: false });
  assert.equal(g.status, "warn");
  assert.match(g.detail, /no key to distribute with/);
});

test("a fresh start gets one interval of grace, not an alarm", () => {
  const g = gradeUndelivered({ tokens: 900, sinceDistribute: null, roundSeconds: ROUND, canDistribute: true });
  assert.equal(g.status, "ok");
  assert.match(g.detail, /no round has run yet/);
});

test("a keeper poked once at genesis is not healthy seventeen days later", () => {
  /*
   * The live reading, exactly: "1 round(s), last 25210 min ago", graded `ok`
   * because the rule only ever looked at `rounds === 0`.
   */
  const now = 1_787_670_000;
  const g = gradeLastPoke({ rounds: 1, lastPokeSec: now - 25_210 * 60, nowSec: now });
  assert.notEqual(g.status, "ok", "a seventeen-day-old poke was filed as healthy");
  assert.equal(g.status, "warn");
  assert.match(g.detail, /17\.5 day/);
});

test("a keeper poked this morning is healthy", () => {
  const now = 1_787_670_000;
  const g = gradeLastPoke({ rounds: 40, lastPokeSec: now - 3600, nowSec: now });
  assert.equal(g.status, "ok");
  assert.match(g.detail, /60 min ago/);
});

test("never poked is a warning about the permissionless path, and says which", () => {
  const now = 1_787_670_000;
  const g = gradeLastPoke({ rounds: 0, lastPokeSec: 0, nowSec: now });
  assert.equal(g.status, "warn");
  assert.match(g.detail, /never poked/);
});

test("a stale poke never escalates to fail — the app's own keeper covers it", () => {
  // `gradeUndelivered` is the check that escalates when tokens are actually
  // stranded. Two checks failing for one cause is how a panel gets ignored.
  const now = 1_787_670_000;
  for (const days of [2, 30, 400]) {
    const g = gradeLastPoke({ rounds: 3, lastPokeSec: now - days * 86_400, nowSec: now });
    assert.equal(g.status, "warn", `${days} days`);
  }
});

/* ---- emissions funding ------------------------------------------------- */

import { gradeEmissionsFunding, type EmitterSink } from "../src/health-grade.ts";

const SERVED = "0x0830935213349d64bebceeb781ab3c8d41bbc316";
const HEIR = "0xf3f30ce53fb962ec2bdbd021b3fb35e00bc69857";
const AMM = "0x3f8a8f7f9612ba42b64f92120f55af0fd28d0d14";
const JAR = "0xf43e9057bffd74a933e6cef36c29da3220971889";

/** The live emitter, exactly as it was read. */
const LIVE: EmitterSink[] = [
  { index: 3, to: AMM, weight: 40n, label: "AMM liquidity emissions" },
  { index: 9, to: JAR, weight: 2n, label: "keeper bounty" },
  { index: 11, to: SERVED, weight: 0n, label: "lending emissions" },
  { index: 12, to: HEIR, weight: 60n, label: "lending emissions" },
];

test("a retired sink is a failure, however healthy the pot looks", () => {
  /*
   * The case every other check passed. `redeploy:pool` step [4] moved the
   * weight to a replacement and step [6] never ran, so the app served a
   * contract the emitter had already retired: pot 214.4798 against 214.4798
   * owed, guard paused, claim panel reading "0 TSRA", replacement holding
   * 1,101,223. `backing` was ok because nothing new can accrue, and `runway`
   * said "no streams running" rather than a fault.
   */
  const g = gradeEmissionsFunding({ served: SERVED, sinks: LIVE, totalWeight: 102n });
  assert.equal(g?.status, "fail");
  assert.match(g!.detail, /weight 0/);
  // Name the successor, or the operator has nowhere to go.
  assert.match(g!.detail, /0xf3f30ce5/);
  assert.match(g!.detail, /58\.8%/);
});

test("the successor named is one carrying the same label, never the AMM's or the tip jar's", () => {
  /*
   * "Some other sink has weight" is true of both of those, and pointing an
   * operator at either would send them to break something that works.
   */
  const noHeir: EmitterSink[] = LIVE.filter((s) => s.to !== HEIR);
  const g = gradeEmissionsFunding({ served: SERVED, sinks: noHeir, totalWeight: 42n });
  assert.equal(g?.status, "fail");
  assert.doesNotMatch(g!.detail, /0x3f8a8f7f|0xf43e9057/);
  assert.match(g!.detail, /by hand/);
});

test("a funded sink passes and says its share", () => {
  const funded = LIVE.map((s) => (s.to === SERVED ? { ...s, weight: 60n } : s));
  const g = gradeEmissionsFunding({ served: SERVED, sinks: funded, totalWeight: 162n });
  assert.equal(g?.status, "ok");
  assert.match(g!.detail, /sink 11/);
});

test("a contract that is not a sink at all can never be funded", () => {
  const g = gradeEmissionsFunding({ served: "0x" + "9".repeat(40), sinks: LIVE, totalWeight: 102n });
  assert.equal(g?.status, "fail");
  assert.match(g!.detail, /not a sink on the emitter/);
});

test("no emitter or no emissions contract is not a finding", () => {
  // A deployment without one of them has nothing to be wrong about, and a
  // check that fires on absence is a check people learn to ignore.
  assert.equal(gradeEmissionsFunding({ served: null, sinks: LIVE, totalWeight: 102n }), null);
  assert.equal(gradeEmissionsFunding({ served: SERVED, sinks: [], totalWeight: 0n }), null);
});

test("the served address matches regardless of case", () => {
  const g = gradeEmissionsFunding({ served: SERVED.toUpperCase(), sinks: LIVE, totalWeight: 102n });
  assert.equal(g?.status, "fail", "a checksummed record address failed to match its own sink");
});
