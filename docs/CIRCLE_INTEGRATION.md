# Circle integration — Agent Stack, Wallets (DCW) & Paymaster

Tessera runs on Arc with **USDC as gas + settlement**. On top of that it wires
three Circle building blocks as **real code seams** (not just prose), each
defaulting to the working path today and activated by a Circle developer key:

| Circle product | Where it lives | Status |
|---|---|---|
| **Agent Stack** (agent → wallet, USDC, on-chain actions) | `agent/src/agentkit.ts` | **Live** — used in the demo, `/api/actions`, and unit-tested |
| **Wallets / Developer-Controlled Wallets** | `agent/src/wallet.ts`, `agent/src/circle/dcw.ts` | Wired seam — `WALLET_MODE=circle` |
| **Paymaster** (gasless first call) | `agent/src/circle/paymaster.ts` | Wired seam — `CIRCLE_PAYMASTER_URL` |

## 1. Agent Stack — the agent's action surface

Circle's Agent Stack is about giving an autonomous agent a set of **typed
actions/tools** that connect it to a wallet, USDC payments, and on-chain
operations. Tessera exposes exactly that: `createTesseraActions(client)` returns
a registry bound to the agent's `TesseraClient`.

```ts
const kit = agent.actionKit();
kit.manifest();                 // enumerable tools (MCP / tool-use shape)
await kit.invoke("usdc_balance");
await kit.invoke("escrow_payment", { provider, amount, deadline, quoteHash });
```

Actions (each with a JSON-schema input and a `read | payment | onchain` kind):

| Action | Kind | Reaches |
|---|---|---|
| `usdc_balance` | read | the agent's **wallet** |
| `discover_services`, `get_reputation`, `get_stake` | read | marketplace + on-chain state |
| `escrow_payment`, `settle_payment`, `refund_payment` | payment | **USDC payments** on Arc |
| `open_tab`, `sign_voucher`, `reclaim_tab` | payment / onchain | **nanopayments** |

A model brain can enumerate the manifest and drive the agent as tool-use; the
deterministic brain calls the same client underneath. See it live:

- `AGENT_STACK=1 npm run run:arc` prints the manifest and runs a live
  `usdc_balance()` through the kit.
- The dashboard serves the manifest at `GET /api/actions` and lists it in
  `/api/state` (`meta.agentStack`).

## 2. Developer-Controlled Wallets (replace raw keys)

Today the agent signs with a private key from `.env`. Circle **DCW** holds the
key in Circle's infrastructure and signs over an API. The seam is a single
construction point:

```ts
// agent/src/wallet.ts
const account = buildAccount({ mode: "key" | "circle", privateKey, role: "AGENT" });
```

`mode:"circle"` builds a viem `Account` via `createDcwAccount(...)` whose
`signMessage` / `signTypedData` / `signTransaction` call Circle's
`w3s/developer/sign/*` endpoints (`agent/src/circle/dcw.ts`). Nothing downstream
changes — escrow, tab vouchers, and EIP-712 quotes verify by **address**, not by
how the signature was produced. `run-arc.ts` reads `WALLET_MODE` and switches
custody with no other edits.

Env: `WALLET_MODE=circle`, `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`,
`AGENT_WALLET_ID`, `AGENT_ADDRESS` (and `CIRCLE_API_BASE_URL` to override the
host). The adapter's request shaping is unit-tested with an injected `fetch`
(`agent/test/wallet.test.ts`), so it's exercised without a live key.

## 3. Paymaster (gasless first call)

On Arc, USDC is the gas token — but a brand-new agent with a zero balance can't
send its very first transaction. Circle **Paymaster** sponsors that first
operation so an agent can bootstrap from nothing.

`agent/src/circle/paymaster.ts` is the configuration seam the runtime consults:
`paymasterFromEnv()` detects whether a Paymaster is wired, `describeGasMode()`
reports the active gas mode (shown at startup and in the dashboard), and
`shouldSponsor(pm, opIndex)` gates the first N operations. Full sponsorship
routes the first `approve` + `open` through an ERC-4337 UserOperation with
Circle's Paymaster as sponsor (requires a smart-account wallet + bundler
endpoint); without it the agent pays gas in USDC as today.

Env: `CIRCLE_PAYMASTER_URL`, `CIRCLE_API_KEY`, `CIRCLE_PAYMASTER_SPONSOR_N`.

## Why this is low-risk

Tessera was built with these seams in mind:

- **Signing is abstracted** behind a viem `Account`, so DCW is an adapter.
- **The protocol is signer-agnostic** — escrow, vouchers, and EIP-712 quotes
  verify signatures by address, not by how they were produced.
- **The first-call bootstrap** is isolated to `ensureApproval` + `open`, so
  Paymaster sponsorship is a localized change.
- **The action surface wraps one client**, so Agent Stack tools and the
  deterministic flow never diverge.

No contract changes, no protocol changes — only wallet/account construction and
the action layer differ, and all three default to the working path.
