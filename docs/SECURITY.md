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
a signed-in Web3 wallet), checked server-side via a bearer token. The
guardian-approval endpoint is admin-only. Read endpoints (`/api/state`,
`/api/actions`) remain public. See `agent/src/auth.ts` and the `requireAuth`
guard in `agent/src/dashboard.ts`.

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
