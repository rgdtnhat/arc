import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A task runs once at a time, or it spends twice.
 *
 * `runningTasks` and `seriesRunning` existed, and were read only to put
 * "running now" on a row. Nothing consulted them before starting. The scheduler
 * guards itself with `tasksBusy` so the sweep cannot overlap the sweep — but
 * `POST /api/tasks/:id/run` went straight to `executeTask` with no guard at
 * all. Two taps on a slow response, or one tap while the sweep is part way
 * through the same task, sent the payment twice.
 *
 * The lock is the set that was already there. What follows models it exactly:
 * the check and the add have no `await` between them, so on one thread it is a
 * mutex, and the refusal path must not touch the run record that the run in
 * flight owns.
 */

const server = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");

/** `executeTask`'s guard, as the source now writes it. */
function makeRunner() {
  const running = new Set<string>();
  const marked: string[] = [];
  let spends = 0;
  const executeTask = async (id: string) => {
    if (running.has(id)) return { ok: false, detail: "that task is already running — this run was not started" };
    running.add(id);
    try {
      spends += 1;                                   // the transfer
      await new Promise((r) => setTimeout(r, 20));   // a slow chain
      marked.push(id);                               // markRun
      return { ok: true, detail: "sent" };
    } finally {
      running.delete(id);
    }
  };
  return { executeTask, marked, running, spends: () => spends };
}

test("a second run while the first is in flight is refused, not queued", async () => {
  const r = makeRunner();
  const [a, b] = await Promise.all([r.executeTask("t1"), r.executeTask("t1")]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.match(b.detail, /already running/);
  assert.equal(r.spends(), 1, "the payment was sent twice");
});

test("the refusal does not overwrite the run record the live run owns", async () => {
  const r = makeRunner();
  await Promise.all([r.executeTask("t1"), r.executeTask("t1")]);
  assert.deepEqual(r.marked, ["t1"], "a refused run wrote a result of its own");
});

test("the lock is released, so the next run is allowed", async () => {
  const r = makeRunner();
  await r.executeTask("t1");
  assert.equal(r.running.has("t1"), false, "the lock outlived the run");
  const again = await r.executeTask("t1");
  assert.equal(again.ok, true);
  assert.equal(r.spends(), 2);
});

test("different tasks do not block each other", async () => {
  const r = makeRunner();
  const [a, b] = await Promise.all([r.executeTask("t1"), r.executeTask("t2")]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(r.spends(), 2);
});

test("both spend paths consult their lock before starting", () => {
  for (const [fn, set] of [["executeTask", "runningTasks"], ["executeSeries", "seriesRunning"]] as const) {
    const at = server.indexOf(`async function ${fn}(`);
    assert.notEqual(at, -1, `${fn} is gone`);
    const head = server.slice(at, at + 1600);
    const guard = head.indexOf(`${set}.has(`);
    const add = head.indexOf(`${set}.add(`);
    assert.notEqual(guard, -1, `${fn} starts without checking ${set}`);
    assert.equal(guard < add, true, `${fn} checks ${set} only after claiming it`);
  }
});

test("nothing awaits between the check and the claim", () => {
  // An await there would reopen the window the lock exists to close.
  for (const [fn, set] of [["executeTask", "runningTasks"], ["executeSeries", "seriesRunning"]] as const) {
    const at = server.indexOf(`async function ${fn}(`);
    const head = server.slice(at, at + 1600);
    const between = head.slice(head.indexOf(`${set}.has(`), head.indexOf(`${set}.add(`));
    assert.equal(/\bawait\b/.test(between), false, `${fn} awaits between checking and claiming ${set}`);
  }
});
