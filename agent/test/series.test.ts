import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SeriesStore, SERIES_LIMITS } from "../src/series.js";

/**
 * A series fires several payments at once, so most of these check that it does
 * *not* fire: no steps, disabled, manual, or a schedule that has not come
 * round. A scheduler whose failure mode is spending is a much worse thing to
 * own than one whose failure mode is sitting still.
 *
 * The rest are about the steps being the series' own. They used to be ids
 * borrowed from the scheduled-task list, which meant pausing a task silently
 * shortened a series and deleting one silently emptied it.
 */

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "tessera-series-")), "series.json");
const store = () => new SeriesStore(file());
const idOf = (r: unknown) => (r as { series: { id: string } }).series.id;
const errOf = (r: unknown) => (r as { error: string }).error;

/** A valid step, so each test only has to say the part it is about. */
const step = (over: Record<string, unknown> = {}) => ({
  venue: "wallet",
  action: "send",
  params: { to: "0x" + "b".repeat(40), amount: "1000000" },
  ...over,
});

test("a series needs at least one step", () => {
  const s = store();
  assert.equal(s.create({ name: "empty", steps: [], schedule: { kind: "manual" } }).ok, false);
  assert.equal(s.create({ name: "empty", schedule: { kind: "manual" } }).ok, false);
});

test("refuses a mode it cannot run", () => {
  const s = store();
  const r = s.create({ steps: [step()], mode: "whenever", schedule: { kind: "manual" } });
  assert.equal(r.ok, false);
  assert.match(errOf(r), /unknown mode/);
});

test("refuses a step whose venue or verb does not exist, and says which step", () => {
  const s = store();
  const badVenue = s.create({ steps: [step(), step({ venue: "casino" })], schedule: { kind: "manual" } });
  assert.equal(badVenue.ok, false);
  assert.match(errOf(badVenue), /step 2: unknown venue "casino"/);

  const badVerb = s.create({ steps: [step({ action: "abscond" })], schedule: { kind: "manual" } });
  assert.equal(badVerb.ok, false);
  assert.match(errOf(badVerb), /step 1: wallet cannot "abscond"/);
});

test("keeps the order given, because that is the sequential run order", () => {
  const s = store();
  const r = s.create({
    steps: [step({ name: "c" }), step({ name: "a" }), step({ name: "b" })],
    schedule: { kind: "manual" },
  });
  assert.deepEqual(s.get(idOf(r))!.steps.map((x) => x.name), ["c", "a", "b"]);
});

test("the same payment twice in one series is two steps, because that is what was asked for", () => {
  /*
   * The opposite of the old rule, and deliberately so. When a step was a task
   * id, naming one twice was a mis-click that would pay somebody twice; now a
   * step is written out in full each time, so two identical steps are two
   * payments somebody typed on purpose — a fortnightly amount sent as two, say.
   */
  const s = store();
  const r = s.create({ steps: [step({ name: "rent" }), step({ name: "rent" })], schedule: { kind: "manual" } });
  assert.equal(s.get(idOf(r))!.steps.length, 2);
});

test("a step gets its own id, and an edit that keeps the id keeps its history", () => {
  const s = store();
  const id = idOf(s.create({ steps: [step({ name: "rent" })], schedule: { kind: "manual" } }));
  const stepId = s.get(id)!.steps[0].id;
  assert.ok(stepId, "a step was stored without an id");

  s.markStep(id, stepId, "ok", "sent 1 USDC", "0x" + "9".repeat(64));
  // The same step, renamed and with a new amount — the history should survive.
  s.update(id, { steps: [{ ...step({ name: "rent (raised)" }), id: stepId }] });
  const after = s.get(id)!.steps[0];
  assert.equal(after.id, stepId);
  assert.equal(after.name, "rent (raised)");
  assert.equal(after.lastStatus, "ok");
  assert.equal(after.lastTxHash, "0x" + "9".repeat(64));

  // A step added without an id is a new step, and starts with no history.
  s.update(id, { steps: [{ ...step({ name: "rent" }), id: stepId }, step({ name: "bills" })] });
  const fresh = s.get(id)!.steps[1];
  assert.notEqual(fresh.id, stepId);
  assert.equal(fresh.lastStatus, null);
});

test("a step with no name is named after what it does, never left blank", () => {
  // A blank line in a run receipt is the one place a reader cannot tell which
  // payment failed.
  const s = store();
  const r = s.create({ steps: [step({ name: "  " })], schedule: { kind: "manual" } });
  assert.equal(s.get(idOf(r))!.steps[0].name, "wallet send");
});

test("the number of steps is capped", () => {
  const s = store();
  const many = Array.from({ length: SERIES_LIMITS.maxMembers + 10 }, (_, i) => step({ name: `t${i}` }));
  const r = s.create({ steps: many, schedule: { kind: "manual" } });
  assert.equal(s.get(idOf(r))!.steps.length, SERIES_LIMITS.maxMembers);
});

test("manual, paused and all-off series are never due", () => {
  const s = store();
  const manual = s.create({ steps: [step()], schedule: { kind: "manual" } });
  const paused = s.create({ steps: [step()], schedule: { kind: "every", seconds: 60 }, enabled: false });
  const allOff = s.create({
    steps: [step({ enabled: false })], schedule: { kind: "every", seconds: 60 },
  });
  assert.ok(manual.ok && paused.ok && allOff.ok);
  assert.equal(s.due(Date.now() + 86_400_000).length, 0);
});

