# Deploy the Tessera live dashboard

The repo ships a `Dockerfile` that runs the whole demo in one container — it
boots a local chain, deploys the contracts, runs the autonomous agent scenario,
and serves the dashboard on `$PORT`. Point any Docker host at it and you get a
public URL.

> Resource note: the container runs an in-process EVM (the local chain), so give
> it **~1 GB RAM** (a "starter"/"hobby" paid instance). Free 256–512 MB tiers may
> OOM. The dashboard auto-runs the scenario on boot; the "Run again" button
> replays it.

## Option A — Render (one click, uses `render.yaml`)

1. Push this repo to GitHub (already at `github.com/rgdtnhat/arc`).
2. In Render: **New → Blueprint**, select the repo. Render reads `render.yaml`,
   builds the `Dockerfile`, and deploys a web service.
3. Open the service URL — the dashboard is live. Done.

## Option B — Railway

1. **New Project → Deploy from GitHub repo**, pick this repo.
2. Railway auto-detects the `Dockerfile`. In the service settings, ensure a
   **1 GB** plan and that the service is exposed (Railway sets `$PORT`
   automatically; the app reads it).
3. Open the generated domain.

## Option C — Fly.io (CLI)

```bash
fly launch --dockerfile Dockerfile --now   # accept the detected settings
fly scale memory 1024                       # give the local chain room
fly open
```

## Option D — any VM / Docker host

```bash
docker build -t tessera-demo .
docker run -p 80:8787 tessera-demo          # dashboard on port 80
```

## Options

- `PORT` — dashboard port (hosts inject this; defaults to 8787).
- `ANTHROPIC_API_KEY` + `AGENT_BRAIN=llm` — enable the LLM decision brain
  instead of the deterministic rules engine (optional).

## What's hosted

The public dashboard shows a full autonomous run: escrow settlements, an
SLA-breach refund with a stake slash, the guardian approval card, the
nanopayment tab session, the billing inbox, and the mission briefing — all
against a fresh local chain inside the container.

To instead point the agent at **live Arc testnet** (real USDC, the deployed
contracts in `deployments/arc.json`), run the providers + `run:arc` flow from
the README rather than the bundled demo; that path needs funded keys and is
better suited to a worker than a public web service.

## Just the deck?

The pitch deck (`docs/deck.html`) is fully static — host it anywhere (GitHub
Pages, Netlify drop, or the Claude artifact link) without a server.
