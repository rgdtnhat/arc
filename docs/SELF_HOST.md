# Self-host Tessera on your own server + domain

Run the live dashboard on a VPS you control, served over HTTPS at your own
domain. This uses Docker Compose with **Caddy** in front, which provisions a
Let's Encrypt TLS certificate automatically.

## What you need

- A **Linux VPS with root/sudo** and a public IP (DigitalOcean, Hetzner, Linode,
  AWS EC2, a home server with ports 80/443 forwarded — anything you control).
  **~1 GB RAM** minimum: the container runs an in-process EVM (the local chain).
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

## What's hosted

A full autonomous run against a fresh local chain inside the container: escrow
settlements, an SLA-breach refund with a stake slash, the guardian approval
card, the nanopayment tab session, the billing inbox, and the mission briefing.
The "Run again" button replays it. Your real contracts stay live on Arc testnet
(`deployments/arc.json`).

## Just the static deck on shared hosting?

`docs/deck.html` is a single self-contained file — upload it to any web host
(cPanel `public_html`, S3, Netlify drop) and it works with no server or RAM.
