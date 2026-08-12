import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, TASK_ACTIONS } from "../src/tasks.js";

/**
 * The bookkeeping behind unattended spending.
 *
 * Most of these check that a task is *not* due. A scheduler whose failure mode
 * is firing is a much worse thing to own than one whose failure mode is sitting
 * still, and every one of these actions moves money.
 */

const store = () => new TaskStore(path.join(mkdtempSync(path.join(tmpdir(), "tessera-tasks-")), "tasks.json"));

test("refuses a verb the venue cannot carry out", () => {
  const s = store();
  const r = s.create({ venue: "vault", action: "borrow", schedule: { kind: "manual" } });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /vault cannot "borrow"/);
});

test("refuses an unknown venue", () => {
  const r = store().create({ venue: "casino", action: "spin" });
  assert.equal(r.ok, false);
});

test("every listed action is accepted for its own venue", () => {
  const s = store();
  for (const [venue, actions] of Object.entries(TASK_ACTIONS)) {
    for (const action of actions) {
      assert.equal(s.create({ venue, action, schedule: { kind: "manual" } }).ok, true, `${venue}.${action}`);
    }
  }
});

test("a manual task is never due on its own", () => {
  const s = store();
  s.create({ venue: "lending", action: "supply", schedule: { kind: "manual" } });
  assert.deepEqual(s.due(Date.now() + 86_400_000), []);
});

test("a disabled task is never due, however overdue", () => {
  const s = store();
  const r = s.create({ venue: "lending", action: "supply", schedule: { kind: "every", seconds: 60 } });
  const id = (r as { task: { id: string } }).task.id;
  s.update(id, { enabled: false });
  assert.deepEqual(s.due(Date.now() + 86_400_000), []);
});

test("an interval task is due at once, then not again until it comes round", () => {
  const s = store();
  const r = s.create({ venue: "vault", action: "deposit", schedule: { kind: "every", seconds: 3600 } });
  const id = (r as { task: { id: string } }).task.id;
  assert.equal(s.due().length, 1, "a new interval task runs on the first tick");
  s.markRun(id, "ok", "deposited");
  assert.deepEqual(s.due(), [], "and not again immediately after");
  assert.equal(s.due(Date.now() + 3_600_001).length, 1, "but does when the hour is up");
});

test("a failed run still counts as a run", () => {
  // Otherwise a task that reverts every time retries in a tight loop for as
  // long as it keeps failing, which is the worst possible response to a
  // failing transaction.
  const s = store();
  const r = s.create({ venue: "lending", action: "borrow", schedule: { kind: "every", seconds: 3600 } });
  const id = (r as { task: { id: string } }).task.id;
  s.markRun(id, "failed", "reverted: unhealthy");
  assert.deepEqual(s.due(), []);
  assert.equal(s.get(id)!.runs, 1);
  assert.equal(s.get(id)!.lastStatus, "failed");
});

test("survives a restart", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "tessera-tasks-")), "tasks.json");
  const a = new TaskStore(file);
  a.create({ name: "weekly top-up", venue: "wallet", action: "send", schedule: { kind: "weekly", days: [1], hour: 9 } });
  const b = new TaskStore(file);
  assert.equal(b.list().length, 1);
  assert.equal(b.list()[0].name, "weekly top-up");
});

test("the view carries the next time and the schedule in words", () => {
  const s = store();
  s.create({ venue: "amm", action: "add", schedule: { kind: "weekly", days: [1], hour: 9, minute: 0, offsetMinutes: 420 } });
  const row = s.view()[0];
  assert.match(row.scheduleText, /Monday at 09:00 GMT\+07:00/);
  assert.ok(row.nextRunAt && row.nextRunAt > Date.now());
});
