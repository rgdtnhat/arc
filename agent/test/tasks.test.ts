import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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

/*
 * Repointing a schedule at a replacement session.
 *
 * A session's cap and expiry are fixed at the moment it is opened, so raising
 * either one means a new session with a new id — and every task still names the
 * old one. The route that moves them is a loop of `update({ params })`, so what
 * matters here is that such an update carries the rest of the task across:
 * losing an owner would re-home somebody's delegation, and losing a schedule
 * would silently change when unattended money moves.
 */
test("changing only the params leaves owner, schedule and history alone", () => {
  const s = store();
  const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const r = s.create({
    name: "rent",
    venue: "wallet",
    action: "sessionSend",
    owner,
    params: { sessionId: "0x" + "1".repeat(64), to: "0x" + "b".repeat(40), amount: "1" },
    schedule: { kind: "every", seconds: 3600 },
  });
  assert.equal(r.ok, true);
  const id = (r as { task: { id: string } }).task.id;

  const moved = s.update(id, {
    params: { sessionId: "0x" + "2".repeat(64), to: "0x" + "b".repeat(40), amount: "1" },
  });
  assert.equal(moved.ok, true);
  const t = (moved as { task: Record<string, unknown> }).task;
  assert.equal((t.params as Record<string, string>).sessionId, "0x" + "2".repeat(64));
  assert.equal((t.params as Record<string, string>).amount, "1");
  assert.equal(t.owner, owner);
  assert.deepEqual(t.schedule, { kind: "every", seconds: 3600 });
  assert.equal(t.name, "rent");
  assert.equal(t.venue, "wallet");
  assert.equal(t.action, "sessionSend");
});

test("a repoint reaches only the tasks of the wallet asking for it", () => {
  const s = store();
  const mine = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const theirs = "0xcccccccccccccccccccccccccccccccccccccccc";
  const old = "0x" + "1".repeat(64);
  for (const owner of [mine, theirs]) {
    s.create({
      venue: "wallet", action: "sessionSend", owner,
      params: { sessionId: old, to: "0x" + "b".repeat(40), amount: "1" },
      schedule: { kind: "manual" },
    });
  }
  // What the route does: list this owner's tasks, then move the matching ones.
  const hit = s.listFor(mine).filter((t) => (t.params as { sessionId?: string }).sessionId === old);
  assert.equal(hit.length, 1);
  assert.equal(s.listFor(null).filter((t) => (t.params as { sessionId?: string }).sessionId === old).length, 2);
  assert.equal(s.ownedBy(hit[0].id, mine), true);
  assert.equal(s.ownedBy(hit[0].id, theirs), false);
});

/*
 * Narrowing the *view* must not narrow the *authority*.
 *
 * The operator can filter the list down to their own schedules, because
 * everybody's in one table is unreadable for the person who has to act on it.
 * That filter is a display rule and nothing more: `owner === null` selects the
 * operator's own rows, while `ownedBy(id, null)` — the question every route
 * asks before it does anything — must keep answering "yes" for every task,
 * whoever wrote it. If those two ever became the same value, an operator who
 * ticked a box would quietly lose the ability to stop a visitor's task, which
 * is the one thing that ability exists for.
 */
