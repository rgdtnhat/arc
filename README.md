# Tessera 🎟️

**Trustless pay-per-use commerce for AI agents, settled on [Arc](https://docs.arc.io) in USDC.**

> A *tessera* was a small token in ancient Rome that granted its bearer entry, a
> seat, or a ration. Tessera is the digital equivalent for the agent economy: an
> autonomous agent pays a tiny USDC toll and receives a verifiable token of
> access — no account, no credit card, no human in the loop.

Built for the [Arc Hackathon](https://www.encodeclub.com/my-programmes/arc-hackathon)
— **Agentic Economy** track.

---

## The problem

AI agents are starting to consume paid services on their own — data feeds, APIs,
compute, premium content. But there is no clean way for an agent to **pay a
stranger's service, per call, without a human first setting up an account and a
credit card.** And trust runs both ways:

- A **service** can't tell whether an unknown agent will actually pay.
- An **agent** can't tell whether a service it has never met will actually
  deliver what it charged for.

Without solving *both* sides, agents can only transact with a hand-curated list
of pre-approved, pre-funded vendors. That is not an economy.

## The idea

Tessera is an **HTTP-402 payment handshake settled by an on-chain escrow on
Arc**:

1. **Quote** — An agent hits a paid endpoint and gets back `402 Payment
   Required` plus a signed price quote in USDC.
2. **Decide** — The agent's decision engine autonomously answers *is this worth
   it?* from its remaining budget, the value of the task, and the provider's
   **on-chain reputation**. No human approves the spend.
3. **Escrow** — The agent locks a nano-sized USDC payment into the Tessera
   escrow contract on Arc (sub-second settlement, USDC is the gas token too).
4. **Deliver & settle** — The provider returns the data. A verifier checks it
   against the promised SLA:
   - ✅ good response → escrow **releases** to the provider, reputation ↑
   - ❌ failure / timeout → the agent **auto-claims a refund**, reputation ↓

The unique core is step 4. Most "agent payment" projects stop at *"agent sends
USDC."* Tessera adds **programmable escrow + SLA-based auto-refund + on-chain
reputation**, which is exactly what makes it safe for an agent to buy from a
service it has never met — the real unlock for agent-to-agent commerce.

Two more primitives round out the trust layer:

- **Nanopayments (`TesseraTab`)** — for per-tick streams, an agent opens a
  *tab*: one on-chain deposit, then each micro-call is paid with an off-chain
  signed voucher (zero gas, cumulative and replay-safe). The provider settles
  the whole stream in a single on-chain claim; the remainder returns to the
  agent, who can also reclaim everything if the provider disappears.
- **Provider staking & slashing** — providers bond USDC in the escrow as skin
  in the game. On an SLA breach the agent gets its refund **plus compensation
  slashed from the provider's stake**, and agents price stake into their trust
  score, so bonded strangers are safer to buy from than unbonded ones.

And a wallet-grade safety layer (inspired by consumer wallets like LOBSTR):

- **Guardian approvals (policy sandbox)** — spends at or below the policy cap
  are fully autonomous; anything above **pauses the agent and escalates to a
  human co-signer** on the dashboard (Approve/Reject). Autonomy inside a
  sandbox, not a blank check.
- **Contacts & personal trust memory** — beyond global on-chain reputation, the
  agent remembers *its own* dealings across runs; a provider that burned it
  loses personal trust (−0.15 per refund) until the agent stops buying from it.
- **Wallet activity** — a live balance sparkline and a readable event feed of
  every escrow, voucher, settle, refund, and slash.
- **Payment requests (billing inbox)** — providers issue invoices; the agent
  autonomously pays the ones from providers it trusts (through the same escrow
  rail), **declines** the ones from providers that burned it, and escalates
  over-cap amounts to the guardian.

## Circle Agent Stack

The agent reaches its **wallet, USDC payments, and on-chain actions** through a
typed **Agent Stack** action layer (`agent/src/agentkit.ts`) rather than ad-hoc
calls — tools like `usdc_balance`, `escrow_payment`, `settle_payment`,
`refund_payment`, `open_tab`, and `sign_voucher`, each with a JSON-schema input
(MCP / tool-use shape). An LLM brain can enumerate and call them; the
deterministic brain uses the same client underneath. Run `AGENT_STACK=1 npm run
run:arc` to print the manifest, or hit `GET /api/actions` on the dashboard.

**Circle Wallets & Paymaster** are wired as real seams too: `WALLET_MODE=circle`
swaps raw keys for a Circle **Developer-Controlled Wallet** (signer-identical
downstream), and `CIRCLE_PAYMASTER_URL` enables **Paymaster** gasless-first-call
sponsorship. Both default to today's working path. See
[`docs/CIRCLE_INTEGRATION.md`](docs/CIRCLE_INTEGRATION.md).

## Lending & borrowing

`TesseraPool` is an isolated money market on Arc: **reserves** with per-asset
**collateral / liability factors**, **utilization-driven interest** (a kinked
rate curve), **health-factor liquidations**, and a **protocol take-rate** that
accrues to the app-owner treasury. Reserves are three real Circle assets — **USDC**,
**EURC**, and **cirBTC** (Circle Wrapped Bitcoin) — all borrowable. Agents put idle
stablecoins to work (supply → yield) or open a credit line (borrow against collateral)
to fund their pay-per-call operations. **Live on Arc testnet**, with a **Lending &
borrowing** dashboard panel (multi-asset, custom + Max amounts). See
[`docs/LENDING.md`](docs/LENDING.md). *(Unaudited testnet code.)*

## Web3 wallet login

The dashboard supports **Sign-In-With-Ethereum** (EIP-4361): "Connect Wallet"
prompts an injected wallet (MetaMask/WalletConnect) to sign a nonce-bound
message, which the server verifies (`/api/auth/*`) — single-use nonces, no
passwords. Your address then shows in the header.

## Multi-agent concurrency

`agent/src/fleet.ts` runs many agents concurrently, each with **its own wallet**,
budget, nonce stream, and trust memory (`runFleet`, unit-tested). It surfaced two
real concurrency bugs, now fixed: providers **serialize on-chain writes per
wallet** (concurrent `fulfill`s no longer collide on the nonce), and the client
reads the **real `paymentId`/`tabId` from the transaction receipt's event**
instead of the speculative `simulateContract` return (which collided across
simultaneous `open()`s).

## Why Arc

- **USDC is the gas token** — the agent funds one asset and uses it for both the
  toll *and* the fees. No native-gas bootstrapping problem for a bot.
- **Sub-second finality** — a per-call toll settles fast enough to sit inside a
  request/response cycle.
- **EVM + Circle stack** — standard Solidity/viem, Circle Wallets for agent
  wallets, Paymaster for gasless UX.

## Architecture

```
                         ┌────────────────────────────┐
                         │   Arc testnet (chainId 5042002) │
   ┌──────────┐          │  ┌──────────────────────────┐  │
   │  Agent   │  open    │  │   TesseraEscrow.sol       │  │
   │ runtime  │─────────▶│  │  • escrow USDC per call   │  │
   │ (viem)   │  settle/ │  │  • SLA deadline + refund  │  │
   │          │  refund  │  │  • provider reputation    │  │
   │ decision │◀─────────│  └──────────────────────────┘  │
   │  engine  │          │        ▲  USDC (0x3600…0000)     │
   └────┬─────┘          └────────┼───────────────────────┘
        │ HTTP 402 handshake      │ release / refund
        ▼                         │
   ┌──────────────────────────────┴──┐
   │  Provider services (mock)        │
   │  weather · finance · news(fails) │
   └──────────────────────────────────┘
```

## Repo layout

| Path          | What it is                                                        |
|---------------|-------------------------------------------------------------------|
| `contracts/`  | `TesseraEscrow`, `TesseraTab`, `TesseraPool` (lending), `MockUSDC`, Hardhat + viem tests |
| `agent/`      | Agent runtime: 402 handshake, hybrid decision engine, settle/refund, Agent Stack action layer, Circle wallet/Paymaster/faucet seams, treasury workflow |
| `providers/`  | Mock priced services that speak the Tessera 402 protocol          |
| `dashboard/`  | Live dashboard (balances, reputation, tx feed)                    |
| `shared/`     | Chain config, ABIs, protocol types shared across packages         |

## The 402 protocol (Tessera flavor)

A paid request/response looks like:

```http
GET /weather?city=Lisbon
→ 402 Payment Required
  X-Tessera-Provider: 0xProvider…
  X-Tessera-Price:    2500        # 0.0025 USDC (6 decimals)
  X-Tessera-Quote:    0xabc…      # keccak256(provider,price,resource,nonce)
  X-Tessera-Deadline: 30          # seconds the provider has to deliver

GET /weather?city=Lisbon
  X-Tessera-Payment: 42           # on-chain paymentId proving escrow is funded
→ 200 OK   { "tempC": 21, … }
```

## Status

Early build for Checkpoint 1. See `docs/ROADMAP.md` for the plan to a deployed
MVP.

## Quick start

```bash
npm install            # installs all workspaces
npm run test           # 28 contract tests + 47 agent unit tests
```

CI runs the tests on every push (`.github/workflows/ci.yml`).

**The dashboard runs live on Arc testnet only** — there is no local chain
or public dev keys. Deploy to Arc (below), then `npm start` reads
`deployments/arc.json` + your `.env` keys and serves the dashboard against Arc.

## Deploy to Arc testnet (one command)

```bash
npm run bootstrap:arc   # deploys escrow + tab, funds agent/provider, writes .env + deployments/arc.json
npm run pool:arc        # deploys the lending pool + opens the agent's position
npm start               # serves the dashboard live on Arc (needs AGENT_/PROVIDER_PRIVATE_KEY in .env)
```

The bootstrap generates deployer/agent/provider keys into `.env` (gitignored),
prints the deployer address and waits while you fund it at
[faucet.circle.com](https://faucet.circle.com) (network: **Arc Testnet** — USDC
is the gas token), then deploys `TesseraEscrow` + `TesseraTab`, funds the agent
and provider wallets, bonds the provider's stake, and writes addresses to `.env`
and `deployments/arc.json`. You can also run the two sides headless:

```bash
node --env-file=.env --import tsx providers/src/server.ts   # terminal 1
node --env-file=.env --import tsx agent/src/run-arc.ts      # terminal 2
```

The Arc scripts set `NODE_USE_ENV_PROXY=1` so Node's `fetch` honors an
`HTTPS_PROXY` (needed in proxied/sandboxed environments; a no-op otherwise). If
your proxy re-terminates TLS, also export `NODE_EXTRA_CA_CERTS=<ca-bundle>`.

## Deploy the live dashboard

A `Dockerfile` serves the dashboard **live on Arc testnet** on `$PORT`. It reads
`deployments/arc.json` (committed) and needs `AGENT_PRIVATE_KEY` +
`PROVIDER_PRIVATE_KEY` (and an `ADMIN_PASSWORD` for login) in the environment —
provide them via a gitignored `.env` next to `docker-compose.yml`. It also
installs as a **PWA** and ships as a **multi-arch** image (see
[`docs/PACKAGING.md`](docs/PACKAGING.md)).

- **Your own server + domain** (HTTPS via Caddy) — see
  [`docs/SELF_HOST.md`](docs/SELF_HOST.md):
  ```bash
  SITE_ADDRESS=tessera.example.com docker compose up -d --build
  ```
- **Managed host** (Render via `render.yaml`, Railway, Fly) — see
  [`docs/DEPLOY.md`](docs/DEPLOY.md).

## License

MIT
