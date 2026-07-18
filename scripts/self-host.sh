#!/usr/bin/env bash
# Tessera one-command self-host installer — run on YOUR VPS (root/sudo).
#
#   SITE_ADDRESS=tessera.example.com bash scripts/self-host.sh
#
# Installs Docker if missing, clones/updates the repo, and brings up the
# dashboard behind Caddy (automatic HTTPS) on your domain. Idempotent: re-run
# to update. Point your domain's DNS A record at this server first.
set -euo pipefail

BRANCH="${TESSERA_BRANCH:-claude/arc-agentic-payment-idea-gwerkd}"
REPO="${TESSERA_REPO:-https://github.com/rgdtnhat/arc}"
DIR="${TESSERA_DIR:-$HOME/tessera}"

SITE_ADDRESS="${SITE_ADDRESS:-}"
if [ -z "$SITE_ADDRESS" ]; then
  read -rp "Your domain (e.g. tessera.example.com): " SITE_ADDRESS
fi
[ -z "$SITE_ADDRESS" ] && { echo "SITE_ADDRESS is required."; exit 1; }

echo "→ Checking Docker…"
if ! command -v docker >/dev/null 2>&1; then
  echo "  installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || {
  echo "Docker Compose v2 not found. Install the docker compose plugin and re-run."; exit 1;
}

echo "→ Fetching Tessera into $DIR…"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

echo "→ Opening ports 80/443 (ufw, if present)…"
command -v ufw >/dev/null 2>&1 && sudo ufw allow 80,443/tcp || true

echo "→ Building and starting (this pulls images + compiles contracts once)…"
SITE_ADDRESS="$SITE_ADDRESS" docker compose up -d --build

cat <<EOF

✅ Tessera is starting.
   Give it 1–3 minutes (image build + first-boot scenario + TLS issuance), then:
      https://$SITE_ADDRESS

   Logs:    docker compose logs -f
   Update:  bash scripts/self-host.sh   (re-run any time)
   Stop:    docker compose down
EOF
