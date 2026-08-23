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

`TesseraVault` and the swap path were reviewed for the usual DeFi failure
modes. The swap path is now `TesseraRouter` over `TesseraAMM`; the rows that
used to be about the oracle desk's inventory are gone because the inventory is:

| Checked | Result |
|---|---|
| Reentrancy | `nonReentrant` on every entry point; shares burned **before** external transfers |
| First-deposit share inflation | Blocked — `MINIMUM_LIQUIDITY` (1000) dead shares burned on first deposit (Uniswap-style) |
| Fee on principal | Impossible — the performance fee is charged only on `totalAssets` **growth** since the last checkpoint |
| Unbounded admin fees | Hard caps in code: performance fee ≤ 30%, vault reserve ratio ≥ 80%, AMM LP fee share ≥ 50%, and an AMM pool fee that must be one of three fixed tiers (0.10% / 0.30% / 1.00%) rather than a free-form number |
| Swap paying out more than it holds | Not reachable — the router holds nothing; a swap is filled from pool reserves, and the AMM's own output check keeps `amountOut < balOut` |
| Slippage | `minOut` enforced on every swap, covering the **final** output of a multi-hop route |
| Stale-price arbitrage on swaps | Not reachable — swap pricing reads the pool's reserves, so no oracle sits in the path to go stale |
| A swap sitting in the mempool | `deadline` on every router entry point, so a transaction cannot be filled later at a drifted price |
| Router allowance left standing | Each leg approves the exact amount and clears it after the swap; a post-swap allowance of zero is asserted in tests |
| Rebalance bricking withdrawals | `_rebalance()` is wrapped in `try/catch`, so a pool hiccup can't block a deposit/withdraw |

### 4. The brute-force lockout could be walked around — MEDIUM → fixed

`req.ip` is what the admin-login lockout counts against, and Express derived it
with `app.set("trust proxy", true)`. That means the **leftmost** entry of
`X-Forwarded-For` — which the client writes, because Caddy appends to that
header rather than replacing it. So the attacker chose their own bucket.

Probed on the live deployment: six wrong passwords behind a *fixed* forged
header locked out on the sixth, exactly as designed; six behind a *varying* one
never did. The brake worked and could be stepped around.

**Fix:** `trust proxy` is now `1` — the number of proxies actually in front of
the process. Express takes the address Caddy itself observed, which no client
can forge, and a deployment with no proxy still falls back to the socket
address.

### 5. The guardian bypass became reachable in a deployment — MEDIUM → fixed

`autoApprove` turns the human co-signer into a rubber stamp, and the rule is
that it must never be reachable in a deployed configuration. That used to hold
because `docker-compose.yml` forwarded a hand-kept list of variables and neither
`TESSERA_AUTO_APPROVE` nor `TESSERA_ONCE` was on it — a property of the
deployment file rather than of the code. That list was later replaced with
`env_file` (fifteen real settings were being silently dropped by it), and the
side effect was that the switch could reach the container for the first time.

**Fix:** the rule lives in the code. On a live chain `autoApprove` is false
whatever the environment says, and the process logs loudly that the variable was
ignored rather than failing silently.

### 6. `?fresh=1` was an anonymous cache bypass — LOW → fixed

The governance and session reads cache because each is a dozen-odd contract
calls; `?fresh=1` skips the cache so a page that has just written does not read
its own stale answer. Anonymous, it was an amplifier: on the live deployment an
uncached `/api/gauge` costs three seconds of upstream RPC against about one
millisecond cached, so a shell loop could spend the operator's rate limit.

**Fix:** `fresh` is honoured only for an authenticated caller — which the page
that just made a transaction always is. Anonymous callers still get an answer;
they just get the cached one.

### 7. An expired admin session could still change the password — LOW → fixed

`changePassword` asked `sessions.has(token)`. The map keeps an entry until
something prunes it, and only `session()` checks the age, so a timed-out token
still opened that door. The current password was required as well, making it the
second lock rather than the only one — but a lock that opens for an expired key
is not a lock. It now goes through `session()`.

### 8. The guardian cap sat in the callers, and one checked the wrong number — HIGH → fixed

The rule is that the cap is enforced inside the one function that escrows
funds, "not repeated in each caller — a cap that callers must remember to check
is not a cap". It was repeated in each caller. Both of them checked something;
the invoice path checked the wrong thing.

