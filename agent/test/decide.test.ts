import test from "node:test";
import assert from "node:assert/strict";
import { decideByRules, passesQuality, trustScore, type OfferedService } from "../src/decide.js";
import { usdc } from "@tessera/shared";

const svc = (over: Partial<OfferedService> = {}): OfferedService => ({
  resource: "weather:current",
  name: "AtmosFeed",
  tags: ["weather"],
  path: "/weather",
  price: usdc("0.0025"),
  slaSeconds: 30,
  billing: "escrow",
  provider: "0x0000000000000000000000000000000000000001",
  stakeUsdc: "0",
  reputation: { fulfilled: 0, failed: 0, earnedUsdc: "0" },
  ...over,
});

const task = {
  goal: "test",
  budget: usdc("0.02"),
  needs: [{ tag: "weather", maxPrice: usdc("0.005") }],
};

test("buys a relevant, affordable service from an unseen provider", () => {
  const d = decideByRules(task, svc(), task.budget);
  assert.equal(d.buy, true);
  assert.equal(d.trust, 0.5);
});

test("skips services irrelevant to the task", () => {
  const d = decideByRules(task, svc({ tags: ["astrology"] }), task.budget);
  assert.equal(d.buy, false);
  assert.match(d.reason, /irrelevant/);
});

test("refuses to pay above the per-need cap", () => {
  const d = decideByRules(task, svc({ price: usdc("0.006") }), task.budget);
  assert.equal(d.buy, false);
  assert.match(d.reason, /over cap/);
});

test("refuses to exceed the remaining budget", () => {
  const d = decideByRules(task, svc(), usdc("0.001"));
  assert.equal(d.buy, false);
  assert.match(d.reason, /budget/);
});

test("applies a trust floor from on-chain reputation", () => {
  const d = decideByRules(
    task,
    svc({ reputation: { fulfilled: 0, failed: 5, earnedUsdc: "0" } }),
    task.budget
  );
  assert.equal(d.buy, false);
  assert.match(d.reason, /trust/);
});

test("staked providers earn a trust bonus", () => {
  assert.equal(trustScore({ fulfilled: 0, failed: 0 }, "0.05"), 0.6);
  assert.equal(trustScore({ fulfilled: 0, failed: 0 }, "0"), 0.5);
});

test("personal memory penalty can push a provider below the floor", () => {
  // Global record is neutral, but this agent was burned twice: 0.5 - 0.30 = 0.20 < floor.
  const d = decideByRules(task, svc(), task.budget, 0.3);
  assert.equal(d.buy, false);
  assert.match(d.reason, /trust/);
});

test("quality gate rejects junk and passes good payloads", () => {
  assert.equal(passesQuality("weather:current", { tempC: 21 }).ok, true);
  assert.equal(passesQuality("weather:current", {}).ok, false);
  assert.equal(passesQuality("news:headlines", { headlines: [] }).ok, false);
  assert.equal(passesQuality("news:headlines", { headlines: ["a"] }).ok, true);
  assert.equal(passesQuality("fx:quote", { rate: 1.1 }).ok, true);
  assert.equal(passesQuality("alpha:report", { stance: "bullish", drivers: [] }).ok, true);
});

// --- reputation that costs something to build --------------------------------
//
// `fulfilled` and `failed` are cheap to manufacture: fund a second address, buy
// from yourself, settle, repeat. This function decides what the agent's money
// buys, so it has to treat a manufactured record as weaker than a real one.

const NOW = 1_800_000_000; // fixed, so decay is deterministic
const RECENT = NOW - 86_400; // a day ago

test("a spread, recent record scores as well as it always did", () => {
  const spread = trustScore(
    { fulfilled: 20, failed: 0, distinctBuyers: 12, lastSettledAt: RECENT },
    "0",
    NOW,
  );
  const naive = trustScore({ fulfilled: 20, failed: 0 }, "0", NOW);
  // Honest providers must not be penalised by the new signals — the point is
  // to catch a fake history, not to make real ones unbuyable.
  assert.ok(Math.abs(spread - naive) < 0.02, `${spread} vs ${naive}`);
});

test("a record from a single counterparty is discounted toward neutral", () => {
  const farmed = trustScore(
    { fulfilled: 40, failed: 0, distinctBuyers: 1, lastSettledAt: RECENT },
    "0",
    NOW,
  );
  const real = trustScore(
    { fulfilled: 40, failed: 0, distinctBuyers: 20, lastSettledAt: RECENT },
    "0",
    NOW,
  );
  // Identical counts, very different claims.
  assert.ok(farmed < real, `${farmed} should be below ${real}`);
  assert.ok(farmed < 0.75, `${farmed} should be well short of a clean record`);
  assert.ok(farmed > 0.5, "still better than unknown, just not by much");
});

test("concentration cannot push a good provider below neutral", () => {
  // The discount pulls toward 0.5, never through it. A provider with a clean
  // record and one counterparty is unproven, not bad.
  const s = trustScore(
    { fulfilled: 50, failed: 0, distinctBuyers: 1, lastSettledAt: RECENT },
    "0",
    NOW,
  );
  assert.ok(s >= 0.5, `${s}`);
});

test("a record that stopped moving decays toward neutral", () => {
  const fresh = trustScore(
    { fulfilled: 30, failed: 0, distinctBuyers: 15, lastSettledAt: RECENT },
    "0",
    NOW,
  );
  const stale = trustScore(
    { fulfilled: 30, failed: 0, distinctBuyers: 15, lastSettledAt: NOW - 86_400 * 240 },
    "0",
    NOW,
  );
  assert.ok(stale < fresh, `${stale} should be below ${fresh}`);
  // Four half-lives out, almost all of the signal is gone.
  assert.ok(stale < 0.55, `${stale}`);
});

test("an unseen provider stays neutral rather than being punished twice", () => {
  const s = trustScore({ fulfilled: 0, failed: 0, distinctBuyers: 0, lastSettledAt: 0 }, "0", NOW);
  assert.equal(s, 0.5);
});

test("a caller that has not read the new fields gets the old behaviour", () => {
  // Reading an escrow deployed before these fields returns a shorter tuple. That
  // must degrade to the previous score, not to "zero counterparties".
  const s = trustScore({ fulfilled: 20, failed: 0 }, "0", NOW);
  assert.ok(s > 0.9, `${s}`);
});

test("a bad record is still bad however well spread it is", () => {
  const s = trustScore(
    { fulfilled: 2, failed: 20, distinctBuyers: 20, lastSettledAt: RECENT },
    "0",
    NOW,
  );
  assert.ok(s < 0.3, `${s}`);
});

test("stake still helps, and concentration still applies on top", () => {
  const staked = trustScore(
    { fulfilled: 10, failed: 0, distinctBuyers: 8, lastSettledAt: RECENT },
    "5.0",
    NOW,
  );
  const unstaked = trustScore(
    { fulfilled: 10, failed: 0, distinctBuyers: 8, lastSettledAt: RECENT },
    "0",
    NOW,
  );
  assert.ok(staked >= unstaked, `${staked} vs ${unstaked}`);
  assert.ok(staked <= 1);
});
