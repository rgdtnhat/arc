# Deploy the Tessera live dashboard

The repo ships a `Dockerfile` that runs the providers, the autonomous agent, and
the dashboard in one container — live against Arc. Point any Docker host at it
and you get a public URL.

> Prerequisite: the app runs **live on Arc only** (there is no local chain), so
> the container needs funded wallet keys and the deployed addresses. Deploy the
> contracts first (`npm run bootstrap:arc` + `npm run pool:arc:init`, see the README),
> then pass `AGENT_PRIVATE_KEY`, `PROVIDER_PRIVATE_KEY`, and `ARC_RPC_URL` to the
> container. Give it **~512 MB–1 GB RAM** (a "starter"/"hobby" instance).

## Updating a running host

```bash
cd /root/tessera && ./scripts/deploy.sh
```

That is the whole thing. It fetches, fast-forwards, rebuilds, and then **checks
that the server is actually serving this commit** — comparing the shell version
the app reports with the one in the repo — and exits non-zero if it is not.

There is no process manager here. `pm2 restart` has never been part of this
deployment and will report `command not found`: the app is a Docker Compose
service with `restart: unless-stopped`, and `docker compose up -d --build`
inside `deploy.sh` is what replaces the running container.

That check asks the **container**, not the host. `docker-compose.yml` `expose`s
8787 rather than publishing it — only Caddy binds a host port, on 80/443 — so
`curl http://127.0.0.1:8787` on the host is answered by nothing at all. Set
`APP_URL` to your real domain if you would rather it went through Caddy.

### Do not add `npm ci` or `npm run compile`

Neither belongs on a host, and both make things worse. The image runs its own
`npm install --omit=dev`, so installing on the host changes nothing about what
gets served; it only unpacks the full Solidity toolchain onto the host's disk,
which is the most likely way a small box then fails the Docker build for want
of space. When that build fails, `restart: unless-stopped` leaves the **old
container running** — so `docker compose logs` looks perfectly healthy and the
site simply never changes. The ABIs are committed precisely so no host ever
needs a compiler.

`npm run build` is a third one to skip, for a different reason: it expands to
`npm run build --workspaces --if-present` and **no workspace defines a `build`
script**, so it does nothing at all — it just looks like it did something.

If `npm ci` has already been run on the host, `node_modules` there is dead
weight — nothing in the container ever reads it. `deploy.sh` now measures it and
says so; reclaim the space with `rm -rf node_modules`.

### `deployments/` is a bind mount, and that matters

`docker-compose.yml` mounts `./deployments:/app/deployments`, so the container
reads those files **from the host**, shadowing the copy baked into the image.
Two consequences that together produce the most confusing failure this project
has had:

- A stale `deployments/arc.json` on the host goes on being served after a
  perfectly clean rebuild. The image is current; the file it reads is not.
- Because `arc.json` is *tracked*, any local edit to it makes every future pull
  abort with "Your local changes would be overwritten by merge" — and if the
  commands were not chained, that abort scrolls past and the rebuild proceeds
  on the old commit.

`deploy.sh` handles this: a local change under `deployments/` is copied to
`deployments/.superseded-<timestamp>/` and the committed version is taken. The
committed record is authoritative for addresses anyway — see the merge rule in
`agent/src/deployment.ts` — so this only discards something already superseded,
and it keeps a copy regardless. A local change to anything *else* still stops
the script, because that is a decision only you can make.

### Why a script rather than a list of commands

A list pasted into a terminal runs every line whether or not the previous one
worked. A `git pull` that refuses scrolls past; a build that dies scrolls past;
the old container answers either way. Every visible sign says the update
worked. `set -e` plus a check at the end is the difference between "it printed
some things" and "it is serving what you think it is".

If you would rather run it by hand, chain with `&&` so the shell stops at the
first failure:

```bash
cd /root/tessera && git pull --ff-only && docker compose up -d --build
```

It used to be longer still, because addresses had to be hand-patched into
`deployments/arc.local.json` after every contract deploy — and a step like that
gets skipped, which is how a host ends up serving pages from contracts nobody
meant it to use.

### Checking that it took

```bash
curl -s https://your-domain/api/version
```

```json
{ "shell": "tessera-v42", "digest": "e1e9f815", "startedAt": "…",
  "contracts": { "pool": "0x4e7d…", "gauge": "0x27b3…" } }
```

`shell` is bumped on every change to the front end, so comparing it with
`grep CACHE dashboard/public/sw.js` in the repo answers "is the container
running this commit" in one line. The dashboard shows the same string in a
**build** pill on the Status card, so it can be checked from a phone.

The pill turns amber and shows *two* versions when the browser's cached shell is
older than the server's. That distinction is the whole point: they are the two
different ways an update fails to appear, and they need opposite fixes.

### If the site looks unchanged

Three causes, in the order they actually happen:

1. **The pull did not land.** `git log --oneline -1` on the host against the
   branch head. A refused `--ff-only` merge is silent if the commands were not
   chained. Local edits to a tracked file are the usual reason: `git status`,
   then `git checkout -- <file>` for anything you did not mean to keep.
2. **The container did not rebuild.** `docker compose ps` for the created time.
   Docker will happily reuse a cached layer; `docker compose build --no-cache`
   settles it.
3. **The browser is holding the old shell.** The build pill shows both versions
   when this is the case. A normal reload is not always enough because the
   service worker answers first — pull-to-refresh twice, or close every tab of
   the site and reopen it.


