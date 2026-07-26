# Deploy the Tessera live dashboard

The repo ships a `Dockerfile` that runs the providers, the autonomous agent, and
the dashboard in one container — live against Arc. Point any Docker host at it
and you get a public URL.

> Prerequisite: the app runs **live on Arc only** (there is no local chain), so
> the container needs funded wallet keys and the deployed addresses. Deploy the
> contracts first (`npm run bootstrap:arc` + `npm run pool:arc`, see the README),
> then pass `AGENT_PRIVATE_KEY`, `PROVIDER_PRIVATE_KEY`, and `ARC_RPC_URL` to the
> container. Give it **~512 MB–1 GB RAM** (a "starter"/"hobby" instance).

## Reading a `pool:arc` run

`pool:arc` is re-runnable. It adopts contracts that are already live rather than
replacing them, and it separates steps that matter from steps that don't:

- **Fatal** — deploying a contract, registering a reserve, writing the deployment
  record. These stop the run, because everything after them depends on them.
- **Optional** — moving tokens: seeding pool liquidity, the agent's starting
  position, swap-desk inventory. A revert here prints `⚠ skipped …` and the run
  continues. Each one is listed again in a block at the end.

A line like this is **normal, not an error**:

```
(skip swap inventory — the desk is owned by 0x… , not the deployer.
 That is the steady state: the fee collector owns it and funds it from
 its own swap allocation.)
```

`TesseraSwap.seed` is `onlyOwner`, and the first run hands the desk to the fee
collector — so from the second run on, the deployer cannot seed it and does not
try. (An earlier build *did* try, and the uncaught revert aborted the script
before `TesseraAMM` was deployed, which is why the app then reported "AMM not
deployed yet". `agent/test/pool-arc.test.ts` runs the script against a fake node
that reverts `seed`, and asserts the AMM still deploys.)

The run has succeeded when you see:

```
✅ Pool + Vault + Swap live on Arc:
   pool / vault / swap / fees / amm / amm fees   0x…
```

A failure now leads with a single line — `❌ pool:arc failed: <reason>` — before
the full viem error, which is otherwise a wall of ABI.

Two knobs for a slow or private RPC: `TESSERA_PACE_MS` (wait between sends,
default 6000) and `ARC_RPC_MIN_INTERVAL_MS` (minimum gap between any two RPC
calls, default 180). Lower both on a private endpoint; raise the first if the
public node throttles you.

## Option A — Render (one click, uses `render.yaml`)

1. Push this repo to GitHub (already at `github.com/rgdtnhat/arc`).
2. In Render: **New → Blueprint**, select the repo. Render reads `render.yaml`,
   builds the `Dockerfile`, and deploys a web service.
3. Add `AGENT_PRIVATE_KEY` / `PROVIDER_PRIVATE_KEY` / `ARC_RPC_URL` as env vars.
4. Open the service URL — the dashboard is live. Done.

## Option B — Railway

1. **New Project → Deploy from GitHub repo**, pick this repo.
2. Railway auto-detects the `Dockerfile`. In the service settings, set the wallet
   env vars and ensure the service is exposed (Railway sets `$PORT` automatically;
   the app reads it).
3. Open the generated domain.

## Option C — Fly.io (CLI)

```bash
fly launch --dockerfile Dockerfile --now   # accept the detected settings
fly secrets set AGENT_PRIVATE_KEY=… PROVIDER_PRIVATE_KEY=… ARC_RPC_URL=…
fly open
```

## Option D — any VM / Docker host

```bash
docker build -t tessera .
docker run -p 80:8787 \
  -e AGENT_PRIVATE_KEY=… -e PROVIDER_PRIVATE_KEY=… -e ARC_RPC_URL=… \
  tessera                                    # dashboard on port 80
```

For a domain + automatic TLS, use the bundled `docker-compose.yml` + Caddy —
see `docs/SELF_HOST.md`.

## Options

- `PORT` — dashboard port (hosts inject this; defaults to 8787).
- `AGENT_PRIVATE_KEY`, `PROVIDER_PRIVATE_KEY` — funded Arc wallets.
- `ARC_RPC_URL` — Arc RPC endpoint (defaults to `https://rpc.testnet.arc.network`).
- `ADMIN_ID` / `ADMIN_PASSWORD` — dashboard admin login (keep secret).
- `ANTHROPIC_API_KEY` + `AGENT_BRAIN=llm` — enable the LLM decision brain
  instead of the deterministic rules engine (optional).

## What's hosted

The public dashboard shows a full autonomous run against Arc: escrow settlements,
an SLA-breach refund with a stake slash, the guardian approval card, the
nanopayment tab session, the billing inbox, and the mission briefing — every line
backed by a real transaction on `deployments/arc.json`.

## Migrating to mainnet

The same container is the production path: repoint `ARC_RPC_URL` and the
deployment addresses at the production chain, supply production wallet keys, and
have the contracts audited first (see `docs/SECURITY.md`). No code forks.

## Just the deck?

The pitch deck (`docs/deck.html`) is fully static — host it anywhere (GitHub
Pages, Netlify drop, or the Claude artifact link) without a server.
