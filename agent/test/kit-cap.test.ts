import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTesseraActions } from "../src/agentkit.ts";
import { usdc } from "@tessera/shared";

/**
 * The action kit is a second door onto the same wallet.
 *
 * `CLAUDE.md`: every new spend path routes through the same choke point, and if
 * that is awkward, fix the choke point rather than adding a second door. The
 * deterministic loop escalates at the policy cap inside `purchase`; the kit
 * called `client.open()` directly with whatever provider and amount it was
 * handed — no cap, no blocklist, no vetted price. Nothing exposes `invoke()`
 * over HTTP, so it was a door rather than a hole, but "unreachable" is a fact
 * about today's routes and not about this file.
 *
 * A model brain is exactly the caller you would least like holding the
 * uncapped version, and there is no guardian on the other end of a tool call
 * to ask — so the kit stops at the cap instead of escalating past it.
 */

const CALLED: string[] = [];
const stubClient = {
  usdcBalance: async () => 0n,
  ensureApproval: async () => { CALLED.push("approve"); },
  open: async () => { CALLED.push("open"); return { paymentId: 1n, txHash: "0x" as const }; },
  openTab: async () => { CALLED.push("openTab"); return { tabId: 1n, txHash: "0x" as const }; },
  stakeOf: async () => 0n,
} as never;

const args = { provider: "0xa5b42b3Ebe7FDB187c956D310f868960015d2988", amount: "", deadline: "9999999999", quoteHash: ("0x" + "1".repeat(64)) };

test("a kit with no cap refuses to move anything", async () => {
  CALLED.length = 0;
  const kit = createTesseraActions(stubClient, {});
  await assert.rejects(
    () => kit.invoke("escrow_payment", { ...args, amount: usdc("0.001").toString() }),
    /no spend cap configured/,
  );
  assert.deepEqual(CALLED, [], "it reached the chain with no cap set");
});

test("a spend over the cap is refused before anything is approved", async () => {
  CALLED.length = 0;
  const kit = createTesseraActions(stubClient, { spendCap: usdc("0.005") });
  await assert.rejects(
    () => kit.invoke("escrow_payment", { ...args, amount: usdc("1").toString() }),
    /over this kit's 0.005 USDC cap/,
  );
  // Order matters: the approval is itself a transaction.
  assert.deepEqual(CALLED, [], "it approved USDC for a spend it then refused");
});

test("a spend at or under the cap goes through", async () => {
  CALLED.length = 0;
  const kit = createTesseraActions(stubClient, { spendCap: usdc("0.005") });
  await kit.invoke("escrow_payment", { ...args, amount: usdc("0.005").toString() });
  assert.deepEqual(CALLED, ["approve", "open"]);
});

test("funding a tab is capped too — it is a deposit, not a promise", async () => {
  CALLED.length = 0;
  const kit = createTesseraActions(stubClient, { spendCap: usdc("0.005") });
  await assert.rejects(
    () => kit.invoke("open_tab", { provider: args.provider, deposit: usdc("5").toString(), durationSeconds: 3600 }),
    /over this kit's/,
  );
  assert.deepEqual(CALLED, []);
});

test("every kit action that moves USDC passes the cap", () => {
  /*
   * A per-action assertion would pass a new uncapped action; this reads the
   * file, so a sixth spend path has to be capped or fail here.
   */
  const src = readFileSync(new URL("../src/agentkit.ts", import.meta.url), "utf8");
  const blocks = src.split(/(?=name: "[a-z_]+",)/);
  const uncapped: string[] = [];
  for (const b of blocks) {
    const name = /^name: "([a-z_]+)",/.exec(b)?.[1];
    if (!name) continue;
    const spends = /client\.(open|openTab)\(|pool\.(supply|borrow|repay)\(/.test(b);
    if (spends && !b.includes("withinCap(")) uncapped.push(name);
  }
  assert.deepEqual(uncapped, [], "these move USDC without passing the cap");
});

test("the agent hands the kit the same ceiling it escalates at", () => {
  const src = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");
  assert.match(src, /spendCap: this\.cfg\.policy\?\.autoApproveMax/);
});
