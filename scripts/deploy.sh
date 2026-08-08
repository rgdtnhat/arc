#!/usr/bin/env bash
#
# Update a running Tessera host, and prove it took.
#
# Run:  ./scripts/deploy.sh
#
# ## Why this is a script and not a list of commands
# A list of commands pasted into a terminal runs every line whether or not the
# previous one worked. A `git pull` that refuses, or a Docker build that runs
# out of disk, scrolls past — and `restart: unless-stopped` means the *old*
# container is still serving, so `docker compose logs` looks perfectly healthy
# and the site simply never changes. Every visible sign says the update worked.
#
# So: `set -e`, a dirty-tree check before anything moves, and a verification at
# the end that compares the version the server actually reports with the one in
# the repo. If those disagree the script says so and exits non-zero.
#
# ## What this deliberately does not do
# `npm ci` and `npm run compile` are not here, and must not be added. The image
# runs its own `npm install --omit=dev`, so installing on the host changes
# nothing about what gets served — it only unpacks the full Solidity toolchain
# into the host's disk, which is the most likely way a small box then fails the
# Docker build for want of space. The ABIs are committed precisely so no host
# ever needs a compiler.
set -euo pipefail

BRANCH="${BRANCH:-claude/arc-agentic-payment-idea-gwerkd}"
APP_URL="${APP_URL:-http://127.0.0.1:8787}"
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '   \033[33mnote\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mSTOPPED\033[0m %s\n\n' "$*" >&2; exit 1; }

say "Before anything moves"

# Disk first: it is the failure that produces the most confusing symptom, since
# the build dies and the previous container keeps answering.
avail_kb=$(df -Pk . | awk 'NR==2 {print $4}')
if [ "$avail_kb" -lt 2000000 ]; then
  warn "only $((avail_kb / 1024)) MB free here — a Docker build wants ~1.5 GB."
  warn "If the build fails, reclaim with: docker system prune -af"
fi

# A refused checkout is the single most common reason an update does not land,
# and pasted commands hide it. Name the files rather than the error.
dirty=$(git --no-pager diff --name-only HEAD)
if [ -n "$dirty" ]; then
  # `deployments/` is special: docker-compose bind-mounts it over the image's
  # copy, so the container reads these files from the host — and the app itself
  # writes into that directory. A tracked file inside a mount the app can write
  # is how one stale record blocks every future pull *and* keeps being served
  # after a clean rebuild. The committed record is authoritative for addresses
  # (see the merge rule in agent/src/deployment.ts), so the local edit can go —
  # but it is backed up first, because "safe to discard" is a judgement and the
  # cost of being wrong should not be somebody's only copy.
  other=$(printf '%s\n' "$dirty" | grep -v '^deployments/' || true)
  if [ -n "$other" ]; then
    printf '\n   These tracked files have local changes:\n'
    printf '%s\n' "$other" | sed 's/^/     /'
    die "the pull would be refused. Keep them (git stash) or drop them (git checkout -- <file>), then re-run."
  fi

  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup="deployments/.superseded-$stamp"
  mkdir -p "$backup"
  printf '\n'
  printf '%s\n' "$dirty" | while read -r f; do
    [ -n "$f" ] || continue
    cp -a "$f" "$backup/$(basename "$f")"
    warn "$f had local changes — copied to $backup/, taking the committed version"
  done
  printf '%s\n' "$dirty" | xargs -r git checkout --
fi
ok "working tree is clean"

say "Fetching $BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
# --ff-only so a diverged local branch stops here rather than opening a merge
# nobody asked for in a non-interactive shell.
git merge --ff-only "origin/$BRANCH"
ok "at $(git rev-parse --short HEAD) — $(git log -1 --format=%s | cut -c1-60)"

want=$(grep -o 'const CACHE = "[^"]*"' dashboard/public/sw.js | cut -d'"' -f2)
ok "this commit's shell is $want"

say "Rebuilding"
# No `|| true` anywhere: a failed build must stop the script, because the old
# container survives it and would otherwise go on serving as though nothing
# happened.
docker compose up -d --build
ok "compose returned success"

say "Checking what is actually being served"
got=""
for _ in $(seq 1 30); do
  got=$(curl -fsS --max-time 5 "$APP_URL/api/version" 2>/dev/null | grep -o '"shell":"[^"]*"' | cut -d'"' -f4 || true)
  [ -n "$got" ] && break
  sleep 2
done

[ -n "$got" ] || die "the app did not answer $APP_URL/api/version within a minute. Try: docker compose logs --tail=80"

if [ "$got" != "$want" ]; then
  printf '\n   the repo is at %s but the server reports %s\n' "$want" "$got"
  die "the container is not running this commit. Usually a cached layer: docker compose build --no-cache && docker compose up -d"
fi

ok "server is serving $got"
curl -fsS "$APP_URL/api/version" | sed 's/^/   /'
printf '\n\033[32mUpdate complete.\033[0m If the page still looks unchanged, that is your browser:\n'
printf 'close every tab of the site and reopen it — the service worker answers before the network.\n\n'
