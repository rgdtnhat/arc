import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { HEADERS, quoteTypedData, usdc, PaymentStatus } from "@tessera/shared";
import type { OfferedService } from "../src/decide.js";
import { TesseraAgent } from "../src/agent.js";

/**
 * The guardian cap has to live where the money moves.
 *
 * `CLAUDE.md` states it plainly: the cap is enforced inside the one function
 * that escrows funds, not repeated in each caller, because "a cap that callers
 * must remember to check is not a cap — the next call site silently bypasses
 * it". The invoice path was that next call site. It checked the *invoice's*
 * amount against the cap and then called `purchase`, which escrows the
 * *quote's* price — bounded only by the catalog entry. A provider that billed
 * a penny for a service listed at a pound was escalated for the penny and paid
 * the pound.
 *
 * So this drives `purchase` directly, which is what both callers ultimately do.
 * Whatever a caller checked, nothing may escrow above the cap without a
 * guardian saying so.
 */

const honest = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const escrow = "0x0000000000000000000000000000000000000abc" as const;
const chainId = 5042002;

/** Listed at a pound; the cap below is a penny. */
const dear: OfferedService = {
  resource: "fx:rate",
  name: "FX Rate",
  tags: ["fx"],
  path: "/fx",
  price: usdc("1"),
  slaSeconds: 60,
  billing: "escrow",
  provider: honest.address,
  stakeUsdc: "10",
  reputation: { fulfilled: 5, failed: 0, earnedUsdc: "1" },
};

function stubClient() {
  const opened: { provider: string; price: bigint }[] = [];
  return {
    opened,
    escrow,
    escrowAddress: escrow,
    public: { chain: { id: chainId } },
    async ensureApproval() {},
    async bondFor() { return 0n; },
    async usdcBalance() { return 10n ** 12n; },
    async chainTime() { return BigInt(Math.floor(Date.now() / 1000)); },
    async open(provider: `0x${string}`, price: bigint) {
      opened.push({ provider, price });
      return { paymentId: 1n, txHash: "0xopen" as const };
    },
    async getPayment() { return { status: PaymentStatus.Escrowed, responseHash: "0x00" }; },
    async settle() { return "0xsettle" as const; },
    async refund() { return "0xrefund" as const; },
  };
}

async function quotingProvider(price: bigint) {
  const nonce = `0x${"11".repeat(32)}` as const;
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 300);
  const typed = quoteTypedData(chainId, escrow, {
    provider: honest.address, price, resource: dear.resource, nonce, expiry,
  });
  const sig = await honest.signTypedData(typed as never);
  const headers: Record<string, string> = {
    [HEADERS.provider]: honest.address,
    [HEADERS.price]: price.toString(),
    [HEADERS.quote]: `0x${"22".repeat(32)}`,
    [HEADERS.deadline]: "60",
    [HEADERS.resource]: dear.resource,
    [HEADERS.quoteNonce]: nonce,
    [HEADERS.quoteExpiry]: expiry.toString(),
    [HEADERS.quoteSig]: sig,
  };
  const server = http.createServer((_req, res) => {
    res.writeHead(402, headers);
    res.end(JSON.stringify({ error: "payment required" }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function buy(policy: Record<string, unknown>, quotedPrice = dear.price) {
  const client = stubClient();
  const server = await quotingProvider(quotedPrice);
  try {
    const agent = new TesseraAgent({
      client: client as never,
      providersBaseUrl: server.baseUrl,
      policy: policy as never,
    });
    const entry = await (agent as never as {
      purchase: (s: OfferedService, d: unknown, q?: string) => Promise<{ status: string; reason: string }>;
    }).purchase(dear, { buy: true, reason: "invoice: a penny please", trust: 1 });
    return { entry, opened: client.opened };
  } finally {
    server.close();
  }
}

test("nothing escrows above the cap without a guardian, whoever called", async () => {
  // No guardian answers, so the request times out and counts as a refusal.
  const { entry, opened } = await buy({ autoApproveMax: usdc("0.005"), approvalTimeoutMs: 60 });
  assert.equal(opened.length, 0, "a spend above the cap reached the escrow with no guardian");
  assert.equal(entry.status, "skipped");
  assert.match(entry.reason, /guardian/i);
});

test("the cap is measured against what will actually be escrowed", async () => {
  /*
   * The quote may discount below the listed price, and the cap applies to the
   * amount that moves. A pound-listed service quoting a tenth of a penny is
   * inside a penny cap and needs no guardian.
   */
  const { entry, opened } = await buy({ autoApproveMax: usdc("0.005"), approvalTimeoutMs: 60 }, usdc("0.001"));
  assert.equal(opened.length, 1, "a spend inside the cap was escalated anyway");
  assert.equal(opened[0].price, usdc("0.001"));
  assert.notEqual(entry.status, "skipped");
});

test("a guardian that approves lets the spend through", async () => {
  // `autoApprove` is the local-demo stand-in for a human co-signer.
  const { opened } = await buy({ autoApproveMax: usdc("0.005"), autoApprove: true });
  assert.equal(opened.length, 1, "an approved spend must still go through");
  assert.equal(opened[0].price, dear.price);
});

test("with no policy configured there is nothing to enforce", async () => {
  // A policy is optional; its absence must not become an accidental refusal.
  const { opened } = await buy({} as never);
  assert.equal(opened.length, 1);
});
