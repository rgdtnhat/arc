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
| Unbounded admin fees | Hard caps in code: performance fee ≤ 30%, swap fee ≤ 5%, app fee share ≤ 100% of the fee, reserve ratio ≥ 50% |
| Swap paying out more than it holds | Blocked — solvency check requires `balance ≥ amountOut + appFee` before any transfer |
| Slippage | `minOut` enforced on every swap |
| Rebalance bricking withdrawals | `_rebalance()` is wrapped in `try/catch`, so a pool hiccup can't block a deposit/withdraw |

## Economic safety model (vault)

The vault is deliberately conservative:

- **Liquid reserve buffer.** `reserveRatioBps` (floor **50%**, default **50%**) is
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
   until borrowers repay or interest lures new supply. At the 50% floor at least
   half of TVL is always redeemable instantly, so this can only bite a
   larger-than-half withdrawal during full utilisation. Funds are not lost —
   they're illiquid.
2. **Admin-set prices.** Both the pool and the swap desk price from
   `TesseraPool`'s owner-set oracle. A stale price lets an arbitrageur drain the
   underpriced side of the **swap inventory**. Wire a live oracle before mainnet.
3. **Trusted operator key.** The owner can change fees (within caps), prices, the
   treasury, and can withdraw swap inventory. This is a custodial trust
   assumption, not a trustless design.
4. **Unaudited.** No third-party audit has been performed. Do not use with real
   funds until one has.

## Design assumptions (not bugs, but worth stating)

- **Trusted price oracle.** `TesseraPool.setPrice()` is owner-only; the pool
  trusts admin-set prices for health/liquidation. Replace with a real oracle
  before mainnet.
- **Trusted admin/deployer key.** Whoever holds the pool owner / deployer key can
  add reserves, set prices, and set the treasury. Keep it in an HSM / DCW for
  production.

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
  untrusted input reaches `innerHTML`.

## Secrets policy

- Private keys, the admin password, and the app wallet key are **never committed**
  — they live in `.env` / a gitignored admin credential file, and only their
  hashes / public addresses are used at runtime.
- `.gitignore` covers `.env`, `.env.*` (except `.env.example`), and the admin
  credential store.
- Before real funds: rotate all keys, move signing to Circle DCW / an HSM, and
  commission a professional smart-contract audit.
