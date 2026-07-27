# Deploy the Tessera live dashboard

The repo ships a `Dockerfile` that runs the providers, the autonomous agent, and
the dashboard in one container — live against Arc. Point any Docker host at it
and you get a public URL.

> Prerequisite: the app runs **live on Arc only** (there is no local chain), so
> the container needs funded wallet keys and the deployed addresses. Deploy the
> contracts first (`npm run bootstrap:arc` + `npm run pool:arc:init`, see the README),
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

### The swap desk needs inventory

`TesseraSwap` fills swaps out of its **own token balance** — there is no internal
ledger, and `swap` checks `balanceOf(address(this))`. An empty desk therefore
reverts every swap into that asset with `insufficient inventory`, even though
quotes still work. The dashboard's **Desk inventory** table shows this per asset,
and flags an empty one.

Three ways to top it up, all landing in the same place:

```bash
npm run swap:fund              # top every reserve up to a default target
npm run swap:fund -- --check   # report inventory, send nothing
npm run swap:fund -- USDC=5 EURC=2 cirBTC=0.0002
```

…or the **Add inventory** control on the Swap card when signed in as operator,
or nothing at all — `pool:arc` funds the desk on every run.

Ownership does **not** gate this, and an earlier build wrongly assumed it did.
`seed` is `onlyOwner`, so that build skipped inventory whenever the fee collector
owned the desk (which it does from the first run onward) and printed
`(skip swap inventory …)`. That left the desk empty with no route offered. But
since inventory is just the desk's balance, a plain ERC-20 transfer from *any*
sender has always counted — the owner-only gate restricted the route that emits
an event, not the outcome. `TesseraSwap.fund` is now permissionless for exactly
that reason, and the tooling picks a route from the deployed bytecode:

| Route | When |
|---|---|
| `fund()` | the deployed code has it — emits `InventoryChanged` |
| `seed()` | no `fund()`, and the caller owns the desk |
| `transfer` | neither — works on any desk, including ones deployed before `fund()` |

The route is read from the bytecode (the selector is a `PUSH4` constant), not
probed by simulation: `fund` returns nothing, so an `eth_call` coming back empty
is a valid success and cannot be told apart from a missing selector.

Inventory is **app-owned**. Funding the desk is a donation to it: there are no
shares and no claim, and only the owner can `withdrawInventory`. For a position
you can withdraw with a share of the fees, use `TesseraAMM`.

The run has succeeded when you see:

```
✅ Pool + Vault + Swap live on Arc:
   pool / vault / swap / fees / amm / amm fees   0x…
```

A failure leads with a single line — `❌ pool:arc stopped: <reason>` — before the
full viem error, which is otherwise a wall of ABI. A stop with a known fix (for
example the fund-custody opt-in) prints the command to run and no stack at all.

Two knobs for a slow or private RPC: `TESSERA_PACE_MS` (wait between sends,
default 6000) and `ARC_RPC_MIN_INTERVAL_MS` (minimum gap between any two RPC
calls, default 180). Lower both on a private endpoint; raise the first if the
public node throttles you.

## If `docker compose up --build` fails

### `ENOSPC: no space left on device`

```
npm warn tar TAR_ENTRY_ERROR ENOSPC: no space left on device, write
```

The host is out of disk. Nothing in the repo can work around that, so free space
first:

```bash
df -h /                              # how bad is it
docker system prune -af --volumes    # usually reclaims the most, by far
docker builder prune -af             # the build cache, separately
journalctl --vacuum-size=100M        # systemd journals grow quietly
du -sh /var/lib/docker /var/log      # where it actually went
```

The build now needs far less of it. It used to install the whole workspace
(~440 MB, 285 packages) including Hardhat, solc and `@nomicfoundation/edr`, and
run `hardhat compile`. All of that was avoidable: the app imports its ABIs and
deploy bytecode from `@tessera/shared`, where `shared/src/abi.ts` and
`shared/src/bytecode.ts` are **generated and committed** — compiling in the image
regenerated them byte for byte and changed nothing. One stage,
`npm install --omit=dev`, no compile: **135 MB and 94 packages.**

`npm run compile` still exists for development, and CI runs
`npm run abi:check -- --compiled`, which fails if the committed ABIs are not
exactly what the current sources compile to. That check is what lets the image
trust them.

### `At least one invalid signature was encountered`

```
E: The repository 'http://deb.debian.org/debian bookworm InRelease' is not signed.
```

Also a symptom of the full disk above — a truncated `InRelease` download fails
verification. The Dockerfile no longer calls `apt` at all, so this cannot fail the
build any more, but the disk is still worth fixing. If disk and clock (`date -u`)
are both fine, the remaining suspect is something between the host and
`deb.debian.org` rewriting plain-HTTP responses.

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
