import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Stop, then Resume, and it runs again.
 *
 * Stop did two things: set an in-memory flag that interrupts the run in flight,
 * and disable the task. The flag is cleared in `executeTask`'s `finally` —
 * which cannot happen while the task is disabled. So a task stopped while idle
 * kept the flag for ever, and the first run after Resume walked into it: the
 * venue handlers ask `stopped(t.id)` before each transfer, refused every one,
 * reported "stopped by the operator", and only then cleared it. A daily
 * schedule lost a day to a stop nobody was still asking for.
 *
 * Reproduced against the running server before the fix — `stopping: true`
 * survived Resume on both a task and a series — and re-run after it:
 *
 *   STOPPED    runs=2 enabled=false stopping=false
 *   +70s       runs=2                            (stop really stops)
 *   RESUMED    runs=2 enabled=true  stopping=false
 *   +75s       runs=4                            (and it runs again)
 *
 * A series was worse: it flags every step, and each step's flag is only cleared
 * by that step running, so one stop mid-list poisoned the whole next pass.
 */

const server = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");

/** Stop / resume / run, as the routes now sequence them. */
function makeLifecycle() {
  const stopRequested = new Set<string>();
  const running = new Set<string>();
  const enabled = new Map<string, boolean>();
  const ran: string[] = [];

  return {
    stopRequested,
    create: (id: string) => enabled.set(id, true),
    stop(id: string) {
      const wasRunning = running.has(id);
      if (wasRunning) stopRequested.add(id);
      enabled.set(id, false);
      return wasRunning;
    },
    setEnabled(id: string, on: boolean) {
      enabled.set(id, on);
      if (on) stopRequested.delete(id);
    },
    /** One scheduler pass. A flagged task reports the refusal instead of acting. */
    tick(id: string) {
      if (!enabled.get(id)) return "not due";
      running.add(id);
      try {
        if (stopRequested.has(id)) return "stopped by the operator";
        ran.push(id);
        return "ran";
      } finally {
        running.delete(id);
        stopRequested.delete(id);
      }
    },
    get ran() { return [...ran]; },
  };
}

test("a task stopped while idle carries no stop into its next run", () => {
  const l = makeLifecycle();
  l.create("t1");
  l.stop("t1");
  assert.equal(l.stopRequested.has("t1"), false, "a stop was recorded with no run to interrupt");
  l.setEnabled("t1", true);
  assert.equal(l.tick("t1"), "ran", "the first run after Resume was eaten");
});

test("a stop while running still interrupts that run", async () => {
  /*
   * The flag has to keep working for the thing it exists for. A bulk transfer
   * asks `stopped(id)` before each recipient, so a stop pressed part way
   * through means the rest are not sent.
   */
  const stopRequested = new Set<string>();
  const running = new Set<string>();
  const sent: number[] = [];

  const run = async (id: string, recipients: number[]) => {
    running.add(id);
    try {
      for (const r of recipients) {
        if (stopRequested.has(id)) return "stopped by the operator — the rest were not sent";
        sent.push(r);
        await new Promise((res) => setTimeout(res, 5));
      }
      return "all sent";
    } finally {
      running.delete(id);
      stopRequested.delete(id);
    }
  };
  /** `/stop`, as the route now writes it. */
  const stop = (id: string) => { if (running.has(id)) stopRequested.add(id); };

  const inFlight = run("t1", [1, 2, 3, 4, 5]);
  await new Promise((res) => setTimeout(res, 12));
  stop("t1");
  assert.equal(await inFlight, "stopped by the operator — the rest were not sent");
  assert.ok(sent.length < 5, "the stop did not stop anything");
  // And it did not outlive the run it interrupted.
  assert.equal(stopRequested.has("t1"), false);
});

test("resume clears a flag set while a run was in flight", () => {
  /*
   * The other half. A stop that lands mid-run is legitimately set; if the
   * operator resumes before that run's `finally` fires, the flag would sit
   * waiting for the next one.
   */
  const l = makeLifecycle();
  l.create("t1");
  l.stopRequested.add("t1");     // as /stop would, with a run in flight
  l.setEnabled("t1", false);
  l.setEnabled("t1", true);      // Resume
  assert.equal(l.stopRequested.has("t1"), false);
  assert.equal(l.tick("t1"), "ran");
});

test("pause and resume changes nothing about stopping", () => {
  const l = makeLifecycle();
  l.create("t1");
  l.setEnabled("t1", false);
  assert.equal(l.stopRequested.has("t1"), false);
  l.setEnabled("t1", true);
  assert.equal(l.tick("t1"), "ran");
});

test("a stopped task does not run until it is resumed", () => {
  // Failing the other way — a stop that does not stop — would be worse.
  const l = makeLifecycle();
  l.create("t1");
  l.stop("t1");
  assert.equal(l.tick("t1"), "not due");
  assert.equal(l.tick("t1"), "not due");
  assert.deepEqual(l.ran, []);
});

test("the stop routes only flag what is actually running", () => {
  for (const route of ['app.post("/api/tasks/:id/stop"', 'app.post("/api/series/:id/stop"']) {
    const at = server.indexOf(route);
    assert.notEqual(at, -1, `${route} is gone`);
    const body = server.slice(at, at + 1400);
    assert.match(body, /if \(wasRunning\)/, `${route} flags a stop with no run to interrupt`);
  }
});

test("both resume paths clear what stop set", () => {
  const task = server.slice(server.indexOf('app.post("/api/tasks/:id"'), server.indexOf('app.post("/api/tasks/:id/delete"'));
  assert.match(task, /r\.task\.enabled\) stopRequested\.delete/, "resuming a task leaves its stop flag set");

  const series = server.slice(server.indexOf('app.post("/api/series/:id"'), server.indexOf('app.post("/api/series/:id/delete"'));
  assert.match(series, /seriesStopped\.delete\(r\.series\.id\)/, "resuming a series leaves its own flag set");
  // Every step, because a stop mid-list flags the ones that never ran and each
  // step's flag is otherwise only cleared by that step running.
  assert.match(series, /for \(const step of r\.series\.steps\) stopRequested\.delete/, "step flags survive a resume");
});
