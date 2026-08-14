import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SeriesStore, SERIES_LIMITS } from "../src/series.js";

/**
 * A series fires several payments at once, so most of these check that it does
 * *not* fire: no members, disabled, manual, or a schedule that has not come
 * round. A scheduler whose failure mode is spending is a much worse thing to
 * own than one whose failure mode is sitting still.
 */

const store = () => new SeriesStore(path.join(mkdtempSync(path.join(tmpdir(), "tessera-series-")), "series.json"));
const idOf = (r: unknown) => (r as { series: { id: string } }).series.id;

test("a series needs at least one task", () => {
  const s = store();
  assert.equal(s.create({ name: "empty", taskIds: [], schedule: { kind: "manual" } }).ok, false);
  assert.equal(s.create({ name: "empty", schedule: { kind: "manual" } }).ok, false);
});

test("refuses a mode it cannot run", () => {
  const s = store();
  const r = s.create({ taskIds: ["a"], mode: "whenever", schedule: { kind: "manual" } });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /unknown mode/);
});

test("keeps the order given, because that is the sequential run order", () => {
  const s = store();
  const r = s.create({ taskIds: ["c", "a", "b"], schedule: { kind: "manual" } });
  assert.deepEqual(s.get(idOf(r))!.taskIds, ["c", "a", "b"]);
});

test("the same task twice in one series is once", () => {
  // Otherwise a mis-click pays somebody twice on every run, and the list looks
  // like it did what was asked.
  const s = store();
  const r = s.create({ taskIds: ["a", "b", "a"], schedule: { kind: "manual" } });
  assert.deepEqual(s.get(idOf(r))!.taskIds, ["a", "b"]);
});

test("membership is capped", () => {
  const s = store();
  const many = Array.from({ length: SERIES_LIMITS.maxMembers + 10 }, (_, i) => `t${i}`);
  const r = s.create({ taskIds: many, schedule: { kind: "manual" } });
  assert.equal(s.get(idOf(r))!.taskIds.length, SERIES_LIMITS.maxMembers);
});

test("manual, paused and empty series are never due", () => {
  const s = store();
  const manual = s.create({ taskIds: ["a"], schedule: { kind: "manual" } });
  const paused = s.create({ taskIds: ["a"], schedule: { kind: "every", seconds: 60 }, enabled: false });
  assert.ok(manual.ok && paused.ok);
  assert.equal(s.due(Date.now() + 86_400_000).length, 0);
});

test("a scheduled series comes due, and stops the moment it is paused", () => {
  const s = store();
  const r = s.create({ taskIds: ["a"], schedule: { kind: "every", seconds: 60 } });
  const id = idOf(r);
  assert.equal(s.due(Date.now() + 120_000).length, 1);
  s.update(id, { enabled: false });
  assert.equal(s.due(Date.now() + 120_000).length, 0);
  assert.equal(s.nextRunAt(s.get(id)!), null);
});

test("deleting a task removes it from every series that named it", () => {
  /*
   * A series holds ids, so a deleted task would otherwise leave a member that
   * can never run — and a series that reports a failure every time it fires,
   * for a task nobody can find, is worse than one that is quietly shorter.
   */
  const s = store();
  const a = idOf(s.create({ taskIds: ["keep", "gone"], schedule: { kind: "manual" } }));
  const b = idOf(s.create({ taskIds: ["gone"], schedule: { kind: "manual" } }));
  s.forgetTask("gone");
  assert.deepEqual(s.get(a)!.taskIds, ["keep"]);
  assert.deepEqual(s.get(b)!.taskIds, []);
  // And an empty one is never due, so it cannot fire as a no-op forever.
  assert.equal(s.due(Date.now() + 86_400_000).length, 0);
});

test("an edit cannot re-home a series to another wallet", () => {
  const s = store();
  const alice = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
  const id = idOf(s.create({ taskIds: ["a"], owner: alice, schedule: { kind: "manual" } }));
  s.update(id, { owner: "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb", name: "renamed" } as never);
  assert.equal(s.get(id)!.owner, alice.toLowerCase());
  assert.equal(s.get(id)!.name, "renamed");
});

test("one wallet cannot act on another's series", () => {
  const s = store();
  const alice = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
  const bob = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
  const id = idOf(s.create({ taskIds: ["a"], owner: alice, schedule: { kind: "manual" } }));
  assert.equal(s.ownedBy(id, alice), true);
  assert.equal(s.ownedBy(id, bob), false);
  assert.equal(s.ownedBy(id, null), true, "the operator could not act on it");
  assert.equal(s.listFor(bob).length, 0);
});

test("a run is recorded once as first, and counted every time", () => {
  const s = store();
  const id = idOf(s.create({ taskIds: ["a"], schedule: { kind: "manual" } }));
  s.markRun(id, "ok", "2 of 2 sent");
  const first = s.get(id)!.firstRunAt;
  s.markRun(id, "failed", "1 of 2 sent");
  const after = s.get(id)!;
  assert.equal(after.firstRunAt, first, "first run moved");
  assert.equal(after.runs, 2);
  assert.equal(after.lastStatus, "failed");
});
