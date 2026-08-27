import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { usdc } from "@tessera/shared";
import { TesseraAgent, type AgentEvent } from "../src/agent.js";

/**
 * The tab rail moves money too.
 *
 * `agentkit`'s `open_tab` action caps its deposit — `kit-cap.test.ts` even reads
 * that file to be sure a sixth action cannot skip it. But `streamTicks` reached
 * `client.openTab` directly, which is the same shortcut past the cap, the
 * guardian and the blocklist that the kit itself was fixed for, in a file that
 * structural test does not scan.
 *
 * The deposit is the number that matters: it is `ticks * depositMultiple` times
 * the per-tick price, and it is computed from a catalog price the provider
 * controls, so a large enough listing opened a tab for any amount at all.
 */

const honest = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const blocked = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
);

/** 0.01/tick x 6 ticks x2 = 0.12 USDC deposit, against a 0.005 cap. */
const TICK_PRICE = usdc("0.01");
const TICKS = 6;
const DEPOSIT = TICK_PRICE * BigInt(TICKS) * 2n;
const CAP = usdc("0.005");

function stubClient() {
  const openedTabs: { provider: string; deposit: bigint }[] = [];
  return {
    openedTabs,
    async ensureApproval() {},
    async openTab(provider: `0x${string}`, deposit: bigint) {
      openedTabs.push({ provider, deposit });
      return { tabId: 7n, txHash: "0xopentab" as const };
    },
    async signVoucher() {
      return "0xvoucher" as const;
    },
  };
}

/** Serves a tab-billed catalog, the ticks, and a close that reports whatever it likes. */
async function tabProvider(provider: `0x${string}`, reportsSettled: bigint) {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/catalog")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          services: [
            {
              resource: "ticker:stream",
              name: "Ticker Stream",
              tags: ["ticker"],
              path: "/ticks",
              price: TICK_PRICE.toString(),
              slaSeconds: 60,
              billing: "tab",
              provider,
              stakeUsdc: "10",
              reputation: { fulfilled: 5, failed: 0, earnedUsdc: "1" },
            },
          ],
        })
      );
      return;
    }
    if (url.includes("/close")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ settled: reportsSettled.toString(), txHash: "0xclose" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tick: 1 }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function stream(
  policy: Record<string, unknown> | undefined,
  opts: { payee?: `0x${string}`; reportsSettled?: bigint } = {}
) {
  const payee = opts.payee ?? honest.address;
  const client = stubClient();
  const server = await tabProvider(payee, opts.reportsSettled ?? 0n);
  const events: AgentEvent[] = [];
  try {
    const agent = new TesseraAgent({
      client: client as never,
      providersBaseUrl: server.baseUrl,
      policy: policy as never,
      onEvent: (e) => events.push(e),
    });
    const out = await agent.streamTicks("ticker:stream", TICKS);
    return { out, openedTabs: client.openedTabs, events };
  } finally {
    server.close();
  }
}

test("a tab deposit over the cap opens no tab without a guardian", async () => {
  const { out, openedTabs } = await stream({ autoApproveMax: CAP });
  assert.equal(openedTabs.length, 0, "no tab may be funded above the cap");
  assert.equal(out, null);
});

test("the guardian is asked about the deposit, not the per-tick price", async () => {
  const { events } = await stream({ autoApproveMax: CAP });
  const escalation = events.find((e) => e.message.includes("ESCALATED"));
  assert.ok(escalation, "an over-cap deposit must escalate");
  // 0.12 is the deposit; 0.01 is the tick price the deposit is built from.
  assert.match(escalation.message, /0\.12/);
  assert.doesNotMatch(escalation.message, /costs 0\.01 USDC/);
});

test("a guardian that approves lets the tab open", async () => {
  const { openedTabs } = await stream({ autoApproveMax: CAP, autoApprove: true });
  assert.equal(openedTabs.length, 1, "an approved deposit should fund the tab");
  assert.equal(openedTabs[0].deposit, DEPOSIT);
});

test("a deposit within the cap needs no guardian", async () => {
  const { openedTabs, events } = await stream({ autoApproveMax: usdc("1") });
  assert.equal(openedTabs.length, 1);
  assert.equal(events.filter((e) => e.message.includes("ESCALATED")).length, 0);
});

test("a blocked provider gets no tab", async () => {
  const { out, openedTabs } = await stream(
    { autoApproveMax: usdc("1"), blockedProviders: [blocked.address] },
    { payee: blocked.address }
  );
  assert.equal(openedTabs.length, 0, "the blocklist must cover the tab rail too");
  assert.equal(out, null);
});

test("with no policy configured there is nothing to enforce", async () => {
  const { openedTabs } = await stream(undefined);
  assert.equal(openedTabs.length, 1);
});

test("streamTicks cannot reach openTab without passing the policy first", () => {
  /*
   * The behavioural tests above pass if the gate exists anywhere; this pins it
   * in front of the money, the way kit-cap.test.ts pins the kit's actions.
   */
  const src = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async streamTicks("));
  const gate = body.indexOf("autoApproveMax");
  const blocklist = body.indexOf("blockedProviders");
  const spend = body.indexOf("client.openTab(");
  assert.ok(gate !== -1 && gate < spend, "the cap must be checked before openTab");
  assert.ok(blocklist !== -1 && blocklist < spend, "the blocklist must be checked before openTab");
});