`payInvoices` compared the **invoice's** amount against `autoApproveMax` and
then called `purchase`, which escrows the **quote's** price — bounded by
`quoteMatchesOffer` against the catalog entry, and not by the bill at all. The
two numbers are independent. A provider that invoiced a penny for a service
listed at a pound was escalated for the penny, approved for the penny, and paid
the pound: an unattended spend of the whole catalog price with no guardian ever
asked about it. Neither the cap nor the invoice budget bound the amount that
actually moved, because the budget was decremented by the invoice too.

Reproduced against a stub escrow: a service listed at 1 USDC, a cap of 0.005,
no guardian answering — 1 USDC reached `open()`.

**Fix:** one gate, inside `purchase`, immediately after the quote is validated
and immediately before anything moves — so the number it reads is the number
that will be escrowed. Both callers now do no checking of their own; a declined
spend comes back as a skipped ledger entry. The guardian is also asked to
approve the quoted price rather than the listed one, and the invoice budget is
decremented by what was escrowed rather than by what was billed.

The cost is one 402 quote request for a spend that is then declined. A quote
moves nothing; the alternative was moving money nobody approved.

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
| No oracle to manipulate | Price comes from the pool's own reserves. Nothing external feeds it, so there is no oracle to move ahead of a trade. |
| Fees cannot be dialled arbitrarily | Following Aquarius (Aqua Network), a pool's fee must be one of three tiers — 0.10%, 0.30% or 1.00%. A free-form fee fragments liquidity across near-identical pools and hands an operator a dial traders cannot anticipate. |
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

### Emission accrual is bounded by the pot

A holder may have, unclaimed, at most their share of what the emissions contract
actually holds:

```
pot × (this stream's rate ÷ every live rate) × (their shares ÷ all shares)
```

and every booking is bounded again by the balance not already promised to
somebody else. Together those give an invariant worth stating on its own:
**`totalOwed` can never exceed the contract's balance.** The same rule applies
to the AMM's liquidity emissions.

Why it is a security property and not a UI nicety: before it, accrual and
funding were independent, so the contract booked debt it could not pay and
`claim` settled `min(owed, held)` first come, first served. Whichever address
had accumulated the largest unbacked balance took every top-up before anybody
else could be paid, and a holder who arrived later was queueing behind a debt
they could never reach the front of.

What it costs: rewards no longer accrue at the posted rate when the pot is thin
— the rate is a ceiling, and the APR figures with it. That is the honest version
of what was already true.

**Operational rule for a migration:** checkpoint holders *before* moving a pot
to a new emissions contract. An unbooked entitlement is worth what the pot can
back at the moment it is read, so draining the pot first leaves nothing for the
old contract's `claimable` to report. A booked balance is counted in
`totalOwed`, which the redeploy explicitly refuses to sweep.

### Transfer memos are public and permanent

A transfer can carry a memo, written into the transaction's own calldata after
the encoded `transfer(to, amount)`. Solidity ignores calldata past the arguments
it decodes, so the payment is unchanged by it — but the memo is **on chain**:
public, permanent, unencrypted, and attributable to both addresses forever. It
is not the same thing as the note the app keeps beside it, which never leaves
the server, and the UI states the difference at the point of entry.

Two rules in code, because the memo is the least important thing in a payment:

- The call is **simulated with the memo attached** before anything is broadcast.
  Nothing on a chain owes Solidity's tolerance of trailing calldata — Arc's USDC
  is the gas token at a reserved address — so tolerance is tested, not assumed.
- If that simulation fails, the **plain transfer goes out instead** and the
  receipt says the memo was not attached. A payment is never risked, or
  silently skipped, for the sake of a note attached to it.

Bounded at 180 bytes: calldata is paid for in gas per byte by the sender.

### Residual risks (honest limits — these are NOT eliminated)

1. **Pool utilisation risk.** If pool borrowers draw down *all* free cash, the
   portion of vault funds deployed to the pool is temporarily unwithdrawable
   until borrowers repay or interest lures new supply. At the 80% floor at least
   four fifths of TVL is always redeemable instantly, so this can only bite a
   withdrawal of more than 80% of TVL during full utilisation. Funds are not
   lost — they're illiquid.
