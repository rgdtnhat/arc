import test from "node:test";
import assert from "node:assert/strict";
import { createTesseraActions } from "../src/agentkit.ts";
import type { TesseraClient } from "../src/client.ts";

/*
 * A cap, because the kit refuses to move USDC without one.
 *
 * These tests are about dispatch — that an action exists, parses its input and
 * reaches the client. The cap they pass is deliberately far above the amounts
 * below, so it never decides the outcome; `kit-cap.test.ts` is where the cap
 * itself is exercised.
 */
const SPEND_CAP = 10n ** 12n;

/** A duck-typed TesseraClient that records calls, so the kit is testable offline. */
function fakeClient() {
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, ...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const client = {
    usdcBalance: async (who?: `0x${string}`) => (rec("usdcBalance", who), 1_500_000n),
    reputation: async (p: `0x${string}`) => (rec("reputation", p), { fulfilled: 3n, failed: 1n, earned: 8_000n }),
    stakeOf: async (p: `0x${string}`) => (rec("stakeOf", p), 50_000n),
    ensureApproval: async (min: bigint) => rec("ensureApproval", min),
    open: async (provider: `0x${string}`, amount: bigint, deadline: bigint, quoteHash: `0x${string}`) =>
      (rec("open", provider, amount, deadline, quoteHash), { paymentId: 7n, txHash: "0xopen" as const }),
    settle: async (id: bigint) => (rec("settle", id), "0xsettle" as const),
    refund: async (id: bigint) => (rec("refund", id), "0xrefund" as const),
    openTab: async (provider: `0x${string}`, deposit: bigint, dur: number) =>
      (rec("openTab", provider, deposit, dur), { tabId: 2n, txHash: "0xtab" as const }),
    signVoucher: async (tabId: bigint, cum: bigint) => (rec("signVoucher", tabId, cum), "0xvoucher" as const),
    reclaimTab: async (id: bigint) => (rec("reclaimTab", id), "0xreclaim" as const),
  } as unknown as TesseraClient;
  return { client, calls };
}

test("manifest exposes wallet, payment and on-chain actions with schemas", () => {
  const { client } = fakeClient();
  const kit = createTesseraActions(client, { spendCap: SPEND_CAP });
  const names = kit.manifest().map((a) => a.name);
  for (const expected of [
    "usdc_balance",
    "discover_services",
    "get_reputation",
    "escrow_payment",
    "settle_payment",
    "refund_payment",
    "open_tab",
    "sign_voucher",
    "reclaim_tab",
  ]) {
    assert.ok(names.includes(expected), `missing action ${expected}`);
  }
  // Every action advertises a JSON-schema input and a kind (tool-use shape).
  for (const a of kit.manifest()) {
    assert.equal(a.inputSchema.type, "object");
    assert.ok(["read", "payment", "onchain"].includes(a.kind));
  }
  // Payment actions must declare their required inputs.
  const escrow = kit.manifest().find((a) => a.name === "escrow_payment")!;
  assert.deepEqual(escrow.inputSchema.required, ["provider", "amount", "deadline", "quoteHash"]);
});

test("usdc_balance reads the wallet and formats USDC", async () => {
  const { client, calls } = fakeClient();
  const kit = createTesseraActions(client, { spendCap: SPEND_CAP });
  const out = await kit.invoke<{ raw: string; usdc: string }>("usdc_balance");
  assert.equal(out.raw, "1500000");
  assert.equal(out.usdc, "1.5");
  assert.equal(calls.usdcBalance.length, 1);
});

test("escrow_payment approves then opens escrow with parsed bigints", async () => {
  const { client, calls } = fakeClient();
  const kit = createTesseraActions(client, { spendCap: SPEND_CAP });
  const out = await kit.invoke<{ paymentId: string; txHash: string }>("escrow_payment", {
    provider: "0x00000000000000000000000000000000000000aa",
    amount: "4000",
    deadline: "1900000000",
    quoteHash: "0xdeadbeef",
  });
  assert.equal(out.paymentId, "7");
  assert.equal(out.txHash, "0xopen");
  assert.deepEqual(calls.ensureApproval[0], [4000n]);
  assert.deepEqual(calls.open[0], [
    "0x00000000000000000000000000000000000000aa",
    4000n,
    1900000000n,
    "0xdeadbeef",
  ]);
});

test("refund_payment routes to the slashing refund path", async () => {
  const { client, calls } = fakeClient();
  const kit = createTesseraActions(client, { spendCap: SPEND_CAP });
  const out = await kit.invoke<{ txHash: string }>("refund_payment", { paymentId: "9" });
  assert.equal(out.txHash, "0xrefund");
  assert.deepEqual(calls.refund[0], [9n]);
});

test("discover_services uses the injected fetch against the providers URL", async () => {
  const { client } = fakeClient();
  let hitUrl = "";
  const kit = createTesseraActions(client, {
    spendCap: SPEND_CAP,
    providersBaseUrl: "http://providers.test",
    fetchImpl: (async (url: string) => {
      hitUrl = String(url);
      return { json: async () => ({ services: [{ resource: "fx:quote" }] }) };
    }) as unknown as typeof fetch,
  });
  const out = await kit.invoke<{ services: unknown[] }>("discover_services");
  assert.equal(hitUrl, "http://providers.test/catalog");
  assert.equal(out.services.length, 1);
});

test("marketplace actions fail clearly without a providers URL", async () => {
  const { client } = fakeClient();
  const kit = createTesseraActions(client, { spendCap: SPEND_CAP });
  await assert.rejects(() => kit.invoke("discover_services"), /providersBaseUrl is required/);
});

test("invoking an unknown action throws", async () => {
  const { client } = fakeClient();
  const kit = createTesseraActions(client, { spendCap: SPEND_CAP });
  await assert.rejects(() => kit.invoke("nope"), /unknown action: nope/);
});

test("lending actions appear and dispatch when a pool is provided", async () => {
  const { client } = fakeClient();
  const calls: Record<string, unknown[]> = {};
  const rec = (k: string, ...a: unknown[]) => ((calls[k] ??= []).push(a));
  const pool = {
    supply: async (asset: string, amount: bigint) => (rec("supply", asset, amount), "0xsup"),
    withdraw: async () => "0xwd",
    borrow: async (asset: string, amount: bigint) => (rec("borrow", asset, amount), "0xbor"),
    repay: async () => "0xrep",
    accountData: async () => ({ supplyValue: 1500n, borrowValue: 500n, borrowLimit: 1000n, healthFactor: 2n * 10n ** 18n }),
    reserveData: async () => ({ cash: 100n, totalBorrows: 50n, utilizationWad: 5n * 10n ** 17n, borrowAprWad: 35n * 10n ** 15n, supplyAprWad: 15n * 10n ** 15n }),
  } as any;
  const kit = createTesseraActions(client, { pool, spendCap: SPEND_CAP });
  const names = kit.manifest().map((a) => a.name);
  for (const n of ["pool_supply", "pool_withdraw", "pool_borrow", "pool_repay", "pool_account", "pool_reserve"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  const borrow = await kit.invoke<{ txHash: string }>("pool_borrow", { asset: "0x00000000000000000000000000000000000000bb", amount: "2000000" });
  assert.equal(borrow.txHash, "0xbor");
  assert.deepEqual(calls.borrow[0], ["0x00000000000000000000000000000000000000bb", 2000000n]);
  const acct = await kit.invoke<{ healthFactor: string }>("pool_account");
  assert.equal(acct.healthFactor, (2n * 10n ** 18n).toString());
});
