# Self-host Tessera on your own server + domain

Run the live dashboard on a VPS you control, served over HTTPS at your own
domain. This uses Docker Compose with **Caddy** in front, which provisions a
Let's Encrypt TLS certificate automatically.

## What you need

- A **Linux VPS with root/sudo** and a public IP (DigitalOcean, Hetzner, Linode,
  AWS EC2, a home server with ports 80/443 forwarded — anything you control).
  **~512 MB RAM** is plenty — the app is a Node server talking to Arc (no local EVM).
- **Docker + Docker Compose** installed (`curl -fsSL https://get.docker.com | sh`).
- A **domain** whose DNS you can edit.

> Shared/cPanel hosting won't run this (no long-lived Node process, no Docker).
> If that's all you have, host the static pitch deck (`docs/deck.html`) there
> instead — see the note at the bottom.

## 1. Point your domain at the server

Create a DNS **A record** for the hostname you want (apex `example.com` or a
subdomain like `tessera.example.com`) → your server's public IP. Wait for it to
resolve (`dig +short tessera.example.com` should return the IP).

## 2. Get the code on the server

```bash
git clone -b claude/arc-agentic-payment-idea-gwerkd https://github.com/rgdtnhat/arc
cd arc
```

## 3. Launch (one command)

```bash
SITE_ADDRESS=tessera.example.com docker compose up -d --build
```

That builds the app image, starts it internally on 8787, and starts Caddy on
80/443. Caddy sees `SITE_ADDRESS`, obtains a certificate, and proxies HTTPS
traffic to the app. Open `https://tessera.example.com` — the dashboard is live.

- Logs: `docker compose logs -f`
- Update after a `git pull`: `docker compose up -d --build`
- Stop: `docker compose down`
- It restarts on reboot/crash (`restart: unless-stopped`).

## Firewall

Open ports **80** and **443** (Caddy needs 80 for the ACME challenge and 443 for
HTTPS). E.g. with ufw: `sudo ufw allow 80,443/tcp`.

## Apex domain (no subdomain)

Set `SITE_ADDRESS=example.com` (and add a DNS A record for the apex). To also
serve `www`, use `SITE_ADDRESS="example.com, www.example.com"`.

## Prefer nginx + certbot instead of Caddy?

Run just the app (`docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 tessera-demo`)
and point an existing nginx server block at `http://127.0.0.1:8787`, then
`certbot --nginx -d tessera.example.com` for TLS. Caddy is simpler, but either
works.

## Required environment (Arc testnet only)

The dashboard runs **live on Arc testnet only** — there is no local demo chain.
It reads the committed `deployments/arc.json` and **requires** your keys. Create
a `.env` next to `docker-compose.yml` on the server (gitignored — never commit;
**testnet-only keys, never mainnet/real-fund keys on a server**):

```bash
SITE_ADDRESS=tesra.xyz, www.tesra.xyz
AGENT_PRIVATE_KEY=0x...          # your Arc agent key
PROVIDER_PRIVATE_KEY=0x...       # your Arc provider key
ADMIN_ID=admin                   # dashboard admin login
ADMIN_PASSWORD=change-me         # secret; enables the Admin button
# ARC_RPC_URL=https://rpc.testnet.arc.network   # optional override
```

Then `docker compose up -d --build`. What's hosted:

- The dashboard reads real on-chain balances / reputation / lending position
  from Arc (reads are paced + cached so the public RPC's rate limit can't break
  it). Escrow, tab, and pool all point at your live contracts.
- It does **not** auto-run on restart — sign in (Admin or Connect Wallet), then
  press **"Run live on Arc"** to spend real testnet USDC. Keep the agent funded
  at [faucet.circle.com](https://faucet.circle.com/).
- **Security:** all state-changing actions require sign-in; strict CSP + security
  headers; admin login is brute-force-locked; sessions expire (12h). See
  [`docs/SECURITY.md`](SECURITY.md).

If `AGENT_PRIVATE_KEY` / `PROVIDER_PRIVATE_KEY` are missing, the app exits with a
clear message rather than falling back to anything insecure.

## Just the static deck on shared hosting?

`docs/deck.html` is a single self-contained file — upload it to any web host
(cPanel `public_html`, S3, Netlify drop) and it works with no server or RAM.