**Never run `npm run compile` on the host.** The ABIs are committed precisely so
the image needs no Solidity toolchain; compiling on a small instance runs it out
of memory.

### How the two deployment files decide

`deployments/arc.json` is committed and reviewed. `deployments/arc.local.json`
is gitignored and records contracts deployed *from the dashboard on that host*,
which by definition are not in the repo yet.

The committed file is the base. The local file overlays only the keys it names
in its `overrides` list — so what a host deployed itself keeps winning, and what
it merely remembers from an older release does not. Anything the committed file
has never heard of (the pool's asset list, for instance) is taken from the local
file regardless, since there is nothing to overrule.

Every disagreement is named at startup:

```
[deployment] local override in effect for tesseraPool
[deployment] deployments/arc.json is newer for tesseraGauge — using the committed
             addresses. Add these to the "overrides" list in
             deployments/arc.local.json, or delete that file, if the local ones
             were meant to win.
```

A file written before `overrides` existed has no list, so its stale addresses
are overruled and its host-only keys are kept — which is the right answer for
every host that has ever been patched by hand. Deleting `arc.local.json`
entirely is also safe on a host that has never deployed from the dashboard.

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

### Replacing only the lending pool

There are three ways to move onto newer pool code, and picking the wrong one is
expensive. They are not variants of each other:

| Command | Replaces | Carries the live risk config | Moves positions |
|---|---|---|---|
| `pools:reset` | pool + vault + AMM + router | no — its own constants | yes |
| `redeploy:pool` | pool + emissions, and rewires guard / emitter / gauge | **yes, read off the chain** | no |
| `migrate:pool` | nothing | n/a | yes |

`redeploy:pool` is the one to reach for when the *pool* is the problem and the
rest of the protocol is fine. It reads every collateral factor, cap, rate curve,
price feed and e-mode assignment off the pool that is live now and reproduces
them on the replacement, so the only thing that changes is the code. `pools:reset`
would instead apply the constants written into that script — which are how the
pool *started*, not how it is running after every risk tweak since.

```bash
npm run redeploy:pool                              # survey: reads only, sends nothing
npm run redeploy:pool -- --emitter=keep --execute
npm run migrate:pool -- --execute
```

No addresses to copy in the third line, deliberately. `redeploy:pool --execute`
rewrites the deployment record — `tesseraPool` becomes the replacement, the pool
it superseded is filed under `tesseraPoolLegacy` — and `migrate:pool` reads both
from there. Passing them by hand is where a shortened address like `0x4e7d2a13…`
gets pasted out of a console and fails at the twentieth transaction; the flags
still work if you need them, and a value ending in `…` is now rejected by name.
Running it before the redeploy, with no legacy pool recorded, still requires
`--to`.

Three things it will refuse to do, each for the same reason — they are decisions
rather than steps:

- **Run without `--emitter=…`.** `TesseraEmitter.lendingPool` is `immutable` and
  the emitter sizes every reward stream from that pool's `activityUsd()`. Pointed
  at a retired pool it reads no activity, sets every rate to zero, and stops
  emissions **without erroring** — the pages keep rendering. `--emitter=keep`
  accepts that knowingly.
- **`--emitter=replace`.** `TesseraToken` mints its whole supply to the emitter
  named in its constructor and has no `mint`, so a replacement emitter can only
  be filled by adding it as a sink on the current one and waiting out
  `maxRatePerSecond`. That is a schedule, not a transaction.
- **List an asset borrowable that the price guard does not band.** The script
  asks the guard to price the asset 50% away from its mark; if the guard accepts
  it, nothing is checking that price and the asset stays supply-only. Band it
  first with `setPeg`.

What it deliberately does *not* seal: the old pool is frozen against new supply
and new borrowing (`FREEZE_SUPPLY | FREEZE_BORROW`), never against withdrawal or
repayment. Anyone the migration cannot reach — an account with debt, or one a
partial log scan missed — has to keep being able to get out and to settle up.

`TesseraVault.pool` is `immutable` too and is left alone: its depositors keep
earning from the old pool, which still holds their capital and still accrues.
That is safe, but it means the vault's yield is now the retired pool's yield.

Rehearse the whole thing against a throwaway chain first — it is part of
`npm run verify`, and can be run on its own:

```bash
npm run rehearse:redeploy
```

It deploys a small protocol configured away from every default, runs the real
script at it through its real CLI, then reads the chain back: risk parameters,
caps, curves, the guard's verdict both before and after banding, the emissions
chain, an earned reward balance surviving the move, the freeze mask, and the
`supplyFor` handoff. The odd numbers in the fixture are the point — a carry-over
that silently falls back to a default shows up as a mismatch instead of agreeing
by coincidence.

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
default 6000) and `ARC_RPC_CONCURRENCY` (how many RPC calls may be open at once,
default 6, adapting between 2 and 8). Raise the second on a private endpoint;
raise the first if the public node throttles you.

`ARC_RPC_MIN_INTERVAL_MS` — the old fixed gap between calls — is still read, as
a rate of `1000/interval`, so existing `.env` files keep working. It is no
longer the right knob: measured against Arc's public RPC, fifteen `eth_getLogs`
sent back to back with no gap are all served and ten sent at once have four
refused. The limit is concurrency, not spacing, so spacing calls out spends
latency without buying anything. Unset it and let the defaults adapt.

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
