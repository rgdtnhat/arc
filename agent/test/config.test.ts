import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppConfigStore, DEFAULT_CONFIG, LIMITS, nextWeeklyRun } from "../src/config.ts";

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "tessera-cfg-")), "config.json");
/** A store of its own per test, so one refusal cannot leak into the next. */
const freshStore = () => new AppConfigStore(tmpFile());

test("defaults match the contract floor and the specified fee split", () => {
  const s = new AppConfigStore(tmpFile());
  const c = s.get();
  assert.equal(c.vaultReserveRatioBps, 8_000, "80% reserve is the deploy default");
  assert.equal(c.vaultPerformanceFeeBps, 1_500, "15% app / 85% user");
  assert.deepEqual(c.feeShares, {
    agentBps: 2_000, lendingBps: 2_000, vaultBps: 2_000, swapBps: 2_000, retainedBps: 2_000,
  });
  assert.equal(c.feeIntervalSeconds, 604_800, "weekly by default");
});

test("refuses a reserve ratio below the contract floor, and explains why", () => {
  const s = new AppConfigStore(tmpFile());
  const r = s.update({ vaultReserveRatioBps: 7_999 });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /80%/);
  // The stored value is untouched by a rejected update.
  assert.equal(s.get().vaultReserveRatioBps, 8_000);
});

test("accepts 80%…100% and rejects above 100%", () => {
  const s = new AppConfigStore(tmpFile());
  assert.equal(s.update({ vaultReserveRatioBps: 8_000 }).ok, true);
  assert.equal(s.update({ vaultReserveRatioBps: 10_000 }).ok, true, "100% = no-APR mode");
  assert.equal(s.update({ vaultReserveRatioBps: 10_001 }).ok, false);
});

test("caps the app's share of vault yield at 30%", () => {
  const s = new AppConfigStore(tmpFile());
  assert.equal(s.update({ vaultPerformanceFeeBps: 3_000 }).ok, true);
  assert.equal(s.update({ vaultPerformanceFeeBps: 3_001 }).ok, false);
});

test("fee allocation shares must total exactly 100%", () => {
  const s = new AppConfigStore(tmpFile());
  const bad = s.update({
    feeShares: { agentBps: 5_000, lendingBps: 2_000, vaultBps: 2_000, swapBps: 2_000, retainedBps: 2_000 },
  });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /100%/);
  const good = s.update({
    feeShares: { agentBps: 4_000, lendingBps: 3_000, vaultBps: 2_000, swapBps: 1_000, retainedBps: 0 },
  });
  assert.equal(good.ok, true);
});

test("cadence must be between one second and one year", () => {
  const s = new AppConfigStore(tmpFile());
  assert.equal(s.update({ feeIntervalSeconds: 1 }).ok, true);
  assert.equal(s.update({ feeIntervalSeconds: 31_536_000 }).ok, true);
  assert.equal(s.update({ feeIntervalSeconds: 0 }).ok, false);
  assert.equal(s.update({ feeIntervalSeconds: 31_536_001 }).ok, false);
});

test("cadence multiplier gives 'every N units' and rejects nonsense", () => {
  const s = new AppConfigStore(tmpFile());
  assert.equal(s.get().feeIntervalEvery, 1, "defaults to every single unit");
  // Every 3 days.
  const r = s.update({ feeIntervalEvery: 3, feeIntervalLabel: "day", feeIntervalSeconds: 3 * 86_400 });
  assert.equal(r.ok, true);
  assert.equal(s.get().feeIntervalEvery, 3);
  assert.equal(s.get().feeIntervalSeconds, 259_200);
  assert.equal(s.update({ feeIntervalEvery: 0 }).ok, false);
  assert.equal(s.update({ feeIntervalEvery: 1001 }).ok, false);
  assert.equal(s.update({ feeIntervalEvery: 2.5 }).ok, false);
});

test("weekly schedule validates the weekday and HH:MM time", () => {
  const s = new AppConfigStore(tmpFile());
  assert.equal(s.update({ feeScheduleMode: "weekly", feeWeekday: 6, feeTimeUtc: "23:59" }).ok, true);
  assert.equal(s.update({ feeWeekday: 7 }).ok, false);
  assert.equal(s.update({ feeTimeUtc: "24:00" }).ok, false);
  assert.equal(s.update({ feeTimeUtc: "9:00" }).ok, false, "needs zero-padded HH");
  assert.equal(s.update({ feeScheduleMode: "hourly" as never }).ok, false);
});

