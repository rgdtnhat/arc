import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  newAlerts,
  retain,
  HF_CRITICAL,
  HF_WARN,
  type Alert,
  type Severity,
  type Observation,
} from "../src/watchtower.ts";

const NOW = 1_700_000_000;
const obs = (o: Partial<Observation> = {}): Observation => ({ now: NOW, ...o });
const keys = (a: Alert[]) => a.map((x) => x.key);

test("says nothing about a healthy system", () => {
  // An alerter that fires on nothing trains its reader to ignore it, which is
  // strictly worse than no alerter.
  const a = evaluate(
    obs({
      reserves: [{ symbol: "USDC", utilisationPct: 40, oracle: { ok: true, spreadBps: 10, sources: 2, updatedAt: NOW } }],
      positions: [{ label: "agent", healthWad: 2_000_000_000_000_000_000n }],
      paused: [{ name: "escrow", paused: false }],
    }),
  );
  assert.deepEqual(a, []);
});

test("flags a position near liquidation as critical", () => {
  const a = evaluate(obs({ positions: [{ label: "agent", healthWad: HF_CRITICAL - 1n }] }));
  assert.equal(a[0]!.severity, "critical");
  assert.match(a[0]!.title, /close to liquidation/);
});

test("flags a drifting position as a warning, not a crisis", () => {
  const a = evaluate(obs({ positions: [{ label: "agent", healthWad: HF_WARN - 1n }] }));
  assert.equal(a[0]!.severity, "warn");
});

test("ignores an account with no debt", () => {
  // A health factor of zero means no borrowing, not imminent liquidation.
  assert.deepEqual(evaluate(obs({ positions: [{ label: "idle", healthWad: 0n }] })), []);
});

test("escalates oracle divergence with the spread", () => {
  const at = (spreadBps: number) =>
    evaluate(obs({ reserves: [{ symbol: "cirBTC", utilisationPct: 10, oracle: { ok: true, spreadBps, sources: 2, updatedAt: NOW } }] }));
  assert.deepEqual(at(50), []);
  assert.equal(at(250)[0]!.severity, "warn");
  assert.equal(at(600)[0]!.severity, "critical");
});

test("says nothing about divergence when there is only one source to diverge from", () => {
  const a = evaluate(
    obs({ reserves: [{ symbol: "EURC", utilisationPct: 5, oracle: { ok: true, spreadBps: 9_000, sources: 1, updatedAt: NOW } }] }),
  );
  assert.deepEqual(a, []);
});

test("notices a feed that has stopped moving", () => {
  const a = evaluate(
    obs({
      reserves: [
        { symbol: "cirBTC", utilisationPct: 5, oracle: { ok: true, spreadBps: 0, sources: 1, updatedAt: NOW - 8 * 3600 } },
      ],
    }),
  );
  assert.ok(keys(a).includes("oracle-stale:cirBTC"));
});

test("treats a drained reserve as critical, and says whose fault it is not", () => {
  const a = evaluate(obs({ reserves: [{ symbol: "USDC", utilisationPct: 99.2 }] }));
  assert.equal(a[0]!.severity, "critical");
  assert.match(a[0]!.action ?? "", /Nothing a depositor did/);
});

test("warns before a supply cap starts reverting deposits", () => {
  const a = evaluate(
    obs({ reserves: [{ symbol: "USDC", utilisationPct: 10, supplyRoom: 10n, supplyCap: 1_000n }] }),
  );
  assert.ok(keys(a).includes("supplycap:USDC"));
});

test("ignores an uncapped reserve rather than dividing by zero", () => {
  const a = evaluate(
    obs({ reserves: [{ symbol: "USDC", utilisationPct: 10, supplyRoom: null, supplyCap: null }] }),
  );
  assert.deepEqual(a, []);
});

test("warns when the outflow bucket is nearly spent", () => {
  const a = evaluate(obs({ outflow: [{ symbol: "USDC", availableFraction: 0.1 }] }));
  assert.equal(a[0]!.key, "outflow:USDC");
  assert.match(a[0]!.action ?? "", /Sustained/);
});

test("a fresh pause is information; a forgotten one is a warning", () => {
  const fresh = evaluate(obs({ paused: [{ name: "escrow", paused: true, since: NOW - 60 }] }));
  assert.equal(fresh[0]!.severity, "info");
  const stale = evaluate(obs({ paused: [{ name: "escrow", paused: true, since: NOW - 7200 }] }));
  assert.equal(stale[0]!.severity, "warn");
  assert.match(stale[0]!.action ?? "", /Unpause/);
});

test("flags a delivery we took and never paid for", () => {
  const a = evaluate(
    obs({ pendingSettlements: [{ paymentId: "7", fulfilledAt: NOW - 7200, disputeWindowSeconds: 3600 }] }),
  );
  assert.equal(a[0]!.key, "settle:7");
});

test("stays quiet while the dispute window is still open", () => {
  const a = evaluate(
    obs({ pendingSettlements: [{ paymentId: "7", fulfilledAt: NOW - 60, disputeWindowSeconds: 3600 }] }),
  );
  assert.deepEqual(a, []);
});

test("puts the most severe first, because the first line is the one that gets read", () => {
  const a = evaluate(
    obs({
      paused: [{ name: "stream", paused: true, since: NOW - 10 }],
      reserves: [{ symbol: "USDC", utilisationPct: 99 }],
      positions: [{ label: "agent", healthWad: HF_WARN - 1n }],
    }),
  );
  assert.equal(a[0]!.severity, "critical");
  assert.equal(a[a.length - 1]!.severity, "info");
});

// --- de-duplication ---------------------------------------------------------

test("does not repeat an alert already delivered", () => {
  const current = evaluate(obs({ positions: [{ label: "agent", healthWad: HF_WARN - 1n }] }));
  const seen = new Map<string, Severity>();
  assert.equal(newAlerts(current, seen).length, 1);
  const next = retain(current, seen);
  assert.equal(newAlerts(current, next).length, 0);
});

test("re-fires when a condition escalates — that is new information", () => {
  const warn = evaluate(obs({ positions: [{ label: "agent", healthWad: HF_WARN - 1n }] }));
  const seen = retain(warn, new Map());
  const critical = evaluate(obs({ positions: [{ label: "agent", healthWad: HF_CRITICAL - 1n }] }));
  const fired = newAlerts(critical, seen);
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.severity, "critical");
});

test("does not re-fire when a condition de-escalates", () => {
  const critical = evaluate(obs({ positions: [{ label: "agent", healthWad: HF_CRITICAL - 1n }] }));
  const seen = retain(critical, new Map());
  const warn = evaluate(obs({ positions: [{ label: "agent", healthWad: HF_WARN - 1n }] }));
  assert.equal(newAlerts(warn, seen).length, 0);
});

test("forgets a condition that cleared, so it fires again if it returns", () => {
  const bad = evaluate(obs({ positions: [{ label: "agent", healthWad: HF_WARN - 1n }] }));
  let seen = retain(bad, new Map());
  seen = retain(evaluate(obs({ positions: [{ label: "agent", healthWad: 3_000_000_000_000_000_000n }] })), seen);
  assert.equal(newAlerts(bad, seen).length, 1);
});