test("a scheduled series comes due, and stops the moment it is paused", () => {
  const s = store();
  const r = s.create({ steps: [step()], schedule: { kind: "every", seconds: 60 } });
  const id = idOf(r);
  assert.equal(s.due(Date.now() + 120_000).length, 1);
  s.update(id, { enabled: false });
  assert.equal(s.due(Date.now() + 120_000).length, 0);
  assert.equal(s.nextRunAt(s.get(id)!), null);
});

test("deleting a task cannot touch a series any more", () => {
  /*
   * The point of the whole change. A series carries what it does, so nothing
   * in the scheduled-task list can shorten one, empty one, or leave it naming
   * something that no longer exists.
   */
  const s = store();
  const id = idOf(s.create({ steps: [step({ name: "rent" })], schedule: { kind: "every", seconds: 60 } }));
  assert.equal("forgetTask" in s, false, "a series still reaches into the task store");
  assert.equal(s.get(id)!.steps.length, 1);
  assert.equal(s.due(Date.now() + 120_000).length, 1);
});

test("a reader cannot edit the store by editing what it was handed", () => {
  // A spread alone shares the steps array, so a caller that reordered what it
  // got back would be changing the record without it ever being persisted.
  const s = store();
  const id = idOf(s.create({ steps: [step({ name: "one" }), step({ name: "two" })], schedule: { kind: "manual" } }));
  const copy = s.get(id)!;
  copy.steps.reverse();
  copy.steps[0].name = "tampered";
  copy.steps[0].params.amount = "999999999";
  const actual = s.get(id)!;
  assert.deepEqual(actual.steps.map((x) => x.name), ["one", "two"]);
  assert.equal(actual.steps[0].params.amount, "1000000");
});

test("an edit cannot re-home a series to another wallet", () => {
  const s = store();
  const alice = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
  const id = idOf(s.create({ steps: [step()], owner: alice, schedule: { kind: "manual" } }));
  s.update(id, { owner: "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb", name: "renamed" } as never);
  assert.equal(s.get(id)!.owner, alice.toLowerCase());
  assert.equal(s.get(id)!.name, "renamed");
});

test("one wallet cannot act on another's series", () => {
  const s = store();
  const alice = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
  const bob = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
  const id = idOf(s.create({ steps: [step()], owner: alice, schedule: { kind: "manual" } }));
  assert.equal(s.ownedBy(id, alice), true);
  assert.equal(s.ownedBy(id, bob), false);
  assert.equal(s.ownedBy(id, null), true, "the operator could not act on it");
  assert.equal(s.listFor(bob).length, 0);
});

test("a run is recorded once as first, and counted every time", () => {
  const s = store();
  const id = idOf(s.create({ steps: [step()], schedule: { kind: "manual" } }));
  s.markRun(id, "ok", "2 of 2 sent");
  const first = s.get(id)!.firstRunAt;
  s.markRun(id, "failed", "1 of 2 sent");
  const after = s.get(id)!;
  assert.equal(after.firstRunAt, first, "first run moved");
  assert.equal(after.runs, 2);
  assert.equal(after.lastStatus, "failed");
});

/*
 * Series written before they owned their steps are still on disk.
 *
 * Dropping them would delete somebody's standing orders without saying so, and
 * leaving them would leave a series that names tasks nothing reads any more —
 * so the members are copied in as steps, once.
 */
test("a series written against task ids is carried onto its own steps", () => {
  const f = file();
  writeFileSync(f, JSON.stringify([{
    id: "old-series",
    name: "payroll",
    taskIds: ["t1", "t2", "missing"],
    mode: "sequential",
    schedule: { kind: "every", seconds: 3600 },
    enabled: true,
    owner: null,
    createdAt: 1,
    firstRunAt: null, lastRunAt: null, lastStatus: null, lastDetail: "", runs: 0,
  }]));
  const s = new SeriesStore(f);

  // Before the migration it has no steps at all, and so is not due — which is
  // the safe direction for a scheduler to be wrong in.
  assert.deepEqual(s.get("old-series")!.steps, []);
  assert.equal(s.due(Date.now() + 7_200_000).length, 0);

  const tasks: Record<string, { name: string; venue: string; action: string; params: Record<string, unknown> }> = {
    t1: { name: "alice", venue: "wallet", action: "send", params: { to: "0x" + "a".repeat(40), amount: "1" } },
    t2: { name: "bob", venue: "wallet", action: "send", params: { to: "0x" + "b".repeat(40), amount: "2" } },
  };
  const { carried, lost } = s.adoptTaskMembers((id) => tasks[id] ?? null);
  assert.equal(carried.length, 2);
  assert.deepEqual(lost, ["missing"]);

  const after = s.get("old-series")!;
  assert.deepEqual(after.steps.map((x) => x.name), ["alice", "bob"]);
  assert.deepEqual(after.steps[0].params, { to: "0x" + "a".repeat(40), amount: "1" });
  assert.equal((after as unknown as { taskIds?: unknown }).taskIds, undefined);
  assert.equal(s.due(Date.now() + 7_200_000).length, 1, "the carried series never came due");

  // And it is a one-off: a second boot must not double every step.
  const again = new SeriesStore(f);
  assert.equal(again.adoptTaskMembers((id) => tasks[id] ?? null).carried.length, 0);
  assert.equal(again.get("old-series")!.steps.length, 2);
});
