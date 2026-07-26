# Security audit & posture

Security review of the Tessera branch, focused on the surfaces that hold or move
value: the lending contract, the dashboard API + Web3 login, and the wallet
seams. **This is unaudited testnet software** — a professional audit is required
before any mainnet or real-funds use.

## Findings

### 1. Authorization on state-changing dashboard endpoints — MEDIUM → fixed

The dashboard's mutating endpoints (`/api/run`, `/api/faucet`,
`/api/lending/:action`, `/api/approvals/:id/:verdict`) were originally
unauthenticated, while the Web3 (SIWE) login issued sessions that nothing
enforced. On a public deployment any visitor could drive the agent's wallet or
approve guardian escalations (bypassing the human-co-signer control).

**Fix:** mutating endpoints now require an authenticated session (admin login or
a signed-in Web3 wallet), checked server-side via a bearer token. Read endpoints
(`/api/state`, `/api/actions`) remain public. See `agent/src/auth.ts` and the
`requireAuth` guard in `agent/src/dashboard.ts`.

### 2. Any connected wallet could spend the agent's wallet — MEDIUM → fixed

`requireAuth` accepts **any** wallet that completes SIWE. But the DeFi endpoints
execute with the **server-side agent key**, so a merely-connected visitor could
move the operator's funds (lend, deposit to the vault, swap, drip the faucet,
approve guardian escalations). Nothing could be stolen — outputs return to the
agent's own custody — but a stranger could churn the operator's balances and
burn fees/slippage.

**Fix:** a stricter `requireOperator` gate (admin session only) now guards every
endpoint that spends the agent's wallet: `/api/lending/:action`,
`/api/vault/:action`, `/api/swap`, `/api/faucet`, `/api/run`, and
`/api/approvals/:id/:verdict`. Connected wallets keep **full read access** plus
the public `/api/swap/quote`.

### 3. Vault & swap contract review — no exploitable findings

`TesseraVault` and `TesseraSwap` were reviewed for the usual DeFi failure modes:

| Checked | Result |
|---|---|
| Reentrancy | `nonReentrant` on every entry point; shares burned **before** external transfers |
| First-deposit share inflation | Blocked — `MINIMUM_LIQUIDITY` (1000) dead shares burned on first deposit (Uniswap-style) |
| Fee on principal | Impossible — the performance fee is charged only on `totalAssets` **growth** since the last checkpoint |
| Unbounded admin fees | Hard caps in code: performance fee ≤ 30%, swap fee ≤ 5%, app fee share ≤ 100% of the fee, vault reserve ratio ≥ 80%, AMM LP fee share ≥ 50% |
| Swap paying out more than it holds | Blocked — solvency check requires `balance ≥ amountOut + appFee` before any transfer |
| Slippage | `minOut` enforced on every swap |
| Rebalance bricking withdrawals | `_rebalance()` is wrapped in `try/catch`, so a pool hiccup can't block a deposit/withdraw |

## Two custody modes (and why they differ)

The dashboard exposes the same DeFi actions through two distinct paths:

| | **Self-custody** (default) | **Agent wallet** (operator) |
|---|---|---|
| Whose funds move | the connected user's | the app's agent wallet |
| Who signs | the user's browser wallet | the server, with `AGENT_PRIVATE_KEY` |
| Auth needed | none — the wallet *is* the auth | admin sign-in (`requireOperator`) |
| Server sees a key | never | yes (its own) |

Self-custody calldata is assembled in the browser from selectors served by
`GET /api/defi/config` (public chain metadata; selectors are derived from the
contract signatures at runtime so they cannot drift). The server is not in the
trust path: it cannot move a user's tokens, and a compromised server still
cannot spend user funds — only the agent's own.

Because self-custody needs no sign-in, keeping the operator path admin-only
(Finding 2) costs users nothing: anyone can transact with their own money, while
only the operator can spend the app's.

## Economic safety model (AMM liquidity pools)

`TesseraAMM` lets anyone provide liquidity and earn swap fees. Its design choices
are mostly about what an operator **cannot** do:

