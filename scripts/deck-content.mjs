/**
 * Deck content and palette — the only file to edit when the pitch changes.
 *
 * Mirrors `docs/deck.html` slide for slide, in its **light** theme, so the
 * PowerPoint export and the interactive deck are the same deck rather than two
 * that drift apart.
 *
 * Each slide names a `type`, which selects a layout in make-deck.mjs:
 *
 *   title   mosaic mark + wordmark + headline + lede + stat tiles
 *   split   headline & lede on the left, cards on the right
 *   quote   one large statement, centred
 *   flow    numbered steps in a row, with a closing lede
 *   cards   headline + lede + a two-column grid of cards
 *   stack   headline + lede + full-width cards
 *   ledger  purchase rows with outcome pills, plus side cards
 *   proof   transaction rows with badges, plus an address line
 *   stats   headline + four large figures
 */

/** Light palette, lifted from deck.html's `:root[data-theme="light"]`. */
export const C = {
  ground: "EEF1F8",
  ground2: "E7EBF5",
  surface: "FFFFFF",
  surface2: "F4F6FC",
  line: "DBE1EF",
  ink: "0D1424",
  muted: "566384",
  faint: "8593B0",
  accent: "2F6BE0",
  accentSoft: "E5EDFF",
  good: "0F9D6B",
  warn: "B9791A",
  bad: "D94B4B",
};