2. **Prices with no feed wired.** Where no oracle is configured, the lending
   pool falls back to the operator-set price, and a stale one lets someone
   borrow against a mispriced asset. Wiring a Chainlink-compatible feed per
   asset removes this (see below); until one is wired for a given asset, the
   risk stands for that asset. Swaps are **not** exposed to this: they price
   from AMM reserves, with no oracle in the path.
3. **Trusted operator key.** The owner can change fees (within caps), prices and
   the treasury. This is a custodial trust assumption, not a trustless design.
   It is a narrower one than it was: with the inventory desk gone there is no
   app-owned trading stock for an operator to withdraw, and the router holds
   nothing an owner could take.
4. **Unaudited.** No third-party audit has been performed. Do not use with real
   funds until one has.

## Money-market safety model (lending, borrowing, liquidation)

The pool follows Blend Capital's structure. Each mechanism below exists because
the simpler version of it has a specific failure:

| Property | How it is guaranteed |
|---|---|
| Borrowing to the limit is not immediately liquidatable | `cFactor` (how much you may borrow against collateral) is enforced strictly below `liqFactor` (where seizure starts). One shared threshold put the maximum borrow exactly on the seizure line, so the next block of interest made a just-opened position liquidatable. |
| A riskier debt costs more limit than its face value | Per-asset `lFactor`: a liability is weighed as `value × 10000 / lFactor`, so one pool can hold assets of genuinely different quality. |
| Utilisation cannot be driven to 100% | A third interest slope above 95% utilisation that the reactive modifier does **not** scale. Full utilisation is the state where suppliers cannot withdraw at any price, so the last five points are priced as a fence rather than a rate. |
| A persistently mispriced asset self-corrects | The reactive rate modifier integrates the utilisation error over time and multiplies the curve, bounded hard to [0.1×, 100×]. A static curve keeps quoting the same number no matter how long an asset has been wrong. |
| Suppliers are not first in line for a loss | The backstop is paid `backstopTakeRate` of borrower interest and absorbs bad debt before supplier balances are touched. Exits are queued for 21 days: capital that can leave the moment a loss becomes visible is not insurance. |
| Bad debt is recognised, not hidden | `clearBadDebt` is permissionless. Unrecognised bad debt means every supplier who withdraws in the meantime is paid at a rate that silently overcharges whoever is left. |
| Liquidation cannot over- or under-shoot | An auction's percentage must leave the borrower's health factor inside [1.03, 1.15] once fully filled. Below the floor they are liquidatable again on the next tick; above the ceiling more collateral was sold than the problem required. |
| A large position can actually be cleared | Auctions can take up to 100% of the auctioned debt and can be **partially filled**, so several liquidators can clear together instead of one needing the whole repayment on hand. |
| The liquidation bonus is discovered, not guessed | A descending auction: the lot ramps 0% → 100% over ten minutes at a full bid, then the bid decays over the next ten. A fixed bonus is too much for a position that would clear at 2% and too little for one nobody will touch under 20%. |
| A late filler cannot take collateral for free | `MIN_BID_BPS = 1000` floors the descending bid — a deliberate departure from Blend, which lets it reach zero. Without the floor, waiting out the ramp takes the whole lot while removing no debt at all. |
| An abandoned auction cannot block future ones | `cancelLiquidationAuction` is permissionless once the borrower recovers, or once the auction is stale. Otherwise opening an auction nobody intends to fill is a denial of service. |

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
routes first (`/delete`, `/merge`, `/archive`, `/mine`, `/transactions`,
`/repoint`) with an explanatory comment, and the API test suite exercises each
one.

## One gate for everything that gets scheduled

A scheduled task and a step of a task series ask the same question — *run this
verb later, with the app's key or with a delegation of mine* — so both go
through one function, `gateScheduled` in `agent/src/dashboard.ts`. It checks, in
this order: the venue and verb exist; a non-operator is confined to `wallet` and
`sessionSend`/`sessionBulk`; the session named is one **their own wallet**
opened; and the parameters describe something that could actually run.

This mattered when series stopped borrowing tasks and started owning their
steps. Previously a series could only name tasks that had already been through
the task gate, so the tasks *were* the choke point. A series that carries its
own steps would have been a second door onto the same spending, with whatever
checks its own route happened to remember — so the rule moved into one place
that both routes call. There is no path that schedules a spend without passing
it.