test("filtering the list to the operator's own does not change what they may act on", () => {
  const s = store();
  const visitor = "0xdddddddddddddddddddddddddddddddddddddddd";
  s.create({ name: "operator's", venue: "wallet", action: "send", owner: null, schedule: { kind: "manual" } });
  s.create({ name: "a visitor's", venue: "wallet", action: "sessionSend", owner: visitor, schedule: { kind: "manual" } });

  const all = s.listFor(null);
  assert.equal(all.length, 2, "the operator does not see every task");

  // What the filter does, and all it does.
  const ownOnly = all.filter((t) => t.owner === null);
  assert.deepEqual(ownOnly.map((t) => t.name), ["operator's"]);

  // What it must not do.
  const theirs = all.find((t) => t.owner === visitor)!;
  assert.equal(s.ownedBy(theirs.id, null), true, "the operator lost the right to act on a visitor's task");
  assert.equal(s.ownedBy(theirs.id, visitor), true);
  assert.equal(s.ownedBy(theirs.id, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"), false);

  // And a visitor never sees anybody else's, filter or no filter.
  assert.deepEqual(s.listFor(visitor).map((t) => t.name), ["a visitor's"]);
});

/*
 * The app wallet's oldest tasks have no `owner` field at all.
 *
 * Tasks predate the field and `JSON.stringify` omits an undefined one, so those
 * records are on disk with the key simply missing. Every reader then has to
 * decide what that means, and the operator's "only mine" filter got it wrong:
 * it tested `owner === null`, which is false for a missing field, so a task the
 * app wallet had been running for months was reported as belonging to somebody
 * else and hidden from the one person who could stop it. Found on the live
 * deployment — a `wallet send` task with no owner key, counted as nobody's.
 */
test("a task stored before owners existed belongs to the operator, not to nobody", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "tessera-tasks-")), "tasks.json");
  writeFileSync(f, JSON.stringify([
    // Exactly the shape found live: no `owner` key.
    {
      id: "legacy", name: "Ally", venue: "wallet", action: "send",
      params: { to: "0x" + "a".repeat(40), amount: "1" },
      schedule: { kind: "every", seconds: 3600 }, enabled: true,
      createdAt: 1, firstRunAt: null, lastRunAt: null,
      lastStatus: null, lastDetail: "", lastTxHash: null, lastFeeWei: null, runs: 0,
    },
    {
      id: "theirs", name: "a visitor's", venue: "wallet", action: "sessionSend",
      params: {}, schedule: { kind: "manual" }, enabled: true,
      owner: "0xdddddddddddddddddddddddddddddddddddddddd",
      createdAt: 1, firstRunAt: null, lastRunAt: null,
      lastStatus: null, lastDetail: "", lastTxHash: null, lastFeeWei: null, runs: 0,
    },
  ]));
  const s = new TaskStore(f);

  // Read back as null, not undefined — one value for "no wallet behind it".
  const legacy = s.get("legacy")!;
  assert.equal(legacy.owner, null);
  assert.equal("owner" in legacy, true, "the field is still missing after loading");

  // Which is what the operator's filter selects on.
  const own = s.listFor(null).filter((t) => t.owner == null);
  assert.deepEqual(own.map((t) => t.name), ["Ally"]);

  // And a visitor still cannot see or act on it.
  const visitor = "0xdddddddddddddddddddddddddddddddddddddddd";
  assert.deepEqual(s.listFor(visitor).map((t) => t.name), ["a visitor's"]);
  assert.equal(s.ownedBy("legacy", visitor), false);
  assert.equal(s.ownedBy("legacy", null), true);
});

/*
 * Which verbs a visitor's own wallet may be scheduled for.
 *
 * A session key can do one thing — `transferFrom(owner, to, amount)` under a
 * cap the owner set. So a visitor's scheduled DeFi action only exists where the
 * venue has a `…For` entry point that credits a third party: the app wallet
 * pays in, and the position is minted to the visitor. Where there is no such
 * entry point, there is no safe way for this server to act for them, and the
 * verb must not be offered at any price — an operator-only verb reachable by a
 * visitor spends the app's wallet, which is the failure this whole split
 * exists to prevent.
 */
test("every verb a visitor may schedule pays in; none of them pays out", () => {
  // The server's own list, mirrored here so a verb added to one without
  // thinking about the other fails a test rather than shipping.
  const visitorMay: Record<string, string[]> = {
    wallet: ["sessionSend", "sessionBulk"],
    lending: ["sessionSupply", "sessionRepay"],
    vault: ["sessionDeposit"],
  };
  for (const [venue, verbs] of Object.entries(visitorMay)) {
    for (const verb of verbs) {
      assert.ok(
        TASK_ACTIONS[venue as keyof typeof TASK_ACTIONS].includes(verb),
        `${venue}:${verb} is offered to visitors but the executor has no such verb`,
      );
      assert.ok(verb.startsWith("session"), `${venue}:${verb} does not name itself as session-funded`);
    }
  }
  // The ones that pay out. None may ever appear above.
  const paysOut = ["withdraw", "borrow", "swap", "remove", "sessionWithdraw", "sessionBorrow", "sessionSwap"];
  const offered = Object.values(visitorMay).flat();
  for (const verb of paysOut) {
    assert.equal(offered.includes(verb), false, `a visitor was offered "${verb}", which pays out to whoever signs it`);
  }
});

test("a verb that spends the app wallet is never one of the visitor's", () => {
  const visitorVerbs = new Set(["sessionSend", "sessionBulk", "sessionSupply", "sessionRepay", "sessionDeposit"]);
  // Everything the executor knows how to do, minus the visitor's list, spends
  // the app's own wallet — so none of those may be named `session…` either, or
  // the gate's prefix check would let one through.
  for (const [venue, verbs] of Object.entries(TASK_ACTIONS)) {
    for (const verb of verbs) {
      if (visitorVerbs.has(verb)) continue;
      assert.equal(
        verb.startsWith("session"), false,
        `${venue}:${verb} is named like a session verb but is not one a visitor may schedule`,
      );
    }
  }
});