| Property | How it is guaranteed |
|---|---|
| Providers keep ≥ 50% of swap fees | `MIN_LP_SHARE = 5000` is a `constant`; `createPool` and `configurePool` both reject less. There is no admin path to change it — only a redeploy. |
| Fee rounding never favours the app | The app's cut is computed first and rounded **down**; the LP cut takes the remainder, so an odd wei always lands with providers. |
| No oracle to manipulate | Price comes from the pool's own reserves (constant product on the traded pair). Nothing external feeds it, so there is no oracle to move ahead of a trade. |
| First-depositor share inflation | `MINIMUM_LIQUIDITY` (1000) shares are burned to `address(0)` on the first deposit, exactly as in Uniswap v2. |
| Unbalanced deposits can't mint free value | Shares minted are the **minimum** ratio across every asset, so skewing one side donates the excess rather than buying shares. |
| A kill-switch can't trap funds | `setFrozen` blocks swaps and deposits; `removeLiquidity` is deliberately exempt, so providers can always exit a frozen pool. |
| Reentrancy | `nonReentrant` on every entry point; in `removeLiquidity` shares are burned and reserves debited **before** any token transfer. |
| Output leg draining to zero | `amountOut = balOut·net/(balIn+net)` is strictly less than `balOut`; the contract also asserts it. |
| Accounting drift | Reserves are tracked per pool rather than read from `balanceOf`, so a stray token transfer into the contract cannot be swapped out or counted as liquidity. |

The app's half of the fees goes to a second `TesseraFeeCollector` instance
configured with `setAmm`, which splits it 20% back into the pool / 20% lending /
20% vault / 20% agent / 20% retained on the same cadence as the main collector.
Funding a pool uses `fund()`, which credits reserves **without minting shares**,
so the value accrues to existing providers — including the app's own position —
rather than diluting them.

**Residual risk (not eliminated):** impermanent loss is inherent to any
constant-product AMM. A provider who deposits into a pool whose assets diverge in
price ends up with less value than simply holding. This is a property of the
model, not a bug, and the UI states the fee split rather than promising a return.

## Economic safety model (vault)

The vault is deliberately conservative:

- **Liquid reserve buffer.** `reserveRatioBps` (floor **80%**, default **80%**) is
  always held as idle tokens in the vault, so routine withdrawals never touch the
  pool. Only the excess earns APR.
- **Yield split.** Depositors keep **≥ 70%** of all yield by construction
  (`MAX_PERFORMANCE_FEE = 3000` bps); the default split is **85% user / 15% app**.
  The fee is minted as shares against the *gain only* — principal is never taxed.
- **Withdrawal path.** Buffer first, then unwind pool supply, bounded by the
  pool's free cash. `maxWithdraw(user)` returns exactly what's withdrawable right
  now, and the UI's **Max** uses it — so the button never proposes an amount that
  would revert.

### Residual risks (honest limits — these are NOT eliminated)

1. **Pool utilisation risk.** If pool borrowers draw down *all* free cash, the
   portion of vault funds deployed to the pool is temporarily unwithdrawable
   until borrowers repay or interest lures new supply. At the 80% floor at least
   four fifths of TVL is always redeemable instantly, so this can only bite a
   withdrawal of more than 80% of TVL during full utilisation. Funds are not
   lost — they're illiquid.
2. **Prices with no feed wired.** Where no oracle is configured, the pool and
   the swap desk fall back to the operator-set price, and a stale one lets an
   arbitrageur drain the underpriced side of the swap inventory. Wiring a
   Chainlink-compatible feed per asset removes this (see below); until one is
   wired for a given asset, the risk stands for that asset.
3. **Trusted operator key.** The owner can change fees (within caps), prices, the
   treasury, and can withdraw swap inventory. This is a custodial trust
   assumption, not a trustless design.
4. **Unaudited.** No third-party audit has been performed. Do not use with real
   funds until one has.

## Price oracle

Each reserve may be pointed at a **Chainlink-compatible aggregator**
(`AggregatorV3Interface` — the same interface Aave and Compound consume, and the
one Chronicle, Pyth's `PythAggregatorV3` wrapper and RedStone's classic adapter
all expose). Once a feed is wired it is the **only** price source for that asset;
the operator-set price is ignored.

Every reading is validated before use:

| Check | Why it is there |
|---|---|
| `answer > 0` | A broken or de-registered feed answers zero or negative. |
| `updatedAt != 0` | An unfinished round has no usable answer yet. |
| `answeredInRound >= roundId` | Catches an answer carried over from an earlier round. |
| `block.timestamp <= updatedAt + staleAfter` | A stale price is what lets someone borrow against a mispriced asset. |
| Feed decimals normalised to 1e8 | An 18-decimal feed read as 8-decimal is a 10-billion-times mispricing. |

