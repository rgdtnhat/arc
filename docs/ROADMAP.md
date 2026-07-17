# Roadmap

Tessera against the Arc Hackathon checkpoints.

## ✅ Done (Checkpoint 1 / 2)

- `TesseraEscrow` contract: escrow, SLA deadline, agent reject, timeout refund,
  on-chain reputation — with a passing test suite.
- **Nanopayments**: `TesseraTab` payment-channel tabs — one deposit, off-chain
  signed vouchers per micro-call (zero gas), one settlement claim.
- **Provider staking & slashing**: bonded USDC compensates agents on SLA
  breaches; stake feeds the agent's trust score.
- **Mission briefing**: the agent assembles its purchases into the final
  deliverable, shown on the dashboard.
- **Guardian approvals**: a wallet-vault-style policy sandbox — spends above a
  per-call cap pause the agent for a human Approve/Reject on the dashboard.
- **Contacts & personal trust memory**: the agent's own cross-run experience
  with providers feeds its decisions (three strikes → stop buying).
- **Wallet activity**: balance sparkline + readable event history.
- **Payment requests**: provider-issued invoices; the agent pays trusted
  billers via the escrow rail, declines providers that burned it, and
  escalates over-cap amounts to the guardian.
- **Escrow liveness guard**: `providerClaim` lets a provider collect a
  delivered payment after a dispute window, so an offline/griefing agent can't
  lock funds forever.
- **Reentrancy guards** on all value-moving functions (defense-in-depth).
- **EIP-712 signed quotes**: providers sign each quote; the agent verifies
  authenticity + expiry before escrowing (tamper-proof, non-repudiable).
- **Real-API provider**: a live Open-Meteo-backed service (with offline
  fallback) — Tessera charges USDC for a genuine service, not only mocks.
- **Tests + CI**: 21 contract tests, 20 agent unit tests (decision engine,
  guardian queue, memory, signed quotes), and the full E2E scenario on every push.
- Offline-capable Hardhat toolchain (seeds solc from npm so it builds in
  locked-down environments).
- The Tessera 402 protocol + three provider services (one deliberately flaky).
- Autonomous agent: discovery, hybrid rule/LLM decision engine, the full
  quote → escrow → verify → settle/refund loop.
- Live dashboard and a one-command local demo.
- Arc testnet deploy + agent runner scripts.

## 🎯 Checkpoint 3 (Final MVP on Arc)

- [x] One-command deploy tooling: `npm run bootstrap:arc` (keygen → faucet
      wait → deploy escrow+tab → fund agent/provider → bond stake → persist
      addresses).
- [x] Deployed live to Arc testnet and ran a full scenario producing
      settle / refund / tab-open / tab-settle transactions (see PR + `deployments/arc.json`).
- [x] Circle Paymaster & Developer-Controlled Wallets integration plan wired to
      the code seams (`docs/CIRCLE_INTEGRATION.md`) — activated by credentials.
- [ ] **Redeploy** the current contracts to Arc (they gained `providerClaim` +
      reentrancy guards since the first deploy) and re-pin `deployments/arc.json`.
- [ ] Activate Circle DCW + Paymaster with a developer key on live Arc.
- [ ] 3-minute video: the agent buying, the SLA refund, the on-chain reputation
      (script + deck ready in `docs/`).

## 🔭 Beyond the hackathon

- **Drop-in middleware package.** Extract the 402 provider layer into
  `@tessera/pay` so any Express/Hono service charges agents in a few lines
  (the core already lives in `providers/src/app.ts` — `createProviderApp`).
- **Discovery registry.** An on-chain catalog so agents discover providers
  without a trusted index.
- **Dispute arbitration.** An optional third-party verifier for subjective SLAs
  where a hash + schema check isn't enough.
