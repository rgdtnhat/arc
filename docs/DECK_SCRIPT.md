# Tessera — deck speaker notes (exact words)

10 slides, ~15–20s of speech each. Bold = what's on the slide; the quote is what
you say. Total ≈ 3 minutes if you also demo; ≈ 2:30 for slides alone.

---

## Slide 1 — Title
**Tessera. Trustless pay-per-use commerce for AI agents, on Arc. [logo · your name/team]**

> "This is Tessera. It's the trust layer that lets AI agents pay for services on
> their own — settled in USDC on Arc. Let me show you why that's hard, and how we
> solved it."

---

## Slide 2 — The problem
**Agents can't pay strangers. Trust is two-sided. Today = pre-approved vendors only.**

> "AI agents are starting to buy things — data, APIs, compute. But right now an
> agent can only pay a service that a human already set up an account and a card
> for. And trust runs both ways: the service doesn't know the agent will pay, and
> the agent doesn't know the service will actually deliver. So agents are boxed
> into a hand-picked list of pre-funded vendors. That's not an economy."

---

## Slide 3 — The insight
**The missing primitive isn't "send USDC." It's escrow + SLA + reputation.**

> "Most agent-payment demos stop at 'the agent sends USDC.' But a raw transfer
> doesn't make a stranger safe to deal with. The missing primitive is programmable
> escrow, with a service-level guarantee and reputation attached. That's what lets
> an agent buy from someone it has never met."

---

## Slide 4 — How it works
**Quote → Decide → Escrow → Settle / Refund. [architecture diagram] · USDC is the gas token · sub-second finality**

> "Here's the flow. The agent hits a paid endpoint and gets a 402 with a USDC
> price and an SLA. It decides for itself whether it's worth buying. It escrows
> the payment on Arc. If the service delivers, the escrow releases. If it breaks
> the SLA, the agent's money comes back — automatically. And because USDC is Arc's
> gas token, the agent funds one asset for both the payment and the fees."

---

## Slide 5 — The differentiators
**Programmable escrow + auto-refund · Provider staking & slashing · Nanopayment tabs · Guardian approvals + trust memory**

> "Four things make it real. One: escrow with an automatic SLA refund. Two:
> providers stake collateral, and a breach slashes it to compensate the agent —
> skin in the game. Three: nanopayment tabs, so a price stream is one deposit and
> hundreds of zero-gas signed vouchers, settled once. Four: a wallet-style safety
> layer — a spending policy that escalates big buys to a human, and a memory that
> refuses providers who burned it before."

---

## Slide 6 — Live demo
**[dashboard screenshot] settled · refunded · guardian · tab · billing inbox — one autonomous run**

> "This is one autonomous run. The agent buys weather and FX and settles them. The
> news provider returns junk — so the agent reclaims its USDC and slashes that
> provider's stake. A premium call is over its policy limit, so it pauses and asks
> me to approve. It streams a live ticker over a nanopayment tab. And it declines
> an invoice from the provider that already failed it. No human drove any of that
> except the one approval."

---

## Slide 7 — On-chain proof
**Live on Arc testnet. [4 Arcscan tx thumbnails] Escrow 0x159b… · Tab 0x88b2… · reputation 10✓/1✗**

> "And none of it is faked. Here it is on Arc testnet: the settlement releasing
> USDC to a provider, the SLA refund reclaiming it, and the tab settling six calls
> in a single transaction. The contracts are deployed and transacting, and the
> provider reputation you saw is real on-chain state."

---

## Slide 8 — Why Arc / Circle
**USDC gas token · sub-second settlement · Circle Wallets · Paymaster + DCW next**

> "Arc is the right chain for this. USDC as the gas token removes the native-gas
> bootstrap problem for a bot. Sub-second finality means a per-call payment clears
> inside the request. We use USDC and Circle Wallets today, and Paymaster for a
> gasless first call is the next step."

---

## Slide 9 — Traction & quality
**34 tests · CI on every push · one-command live deploy · offline-capable build**

> "On execution: thirty-four automated tests, CI running the full agentic scenario
> on every push, and a one-command live deploy to Arc. We optimized for quality
> over surface area — every feature you saw is tested and runs end to end."

---

## Slide 10 — Vision / ask
**From demo to the settlement rail for agent-to-agent commerce. [repo link]**

> "Tessera is the settlement rail for the agent economy — escrow, refunds,
> staking, and reputation that make autonomous commerce safe. Next is wrapping
> real providers, a discovery registry, and reputation staking. The code is public
> and live on Arc today. Thanks — let's let machines do business with each other."

---

### Delivery notes
- Pace: ~150 words/minute. The quotes above total ~430 words → land near 3 min.
- If you're also screen-recording the demo, compress slides 4–5 and let the demo
  (slide 6) carry the mechanics; you can cut slide 5's script to its four labels.
- Memorize the three tx one-liners on slide 7 — that reveal is your strongest
  moment; say it slowly.
- End on the repo URL held on screen for the final 5 seconds.
