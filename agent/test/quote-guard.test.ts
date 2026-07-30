import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { HEADERS, quoteTypedData, usdc, PaymentStatus } from "@tessera/shared";
import { quoteMatchesOffer, type OfferedService } from "../src/decide.js";
import { TesseraAgent } from "../src/agent.js";

/**
 * The quote is what gets escrowed, but the guardian cap, the blocklist, and the
 * trust score were all evaluated against the catalog entry. These tests pin the
 * gap between the two: a provider must not be able to move more of the agent's
 * money than the offer it was vetted on, or redirect the payment elsewhere.
 */

const honest = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const attacker = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
);
const escrow = "0x0000000000000000000000000000000000000abc" as const;
const chainId = 5042002;

const offer: OfferedService = {
  resource: "fx:rate",
  name: "FX Rate",
  tags: ["fx"],
  path: "/fx",
  price: usdc("0.001"),
  slaSeconds: 60,
  billing: "escrow",
  provider: honest.address,
  stakeUsdc: "10",
  reputation: { fulfilled: 5, failed: 0, earnedUsdc: "1" },
};

test("a quote matching the vetted offer is accepted", () => {
  const v = quoteMatchesOffer({ provider: honest.address, price: usdc("0.001") }, offer);
  assert.equal(v.ok, true);
});

test("a cheaper quote is accepted — providers may discount", () => {
  const v = quoteMatchesOffer({ provider: honest.address, price: usdc("0.0005") }, offer);
  assert.equal(v.ok, true);
});

test("a quote above the vetted price is refused", () => {
  const v = quoteMatchesOffer({ provider: honest.address, price: usdc("999") }, offer);
  assert.equal(v.ok, false);
  assert.match(v.reason, /exceeds the vetted/);
});

test("a quote naming a different payee is refused", () => {
  const v = quoteMatchesOffer({ provider: attacker.address, price: usdc("0.001") }, offer);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not the vetted provider/);
});

test("payee comparison ignores address casing", () => {
  const v = quoteMatchesOffer(
    { provider: honest.address.toUpperCase().replace("0X", "0x") as `0x${string}`, price: offer.price },
    offer
  );
  assert.equal(v.ok, true);
});

/** Minimal stand-in for TesseraClient that records whether funds ever moved. */
function stubClient() {
  const opened: { provider: string; price: bigint }[] = [];
  return {
    opened,
    escrow,
    escrowAddress: escrow,
    public: { chain: { id: chainId } },
    async ensureApproval() {},
    async chainTime() {
      return BigInt(Math.floor(Date.now() / 1000));
    },
    async open(provider: `0x${string}`, price: bigint) {
      opened.push({ provider, price });
      return { paymentId: 1n, txHash: "0xopen" as const };
    },
    async getPayment() {
      return { status: PaymentStatus.Escrowed, responseHash: "0x00" };
    },
    async settle() {
      return "0xsettle" as const;
    },
    async refund() {
      return "0xrefund" as const;
    },
  };
}

/** A provider that answers 402 with whatever headers the test dictates. */
async function hostileProvider(headers: Record<string, string>) {
  const server = http.createServer((_req, res) => {
    res.writeHead(402, headers);
    res.end(JSON.stringify({ error: "payment required" }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function signedHeaders(
  signer: typeof honest,
  price: bigint,
  payee: `0x${string}`
): Promise<Record<string, string>> {
  const nonce = `0x${"11".repeat(32)}` as const;
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 300);
  const typed = quoteTypedData(chainId, escrow, {
    provider: payee,
    price,
    resource: offer.resource,
    nonce,
    expiry,
  });
  const sig = await signer.signTypedData(typed as never);
  return {
    [HEADERS.provider]: payee,
    [HEADERS.price]: price.toString(),
    [HEADERS.quote]: `0x${"22".repeat(32)}`,
    [HEADERS.deadline]: "60",
    [HEADERS.resource]: offer.resource,
    [HEADERS.quoteNonce]: nonce,
    [HEADERS.quoteExpiry]: expiry.toString(),
    [HEADERS.quoteSig]: sig,
  };
}

async function attempt(headers: Record<string, string>) {
  const client = stubClient();
  const server = await hostileProvider(headers);
  try {
    const agent = new TesseraAgent({
      client: client as never,
      providersBaseUrl: server.baseUrl,
      policy: { autoApproveMax: usdc("0.005") },
    });
    const entry = await (agent as never as {
      purchase: (s: OfferedService, d: unknown, q?: string) => Promise<{ reason: string }>;
    }).purchase(offer, { buy: true, reason: "test", trust: 1 });
    return { entry, opened: client.opened };
  } finally {
    server.close();
  }
}

test("a provider inflating its own signed quote cannot escrow above the vetted price", async () => {
  // Signed correctly by the real provider — authenticity is not the defense here.
  const { entry, opened } = await attempt(await signedHeaders(honest, usdc("999"), honest.address));
  assert.equal(opened.length, 0, "no escrow may be opened for an inflated quote");
  assert.match(entry.reason, /exceeds the vetted/);
});

test("an unsigned quote is refused rather than silently trusted", async () => {
  // Omitting the signature headers previously skipped verification entirely.
  const { entry, opened } = await attempt({
    [HEADERS.provider]: attacker.address,
    [HEADERS.price]: usdc("999").toString(),
    [HEADERS.quote]: `0x${"22".repeat(32)}`,
    [HEADERS.deadline]: "60",
    [HEADERS.resource]: offer.resource,
  });
  assert.equal(opened.length, 0, "an unsigned quote must never reach the escrow");
  assert.match(entry.reason, /did not return a 402 quote|unsigned/);
});

test("a quote redirecting payment to another address cannot escrow", async () => {
  const { entry, opened } = await attempt(
    await signedHeaders(attacker, offer.price, attacker.address)
  );
  assert.equal(opened.length, 0, "no escrow may be opened for an unvetted payee");
  assert.match(entry.reason, /not the vetted provider/);
});

test("an honest quote still goes through", async () => {
  const { opened } = await attempt(await signedHeaders(honest, offer.price, honest.address));
  assert.equal(opened.length, 1, "the legitimate path must still escrow");
  assert.equal(opened[0].price, offer.price);
});
