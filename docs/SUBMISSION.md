# Tessera — submission one-pager

**Tessera — trustless pay-per-use commerce for AI agents, settled on Arc in USDC.**
Track: Agentic Economy.

## One-line
An AI agent pays any service per-call in USDC through an HTTP-402 handshake and an
on-chain escrow that auto-refunds on SLA breach and tracks provider reputation —
autonomous spending with no human in the loop.

## The problem (2 sentences)
AI agents are starting to consume paid services on their own, but there is no way
for an agent to pay a stranger's service per-call without a human first setting up
an account and a card — and trust runs both ways: the service can't tell the agent
will pay, and the agent can't tell the service will deliver. Solve only one side
and agents are stuck with a hand-curated list of pre-funded vendors; that is not an
economy.

## What we built
Tessera turns a `402 Payment Required` into a trustless purchase:
1. **Quote** — the agent hits a paid endpoint and gets a signed USDC price + SLA.
2. **Decide** — a hybrid rules/LLM engine judges *is it worth it?* from budget, the
   provider's on-chain reputation, its bonded stake, and the agent's own memory.
3. **Escrow** — the agent locks a nano-sized USDC payment in `TesseraEscrow` on Arc.
4. **Settle or refund** — good delivery releases the escrow and lifts reputation; a
   bad or missing one lets the agent reclaim its USDC **plus compensation slashed
   from the provider's stake**, and lowers reputation.

Beyond the core: **nanopayment tabs** (one deposit, many zero-gas off-chain
vouchers, one settlement), **guardian approvals** (spends over a policy cap pause
for a human co-signer), **personal trust memory** (a provider that burned this
agent is declined next time), and a **billing inbox** for provider-issued invoices.

## Why it's different
Most "agent payment" demos stop at *"agent sends USDC."* Tessera's core is
**programmable escrow + SLA-based auto-refund + on-chain reputation with staked
skin-in-the-game** — exactly what makes it safe for an agent to transact with a
service it has never met. That is the unlock for agent-to-agent commerce.

## Why Arc / Circle
USDC is Arc's gas token, so the agent funds a single asset for both the toll and
the fees — no native-gas bootstrapping for a bot. Sub-second finality lets a
per-call payment settle inside a request/response cycle. Built on USDC + Circle
Wallets today; Paymaster (gasless first call) and Developer-Controlled Wallets are
the next integrations.

## Proof it works (live on Arc testnet, chainId 5042002)
- TesseraEscrow: `0x9776498c2a0661a2d3bbb10c5094d16f835a9a7d`
- TesseraTab: `0x5d482c70ac56cdc44414a93446709fee17d78c6d`
- Live transactions — settle `0xbbf5c98b…`, refund `0xf8a57c18…`, tab settle
  `0x15c13f79…` (all on testnet.arcscan.app), each status=success.
- 64 automated tests (21 contract + 43 agent) and CI on every push; one-command
  live deploy via `npm run bootstrap:arc`.

## Links
- Repo: https://github.com/rgdtnhat/arc
- Escrow: https://testnet.arcscan.app/address/0x9776498c2a0661a2d3bbb10c5094d16f835a9a7d
- Tab: https://testnet.arcscan.app/address/0x5d482c70ac56cdc44414a93446709fee17d78c6d

---

### Shorter blurbs (for tight fields)

**280 chars:**
Tessera lets AI agents pay any service per-call in USDC on Arc via HTTP-402 + an
on-chain escrow that auto-refunds on SLA breach and tracks provider reputation.
Nanopayments, staking, and a human "guardian" cap. Live on Arc testnet with
real settle/refund txs.

**~60 words:**
Tessera is the trust layer for agent-to-agent commerce. An AI agent pays any
service per-call in USDC through a 402 handshake and an on-chain escrow on Arc
that releases on delivery, auto-refunds on SLA breach, slashes a provider's
stake, and tracks reputation — so agents can safely buy from services they've
never met. Live on Arc testnet with verifiable transactions.
