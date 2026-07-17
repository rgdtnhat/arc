# Tessera — pitch kit

Everything for the Checkpoint 3 submission: a 3-minute video shot-list timed to
the real on-chain transactions, and a slide-by-slide deck outline.

Live artifacts to have open while recording:
- Dashboard: `npm run demo` → http://127.0.0.1:8787
- Escrow on Arcscan: https://testnet.arcscan.app/address/0x159b15b0f052d2db65e6798c84f6bbaa00de03b0
- Tab on Arcscan: https://testnet.arcscan.app/address/0x88b238909525b8b0efadf249988422ffd1521243
- Settle tx: https://testnet.arcscan.app/tx/0x5088d17acba3ff537d199a543fcca7620d175d66f992133eef50cf8e0aca4f86
- Refund tx: https://testnet.arcscan.app/tx/0x6c050fb0c3f0d2c5b199da58adfca24866d116bad7263f951f91ebfe1b8d58e0
- Tab settle tx: https://testnet.arcscan.app/tx/0x1f519084cb88b0374edbcf4a9e0b1b1e747fa45884e781ec5d53bce4562c4359

---

## 3-minute video shot-list (~450 words spoken)

Target: 2:55. Record the dashboard run once, clean, then narrate over it. Keep
cuts tight; the on-chain tx reveals are the payoff — don't rush them.

### [0:00–0:20] Cold open — the problem (talking head or title card)
> "AI agents are starting to spend money on their own — buying data, APIs,
> compute. But today an agent can only pay services a human pre-approved and
> pre-funded, because nobody trusts a stranger. The service doesn't know the
> agent will pay. The agent doesn't know the service will deliver. Tessera fixes
> both sides."

**On screen:** title "Tessera — trustless pay-per-use commerce for AI agents on Arc."

### [0:20–0:40] The idea in one breath (architecture diagram)
> "An agent hits a paid endpoint, gets an HTTP 402 with a USDC price, decides for
> itself if it's worth it, and escrows the payment on Arc. If the service
> delivers, the escrow releases. If it breaks its SLA, the agent's money comes
> back — automatically. It's programmable escrow, an SLA refund, and on-chain
> reputation, settled in USDC."

**On screen:** the README architecture diagram; underline "USDC is the gas token."

### [0:40–1:50] Live demo — the dashboard run (screen capture)
Narrate over the real run. Beats:
- **(0:40)** "Here's an autonomous agent with a task and a budget. No human in the
  loop." — show task bar + budget.
- **(0:55)** "It discovers services, each with on-chain reputation and staked
  collateral, and buys weather and FX — verified, settled." — ledger rows turn
  green; wallet balance ticks down; sparkline moves.
- **(1:10)** "The news provider returns junk. The agent's quality gate catches
  it, reclaims its USDC, and slashes the provider's stake as compensation. Watch
  the reputation flip to a failure." — REFUNDED badge; WireScoop 0✓/1✗; stake
  drops.
- **(1:25)** "A premium analysis costs more than the agent's policy allows — so it
  pauses and asks a human guardian to co-sign. I approve." — click Approve;
  settles. "Autonomy inside a sandbox, not a blank check."
- **(1:38)** "For a live price stream it opens a nanopayment tab — one deposit,
  then six micro-payments signed off-chain for zero gas, settled in a single
  transaction." — tab session card; 6 ticks; one settle.
- **(1:48)** "And when a provider it doesn't trust sends an invoice, it declines —
  because it remembers being burned." — billing inbox: paid vs declined.

### [1:50–2:30] It's real — on Arc (Arcscan)
> "None of that is a mockup. Here it is on Arc testnet."
- Cut to the **settle** tx on Arcscan — "USDC released to the provider."
- Cut to the **refund** tx — "the SLA reclaim."
- Cut to the **tab settle** tx — "six calls, one settlement."
> "USDC is Arc's gas token, so the agent funds one asset for both the toll and
> the fees, and settlement is sub-second — fast enough to sit inside a request."

### [2:30–2:55] Close
> "Tessera is the trust layer for the agent economy: escrow, SLA refunds, staking,
> and reputation that let agents safely pay services they've never met. Contracts
> are live on Arc, the repo is public, CI is green. That's how machines start
> doing business with each other."

**On screen:** repo URL + the two contract addresses.

---

## Deck outline (10 slides)

1. **Title** — Tessera; "trustless pay-per-use commerce for AI agents, on Arc."
   One line: the agent economy needs a trust layer. Logo, your name/team.
2. **Problem** — agents can't pay strangers; trust is two-sided; today = pre-approved
   vendors only. One stat/quote on agentic spend if you have one.
3. **Insight** — the missing primitive isn't "send USDC," it's *escrow + SLA +
   reputation*. That's what makes an unknown counterparty safe.
4. **How it works** — the 4-step flow (quote → decide → escrow → settle/refund)
   with the architecture diagram. Call out USDC-as-gas + sub-second finality.
5. **The differentiators** — 4 quadrants: programmable escrow & auto-refund ·
   provider staking/slashing · nanopayment tabs (off-chain vouchers) · guardian
   approvals + trust memory.
6. **Live demo** — the dashboard screenshot; annotate settled / refunded / tab /
   guardian / billing inbox. "One autonomous run."
7. **On-chain proof** — the 4 Arcscan transactions (settle, refund, tab open, tab
   settle) + contract addresses. Reputation 10✓/1✗. "Deployed and transacting."
8. **Why Arc / Circle** — USDC gas token, sub-second settlement, Circle Wallets;
   Paymaster + Developer-Controlled Wallets on the roadmap.
9. **Traction & quality** — 34 tests, CI on every push, one-command live deploy
   (`bootstrap:arc`), offline-capable toolchain. Execution > complexity.
10. **Vision / ask** — from a demo to the settlement rail for agent-to-agent
    commerce: real providers, discovery registry, reputation staking. Repo link.

---

## Judging-criteria crosswalk (keep this in your back pocket)

- **Arc & Circle integration** — deployed on Arc testnet (chainId 5042002),
  native USDC as gas + settlement, live txs; Circle Wallets used, Paymaster next.
- **Use case & impact** — a real, unsolved problem (agent-to-stranger payments)
  with a credible path to production.
- **Execution & quality** — 34 tests, CI, one-command deploy, live on-chain proof,
  resilient to public-RPC limits. Quality over complexity.
- **Presentation** — this kit: a tight demo narrative anchored to real transactions.
