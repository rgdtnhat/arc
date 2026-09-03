/**
 * The sweep as the agent actually runs it: enumerate, read, plan, reclaim.
 *
 * The pure rules are pinned in `tab-sweep.test.ts`. What is checked here is the
 * half that touches a chain — that a failure at any of the three steps costs
 * only the tabs it actually affects, and that what the feed reports is what the
 * plan said would move rather than what was hoped for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { usdc } from "@tessera/shared";
import { TesseraAgent, type AgentEvent } from "../src/agent.ts";
import { TesseraClient, type TabRowOnChain } from "../src/client.ts";

const ME = "0x00000000000000000000000000000000000000aa" as const;
const PROVIDER = "0x00000000000000000000000000000000000000bb" as const;
const TAB = "0x00000000000000000000000000000000000000cc" as const;

const NOW = () => Math.floor(Date.now() / 1000);

function row(over: Partial<TabRowOnChain> = {}): TabRowOnChain {
  return {
    tabId: 1n,
    agent: ME,
    provider: PROVIDER,
    deposit: usdc("1"),
    claimed: 0n,
    expiry: BigInt(NOW() - 3600),
    closed: false,
    ...over,
  };
}

interface Stub {
  agent: TesseraAgent;
  events: AgentEvent[];
  reclaimed: bigint[];
}

function agentWith(opts: {
  ids?: bigint[] | (() => never);
  rows?: TabRowOnChain[];
  unreadable?: { tabId: bigint; why: string }[];
  reclaimFails?: Set<bigint>;
  tab?: `0x${string}`;
}): Stub {
  const events: AgentEvent[] = [];
  const reclaimed: bigint[] = [];
  const client = {
    tab: "tab" in opts ? opts.tab : TAB,
    account: { address: ME },
    tabsAsAgent: async () => (typeof opts.ids === "function" ? opts.ids() : (opts.ids ?? [])),
    tabRows: async () => ({ rows: opts.rows ?? [], unreadable: opts.unreadable ?? [] }),
    reclaimTab: async (tabId: bigint) => {
      if (opts.reclaimFails?.has(tabId)) throw new Error("execution reverted: TabIsClosed");
      reclaimed.push(tabId);
      return `0x${tabId.toString(16).padStart(64, "0")}` as const;
    },
  } as unknown as TesseraClient;

  const agent = new TesseraAgent({
    client,
    providersBaseUrl: "http://127.0.0.1:0",
    onEvent: (e) => events.push(e),
  });
  return { agent, events, reclaimed };
}

const messages = (s: Stub) => s.events.map((e) => e.message).join("\n");

test("an expired unsettled tab is reclaimed and reported at its remainder", async () => {
  const s = agentWith({
    ids: [7n],
    rows: [row({ tabId: 7n, deposit: usdc("0.12"), claimed: usdc("0.02") })],
  });
  const out = await s.agent.sweepExpiredTabs();

  assert.deepEqual(s.reclaimed, [7n]);
  assert.equal(out.reclaimed, usdc("0.1"));
  assert.equal(out.txs.length, 1);
  assert.match(messages(s), /Tab #7 expired unsettled — reclaimed 0\.1 USDC/);
});

test("a live tab is left alone and nothing is sent", async () => {
  const s = agentWith({ ids: [1n], rows: [row({ expiry: BigInt(NOW() + 3600) })] });
  const out = await s.agent.sweepExpiredTabs();

  assert.deepEqual(s.reclaimed, []);
  assert.equal(out.reclaimed, 0n);
  assert.equal(s.events.length, 0, "a sweep with nothing to do stays quiet");
});

test("a deployment with no tab contract sweeps nothing and says nothing", async () => {
  // Not a fault — a configuration. Warning about it every run would train the
  // reader to skip the line that matters.
  const s = agentWith({ tab: undefined, ids: [1n], rows: [row()] });
  const out = await s.agent.sweepExpiredTabs();

  assert.equal(out.reclaimed, 0n);
  assert.equal(s.events.length, 0);
});

test("a failure to list tabs is reported, not swallowed", async () => {
  // A sweep that cannot enumerate recovers nothing, and that must not look the
  // same as a sweep with nothing to do.
  const s = agentWith({
    ids: () => {
      throw new Error("HTTP request failed: 429 Too Many Requests");
    },
  });
  const out = await s.agent.sweepExpiredTabs();

  assert.equal(out.reclaimed, 0n);
  assert.match(messages(s), /Tab sweep skipped — could not list this agent's tabs \(HTTP request failed/);
});

test("a row that could not be read is named, and the readable ones still run", async () => {
  const s = agentWith({
    ids: [1n, 2n],
    rows: [row({ tabId: 2n, deposit: usdc("3") })],
    unreadable: [{ tabId: 1n, why: "tabs: returned no data" }],
  });
  const out = await s.agent.sweepExpiredTabs();

  assert.match(messages(s), /Tab #1 could not be read — tabs: returned no data/);
  assert.deepEqual(s.reclaimed, [2n], "the readable tab is still reclaimed");
  assert.equal(out.reclaimed, usdc("3"));
});

test("one reverting reclaim does not abandon the rest of the pass", async () => {
  const s = agentWith({
    ids: [1n, 2n, 3n],
    rows: [
      row({ tabId: 1n, deposit: usdc("5") }),
      row({ tabId: 2n, deposit: usdc("9") }),
      row({ tabId: 3n, deposit: usdc("1") }),
    ],
    reclaimFails: new Set([2n]),
  });
  const out = await s.agent.sweepExpiredTabs();

  assert.deepEqual(s.reclaimed, [1n, 3n]);
  assert.match(messages(s), /Tab #2 could not be reclaimed — execution reverted: TabIsClosed/);
  assert.equal(out.reclaimed, usdc("6"), "the reverted tab is not counted as recovered");
  assert.equal(out.txs.length, 2);
});

test("the total reported is what moved, not what was planned", async () => {
  // The failure this pins: adding up the plan and reporting that as recovered.
  // A pass where every reclaim reverts would then announce a full recovery.
  const s = agentWith({
    ids: [1n, 2n],
    rows: [row({ tabId: 1n, deposit: usdc("4") }), row({ tabId: 2n, deposit: usdc("6") })],
    reclaimFails: new Set([1n, 2n]),
  });
  const out = await s.agent.sweepExpiredTabs();

  assert.equal(out.reclaimed, 0n);
  assert.equal(out.txs.length, 0);
  assert.match(messages(s), /Sweeping 2 expired tab\(s\) — 10 USDC to reclaim/);
});

test("the pass is capped, and the cap is what limits the writes", async () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    row({ tabId: BigInt(i + 1), deposit: usdc(String(i + 1)) }),
  );
  const s = agentWith({ ids: rows.map((r) => r.tabId), rows });
  const out = await s.agent.sweepExpiredTabs({ maxPerPass: 3 });

  assert.deepEqual(s.reclaimed, [9n, 8n, 7n], "most valuable first");
  assert.equal(out.reclaimed, usdc("24"));
});
