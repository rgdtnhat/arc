/**
 * Reading tabs off the chain: what comes back, and what happens to a row that
 * does not.
 *
 * The partitioning is the whole promise of `tabRows`, so these run against the
 * real method rather than a stub of it — built on the prototype because the
 * constructor opens real transports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { usdc } from "@tessera/shared";
import { TesseraClient } from "../src/client.ts";

const ME = "0x00000000000000000000000000000000000000aa" as const;
const PROVIDER = "0x00000000000000000000000000000000000000bb" as const;
const TAB = "0x00000000000000000000000000000000000000cc" as const;

function realClientOver(readContract: (a: { args?: unknown[] }) => Promise<unknown>): TesseraClient {
  const c = Object.create(TesseraClient.prototype) as TesseraClient;
  Object.assign(c, { tab: TAB, public: { readContract } });
  return c;
}

test("tabRows returns readable rows and names the ones it could not read", async () => {
  const c = realClientOver(async ({ args }) => {
    const id = (args as bigint[])[0];
    if (id === 2n) throw new Error("execution reverted: no data");
    return [ME, PROVIDER, usdc("1"), usdc("0.25"), 42n, false];
  });

  const { rows, unreadable } = await c.tabRows([1n, 2n, 3n]);

  assert.deepEqual(
    rows.map((r) => r.tabId),
    [1n, 3n],
  );
  assert.deepEqual(rows[0], {
    tabId: 1n,
    agent: ME,
    provider: PROVIDER,
    deposit: usdc("1"),
    claimed: usdc("0.25"),
    expiry: 42n,
    closed: false,
  });
  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0].tabId, 2n);
  assert.match(unreadable[0].why, /tabs: execution reverted: no data/);
});

test("a tab that could not be read never arrives as a zeroed row", async () => {
  // The bug the whole chain-read module exists for: a failed read that renders
  // as `deposit 0, claimed 0` is one a sweep skips as "nothing to reclaim" and
  // never looks at again.
  const c = realClientOver(async () => {
    throw new Error("HTTP request failed");
  });

  const { rows, unreadable } = await c.tabRows([1n, 2n]);
  assert.deepEqual(rows, []);
  assert.deepEqual(
    unreadable.map((u) => u.tabId),
    [1n, 2n],
  );
});

test("tabRows on a deployment without a tab contract is an error, not an empty list", async () => {
  // Silently answering "no tabs" would make a misconfiguration indistinguishable
  // from an agent that has never opened one.
  const c = Object.create(TesseraClient.prototype) as TesseraClient;
  await assert.rejects(() => c.tabRows([1n]), /tabAddress not configured/);
});
