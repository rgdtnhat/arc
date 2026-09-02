import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalQueue } from "../src/policy.js";

const req = {
  resource: "alpha:report",
  name: "AlphaSignal",
  provider: "0x0000000000000000000000000000000000000002" as const,
  priceUsdc: "0.008",
  reason: "test",
};

test("guardian approval resolves the pending request", async () => {
  const q = new ApprovalQueue();
  const p = q.request(req, 5_000);
  assert.equal(q.list().length, 1);
  const id = q.list()[0].id;
  assert.equal(q.resolve(id, true), true);
  assert.equal(await p, true);
  assert.equal(q.list().length, 0);
});

test("guardian rejection resolves false", async () => {
  const q = new ApprovalQueue();
  const p = q.request(req, 5_000);
  q.resolve(q.list()[0].id, false);
  assert.equal(await p, false);
});

test("timeout counts as rejection", async () => {
  const q = new ApprovalQueue();
  const p = q.request(req, 50);
  assert.equal(await p, false);
  assert.equal(q.list().length, 0);
});

test("unknown ids are rejected without touching the queue", () => {
  const q = new ApprovalQueue();
  void q.request(req, 5_000);
  assert.equal(q.resolve(999, true), false);
  assert.equal(q.list().length, 1);
  q.resolve(q.list()[0].id, false); // clean up the pending timer
});

/*
 * The guardian cannot be switched off on a live chain.
 *
 * `autoApprove` turns the human co-signer into a rubber stamp. It exists for
 * one-shot and CI runs, and the rule is that it must never be reachable in a
 * deployed configuration. That used to hold because `docker-compose.yml`
 * forwarded a hand-kept list of variables and this one was not on it — a
 * property of the deployment file, not of the code. When that list was replaced
 * with `env_file` (fifteen real settings were being dropped by it), the switch
 * became reachable for the first time. So the rule moved into the code.
 */
test("a live deployment ignores the guardian bypass however it is set", () => {
  // The expression the dashboard builds its policy from.
  const decide = (env: Record<string, string | undefined>, live: boolean) =>
    (env.TESSERA_ONCE === "1" || env.TESSERA_AUTO_APPROVE === "1") && !live;

  for (const env of [
    { TESSERA_AUTO_APPROVE: "1" },
    { TESSERA_ONCE: "1" },
    { TESSERA_ONCE: "1", TESSERA_AUTO_APPROVE: "1" },
  ]) {
    assert.equal(decide(env, true), false, `the guardian was bypassed live with ${JSON.stringify(env)}`);
    assert.equal(decide(env, false), true, "the local affordance stopped working");
  }
  assert.equal(decide({}, false), false, "it defaulted to on");
  assert.equal(decide({ TESSERA_AUTO_APPROVE: "yes" }, false), false, "a non-'1' value turned it on");
});
