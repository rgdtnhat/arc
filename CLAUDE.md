# CLAUDE.md

Guidance for working in this repository.

## What this is

**Tessera** — trustless pay-per-use commerce for AI agents, settled on Arc in USDC.
An HTTP-402 handshake backed by on-chain escrow: quote → autonomous decide → escrow →
deliver → verify → settle or auto-refund, with provider staking, on-chain reputation,
and off-chain signed vouchers for nanopayment streams.

**This is unaudited testnet software.** No mainnet, no real funds, no production
custody claims — see [docs/SECURITY.md](docs/SECURITY.md). Anything that would only be
safe "because we'd never do that" must be enforced in code instead.

## Layout

- `contracts/contracts/` — Solidity. `TesseraEscrow` (payment + SLA refund + stake/slash),
  `TesseraTab` (voucher streams), `TesseraVault`/`TesseraSwap`/`TesseraAMM`/`TesseraPool` (DeFi),
  `TesseraFeeCollector`.
- `agent/src/` — the buying agent. `agent.ts` the buy/settle loop · `decide.ts` the decision
  engine · `policy.ts` the guardian sandbox · `wallet.ts` key handling · `client.ts` chain writes ·
  `memory.ts` personal trust · `txlog.ts` activity log · `dashboard.ts` API + UI · `auth.ts` gates.
- `providers/src/` — the paid-service side: catalog, 402 quotes, delivery.
- `shared/src/` — protocol types, ABIs, chain config shared by every workspace.
- `dashboard/` — operator UI. `scripts/` — bootstrap/deploy. `docs/` — architecture, security, deploy.

## The money invariants (non-negotiable)

This is a system that moves a user's funds autonomously. These are the rules that make
that defensible; none of them may be relaxed for convenience, a demo, or a deadline.

1. **Every spend passes the policy gate, and the gate lives at the choke point.**
   The guardian cap must be enforced inside the one function that escrows funds
   (`Agent.purchase`), not repeated in each caller. A cap that callers must remember to
   check is not a cap — the next call site silently bypasses it.

2. **Escrow only what was vetted.** The catalog price and provider address are what the
   cap, the blocklist, and the trust score were evaluated against. Before `open()`, the
   quote's `price` and `provider` must be validated against that vetted entry; a quote
   that raises the price or redirects the payee is refused, not paid.

3. **Provider input is data, never authority.** Everything in a 402 response — price,
   provider address, deadline, body — is attacker-controlled. A quote signature proves
   only that whoever holds *that* key signed it; it does not prove the signer is the
   provider you chose. Never let an unsigned quote take the signed path by default.

4. **Never widen the guardian's scope.** `autoApprove` turns the human co-signer into a
   rubber stamp; it is a local-demo affordance and must stay off by default, never reachable
   in a deployed configuration. The agent never gains standing authority to move any amount,
   anywhere, silently.

5. **Log what was actually spent.** Every ledger entry, event, and dashboard figure reports
   the amount that moved on-chain, not the amount that was expected. An operator who cannot
   see an overspend cannot stop one.

6. **The agent's key is the crown jewel.** `AGENT_PRIVATE_KEY` signs with the operator's
   funds. Every endpoint that spends it stays behind `requireOperator` (admin session), never
   merely `requireAuth` (any connected wallet). Read endpoints may be public; spending ones
   never are.

7. **Refunds are not a safety net for overspending.** Escrow protects against non-delivery.
   A provider that overcharges *and* delivers gets settled and paid. Price control is the
   only defense against that, and it happens before `open()`.

## Conventions

- **TypeScript across workspaces** (`shared`, `contracts`, `providers`, `agent`, `dashboard`),
  shared types in `@tessera/shared` — the protocol shape is defined once and imported, never
  redeclared.
- **Determinism in tests**: no live network or real funds in the suite; mock contracts
  (`MockUSDC`, `MockAggregator`) back the deterministic paths.
- **Contracts guard themselves**: `nonReentrant` on every entry point, state written before
  external transfers, admin fees hard-capped in code rather than by convention.

## Common commands

```bash
npm test                 # contracts + agent suites
npm run compile          # solc via the contracts workspace
npm run abi:check        # ABI drift between contracts and shared/src/abi.ts
npm start                # dashboard + agent on the configured Arc RPC
npm run audit            # dependency audit
```

## When adding features

1. If the change can move USDC, state which of the money invariants above applies and how
   the code enforces it — before writing the code.
2. Test the composition, not just the primitive. A passing signature-verification unit test
   says nothing about whether the agent refuses a bad quote; assert on the agent's behavior.
3. Any new spend path routes through the same choke point as the existing ones. If that is
   awkward, fix the choke point — do not add a second door.
4. Update `docs/SECURITY.md` when you change an auth gate, a custody path, or a limit.
