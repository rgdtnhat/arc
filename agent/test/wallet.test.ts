import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { buildAccount } from "../src/wallet.ts";
import { createDcwAccount } from "../src/circle/dcw.ts";
import { describeGasMode, shouldSponsor, type PaymasterConfig } from "../src/circle/paymaster.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const ADDR = privateKeyToAccount(KEY).address;

test("key mode returns a raw-key account with the expected address", () => {
  const acct = buildAccount({ mode: "key", privateKey: KEY });
  assert.equal(acct.address.toLowerCase(), ADDR.toLowerCase());
});

test("key mode without a key fails clearly", () => {
  assert.throws(() => buildAccount({ mode: "key" }), /no private key/);
});

test("circle mode without config fails with an actionable message", () => {
  assert.throws(() => buildAccount({ mode: "circle", dcw: null, role: "AGENT" }), /WALLET_MODE=circle needs/);
});

test("DCW account signs via Circle's API and returns the signature", async () => {
  let seenUrl = "";
  let seenBody: any = null;
  const fakeSig = "0x" + "11".repeat(65);
  const fetchImpl = (async (url: string, init: any) => {
    seenUrl = String(url);
    seenBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ data: { signature: fakeSig } }) };
  }) as unknown as typeof fetch;

  const acct = createDcwAccount({
    apiKey: "test-key",
    entitySecret: "cipher",
    walletId: "wallet-123",
    address: ADDR,
    baseUrl: "https://api.circle.test",
    fetchImpl,
  });

  const sig = await acct.signMessage!({ message: "hello" });
  assert.equal(sig, fakeSig);
  assert.equal(seenUrl, "https://api.circle.test/v1/w3s/developer/sign/message");
  assert.equal(seenBody.walletId, "wallet-123");
  assert.equal(seenBody.entitySecretCiphertext, "cipher");
  assert.match(seenBody.digest, /^0x[0-9a-f]+$/);
});

test("DCW account surfaces a clear error on a non-OK response", async () => {
  const fetchImpl = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
  const acct = createDcwAccount({
    apiKey: "k",
    entitySecret: "c",
    walletId: "w",
    address: ADDR,
    fetchImpl,
  });
  await assert.rejects(() => acct.signMessage!({ message: "x" }), /HTTP 403/);
});

test("buildAccount circle mode wires an explicit DCW config", async () => {
  const fakeSig = "0x" + "22".repeat(65);
  const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ signature: fakeSig }) })) as unknown as typeof fetch;
  const acct = buildAccount({
    mode: "circle",
    dcw: { apiKey: "k", entitySecret: "c", walletId: "w", address: ADDR, fetchImpl },
  });
  assert.equal(acct.address.toLowerCase(), ADDR.toLowerCase());
  const sig = await acct.signMessage!({ message: "hi" });
  assert.equal(sig, fakeSig);
});

test("gas mode describes native vs paymaster-sponsored", () => {
  assert.match(describeGasMode(null), /USDC-gas/);
  const pm: PaymasterConfig = { paymasterUrl: "https://paymaster.circle.test/rpc", sponsorFirstN: 2 };
  assert.match(describeGasMode(pm), /Paymaster-sponsored first 2/);
  assert.match(describeGasMode(pm), /paymaster\.circle\.test/);
});

test("shouldSponsor gates the first N operations", () => {
  const pm: PaymasterConfig = { paymasterUrl: "x", sponsorFirstN: 1 };
  assert.equal(shouldSponsor(pm, 0), true);
  assert.equal(shouldSponsor(pm, 1), false);
  assert.equal(shouldSponsor(null, 0), false);
});
