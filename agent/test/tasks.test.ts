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

test("an edit keeps the task's id and its history", () => {
  /*
   * Editing used to mean delete-and-recreate for the venue and the verb — the
   * two fields most likely to be the thing somebody got wrong — which threw
   * away the run history that says whether the task has ever worked.
   */
  const s = store();
  const made = s.create({
    venue: "wallet", action: "send", name: "rent",
    params: { to: "0x1111111111111111111111111111111111111111", amount: "1000" },
    schedule: { kind: "every", seconds: 60 },
  });
  assert.ok(made.ok);
  const id = (made as { task: { id: string } }).task.id;
  s.markRun(id, "ok", "1 sent");

  const edited = s.update(id, { venue: "lending", action: "supply", params: { amount: "5" } });
  assert.ok(edited.ok);
  const after = s.get(id)!;
  assert.equal(after.id, id);
  assert.equal(after.venue, "lending");
  assert.equal(after.action, "supply");
  assert.equal(after.runs, 1, "the history went with the edit");
});

test("an edit cannot put a verb into a task that creating one refuses", () => {
  const s = store();
  const made = s.create({ venue: "vault", action: "deposit", schedule: { kind: "manual" } });
  assert.ok(made.ok);
  const id = (made as { task: { id: string } }).task.id;
  // A vault has no "borrow", and neither does an edit.
  const bad = s.update(id, { action: "borrow" });
  assert.equal(bad.ok, false);
  assert.equal(s.get(id)!.action, "deposit");
  // Nor an invented venue.
  assert.equal(s.update(id, { venue: "casino" }).ok, false);
});

test("a stopped task is never due, whatever its schedule says", () => {
  // The Stop button's whole contract. A task that keeps coming back due after
  // being stopped is one that keeps spending after being told not to.
  const s = store();
  const made = s.create({ venue: "wallet", action: "send", schedule: { kind: "every", seconds: 5 } });
  const id = (made as { task: { id: string } }).task.id;
  assert.equal(s.due(Date.now() + 60_000).length, 1);
  s.update(id, { enabled: false });
  assert.equal(s.due(Date.now() + 60_000).length, 0);
  assert.equal(s.nextRunAt(s.get(id)!), null);
});

test("a task belongs to the wallet that made it, and only to it", () => {
  /*
   * A visitor who has delegated a session key can schedule payments out of
   * their own wallet, so the task list stopped being one operator's. This is
   * the separation: two wallets, two lists, and neither can act on the other's.
   */
  const s = store();
  const alice = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
  const bob = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
  const mine = s.create({ venue: "wallet", action: "sessionSend", owner: alice, schedule: { kind: "manual" } });
  const theirs = s.create({ venue: "wallet", action: "sessionSend", owner: bob, schedule: { kind: "manual" } });
  assert.ok(mine.ok && theirs.ok);
  const mineId = (mine as { task: { id: string } }).task.id;

  assert.equal(s.listFor(alice).length, 1);
  assert.equal(s.listFor(bob).length, 1);
  // Case must not decide ownership: a wallet address is the same address
  // whichever way it is capitalised.
  assert.equal(s.listFor(alice.toLowerCase()).length, 1);
  // The operator sees both.
  assert.equal(s.listFor(null).length, 2);

  assert.equal(s.ownedBy(mineId, alice), true);
  assert.equal(s.ownedBy(mineId, bob), false, "one wallet could act on another's task");
  assert.equal(s.ownedBy(mineId, null), true, "the operator could not act on a visitor's task");
});

test("an edit cannot re-home a task to another wallet", () => {
  // The one edit that would let somebody point another wallet's delegation at
  // themselves, so `owner` is not editable at all.
  const s = store();
  const alice = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
  const made = s.create({ venue: "wallet", action: "sessionSend", owner: alice, schedule: { kind: "manual" } });
  const id = (made as { task: { id: string } }).task.id;
  s.update(id, { owner: "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb", name: "renamed" } as never);
  assert.equal(s.get(id)!.owner, alice.toLowerCase());
  assert.equal(s.get(id)!.name, "renamed", "the rest of the edit should still apply");
});