export const SLIDES = [
  {
    type: "title",
    label: "TESSERA",
    eyebrow: "Agentic Economy · Arc Hackathon",
    title: "Money for machines.",
    lede: [
      { t: "Trustless pay-per-use commerce for AI agents — settled on " },
      { t: "Arc", color: C.accent },
      { t: " in USDC. The trust layer that lets an agent pay a service it has never met." },
    ],
    stats: [
      ["Live on Arc testnet", "chainId 5042002 · USDC as gas"],
      ["8 contracts deployed", "escrow, tabs, pool, vault, swap, AMM, 2 collectors"],
      ["238 automated tests", "104 contract · 134 agent · CI on every push"],
    ],
    note:
      "Open on the problem, not the product. An agent today can only buy from a service a human " +
      "already set up an account and a card for. Tessera is the trust layer that removes that step.",
  },
  {
    type: "split",
    label: "THE PROBLEM",
    eyebrow: "The problem",
    title: "Agents can't pay strangers.",
    lede: "An agent can only buy from a service a human already set up an account and a card for.",
    cards: [
      ["Trust runs both ways", "The service can't tell the agent will pay. The agent can't tell the service will deliver."],
      ["So: pre-funded vendors only", "Agents are boxed into a hand-curated list of pre-approved suppliers."],
      ["That isn't an economy", "Real machine-to-machine commerce needs strangers to transact safely.", C.accent],
    ],
    note:
      "Solve only one side of the trust problem and you still have a curated vendor list. Both sides " +
      "have to be solved at once, and that is what escrow plus a delivery guarantee does.",
  },
  {
    type: "quote",
    label: "THE INSIGHT",
    eyebrow: "The insight",
    quote: [
      { t: "The missing primitive isn't " },
      { t: "“send USDC.”", color: C.faint },
      { t: " It's " },
      { t: "escrow + SLA + reputation.", color: C.accent },
    ],
    lede:
      "A raw transfer doesn't make a stranger safe to deal with. Programmable escrow — with a " +
      "delivery guarantee and reputation attached — does.",
    note:
      "This is the whole pitch in one line. Anyone can move USDC. What is missing is the ability to " +
      "get it back automatically when the other side fails to deliver.",
  },
  {
    type: "flow",
    label: "HOW IT WORKS",
    eyebrow: "How it works",
    title: "402 → decide → escrow → settle or refund",
    steps: [
      ["01", "Quote", "Agent hits a paid endpoint → HTTP 402 plus a signed USDC price and SLA."],
      ["02", "Decide", "Rules or an LLM weigh budget, on-chain reputation, bonded stake and memory."],
      ["03", "Escrow", "Locks a nano-sized USDC payment in TesseraEscrow on Arc."],
      ["04", "Settle / refund", "Delivered → released. SLA breach → reclaimed."],
    ],
    lede: [
      { t: "USDC is Arc's " },
      { t: "gas token", color: C.accent },
      { t: ", so the agent funds one asset for the toll and the fees — and sub-second finality lets a payment settle inside the request." },
    ],
    note:
      "Walk the four steps. The one that matters is step four: the refund is enforced by the contract, " +
      "not by a dispute process or by trusting the counterparty.",
  },
  {
    type: "cards",
    label: "DIFFERENTIATORS",
    eyebrow: "What makes it real",
    title: "Guarantees, not promises.",
    cards: [
      ["◆ Escrow + auto-refund", "Delivery releases funds; an SLA breach reclaims them automatically. Enforced by the contract, not trust.", C.accent],
      ["◆ Provider staking & slashing", "Providers bond USDC; a breach slashes it to compensate the agent. Skin in the game.", C.good],
      ["◆ Nanopayment tabs", "One deposit, many zero-gas off-chain vouchers, one settlement. Streams at nano-scale.", C.warn],
      ["◆ Guardian + trust memory", "Big buys pause for a human co-signer; a provider that burned this agent is declined next time.", C.accent],
    ],
    note:
      "Each of these runs end to end, not stubbed. The staking one answers “why would an agent trust " +
      "an unknown provider” — because the provider has money at risk.",
  },
  {
    type: "cards",
    label: "THE DEFI STACK",
    eyebrow: "The DeFi stack",
    title: "The rails that fund the agent.",
    lede: "An agent needs working capital. Tessera provides it natively rather than assuming a funded wallet.",
    cards: [
      ["◆ Lending & borrowing", "Supply for yield or borrow against collateral. Kinked-utilisation interest, health-factor liquidation, per-action freeze controls.", C.accent],
      ["◆ Yield vault", "80% held liquid by a contract floor no admin can lower. The app's fee touches yield only — never principal.", C.good],
      ["◆ Swap desk", "Oracle-priced swaps between pool assets, with a configurable fee split.", C.warn],
      ["◆ Liquidity pools (AMM)", "Multi-asset pools where providers keep at least 50% of every swap fee — a constant in the contract, not a setting.", C.accent],
    ],
    note:
      "The DeFi is not decoration. An agent that earns fees needs somewhere to put them, and somewhere " +
      "to borrow from when it is short.",
  },
  {
    type: "stack",
    label: "GUARDRAILS",
    eyebrow: "Guardrails",
    title: [{ t: "What an operator " }, { t: "cannot", color: C.accent }, { t: " do." }],
    lede: "The safety properties that matter are the ones written as constants, not as policy.",
    cards: [
      ["Vault reserve floor", "80% liquid is a contract constant. Raising it is allowed; lowering it is not."],
      ["AMM provider share", "50% of swap fees to liquidity providers, enforced on every configuration path."],
      ["No position transfers", "No function anywhere lets an operator move someone else's position. Migration pays in on their behalf instead.", C.accent],
      ["Oracle validation", "A stale, negative, unfinished or carried-over price pauses the market rather than pricing wrongly."],
      ["Freeze, not trap", "Freezing is per action — withdraw and repay can stay open, and liquidation is never frozen."],
    ],
    note:
      "This is the slide a technical judge will care about. Every line is something that cannot be done " +
      "even with the deployer key, which is what makes the trust assumption bounded.",
  },
  {
    type: "cards",
    label: "AGENT WORKSPACE",
    eyebrow: "Agent workspace",
    title: "Live information the agent can act on.",
    lede:
      "News across 21 topics, 46 FX pairs, 52 crypto assets, 36 stocks, 16 indices, 18 commodities, " +
      "central bank policy rates and balance sheets — plus analysis derived from those figures.",
    cards: [
      ["Named sources", "ECB reference rates, CoinGecko, Yahoo Finance, FRED (St. Louis Fed), public RSS. Each panel names its source and its age."],
      ["Never a fabricated number", "An unreachable feed says so. It does not fall back to a stale figure someone might trade on.", C.bad],
      ["Analysis, not opinion", "Breadth, volatility, dollar direction, policy rates, QE/QT — arithmetic on published figures. A rate change is dated by finding where the series moved, not by reading a statement."],
      ["Full transaction history", "Filter by user, date, range, value, outcome and type; export to CSV."],
    ],
    note:
      "Worth saying out loud: the analysis tab computes from the prices in the other tabs and says so. " +
      "We deliberately did not generate market commentary, because that would be invented.",
  },
  {
    type: "ledger",
    label: "LIVE RUN",
    eyebrow: "Live run · one autonomous run",
    rows: [
      ["AtmosFeed — weather", "0.0025", "settled"],
      ["ParityDesk — FX quote", "0.0040", "settled"],
      ["WireScoop — news (junk)", "0.0030", "refunded"],
      ["AlphaSignal — analysis", "0.0080", "settled"],
      ["PulseWire — ticker (tab)", "6 ticks", "settled"],
    ],
    cards: [
      ["SLA breach → slash", "News returns junk; the agent reclaims its USDC and slashes the provider's stake 0.05 → 0.0494.", C.warn],
      ["Guardian pause", "A premium call exceeds the policy cap, so a human approves before it settles.", C.accent],
      ["Declined from memory", "A later invoice from the provider that failed it is declined, with no human asked."],
    ],
    note:
      "The refund and the slash are the two to point at. Everything else a payment rail can do; getting " +
      "the money back and taking it out of the counterparty's bond is the part that is new.",
  },
  {
    type: "proof",
    label: "ON-CHAIN PROOF",
    eyebrow: "On-chain proof · Arc testnet · chainId 5042002",
    txs: [
      ["✓", "Settle — USDC released to provider", "Verified delivery, escrow released", "0xbbf5c98b…753f", C.good],
      ["↩", "Refund — SLA breach reclaimed", "Agent recovered its USDC automatically", "0xf8a57c18…18ba", C.warn],
      ["⚡", "Tab settle — 6 calls, one transaction", "Nanopayment stream, remainder returned", "0x15c13f79…4f66", C.accent],
    ],
    addr: "Escrow 0x9776498c…5a9a7d     Tab 0x5d482c70…d78c6d     chainId 5042002 · live",
    note:
      "Have the explorer open. The refund transaction is the one to show — it is the differentiator " +
      "made concrete.",
  },
  {
    type: "split",
    label: "WHY ARC",
    eyebrow: "Why Arc + Circle",
    title: "Built for money that moves itself.",
    cards: [
      ["USDC is the gas token", "The agent funds one asset for both the toll and the fees — no native-gas bootstrap for a bot.", C.accent],
      ["Sub-second finality", "A per-call payment clears inside the request/response cycle."],
      ["Config, not fork", "Chain id, RPC, explorer and USDC address are env-driven; mainnet is a configuration change."],
    ],
    note:
      "The gas-token point is the one people miss. On a normal chain an agent needs two assets and a " +
      "top-up strategy for the one it does not earn.",
  },
  {
    type: "stats",
    label: "EXECUTION",
    eyebrow: "Execution & quality",
    title: "Every feature runs end to end.",
    stats: [
      ["238", "automated tests\n104 contract · 134 agent"],
      ["CI", "full agentic scenario\non every push", C.good],
      ["1", "command to deploy live\nbootstrap:arc"],
      ["Live", "deployed & transacting\non Arc testnet", C.accent],
    ],
    note:
      "Close the credibility gap here. The honest caveat belongs on this slide too: unaudited testnet " +
      "software, and we say so inside the app itself.",
  },
  {
    type: "quote",
    label: "THE VISION",
    eyebrow: "The vision",
    quote: "The settlement rail for agent-to-agent commerce.",
    lede:
      "Escrow, refunds, staking and reputation that make autonomous commerce safe. Next: real " +
      "providers, a discovery registry, reputation staking.",
    addr: "github.com/rgdtnhat/arc   ·   live on Arc testnet",
    note:
      "End on the market, not the feature list. Every agent that buys anything needs this, and today " +
      "each of them re-implements a worse version of it.",
  },
];
