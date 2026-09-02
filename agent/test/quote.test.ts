import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, toHex } from "viem";
import { quoteTypedData, usdc } from "@tessera/shared";

const provider = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const escrow = "0x0000000000000000000000000000000000000abc" as const;
const chainId = 5042002;
const baseQuote = {
  provider: provider.address,
  price: usdc("0.004"),
  resource: "fx:quote",
  nonce: toHex(new Uint8Array(32).fill(7)),
  expiry: 9999999999n,
};

test("a provider-signed quote verifies against the provider address", async () => {
  const typed = quoteTypedData(chainId, escrow, baseQuote);
  const sig = await provider.signTypedData(typed);
  const ok = await verifyTypedData({ address: provider.address, signature: sig, ...typed });
  assert.equal(ok, true);
});

test("tampering with the price invalidates the signature", async () => {
  const typed = quoteTypedData(chainId, escrow, baseQuote);
  const sig = await provider.signTypedData(typed);
  const tampered = quoteTypedData(chainId, escrow, { ...baseQuote, price: usdc("0.001") });
  const ok = await verifyTypedData({ address: provider.address, signature: sig, ...tampered });
  assert.equal(ok, false);
});

test("a different signer does not pass as the provider", async () => {
  const other = privateKeyToAccount(
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  );
  const typed = quoteTypedData(chainId, escrow, baseQuote);
  const sig = await other.signTypedData(typed);
  const ok = await verifyTypedData({ address: provider.address, signature: sig, ...typed });
  assert.equal(ok, false);
});