test("config round-trips through the file and merges over defaults", () => {
  const f = tmpFile();
  const a = new AppConfigStore(f);
  assert.equal(a.update({ vaultReserveRatioBps: 9_000, feeIntervalLabel: "day" }).ok, true);
  const b = new AppConfigStore(f); // reload from disk
  assert.equal(b.get().vaultReserveRatioBps, 9_000);
  assert.equal(b.get().feeIntervalLabel, "day");
  // Fields absent from the file still fall back to the defaults.
  assert.equal(b.get().vaultPerformanceFeeBps, DEFAULT_CONFIG.vaultPerformanceFeeBps);
  rmSync(path.dirname(f), { recursive: true, force: true });
});

test("nextWeeklyRun picks the right UTC moment, always in the future", () => {
  const from = new Date("2026-07-29T12:00:00Z"); // a Wednesday
  assert.equal(nextWeeklyRun(1, "09:00", from).toISOString(), "2026-08-03T09:00:00.000Z", "next Monday");
  assert.equal(nextWeeklyRun(3, "18:00", from).toISOString(), "2026-07-29T18:00:00.000Z", "later today");
  assert.equal(nextWeeklyRun(3, "09:00", from).toISOString(), "2026-08-05T09:00:00.000Z", "past today → +1 week");
  assert.equal(nextWeeklyRun(0, "00:00", from).toISOString(), "2026-08-02T00:00:00.000Z", "Sunday midnight");
  for (let d = 0; d < 7; d++) {
    assert.ok(nextWeeklyRun(d, "12:00", from).getTime() > from.getTime(), `weekday ${d} is in the future`);
  }
});

/* ---- the guardian cap, and its ceiling --------------------------------- */

test("the guardian cap is settable, and bounded by code rather than by the form", () => {
  /*
   * The cap is the only thing between an unattended agent and the operator's
   * balance, and a form is where a zero gets added by accident. `LIMITS` is the
   * ceiling on the ceiling: no saved config, no API call and no typo can raise
   * the per-call risk above it.
   */
  const store = freshStore();
  const ok = store.update({ guardianCapUsdc: "2.5" });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.config.guardianCapUsdc, "2.5");

  const tooBig = store.update({ guardianCapUsdc: String(LIMITS.guardianCapMaxUsdc + 1) });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.ok === false ? tooBig.error : "", /ceiling is in code/);

  // The refusal must not have moved the stored value.
  assert.equal(store.get().guardianCapUsdc, "2.5");
});

test("a cap that is not an amount is refused rather than coerced", () => {
  const store = freshStore();
  for (const bad of ["abc", "-1", "1e6", "1.2.3", "", "0.0000001"]) {
    const r = store.update({ guardianCapUsdc: bad });
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
  // Separators are fine, and are normalised away.
  const r = store.update({ guardianCapUsdc: "1,000" });
  assert.equal(r.ok, false, "1,000 is over the ceiling and must still be refused");
  const ok = store.update({ guardianCapUsdc: "1,0" });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.config.guardianCapUsdc, "10");
});

test("the config cannot switch the guardian off", () => {
  /*
   * Raising a limit and removing the limiter are different decisions.
   * `autoApprove` is a local-demo affordance and must not be reachable from a
   * deployed configuration — so it is not a field here at all, and a patch that
   * tries to set it changes nothing.
   */
  const store = freshStore();
  const before = JSON.stringify(store.get());
  store.update({ autoApprove: true, guardianCapUsdc: "1" } as never);
  const after = store.get() as Record<string, unknown>;
  assert.equal("autoApprove" in after, false, "autoApprove became a stored setting");
  assert.notEqual(before, JSON.stringify(after), "the legitimate half of the patch was dropped too");
});

test("the launchpad fee is bounded by what the contract will accept", () => {
  const store = freshStore();
  assert.equal(store.update({ launchpadFeeBps: 500 }).ok, true);
  assert.equal(store.update({ launchpadFeeBps: LIMITS.launchpadFeeMaxBps + 1 }).ok, false);
  assert.equal(store.update({ launchpadFeeBps: -1 }).ok, false);
  assert.equal(store.update({ launchpadFeeBps: 2.5 }).ok, false, "bps must be whole");
});
