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
- Offline-capable Hardhat toolchain (seeds solc from npm so it builds in
  locked-down environments).
- The Tessera 402 protocol + three provider services (one deliberately flaky).
- Autonomous agent: discovery, hybrid rule/LLM decision engine, the full
  quote → escrow → verify → settle/refund loop.
- Live dashboard and a one-command local demo.
- Arc testnet deploy + agent runner scripts.

## 🎯 Checkpoint 3 (Final MVP on Arc)

- [ ] Deploy `TesseraEscrow` to Arc testnet and pin the address in the demo.
- [ ] Fund an agent wallet from `faucet.circle.com` and run the scenario against
      Arc, with Arcscan links in the dashboard.
- [ ] Swap the demo's local keys for **Circle Developer-Controlled Wallets** so
      the agent and providers use managed wallets.
- [ ] Add **Paymaster** so the agent's very first call is gasless (removes the
      USDC-bootstrap step for a brand-new agent).
- [ ] 3-minute video: the agent buying, the SLA refund, the on-chain reputation.

## 🔭 Beyond the hackathon

- **Real providers.** Wrap an actual data/API vendor behind the 402 middleware;
  ship the middleware as a drop-in package so any HTTP service can charge agents.
- **Discovery registry.** An on-chain catalog so agents discover providers
  without a trusted index.
- **Dispute arbitration.** An optional third-party verifier for subjective SLAs
  where a hash + schema check isn't enough.
