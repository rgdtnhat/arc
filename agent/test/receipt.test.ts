import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, keccak256, toHex } from "viem";
import { receiptTypedData, receiptFromPayment, quoteTypedData, usdc } from "@tessera/shared";

const provider = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const payer = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
);
const escrow = "0x0000000000000000000000000000000000000abc" as const;
const chainId = 5042002;

const body = { temperature: 12.5, city: "Lisbon" };
const base = {
  paymentId: 42n,
  provider: provider.address,
  payer: payer.address,
  amount: usdc("0.004"),
  resource: "weather:current",
  responseHash: keccak256(toHex(JSON.stringify(body))),
  issuedAt: 1750000000n,
};

test("a provider-signed receipt verifies against the provider address", async () => {
  const typed = receiptTypedData(chainId, escrow, base);
  const sig = await provider.signTypedData(typed);
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...typed }), true);
});

test("a receipt does not verify against a different body", async () => {
  const typed = receiptTypedData(chainId, escrow, base);
  const sig = await provider.signTypedData(typed);
  // The provider serves one thing and the agent checks the hash of another.
  const swapped = receiptTypedData(chainId, escrow, {
    ...base,
    responseHash: keccak256(toHex(JSON.stringify({ ...body, temperature: 30 }))),
  });
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...swapped }), false);
});

test("a receipt cannot be replayed against a different payment", async () => {
  const typed = receiptTypedData(chainId, escrow, base);
  const sig = await provider.signTypedData(typed);
  const other = receiptTypedData(chainId, escrow, { ...base, paymentId: 43n });
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...other }), false);
});

test("a receipt issued to one payer does not prove delivery to another", async () => {
  const typed = receiptTypedData(chainId, escrow, base);
  const sig = await provider.signTypedData(typed);
  const other = receiptTypedData(chainId, escrow, {
    ...base,
    payer: "0x000000000000000000000000000000000000dEaD",
  });
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...other }), false);
});

test("the amount is bound, so a receipt cannot understate what was charged", async () => {
  const typed = receiptTypedData(chainId, escrow, base);
  const sig = await provider.signTypedData(typed);
  const other = receiptTypedData(chainId, escrow, { ...base, amount: usdc("0.001") });
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...other }), false);
});

test("somebody else's signature does not pass as the provider's receipt", async () => {
  const typed = receiptTypedData(chainId, escrow, base);
  const sig = await payer.signTypedData(typed);
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...typed }), false);
});

test("a receipt does not verify on a different chain or escrow", async () => {
  const typed = receiptTypedData(chainId, escrow, base);
  const sig = await provider.signTypedData(typed);

  const otherChain = receiptTypedData(1, escrow, base);
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...otherChain }), false);

  const otherEscrow = receiptTypedData(chainId, "0x0000000000000000000000000000000000000def", base);
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...otherEscrow }), false);
});

test("a quote signature is not accepted as a receipt", async () => {
  // Both are EIP-712 under the same domain. The struct type is what separates
  // them — without distinct primary types, a signed quote would double as proof
  // of delivery for a request the provider never served.
  const quoteTyped = quoteTypedData(chainId, escrow, {
    provider: provider.address,
    price: base.amount,
    resource: base.resource,
    nonce: toHex(new Uint8Array(32).fill(7)),
    expiry: 9999999999n,
  });
  const quoteSig = await provider.signTypedData(quoteTyped);
  const asReceipt = receiptTypedData(chainId, escrow, base);
  assert.equal(await verifyTypedData({ address: provider.address, signature: quoteSig, ...asReceipt }), false);
});

// --- the single field-selection path -----------------------------------------
//
// The provider signs and the agent verifies. Both now build the payload from an
// escrow payment through `receiptFromPayment`, so "which field comes from
// where" is answered once rather than twice.

const payment = {
  agent: payer.address,
  provider: provider.address,
  amount: usdc("0.004"),
  responseHash: base.responseHash,
} as const;

test("a receipt built from a payment verifies for both sides", async () => {
  const signed = receiptFromPayment(chainId, escrow, 42n, payment, base.resource, base.issuedAt);
  const sig = await provider.signTypedData(signed);
  // The agent rebuilds from its own read of the same payment.
  const rebuilt = receiptFromPayment(chainId, escrow, 42n, { ...payment }, base.resource, base.issuedAt);
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...rebuilt }), true);
});

test("it takes the amount from the escrow, not from the quote", async () => {
  // The escrow requires only `amount >= price`. A buyer who overpays makes the
  // two differ — and a receipt rebuilt from the quoted price silently stops
  // verifying, which is indistinguishable from a provider that never signed one.
  const quoted = usdc("0.004");
  const escrowed = usdc("0.010");
  const overpaid = { ...payment, amount: escrowed };

  const sig = await provider.signTypedData(
    receiptFromPayment(chainId, escrow, 42n, overpaid, base.resource, base.issuedAt)
  );

  const fromEscrow = receiptFromPayment(chainId, escrow, 42n, overpaid, base.resource, base.issuedAt);
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...fromEscrow }), true);

  const fromQuote = receiptFromPayment(
    chainId, escrow, 42n, { ...payment, amount: quoted }, base.resource, base.issuedAt
  );
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...fromQuote }), false);
});

test("the payer is taken from the payment's buyer, not assumed", async () => {
  const sig = await provider.signTypedData(
    receiptFromPayment(chainId, escrow, 42n, payment, base.resource, base.issuedAt)
  );
  const wrongBuyer = receiptFromPayment(
    chainId, escrow, 42n,
    { ...payment, agent: "0x000000000000000000000000000000000000dead" },
    base.resource, base.issuedAt
  );
  assert.equal(await verifyTypedData({ address: provider.address, signature: sig, ...wrongBuyer }), false);
});

test("receiptFromPayment and receiptTypedData agree on the same facts", async () => {
  // If these ever diverge, one call site is signing something different from
  // what another verifies.
  const viaPayment = receiptFromPayment(chainId, escrow, 42n, payment, base.resource, base.issuedAt);
  const viaFields = receiptTypedData(chainId, escrow, {
    paymentId: 42n,
    provider: payment.provider,
    payer: payment.agent,
    amount: payment.amount,
    resource: base.resource,
    responseHash: payment.responseHash,
    issuedAt: base.issuedAt,
  });
  assert.deepEqual(viaPayment, viaFields);
});