Running a step goes through the same door for the same reason: `executeSeries`
hands each step to `executeTask`, the function a scheduled task has always gone
through. A series has no executor of its own, so it cannot have a weaker one —
each step is validated, logged to the ledger, and honours the same stop flag.

| Question | Answered by |
|---|---|
| May this caller schedule this verb at all? | `gateScheduled`, called by `/api/tasks`, `/api/tasks/:id`, `/api/series`, `/api/series/:id` |
| Whose funds does it move? | The verb. Everything not named `session…` spends the app's wallet and is operator-only; the `session…` verbs spend the caller's own delegation and nothing else |
| Whose delegation may it name? | The session's on-chain `owner` must equal the authenticated wallet |
| What actually spends? | `executeTask` → `runTask`, for a task and a series step alike |

## Scheduling DeFi out of a visitor's own wallet

A session key can do exactly one thing: `transferFrom(owner, to, amount)`,
bounded by a cap, a per-payment ceiling, an optional allow-list and an expiry
the owner set. It cannot call the pool. So a visitor's scheduled supply cannot
be one transaction — the money has to move, and then be paid in.

What makes that safe rather than custodial in effect is that the pool, the vault
and the AMM each carry a `…For` entry point whose contract comment says it
plainly: *you pay, they get the position*, permissionless because giving
somebody your money can only help them. The app wallet pays in and the position
is minted to **the visitor**. At no point is the position the app's, and there
is no admin primitive in any of those contracts that could move it afterwards —
deliberately, because that primitive is indistinguishable from a rug pull.

| Verb | Legs | Who ends up holding it |
|---|---|---|
| `lending:sessionSupply` | `spend(session → app)` then `pool.supplyFor(asset, visitor, amount)` | the visitor |
| `lending:sessionRepay` | `spend(session → app)` then `pool.repayFor(asset, visitor, amount)` | the visitor's debt is reduced |
| `vault:sessionDeposit` | `spend(session → app)` then `vault.depositFor(visitor, amount)` | the visitor |
| `amm:sessionAdd` | one `spend` **per pool asset**, then `amm.addLiquidityFor(poolId, visitor, amounts, 0)` | the visitor |
| `amm:sessionSwap` / `swap:sessionSwap` | `spend(session → app)`, the swap, then the proceeds are transferred on | the visitor |

Adding liquidity needs one delegation per asset because `_addLiquidity`
requires every amount to be above zero — it mints nothing for a one-sided
deposit — and a session key moves exactly one token. Every session named must
belong to the same wallet, checked in `gateScheduled` across the whole list
rather than only the first: one unchecked id there is somebody else's money.

A swap is the one case where nothing is created in the visitor's name, because
neither the AMM nor the router takes a recipient. The proceeds land in the app
wallet and are forwarded in a third transaction, and the amount forwarded is
read from **that swap's own transfer logs** — with the *difference* in balance
as the only fallback, never the balance itself. The app wallet holds hundreds of
EURC of its own on the live deployment; forwarding a balance rather than a delta
would hand a visitor all of it the first time a receipt could not be read.

Its slippage floor is a share of a quote taken **at run time**, not a stored
`minOut`. A fixed floor on a recurring trade is wrong within a day: either it
blocks every run once the price moves, or it is so loose it protects nothing.
The share is clamped to 0.1%–10%.

### The window between the two legs, and what closes it

Between them the visitor's funds sit in the app wallet. That window is the whole
risk of the feature, so `runSessionFunded` in `agent/src/dashboard.ts`:

1. **simulates the second leg first**, and moves nothing if it would revert —
   frozen reserve, supply cap, unknown asset, zero amount are all caught here,
   before the visitor's money has left their wallet;
2. **returns the funds** to the wallet they came from if it fails anyway;
3. **records stranded funds loudly** if even the return fails — naming the
   amount, the address holding it and the address owed — because an operator
   who cannot see stranded funds cannot return them.

The amount is never more than the session's own remaining cap. That ceiling is
the contract's, enforced on chain in the first leg, not this function's.

Two things are refused at the form rather than at run time: an asset that is not
the session's own (spending one token and crediting a position in another is a
mistake nothing downstream could detect), and a restricted session whose
allow-list omits the app wallet (every run would revert at the first leg).

### The dry run, and the one thing it cannot tell you alone

