# Circle integration — Paymaster & Developer-Controlled Wallets

Tessera runs on Arc with **USDC as gas + settlement** and Circle Wallets today.
Two further Circle products slot into the existing seams with no protocol change;
this document is the concrete integration plan (endpoints, code seams, env), so
the work is a wiring exercise, not a redesign.

> Status: **integration-ready.** Both need a Circle developer key and live Arc
> access to exercise, so they are wired at the seams below and activated by
> credentials rather than left as a rewrite.

## 1. Developer-Controlled Wallets (replace raw keys)

Today the agent and providers sign with private keys from `.env`
(`AGENT_PRIVATE_KEY`, `PROVIDER_PRIVATE_KEY`). Circle **Developer-Controlled
Wallets** (DCW) hold the keys in Circle's infrastructure and expose a signing
API — more production-credible, and the path to per-user agent wallets.

**The seam already exists.** `TesseraClient` takes a viem `Account`:

```ts
// agent/src/client.ts
new TesseraClient({ chain, rpcUrl, account, escrowAddress, usdcAddress, tabAddress })
```

So DCW integration is: produce a viem-compatible `Account` whose `signMessage` /
`signTypedData` / `signTransaction` call Circle instead of a local key. viem's
`toAccount({ address, signMessage, signTypedData, signTransaction })` is exactly
this adapter — nothing downstream (escrow, tab vouchers, signed quotes) changes.

Flow:
1. `POST /v1/w3s/developerWalletSets` → create a wallet set (once).
2. `POST /v1/w3s/developer/wallets` with `blockchains: ["ARC-SEPOLIA"]` → create
   the agent and provider wallets; store the returned wallet ids.
3. Sign via `POST /v1/w3s/developer/sign/{message|typedData|transaction}` using
   the wallet id + entity-secret ciphertext.
4. Wrap those calls in `toAccount(...)` and pass the result as `account`.

Env: `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_SET_ID`,
`AGENT_WALLET_ID`, `PROVIDER_WALLET_ID`. Add a `WALLET_MODE=key|circle` switch in
`agent/src/run-arc.ts` and `providers/src/server.ts` that builds either a
`privateKeyToAccount` (today) or a Circle-backed `toAccount` (new). No other
file changes.

## 2. Paymaster (gasless first call)

On Arc, USDC is the gas token — elegant, but a **brand-new agent with a zero
balance can't send its very first transaction** (it has no USDC for gas). Circle
**Paymaster** sponsors that first transaction, so an agent can bootstrap from
nothing and start earning.

Where it plugs in: the agent's first on-chain write is `open()` (or the USDC
`approve` before it) in `TesseraClient`. With an ERC-4337 smart-account agent
wallet, those writes become UserOperations whose `paymasterAndData` points at
Circle's Paymaster; the bundler submits them gas-sponsored.

Integration points:
- Give the agent a smart-account wallet (Circle Modular Wallets / DCW smart
  account) instead of an EOA.
- Route `ensureApproval` + `open` through the account's UserOperation path with
  Circle's Paymaster as sponsor for the first N operations.
- Everything else (escrow lifecycle, reputation, tabs) is unchanged — it only
  cares that the calls land on-chain.

Env: `CIRCLE_PAYMASTER_URL` (bundler/paymaster endpoint), `CIRCLE_API_KEY`.

## Why this is low-risk

Tessera was built with these seams in mind:
- **Signing is abstracted** behind a viem `Account`, so DCW is an adapter.
- **The protocol is signer-agnostic** — escrow, vouchers, and EIP-712 quotes
  verify signatures by address, not by how they were produced.
- **The first-call bootstrap** is isolated to `ensureApproval` + `open`, so
  Paymaster sponsorship is a localized change.

The result: no contract changes, no protocol changes — only the wallet/account
construction differs.
