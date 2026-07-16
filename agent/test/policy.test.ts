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
