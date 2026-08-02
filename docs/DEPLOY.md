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
  position, AMM pool liquidity. A revert here prints `⚠ skipped …` and the run
  continues. Each one is listed again in a block at the end.

### Swaps come from pool liquidity, not from inventory

There is no swap desk any more. `TesseraSwap` held its own stock of every asset,
priced from the lending pool's oracle, and reverted `insufficient inventory` when
it ran out — so someone had to keep it funded, someone had to be able to withdraw
from it, and getting that authority wrong left balances stranded behind an owner
that was a contract with no forwarding function.

`TesseraRouter` replaces it and has none of those properties:

- **It holds nothing.** It pulls the input from the caller, routes it through
  `TesseraAMM` pools, and forwards the output in the same transaction. Its
  balances are zero between calls, so there is nothing to fund and nothing to
  strand. The `sweep` function exists only to recover a stray transfer.
- **It prices from the pool's own reserves.** No oracle sits in the swap path, so
  a feed outage stops the money market without stopping trading, and there is no
  operator-set price to arbitrage against.
- **It routes.** Direct pools first, then up to two hops through a hub token
  (USDC on this deployment), with one `minOut` guard covering the whole chain and
  a deadline on every call.

`pool:arc` deploys it as part of a normal run. To deploy or replace only the
router against an AMM that is already live:

```bash
npm run router:deploy            # deploy, record, report
npm run router:deploy -- --check # report only, change nothing
```

The router works against an AMM deployed before the routing helpers existed: it
uses `poolsForPair` when the AMM has that index and falls back to walking
`poolCount` when it does not, so no liquidity provider has to migrate.

If a quote comes back with **no route**, the answer is liquidity in the pool, not
inventory in the router — add it on the Liquidity pool tab, where it earns a
share of every swap fee it goes on to serve.

### Resetting the pools onto the new contracts

`router:deploy` gets swaps working against the AMM already deployed. It does not
get you the **Blend** or **Aqua** behaviour, because those live in contracts that
are not deployed yet: the pool on Arc today has no backstop, no three-slope curve
and no auctions — the functions do not exist on it, so there is nothing to switch
on. Same for the AMM's fee tiers and pair index.

`pools:reset` deploys the replacements and re-creates every position in them.

```bash
npm run pools:reset                        # scan and report, change nothing
npm run pools:reset -- --confirm           # do it
npm run pools:reset -- --confirm --abandon # deploy fresh, migrate nobody
```

**Positions are re-created, not transferred.** No contract here has an admin
function that moves someone else's position — that primitive is a rug pull with
better branding — so migration works the only honest way it can: the deployer
pays in on each holder's behalf via `supplyFor` / `depositFor` /
`addLiquidityFor`. Two things follow:

- **It costs the deployer**, an amount equal to the total migrated. The dry run
  prices it per asset against the deployer's balance and refuses to start if it
  is short, so a run cannot strand half the holders part-way through.
- **The old contracts are untouched.** Everyone keeps their claim there as well
  and can withdraw from either. Nothing is taken from anyone, which is what makes
  this safe to run.

What the script does that is not obvious:

| Behaviour | Why |
|---|---|
| Skips holders that are contracts | The vault supplies into the pool, so the vault *is* a pool supplier — but its position is the derived shadow of its depositors, who are being migrated already. Re-creating both pays for the same money twice, and pays it to an address with no function that could ever withdraw it. Each skipped contract is named; `--include-contracts` overrides. |
| Takes the first deposit in each fresh venue itself | The vault and AMM burn `MINIMUM_LIQUIDITY` dead shares on a first deposit. During a migration the "first depositor" is whichever holder happens to go first, and they silently end up short by exactly that much. Priming puts the burn on the deployer. For the AMM it also sets the pool's ratio — taken from the old pool, so nobody is credited against a price nobody chose. |
| Records every leg before the next one starts | A crashed run resumes rather than re-paying. `deployments/reset-state.json` is the record; keep it until you are happy with the result, because deleting it and re-running would pay every holder a second time. |
| Refuses to run twice | A finished run rewrites `arc.local.json` with the new addresses, so on a second run the "old" contracts in the record *are* the new ones — it would scan them, find the positions it just created, and credit them again. Verified on a test migration: the guard is what stops it. |
| Stops on a partial log scan | A truncated scan under-reports *who*, never *how much*, so holders would be silently left behind. `--accept-partial` proceeds knowingly. |
| Refuses to migrate an AMM pool whose assets do not line up | `addLiquidityFor` takes amounts positionally. A mismatched order would credit the wrong side and hand someone a different position from the one they had. |

After it finishes: restart the app, seed the AMM pools with liquidity (a pool with
an empty side quotes no route), and optionally put up backstop cover on the
Lending tab so first-loss capital exists.

The old desk, if this deployment had one, keeps whatever it held. Those balances
were always its trading stock rather than a withdrawable balance; the app simply
no longer offers it.

The run has succeeded when you see:

```
✅ Pool + Vault + AMM + Router live on Arc:
   pool / vault / router / fees / amm / amm fees   0x…
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
