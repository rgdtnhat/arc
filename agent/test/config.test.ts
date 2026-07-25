import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppConfigStore, DEFAULT_CONFIG, nextWeeklyRun } from "../src/config.ts";

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "tessera-cfg-")), "config.json");

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
