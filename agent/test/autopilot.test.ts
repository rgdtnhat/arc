import test from "node:test";
import assert from "node:assert/strict";
import { planClaim, planCompound, planVote, mayRun } from "../src/autopilot.js";

/**
 * The decisions an autopilot makes with nobody watching.
 *
 * Most of these assert that it does *nothing*. That is the point: this is the
 * one part of the system that spends money without a human present, so its
 * default has to be inaction and every reason to move has to be argued. A test
 * suite here that mostly checked it acts correctly would be testing the easy
 * half.
 */

const TSRA = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

// --- claiming ---------------------------------------------------------------

test("does not claim a reward worth less than the gas to claim it", () => {
  // The slow leak: a bot that claims every tick, looks diligent in the log,
  // and pays more in fees than it collects.
  const d = planClaim({
    claimable: TSRA(0.5),
    rewardCentsPerToken: 10, // $0.10 a token → 5c of reward
    decimals: 18,
    gasCents: 4,
    multiple: 3, // wants 12c
  });
  assert.equal(d.action, "hold");
  assert.match(d.reason, /needs 12/);
});

test("claims once the reward clears the gas by the required multiple", () => {
  const d = planClaim({
    claimable: TSRA(200),
    rewardCentsPerToken: 10, // $20
    decimals: 18,
    gasCents: 4,
    multiple: 3,
  });
  assert.equal(d.action, "act");
  assert.equal(d.amount, TSRA(200));
});

test("refuses to claim on a guessed valuation when there is no usable price", () => {
  /*
   * The live case: the TWAP oracle is openly declining to price a one-dollar
   * pool. An autopilot that filled that gap with a guess would be making the
   * single decision this whole design exists to avoid — and the guess would
   * not be recorded anywhere.
   */
  const d = planClaim({
    claimable: TSRA(1_000_000),
    rewardCentsPerToken: null,
    decimals: 18,
    gasCents: 4,
    multiple: 3,
  });
  assert.equal(d.action, "hold");
  assert.match(d.reason, /no usable price/);
});

test("holds when nothing has accrued", () => {
  const d = planClaim({ claimable: 0n, rewardCentsPerToken: 100, decimals: 18, gasCents: 1, multiple: 2 });
  assert.equal(d.action, "hold");
});

// --- compounding ------------------------------------------------------------

test("compounds only a share of a claim, never the lot", () => {
  // Sweeping every claim into first-loss risk converts a treasury into a
  // leveraged bet on the pool never taking a bad debt, one tick at a time,
  // without anybody having decided to do that.
  const d = planCompound({
    claimed: TSRA(100),
    positionNow: 0n,
    shareBps: 2_500,
    cap: TSRA(10_000),
    minMove: TSRA(1),
  });
  assert.equal(d.action, "act");
  assert.equal(d.amount, TSRA(25));
});

test("stops at the cap however much comes in", () => {
  // The point of a cap is that a run of good weeks cannot talk you out of it.
  const d = planCompound({
    claimed: TSRA(10_000),
    positionNow: TSRA(990),
    shareBps: 10_000,
    cap: TSRA(1_000),
    minMove: TSRA(1),
  });
  assert.equal(d.action, "act");
  assert.equal(d.amount, TSRA(10)); // the room, not the share
});

test("does nothing once the backstop position is at its cap", () => {
  const d = planCompound({
    claimed: TSRA(500),
    positionNow: TSRA(1_000),
    shareBps: 5_000,
    cap: TSRA(1_000),
    minMove: TSRA(1),
  });
  assert.equal(d.action, "hold");
  assert.match(d.reason, /cap/);
});

test("leaves a deposit too small to be worth its gas alone", () => {
  const d = planCompound({
    claimed: TSRA(2),
    positionNow: 0n,
    shareBps: 1_000,
    cap: TSRA(1_000),
    minMove: TSRA(1),
  });
  assert.equal(d.action, "hold");
});

test("compounding can be switched off entirely", () => {
  const d = planCompound({
    claimed: TSRA(100), positionNow: 0n, shareBps: 0, cap: TSRA(1_000), minMove: TSRA(1),
  });
  assert.equal(d.action, "hold");
});

// --- voting -----------------------------------------------------------------

test("votes only for markets the agent is actually in", () => {
  /*
   * An agent voting on markets it has no exposure to is expressing an opinion
   * about somebody else's business with the protocol's money.
   */
  const plan = planVote(
    [
      { id: 0, votes: 0n, eligible: true, mine: true },
      { id: 1, votes: 0n, eligible: true, mine: false },
      { id: 2, votes: 0n, eligible: true, mine: true },
    ],
    { hasWeight: true },
  );
  assert.equal(plan.action, "act");
  assert.deepEqual(plan.allocations.map((a) => a.id), [0, 2]);
});

test("allocates exactly ten thousand basis points, remainder and all", () => {
  // A gauge that rejects a sum of 9,999 would reject any odd number of
  // markets, which is the kind of thing that only shows up on the third one.
  const plan = planVote(
    [0, 1, 2].map((id) => ({ id, votes: 0n, eligible: true, mine: true })),
    { hasWeight: true },
  );
  assert.equal(plan.allocations.reduce((s, a) => s + a.bps, 0), 10_000);
});

test("drops ineligible markets, where weight would earn nothing", () => {
  const plan = planVote(
    [
      { id: 0, votes: 0n, eligible: false, mine: true },
      { id: 1, votes: 0n, eligible: true, mine: true },
    ],
    { hasWeight: true },
  );
  assert.deepEqual(plan.allocations.map((a) => a.id), [1]);
  assert.equal(plan.allocations[0].bps, 10_000);
});

test("says so when every market it is in is ineligible", () => {
  const plan = planVote([{ id: 0, votes: 0n, eligible: false, mine: true }], { hasWeight: true });
  assert.equal(plan.action, "hold");
  assert.match(plan.reason, /ineligible/);
});

test("holds when it has no voting weight at all", () => {
  const plan = planVote([{ id: 0, votes: 0n, eligible: true, mine: true }], { hasWeight: false });
  assert.equal(plan.action, "hold");
});

test("does not spread into markets it has no position in, even when it has weight", () => {
  const plan = planVote(
    [{ id: 0, votes: 0n, eligible: true, mine: false }],
    { hasWeight: true },
  );
  assert.equal(plan.action, "hold");
  assert.match(plan.reason, /no position/);
});

// --- the gate ---------------------------------------------------------------

test("will not run when it is switched off", () => {
  const r = mayRun({ now: 1_000_000, lastRunAt: 0, enabled: false, limits: { minIntervalMs: 60_000, maxActionsPerRun: 3 } });
  assert.equal(r.ok, false);
});

test("will not run again inside its own interval, and says how long to wait", () => {
  const r = mayRun({
    now: 1_000_000, lastRunAt: 970_000, enabled: true,
    limits: { minIntervalMs: 60_000, maxActionsPerRun: 3 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.retryInSeconds, 30);
});

test("runs the first time, with no previous run to be too close to", () => {
  const r = mayRun({ now: 1_000_000, lastRunAt: 0, enabled: true, limits: { minIntervalMs: 60_000, maxActionsPerRun: 3 } });
  assert.equal(r.ok, true);
});
