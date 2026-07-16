# Tessera architecture

Tessera turns an ordinary "402 Payment Required" into a **trustless, autonomous
purchase** settled on Arc. This document walks the pieces and the end-to-end flow.

## Components

| Package        | Responsibility |
|----------------|----------------|
| `contracts/`   | `TesseraEscrow` (per-call escrow, SLA deadline, refund, reputation) and `MockUSDC` for local runs. |
| `shared/`      | Arc chain config, USDC helpers, the 402 protocol header definitions, generated ABIs/bytecode. |
| `providers/`   | Express services that speak the Tessera 402 protocol and settle on-chain. One is deliberately flaky. |
| `agent/`       | The autonomous buyer: discovery, a hybrid decision engine, the 402 handshake, verification, settle/refund. |
| `dashboard/`   | A live view of balances, on-chain reputation, the purchase ledger and the agent's activity. |

## The escrow contract

`TesseraEscrow` is intentionally small. One payment moves through:

```
Escrowed ──fulfill──▶ Fulfilled ──settle──▶ Settled     (provider paid, reputation++)
   │                      │
   │ timeout              │ agent rejects
   ▼                      ▼
Refunded  ◀───────────────┘                              (agent repaid, reputation--)
```

- `open(provider, amount, deadline, quoteHash)` — the agent pulls USDC into
  escrow (needs a prior ERC-20 approval) and commits to a provider + deadline.
- `fulfill(paymentId, responseHash)` — only the named provider, only before the
  deadline; records a hash commitment to what it delivered.
- `settle(paymentId)` — only the paying agent; releases funds and bumps the
  provider's `fulfilled` count and `earned`.
- `refund(paymentId)` — the agent rejects a bad `Fulfilled` payment, **or**
  anyone reclaims an `Escrowed` payment after its deadline. Either path bumps the
  provider's `failed` count.

Reputation (`fulfilled`, `failed`, `earned`) is public, so an agent can price the
risk of an unknown provider *before* it spends — see `trustScore()` in the agent.

### Staking & slashing

Providers can bond USDC via `stake()`. On any SLA breach (`refund()`), 20% of the
payment (`SLASH_BPS`) is slashed from the provider's stake and paid to the agent
as compensation on top of the refund. Agents add a trust bonus for staked
providers — a stranger with money at risk is a safer counterparty.

## Nanopayments: TesseraTab

Per-call escrow is wrong for high-frequency micro-calls (a price tick isn't worth
a transaction). `TesseraTab` is a payment-channel-style tab:

```
openTab(provider, deposit, duration)      1 on-chain tx
  ├─ call 1: voucher(cum=0.0002) signed   off-chain, no gas
  ├─ call 2: voucher(cum=0.0004) signed   off-chain, no gas
  ├─ ... N calls ...
closeTab(tabId, bestVoucher)              1 on-chain tx: provider paid,
                                          remainder returned to the agent
reclaim(tabId)                            agent recovers funds after expiry
                                          if the provider never settles
```

Vouchers are EIP-191 signatures over `(tabContract, tabId, cumulativeAmount)` —
monotonic and bound to the contract, so they can't be replayed. The provider
verifies each voucher off-chain in the request path (`recoverMessageAddress`)
and needs only the single best voucher to settle everything.

## The 402 handshake

```
Agent                         Provider                         Arc / TesseraEscrow
  │  GET /weather                 │                                   │
  │ ─────────────────────────────▶                                   │
  │  402 + price/quote/deadline   │                                   │
  │ ◀─────────────────────────────                                   │
  │                                                                   │
  │  decide (rules or Claude), then escrow                            │
  │  open(provider, price, deadline, quoteHash) ─────────────────────▶  Escrowed
  │  ◀── paymentId                                                    │
  │                                                                   │
  │  GET /weather  (x-tessera-payment: paymentId)                     │
  │ ─────────────────────────────▶  verify escrow on-chain           │
  │                                 fulfill(paymentId, hash) ─────────▶  Fulfilled
  │  200 + body                   │                                   │
  │ ◀─────────────────────────────                                   │
  │                                                                   │
  │  verify body hash + quality gate                                  │
  │   ok   → settle(paymentId) ──────────────────────────────────────▶  Settled  (provider paid)
  │   bad  → refund(paymentId) ──────────────────────────────────────▶  Refunded (agent repaid)
```

## The decision engine (hybrid)

`agent/src/decide.ts` exposes two brains behind one guardrail:

- **`decideByRules`** — deterministic: match a service to a need, reject if it's
  over the per-need cap or the remaining budget, and apply a trust floor from
  on-chain reputation. This is *always* the final word.
- **`decideByLlm`** — asks Claude whether an offer advances the goal, but the
  result is clamped by the rules, so the agent can never be talked into
  overspending or buying something irrelevant.

Set `AGENT_BRAIN=llm` (with `ANTHROPIC_API_KEY`) to enable the LLM path; it falls
back to rules on any error.

## The SLA / quality gate

After delivery the agent checks two things before releasing escrow:

1. **Integrity** — `keccak256(body)` equals the on-chain `responseHash` the
   provider committed to.
2. **Quality** — resource-specific checks (e.g. news must actually contain
   headlines). The demo's flaky provider returns empty headlines, fails this
   gate, and the agent reclaims its USDC — enforced by the contract, not trust.

## The guardian (policy sandbox)

`agent/src/policy.ts` implements a wallet-style co-signer, inspired by
multisig vaults in consumer wallets:

- A `SpendingPolicy` sets `autoApproveMax` — the per-call ceiling for full
  autonomy — plus optional provider blocklists.
- A purchase above the cap **pauses the agent** and enqueues an
  `ApprovalRequest`; the dashboard renders Approve/Reject buttons and posts the
  verdict to `/api/approvals/:id/:verdict`. Timeout counts as rejection.
- The policy is enforced *outside* the decision engine: even an LLM-driven
  brain cannot exceed it.

## Personal trust memory

`agent/src/memory.ts` is the agent's address book. Global on-chain reputation
says how a provider treated *everyone*; memory says how it treated *this
agent*. Each personal refund costs 0.15 trust (capped at 0.45) — after three
strikes the provider falls below the buy floor and the agent stops dealing
with it. Persisted to `.tessera-memory.json` across runs.

## Payment requests (the billing inbox)

Providers publish invoices at `GET /invoices`; paying one is just buying the
referenced resource through the normal 402 escrow flow, so every guarantee
(escrow, SLA gate, refund, reputation) applies to inbound billing too. The
agent's verdict logic in `processInvoices()`:

1. **Decline** if its personal memory says the provider burned it before.
2. **Decline** if combined trust (reputation + stake − memory penalty) is
   below the floor, or the amount exceeds the invoice budget.
3. **Escalate to the guardian** if the amount is over the policy cap.
4. Otherwise **pay autonomously**; the provider marks the invoice paid when it
   fulfills the receipt on-chain.

## Running locally vs on Arc

- **Local**: `npm run demo` spins up a Hardhat node, deploys `MockUSDC` +
  `TesseraEscrow`, funds the agent, starts the providers, and opens the
  dashboard. Everything is offline (see the compiler note in the root README).
- **Arc testnet**: deploy with `npm run deploy:arc` (binds the real USDC at
  `0x3600…0000`), run a providers server, then drive the agent with
  `npm run run:arc` using a faucet-funded key.