**A failed check pauses the market; it never falls back.** Falling back to a
manual price on oracle failure is the tempting choice and the wrong one — it
converts a visible outage into a silent mispricing. An operator who wants the
manual price back must clear the feed deliberately. `priceOk(asset)` answers the
same question without reverting, so the UI can say "paused" instead of blanking.
A bad feed address is rejected at configuration time by test-reading it, rather
than surfacing at someone's next withdrawal.

## Freeze controls

`frozenActions` is a per-reserve bitmask over supply / withdraw / borrow / repay
rather than a single paused flag, because the incident it exists for — a
suspicious position under investigation — calls for stopping *new* risk while
letting people reduce exposure. **Liquidation is never frozen**: blocking it
during a freeze would let bad debt compound against the very depositors the
freeze protects. `supplyFor` is subject to the same masks, so migration is not a
route around a halt.

Hiding a reserve is presentation only. It does not freeze anything, and the
dashboard keeps showing any reserve the viewer holds a position in — a shortened
list must never stand between someone and their own funds. The same rule governs
the "show at most N" caps.

## Contract history and fund recovery

Two properties do the work here:

1. **The archive is an index, not a ledger.** Holder *sets* come from event logs;
   every *amount* is read live from the contract, and re-read immediately before
   any payout or migration. A stored snapshot only decides who to look at. Stale
   snapshots are flagged, and an incomplete log scan is reported rather than
   hidden — it under-reports *who*, never *how much*, which is the safe direction
   to fail.
2. **Nothing can move a user's position.** There is deliberately no function in
   any of these contracts that lets an operator reassign someone's shares. That
   primitive is a rug pull regardless of intent, so it does not exist. Migration
   works through `supplyFor` / `depositFor` / `addLiquidityFor`, where the caller
   pays and the beneficiary receives; naming someone as beneficiary cannot pull
   from their wallet. Their claim on the old contract is left intact, so they end
   up able to withdraw from either.

A holder is marked settled only when every asset leg landed — a half-paid holder
that reads as "done" is the failure mode that actually loses people money — and a
refresh preserves settlement marks so re-reading the chain cannot re-open
completed work.

## Notices

Notice text is stored raw and rendered with `textContent`, never `innerHTML`.
Colour is the one field that reaches a `style` attribute, so it is validated
server-side against `#rgb` / `#rrggbb` and a fixed list of theme variables;
anything else falls back to the default. Both paths are covered by browser tests
that attempt injection. Reads are public — a maintenance warning nobody can see
is worthless — and writes are operator-only.

## Transaction history

The history is an **activity log, not a ledger** — balances are always read from
the contracts, never derived from it. Two access levels, and the boundary between
them is the part that matters:

- A signed-in user reads only their own entries. `forceActor` is pinned to the
  session address **server-side and applied last**, so no query parameter can
  widen the scope. The filter facets a scoped caller receives contain no other
  users' addresses at all, so the list of who exists is not disclosed either.
- An operator reads across every user, with filters and CSV export.

Self-custody transactions are reported by the browser, because the server never
sees them — it holds no key and is not in the signing path. That write can only
ever land in the caller's own history, and a transaction hash is validated
against `/^0x[0-9a-fA-F]{64}$/` before storage: a wallet's response is untrusted
input. Every rendered field goes through `textContent`-equivalent escaping;
browser tests plant `<img onerror>` and `<svg onload>` payloads in the detail and
amount fields and assert that nothing executes and no element is injected.

## Live market and news feeds

Public reads, cached server-side. The security-relevant properties:

| Property | Why |
|---|---|
| No fabricated numbers | An unreachable feed reports the reason. It never substitutes a plausible figure — someone might trade on it. |
| Every panel names its source and age | A stale value stays visible but is labelled, rather than silently passing as current. |
| RSS content is never rendered as markup | Titles and links come from third parties. Titles are escaped; links are validated as `http(s)` and carry `rel="noopener noreferrer"`. |
| Hard timeouts on every upstream fetch | A hung upstream cannot hang a request to this server. |
| Only the visible tab polls | Keeps the app inside upstream rate limits, so the panel does not degrade itself. |

