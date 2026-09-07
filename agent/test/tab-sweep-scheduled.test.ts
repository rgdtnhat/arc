import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A sweep nothing calls is a sweep that does not happen.
 *
 * `sweepExpiredTabs` shipped wired into `runScenario`, and the commit that
 * added it said "the whole point is that this keeps working unattended". On
 * this build that was not true. `live` is hardcoded true, which skips the
 * startup run, so `runScenario` is reached only by `POST /api/run` (operator)
 * and `TESSERA_ONCE=1` (CI). Recovery still needed a person — just one pressing
 * a button rather than one remembering a tab id. Tabs expire in an hour, so
 * even a second run inside the hour reclaims nothing.
 *
 * That is the same failure the tab rail was fixed for, one level up: a
 * mechanism that exists, a sentence that says it runs, and nothing turning the
 * handle. These are structural assertions against the source for the same
 * reason `kit-cap.test.ts` is — the interval lives inside `startDashboard`,
 * which binds a server and a chain client, so the thing worth pinning is that
 * the wiring exists at all and cannot quietly be removed.
 */

const dashboard = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
const agentSrc = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");

test("the sweep is on a clock, not only on a button", () => {
  const calls = [...dashboard.matchAll(/agent\.sweepExpiredTabs\(/g)];
  assert.ok(calls.length >= 2, `expected a scheduled call as well as the one in runScenario, found ${calls.length}`);

  // The scheduled one has to be inside a setInterval, not merely a second
  // call from another request handler.
  const interval = dashboard.slice(dashboard.indexOf("const TAB_SWEEP_MS"));
  const body = interval.slice(0, interval.indexOf("}, TAB_SWEEP_MS)"));
  assert.match(body, /setInterval\(/, "the sweep is scheduled with setInterval");
  assert.match(body, /agent\.sweepExpiredTabs\(/, "the interval actually calls the sweep");
});

test("the scheduled sweep obeys the same rules as the other keepers", () => {
  const interval = dashboard.slice(dashboard.indexOf("const TAB_SWEEP_MS"));
  const body = interval.slice(0, interval.indexOf("}, TAB_SWEEP_MS)"));

  assert.match(body, /process\.env\.TESSERA_TAB_SWEEP === "off"/, "an operator can turn it off");
  assert.match(body, /tabSweepBusy/, "a slow pass does not overlap the next one");
  assert.match(body, /catch \(e\)/, "a failed pass is logged and retried, not thrown into the loop");
  assert.match(body, /finally/, "the busy flag is released even when the pass throws");
});

test("the interval cannot be set faster than the floor the other keepers use", () => {
  // 60_000 is the floor every other keeper in this file takes. A tab sweep
  // spends gas, so a typo in the env var must not turn it into a spin loop.
  assert.match(
    dashboard,
    /const TAB_SWEEP_MS = Math\.max\(60_000, Number\(process\.env\.TESSERA_TAB_SWEEP_MS \?\? [^)]*\)\)/,
    "TAB_SWEEP_MS is clamped to at least 60s",
  );
});

test("no message promises a sweep unless something schedules one", () => {
  // The wording is the load-bearing part. Both of these lines tell an operator
  // their money is coming back; each is only honest while a scheduler exists.
  const promises = [
    ...[...agentSrc.matchAll(/next sweep reclaims/g)],
    ...[...dashboard.matchAll(/tab sweep reclaims it/g)],
  ];
  assert.ok(promises.length >= 2, "both the agent log line and the try-route error name the sweep");

  assert.ok(
    dashboard.includes("setInterval") && dashboard.includes("TAB_SWEEP_MS"),
    "a message that names the sweep requires the sweep to be scheduled",
  );
});

test("the try route no longer leaves the operator with no path to the money", () => {
  // It used to end at "it is reclaimable after the tab expires" — true, and
  // offering nothing that would do the reclaiming.
  assert.doesNotMatch(
    dashboard,
    /it is reclaimable after the tab expires/,
    "the dead-end wording is gone",
  );
});
