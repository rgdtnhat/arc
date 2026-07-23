import test from "node:test";
import assert from "node:assert/strict";
import { usdc } from "@tessera/shared";
import { runFleet, type FleetMember } from "../src/fleet.ts";
import type { LedgerEntry } from "../src/agent.ts";

const ADDR = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as `0x${string}`;

function entry(status: LedgerEntry["status"], price: bigint): LedgerEntry {
  return { resource: "x", name: "X", provider: ADDR(9), price, status, reason: "", txs: {} };
}

/** A fake member whose agent.run() populates a preset ledger — lets us test the
 *  fleet's concurrency + aggregation without a chain. */
function fakeMember(id: number, ledger: LedgerEntry[], delayMs = 0): FleetMember {
  const agent: any = {
    ledger: [] as LedgerEntry[],
    async run() {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      this.ledger.push(...ledger);
      return this.ledger;
    },
  };
  return { id, label: `agent-${id + 1}`, account: { address: ADDR(id + 1) } as any, client: {} as any, agent };
}

test("runFleet runs all members and aggregates settled/refunded/spent", async () => {
  const members = [
    fakeMember(0, [entry("settled", usdc("0.0025")), entry("settled", usdc("0.004"))]),
    fakeMember(1, [entry("settled", usdc("0.008")), entry("refunded", usdc("0.003"))]),
    fakeMember(2, [entry("skipped", 0n)]),
  ];
  const res = await runFleet(members, () => ({ goal: "g", budget: usdc("1"), needs: [] }));

  assert.equal(res.members.length, 3);
  assert.equal(res.totalSettled, 3);
  assert.equal(res.totalRefunded, 1);
  assert.equal(res.totalSpentUsdc, "0.0145"); // 0.0025 + 0.004 + 0.008
  assert.equal(res.members[0].spentUsdc, "0.0065");
  assert.equal(res.members[1].refunded, 1);
  assert.equal(res.members[2].skipped, 1);
  assert.equal(res.members[1].address, ADDR(2));
});

test("runFleet executes members concurrently, not sequentially", async () => {
  // Three members each sleeping 120ms: parallel ≈ 120ms, serial would be ≈ 360ms.
  const members = [0, 1, 2].map((i) => fakeMember(i, [entry("settled", usdc("0.001"))], 120));
  const res = await runFleet(members, () => ({ goal: "g", budget: usdc("1"), needs: [] }));
  assert.equal(res.totalSettled, 3);
  assert.ok(res.wallClockMs < 300, `expected parallel (<300ms), got ${res.wallClockMs}ms`);
});

test("one member throwing doesn't sink the fleet", async () => {
  const good = fakeMember(0, [entry("settled", usdc("0.002"))]);
  const bad: FleetMember = {
    id: 1,
    label: "agent-2",
    account: { address: ADDR(2) } as any,
    client: {} as any,
    agent: { ledger: [], async run() { throw new Error("rpc boom"); } } as any,
  };
  const res = await runFleet([good, bad], () => ({ goal: "g", budget: usdc("1"), needs: [] }));
  assert.equal(res.totalSettled, 1);
  assert.equal(res.members[1].settled, 0);
});
