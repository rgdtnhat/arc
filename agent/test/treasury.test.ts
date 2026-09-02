import test from "node:test";
import assert from "node:assert/strict";
import { usdc } from "@tessera/shared";
import { TesseraTreasury } from "../src/treasury.ts";
import { CircleFaucet, CIRCLE_FAUCET_API } from "../src/circle/faucet.ts";
import type { TesseraClient } from "../src/client.ts";
import type { Faucet, FaucetResult } from "../src/circle/faucet.ts";
import type { LedgerEntry } from "../src/agent.ts";

const ADDR = "0x00000000000000000000000000000000000000aa" as const;

function clientWithBalance(balance: bigint): TesseraClient {
  return {
    account: { address: ADDR },
    usdcBalance: async () => balance,
  } as unknown as TesseraClient;
}

function recordingFaucet(): { faucet: Faucet; calls: number } {
  let calls = 0;
  const faucet: Faucet = {
    kind: "test",
    async request(address): Promise<FaucetResult> {
      calls++;
      return { ok: true, address, amountUsdc: "0.05", message: "dripped" };
    },
  };
  return {
    faucet,
    get calls() {
      return calls;
    },
  } as { faucet: Faucet; calls: number };
}

test("snapshot reports health and runway", async () => {
  const t = new TesseraTreasury({ client: clientWithBalance(usdc("0.1")), lowWaterMark: usdc("0.02") });
  const snap = await t.snapshot(usdc("0.004"));
  assert.equal(snap.balanceUsdc, "0.1");
  assert.equal(snap.healthy, true);
  assert.equal(snap.runwayCalls, 25); // 0.1 / 0.004
});

test("topUpIfLow drips when below the low-water mark", async () => {
  const rf = recordingFaucet();
  const t = new TesseraTreasury({ client: clientWithBalance(usdc("0.005")), lowWaterMark: usdc("0.02"), faucet: rf.faucet });
  const result = await t.topUpIfLow();
  assert.ok(result);
  assert.equal(result!.ok, true);
  assert.equal(rf.calls, 1);
});

test("topUpIfLow is a no-op when the balance is healthy", async () => {
  const rf = recordingFaucet();
  const t = new TesseraTreasury({ client: clientWithBalance(usdc("1")), lowWaterMark: usdc("0.02"), faucet: rf.faucet });
  const result = await t.topUpIfLow();
  assert.equal(result, null);
  assert.equal(rf.calls, 0);
});

test("requestFaucet without a faucet returns manual instructions", async () => {
  const t = new TesseraTreasury({ client: clientWithBalance(0n), lowWaterMark: usdc("0.02") });
  const r = await t.requestFaucet();
  assert.equal(r.ok, false);
  assert.equal(r.manual, true);
  assert.match(r.url!, /faucet\.circle\.com/);
  assert.match(r.message, /faucet\.circle\.com/);
});

test("settlement accounting sums spent, reclaimed and net", () => {
  const ledger: LedgerEntry[] = [
    { resource: "weather:current", name: "W", provider: ADDR, price: usdc("0.0025"), status: "settled", reason: "", txs: {} },
    { resource: "fx:quote", name: "F", provider: ADDR, price: usdc("0.004"), status: "settled", reason: "", txs: {} },
    { resource: "news:headlines", name: "N", provider: ADDR, price: usdc("0.003"), status: "refunded", reason: "", txs: {} },
  ];
  const s = TesseraTreasury.settlement(ledger, usdc("1"), usdc("0.9935"));
  assert.equal(s.spentUsdc, "0.0065");
  assert.equal(s.reclaimedUsdc, "0.003");
  assert.equal(s.settledCount, 2);
  assert.equal(s.refundedCount, 1);
  assert.equal(s.netUsdc, "-0.0065");
});

test("CircleFaucet is manual without an API key", async () => {
  const f = new CircleFaucet();
  const r = await f.request(ADDR);
  assert.equal(r.ok, false);
  assert.equal(r.manual, true);
  assert.match(r.message, /faucet\.circle\.com/);
});

test("CircleFaucet posts to the Circle drips API with a key", async () => {
  let seenUrl = "";
  let seenBody: any = null;
  let seenAuth = "";
  const fetchImpl = (async (url: string, init: any) => {
    seenUrl = String(url);
    seenAuth = init.headers.Authorization;
    seenBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ data: { txHash: "0xfaucet" } }) };
  }) as unknown as typeof fetch;
  const f = new CircleFaucet({ apiKey: "k", blockchain: "ARC-SEPOLIA", fetchImpl });
  const r = await f.request(ADDR);
  assert.equal(r.ok, true);
  assert.equal(r.txHash, "0xfaucet");
  assert.equal(seenUrl, CIRCLE_FAUCET_API);
  assert.equal(seenAuth, "Bearer k");
  assert.equal(seenBody.address, ADDR);
  assert.equal(seenBody.blockchain, "ARC-SEPOLIA");
  assert.equal(seenBody.usdc, true);
});

test("CircleFaucet falls back to manual on an API error", async () => {
  const fetchImpl = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
  const f = new CircleFaucet({ apiKey: "k", fetchImpl });
  const r = await f.request(ADDR);
  assert.equal(r.ok, false);
  assert.match(r.message, /HTTP 429/);
  assert.match(r.message, /faucet\.circle\.com/);
});
