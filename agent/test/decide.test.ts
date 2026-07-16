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