Every settling call pulls its tokens from the app wallet, so simulating one
before the visitor's funds have arrived reports a failure for a reason that is
about to stop being true. `runSessionFunded` separates the two by asking
whether the app wallet already holds enough: if it does, a failed simulation is
a real refusal and nothing moves; if it does not, the answer is unknown and the
check runs again once the funds are here, refunding rather than broadcasting if
it still fails. The settling call is never broadcast without a simulation
agreeing to it — the difference is only whether a refusal costs a refund or
costs nothing.

## Scheduling an exit: the authority runs the other way

Everything above pays *in*, funded by a session key. Leaving a position pays
*out* of something the visitor already holds, and no session key can reach a
position — a session moves tokens. So an exit is authorised on the position
itself, by its holder, from their own wallet:

| Verb | Authority | Where the proceeds go |
|---|---|---|
| `amm:sessionRemove` | `approveShares(poolId, app, n)` — an ERC-20-style allowance the AMM already gives LP positions | taken as shares, burned, and the tokens transferred on |
| `vault:sessionWithdraw` | `setPositionOperator(app, true)` on the vault | **paid to the holder by the contract itself** — nothing passes through the app wallet at all |

Two rules hold for the vault operator permission no matter who the operator is,
and neither may be relaxed:

1. **The assets go to the holder.** `withdrawFor` transfers to `user`, never to
   `msg.sender`. An operator triggers the exit and can never receive it, which
   is the whole difference between "act for me" and "take from me".
2. **Every limit the holder's own call would face still binds**, because it is
   the same code path with the address supplied rather than assumed.

It is off for everybody until the holder turns it on, and revocable in one
transaction from their wallet. Contract tests assert the refusal for an operator
nobody named, that the operator's balance does not move, and that revoking stops
it immediately.

An exit takes its owner from the **task's** `owner`, never from a parameter. A
task that could name whose position to unwind is a task that could unwind
anybody's.

The AMM exit is the one with a window: the shares are held by the app between
being taken and being burned. The burn is simulated once they are actually here
and the shares handed straight back if it would revert; what is forwarded is
measured from the burn's own transfer logs, never from a balance; and anything
that cannot be given back is recorded as stranded, named and loud.

Lending has the same permission, reached through `actFor(asset, user, amount,
borrowing)` — one entry point rather than two named ones because the contract
had room for one. `lending:sessionWithdraw` and `lending:sessionBorrow` use it,
and like the vault they have no window: the pool pays the holder directly.

**Borrowing on somebody's behalf deserves saying out loud.** It creates debt for
the holder, which is a real authority and not a symmetrical one with
withdrawing. It is bounded the same way their own borrow is — collateral,
health factor, caps, liquidity, freezes, all checked against *their* account —
and the proceeds go to them. But an operator can still take a holder closer to
liquidation than they might have chosen. That is what the permission means, it
is theirs to grant, and it is one transaction to take back.

### Making it fit: what came out of TesseraPool

The permission needed about 430 bytes and the deployed pool had 66 spare against
the 24,576-byte EIP-170 limit. Lowering the optimizer makes it *larger* under
`viaIR` (24,760 at runs:1), so the space came from merging entry points that
were separate for readability rather than necessity:

| Was | Is now |
|---|---|
| `setPriceGuard` · `setRiskOracle` · `setRateLimiter` · `setTreasury` | `setWiring(slot, address)` |
| `setBorrowable` · `setReserveHidden` | `setReserveFlag(asset, flag, on)` |
| `setFrozen(address,uint8)` · `setFrozenMany(address[],uint8)` | `setFrozenMany` only — the plural survived, because the emergency case is "stop everything now" and that has to stay one transaction |
| `setEmodeEnabled(uint8,bool)` | an `enabled` argument on `setEmodeCategory` |

No control was lost. Every merged function keeps its behaviour, its events and
its `onlyOwner` gate; a single reserve is a one-element array; and the
timelock's instant-execution allowlist keeps the freeze brake, now naming the
plural selector. The result is 24,368 bytes with 208 spare.

**This is a redeploy, not a flag.** The pool on a running deployment has no
`actFor`, so the app asks it — `canActForHolders()` — and refuses the verb with
an explanation rather than reverting. `npm run redeploy:pool` migrates the
positions; the rehearsal in `npm run verify` runs that migration end to end
against a real chain on every commit.