## Route ordering

Express matches in registration order, so a literal path registered *after* a
`:id` sibling is unreachable. This produced a real bug once —
`/api/notices/delete` was matched as a notice with the id `"delete"`, so bulk
delete silently 404'd. Every collection endpoint now registers its literal
routes first (`/delete`, `/merge`, `/archive`, `/mine`, `/transactions`) with an
explanatory comment, and the API test suite exercises each one.

## Design assumptions (not bugs, but worth stating)

- **Trusted admin/deployer key.** Whoever holds the pool owner / deployer key can
  add reserves, set prices where no feed is wired, freeze actions, and set the
  treasury. Keep it in an HSM / DCW for production.
- **Operator-funded recovery.** "Return funds" and "Migrate" spend the app's own
  wallet. They are payouts, not seizures, and both depend on that wallet holding
  enough — there is no mechanism that conjures the funds from users.

## Hardening added (highest-level dashboard security)

- **Arc-only runtime.** The app no longer runs a local Hardhat chain with public
  dev keys — it requires the real Arc deployment + `AGENT_/PROVIDER_PRIVATE_KEY`
  and exits otherwise. No well-known private keys anywhere in the running app.
- **Strict Content-Security-Policy.** The dashboard script is an external file
  (`app.js`), so the CSP forbids inline scripts: `script-src 'self'`,
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`,
  `connect-src 'self'`. Plus `X-Frame-Options: DENY`, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera/mic/geo
  off), and `Strict-Transport-Security` (HSTS).
- **Brute-force lockout.** 5 failed admin logins from an IP → 15-minute lockout
  (429). `trust proxy` is set so the real client IP is used behind Caddy.
- **Session expiry.** Admin and Web3 sessions expire after 12h.
- **Bounded JSON bodies** (64 KB) and `x-powered-by` disabled.
- **Auth required** on every state-changing endpoint (see Finding 1).

## What was checked and found clean

- **No reentrancy / share-inflation** in `TesseraPool`: internal asset
  accounting (not `balanceOf`), `nonReentrant` on all value-movers,
  checks-effects-interactions ordering.
- **SIWE** uses viem `verifyMessage` with single-use server nonces and
  UUID session tokens; replay-protected.
- **No XSS**: dashboard renders server-generated state or uses `textContent`; no
  untrusted input reaches `innerHTML`. Wallet-supplied transaction hashes are
  validated against `/^0x[0-9a-fA-F]{64}$/` before being put in a link, and
  operator notice text and colours are covered by injection tests.
- **Route shadowing**: literal API routes are registered before their `:id`
  siblings. This was a real bug — `/api/notices/delete` was being matched as a
  notice with the id `"delete"`, so bulk delete silently 404'd — and it is now
  covered by API tests for every collection endpoint.
- **AMM invariant**: swap pricing runs on the input net of the whole fee, and the
  pool is credited everything except the app's cut, so `k` strictly grows by the
  LP fee on every swap. Asserted by test against real balances, not just reasoning.
- **Fee rounding direction**: the app's cut is rounded down and the LP cut takes
  the remainder, so an odd wei always lands with liquidity providers.

## Secrets policy

- Private keys, the admin password, and the app wallet key are **never committed**
  — they live in `.env` / a gitignored admin credential file, and only their
  hashes / public addresses are used at runtime.
- `.gitignore` covers `.env`, `.env.*` (except `.env.example`), and the admin
  credential store.
- Before real funds: rotate all keys, move signing to Circle DCW / an HSM, and
  commission a professional smart-contract audit.

## Dependency advisories

```
npm run audit          →  clean
npm audit --omit=dev   →  found 0 vulnerabilities        (the tree that ships)
npm audit              →  13 low, 0 moderate, 0 high     (was 51: 19/9/23)
```

Nothing that runs in production has an advisory, and nothing at any severity
above **low** has one anywhere. What is left is a single unfixable advisory
counted thirteen times; the detail is below.

### What was actually wrong

Not the count — the `Dockerfile`. It ran a plain `npm install`, so the whole
Solidity toolchain was installed into the image that serves the site, even
though nothing under `agent/`, `shared/` or `providers/` imports Hardhat and
nothing reads its build artifacts. The build is now two stages: the builder
compiles the contracts (which exports the ABIs and bytecode into `shared/src/`),
and the runtime stage does a fresh `npm install --omit=dev`. That takes the
shipped tree from **423 packages to 95** and drops the native build toolchain.
Verified by assembling the runtime stage's exact contents and serving real
requests from it — `/`, `/api/state` and the feed routes all 200, live Arc reads
intact, Hardhat absent.

`tsx` is therefore a **production** dependency of the agent, not a dev one: the
app is served straight from its TypeScript sources via `node --import tsx`, so it
is a runtime loader here. Under `devDependencies` an `--omit=dev` install could
not start.

### Getting the count down: 51 → 13

**Dropped `@nomicfoundation/hardhat-toolbox-viem` (51 → 26).** The toolbox is an
aggregator. Of the five plugins it registers, this project uses two —
`hardhat-viem` for `hre.viem`, plus its `chai.use(chaiAsPromised)` setup for the
tests' `.to.be.rejected`. The other three (`hardhat-verify`,
`hardhat-ignition-viem`, `hardhat-gas-reporter`, `solidity-coverage`) are unused:
there is no ignition module, no coverage script, and `REPORT_GAS` is never set.
They were dragging in the entire ethers v5 tree. `contracts/hardhat.config.ts`
now names the two plugins directly.

**Pinned fixed versions of vulnerable transitives via `overrides` (26 → 13).**
Every remaining advisory except one had a published fix that Hardhat's own
version ranges were holding back:

| Override | From | Advisory range | Reached via |
|---|---|---|---|
| `adm-zip` ^0.6.0 | 0.4.16 | `<0.6.0` | hardhat |
| `brace-expansion` ^5.0.8 | 1.1.x / 2.0.x | `<=5.0.7` | mocha → glob → minimatch |
| `cookie` ^0.7.2 | 0.4.2 | `<0.7.0` | hardhat → @sentry/node 5 |
| `diff` ^8.0.3 | 7.0.0 | `>=6.0.0 <8.0.3` | mocha |
| `serialize-javascript` ^7.0.7 | 6.0.2 | `<=7.0.2` | mocha |
| `tmp` ^0.2.7 | 0.0.33 | `<=0.2.3` | hardhat → solc |
| `undici` ^6.28.0 | 5.29.0 | `<6.23.0` | hardhat |
| `uuid` ^11.1.1 | 8.3.2 | `<11.1.1` | hardhat |

Three of those (`diff`, `serialize-javascript`, `brace-expansion`) are inside
mocha, which is the contract test runner — so these overrides are load-bearing
for the build, not cosmetic. They are verified: a clean recompile on them
produces **byte-identical** bytecode, and 104/104 contract tests plus 140/140
agent tests pass.

### The 13 that remain

All thirteen are one advisory — [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84),
`elliptic` "uses a cryptographic primitive with a risky implementation" (low,
CVSS 5.6) — plus the twelve packages npm lists for containing it:
`@ethersproject/{abi,abstract-provider,abstract-signer,hash,signing-key,transactions}`,
`ethereum-cryptography`, `ethereumjs-util`, `secp256k1`, `hardhat`, and the two
hardhat plugins.

It cannot be fixed from here, for a concrete reason: the advisory covers
`elliptic <=6.6.1` and **6.6.1 is the latest published release** — there is no
patched version to pin. It arrives through `hardhat@2` → `@ethersproject/abi`,
which ethers v5 (frozen) resolves to `elliptic`. npm agrees: the fix it proposes
is `@nomicfoundation/hardhat-network-helpers@3.0.11`, i.e. **the Hardhat 3
plugin line**.

Hardhat 3.11 does drop the whole tree — no `@ethersproject/*`, no `undici` 5, no
`@sentry/node` 5, no `mocha`. Migrating to it would reach a genuine zero. It is
deliberately **not** done here: Hardhat 3 is a rewrite (ESM config, `plugins`
array, no `hre` global, `network.connect()`, a different test runner), so it
means rewriting the config and all 11 contract test files. Trading a verified
104-test suite for a low-severity advisory in a tool that no longer ships is the
wrong trade to make unprompted — but it is the route if a zero-tolerance policy
requires it.

`npm run audit` encodes the position: the production tree must be clean, and the
full tree must be clean at moderate and above. A new advisory at any real
severity therefore fails the check instead of hiding in the noise.
