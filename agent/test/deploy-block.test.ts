/**
 * The binary search that gives every log scan its floor.
 *
 * This one is worth pinning because getting it wrong is invisible: a floor
 * that's too late produces a short scan, and a short scan of a lending pool
 * looks exactly like a pool nobody has used. The bug it replaced was precisely
 * that — a fixed 500k-block lookback, which on Arc is a few days, so a
 * fortnight-old pool reported zero suppliers and zero fee history.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { findDeploymentBlock, windowPlan } from "../src/deploy-block.js";

/** A fake chain where `address` gained code at `createdAt`. */
function chainWhereCodeAppearsAt(createdAt: bigint, latest = 54_000_000n) {
  let calls = 0;
  const pub = {
    getBlockNumber: async () => latest,
    getCode: async ({ blockNumber }: { blockNumber?: bigint }) => {
      calls++;
      const at = blockNumber ?? latest;
      return at >= createdAt ? "0xdeadbeef" : "0x";
    },
  };
  return { pub, calls: () => calls };
}

test("finds the exact block at which code first appeared", async () => {
  const { pub } = chainWhereCodeAppearsAt(53_308_405n);
  const found = await findDeploymentBlock(pub as never, "0x1111111111111111111111111111111111111111");
  assert.equal(found, 53_308_405n);
});

test("finds it in a logarithmic number of probes, not a scan", async () => {
  const { pub, calls } = chainWhereCodeAppearsAt(40_000_001n);
  await findDeploymentBlock(pub as never, "0x2222222222222222222222222222222222222222");
  // log2(54e6) ≈ 26. Anything near the block count means it degraded to a walk.
  assert.ok(calls() < 40, `expected a binary search, took ${calls()} probes`);
});

test("returns null for an address with no code at all", async () => {
  const pub = { getBlockNumber: async () => 100n, getCode: async () => "0x" };
  assert.equal(await findDeploymentBlock(pub as never, "0x3333333333333333333333333333333333333333"), null);
});

test("handles a contract deployed in the genesis block", async () => {
  const { pub } = chainWhereCodeAppearsAt(0n);
  assert.equal(await findDeploymentBlock(pub as never, "0x4444444444444444444444444444444444444444"), 0n);
});

test("caches the answer — a contract's creation block never changes", async () => {
  const addr = "0x5555555555555555555555555555555555555555";
  const { pub, calls } = chainWhereCodeAppearsAt(1_000n);
  await findDeploymentBlock(pub as never, addr);
  const first = calls();
  await findDeploymentBlock(pub as never, addr);
  assert.equal(calls(), first, "the second call did no chain reads");
});

test("concurrent callers share one search rather than racing", async () => {
  const addr = "0x6666666666666666666666666666666666666666";
  const { pub, calls } = chainWhereCodeAppearsAt(7_000n);
  const [a, b, c] = await Promise.all([
    findDeploymentBlock(pub as never, addr),
    findDeploymentBlock(pub as never, addr),
    findDeploymentBlock(pub as never, addr),
  ]);
  assert.equal(a, 7_000n);
  assert.deepEqual([b, c], [a, a]);
  // One search's worth of probes, not three.
  assert.ok(calls() < 40, `three callers caused ${calls()} probes`);
});

test("a node refusing historical state fails towards a later floor, never earlier", async () => {
  // A later floor means a shorter scan, which surfaces as `partial`. An earlier
  // one would mean silently missing logs while claiming a complete history.
  const pub = {
    getBlockNumber: async () => 1_000n,
    getCode: async ({ blockNumber }: { blockNumber?: bigint }) =>
      blockNumber === undefined ? "0xcode" : Promise.reject(new Error("no historical state")),
  };
  const found = await findDeploymentBlock(pub as never, "0x7777777777777777777777777777777777777777");
  assert.equal(found, 1_000n, "falls back to the chain head, not to zero");
});

// --- windowPlan -------------------------------------------------------------

test("windowPlan reports a scan that fits as complete", () => {
  const p = windowPlan(0n, 8_999n, 9_000n, 60);
  assert.equal(p.windows, 1);
  assert.equal(p.complete, true);
});

test("windowPlan counts a partial window as a whole one", () => {
  // 794k blocks at 9k each is 89 windows: 88 full and a remainder that still
  // costs a request. Rounding down here would under-scan the oldest history.
  const p = windowPlan(0n, 793_999n, 9_000n, 220);
  assert.equal(p.windows, 89);
  assert.equal(p.complete, true);
});

test("windowPlan says so when the range exceeds the budget", () => {
  const p = windowPlan(0n, 10_000_000n, 9_000n, 60);
  assert.equal(p.windows, 60);
  assert.equal(p.complete, false, "the caller must report this as partial");
});

test("windowPlan treats an inverted range as nothing to do", () => {
  assert.deepEqual(windowPlan(500n, 400n, 9_000n, 60), { windows: 0, complete: true });
});