## Session keys: what can be changed, and by whom

`TesseraSessionKeys` has `open` and `revoke` and nothing between them. A
session's cap, per-payment ceiling, expiry and allow-list are fixed at the
moment the owner signs for them, and no later call — by the owner, the session
key, or this app — can widen any of them. That is deliberate: a delegation whose
limits could be edited afterwards is worth less than the signature that created
it.

So "raise the cap" or "extend the expiry" is a **replacement**, not an edit: a
new session is opened, any scheduled tasks are moved onto it, and only then is
the old one revoked. The page says so rather than implying an edit, and the
order matters — revoking first would leave every scheduled payment pointing at a
dead session.

| Control | Where it is enforced |
|---|---|
| Cap, per-payment max, expiry, allow-list | `TesseraSessionKeys.spend`, on every payment |
| A session with no time limit | Not a mode — it is an expiry of `type(uint64).max`, which the contract accepts and which no clock reaches. Revocation remains the only way it ends, and a contract test asserts both. |
| Which wallet a session belongs to | `open` records `msg.sender`; `revoke` refuses anybody else |
| Moving a schedule onto another session (`/api/tasks/repoint`) | `requireAuth` plus an owner check on **both** ends: the caller must own the tasks and the destination session. Without the second check this would be a way to aim your tasks at somebody else's delegation, or theirs at yours. |
| Scheduling a payment from a session at all | `/api/tasks` and `/api/tasks/:id` refuse any venue but `wallet` and any verb but `sessionSend`/`sessionBulk` for a non-operator, and only against a session that wallet opened |

The allowance is a separate ceiling the owner controls from any wallet
interface, and it is one shared number per (owner, token) — `approve` replaces
rather than adds. Opening a session therefore approves the new cap **plus what
every live session on that asset still holds**, never an unlimited amount, and
the flow now stops if that approval does not land rather than opening a session
that cannot pay.

## What `/api/version` may say about the RPC

`/api/version` is public and unauthenticated, and it now reports what the RPC
limiter is doing: how many requests it will keep open at once, the rate it has
settled on, how many calls have been sent and refused, a per-method tally, and
the last refusal. That is deliberate — "the site is slow" and "the public node
is refusing a third of our calls" look identical from outside, and only the
second one is visible from in here. An operator who cannot see it guesses.

The one thing it does **not** carry is the refused request itself. viem builds
its error message out of the URL, the node's reason, *and the full JSON request
body*, and the body of a refused `eth_call` or `eth_getBalance` names whichever
address the app was reading at that moment. On a public endpoint that would
publish, one at a time, which wallets the app looks at — so only the method and
the node's own sentence ("rate limit exceeded") are kept. `refusalReason()` in
`shared/src/transport.ts` does that trimming, and a test asserts the payload is
gone rather than trusting the trim to stay correct.

Nothing else in the snapshot is sensitive: counts of RPC calls by method say
what the dashboard reads, which the dashboard already shows.

### A cached answer that must never be a stale one

Two things are now remembered rather than re-asked, and both are immutable by
construction, which is the only reason it is safe:

- **`eth_chainId`** — a property of the chain.
- **`eth_getCode`, and only when it returned code, and only for "as of now".**
  Bytecode at an address is fixed once deployed. An *empty* answer is
  deliberately never remembered: that address may be deployed to a moment later,
  and every "is this contract there yet?" check depends on eventually seeing
  that it is. A `getCode` at a specific historical block is not remembered
  either — those are the deployment-block search's probes, single-use by
  construction.

Nothing whose answer moves with the chain is cached at this layer. Balances,
`eth_call` results, receipts and logs go to the network every time, because a
stale balance is how an app reports money that is not there.

### A refused probe is not "no code here"

The deployment-block search — the binary search that gives every log scan its
floor — used to swallow every probe error as "not deployed yet". That is the
safe direction for a node that will not serve old state, and the wrong one for a
throttle: the answer moves later, and it was then cached forever, so every fee
and holder scan silently started halfway and reported a truncated history as the
whole of it. Throttles are now told apart from refusals and abandon the search
instead of poisoning it. The search's answers are also persisted to
`.tessera-deploy-blocks.json` in `STATE_DIR`, so a container restart no longer
re-runs ~26 probes per contract into the rate limit it is about to trip.

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
