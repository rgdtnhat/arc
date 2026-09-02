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

# A host `node_modules` is dead weight on a deploy box, and it is the first
# thing to reclaim when disk is short. Nothing here ever reads it: the image
# runs its own `npm install --omit=dev`, so a host install only unpacks the
# Solidity toolchain — some 400 packages against the image's ~95 — onto the
# disk the Docker build then needs. It is easy to end up with one by running
# `npm ci` here, which looks like the obvious thing to do and is not.
if [ -d node_modules ]; then
  nm_kb=$(du -sk node_modules 2>/dev/null | awk '{print $1}')
  warn "node_modules here is $((${nm_kb:-0} / 1024)) MB and is never used by the container."
  warn "Free it any time with: rm -rf node_modules"
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
  # The deploy scripts write newly deployed addresses into deployments/arc.json,
  # so a discard here can destroy the only copy of a contract that exists
  # on-chain and holds tokens. That is not hypothetical: the NFT launchpad and
  # then the NFT marketplace were both lost to this exact line, and each came
  # back as "not deployed on this network yet" while sitting on-chain. Rescued
  # further down, once the pull has landed and there is something to compare
  # against.
  if [ -f "$backup/arc.json" ]; then carry_from="$backup/arc.json"; fi
fi
ok "working tree is clean"

say "Fetching $BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
# --ff-only so a diverged local branch stops here rather than opening a merge
# nobody asked for in a non-interactive shell.
git merge --ff-only "origin/$BRANCH"
ok "at $(git rev-parse --short HEAD) — $(git log -1 --format=%s | cut -c1-60)"

# Now that the committed record is the pulled one, see whether the copy we threw
# away held an address it does not. Only additions are carried, into the
# gitignored deployments/arc.local.json; a genuine disagreement is named and
# left for a person, because deciding it silently is how a stale address gets
# resurrected.
if [ -n "${carry_from:-}" ]; then
  say "Addresses in the record that was replaced"
  if command -v node >/dev/null 2>&1; then
    node scripts/carry-addresses.mjs "$carry_from" deployments || \
      warn "the carry-over check failed; $carry_from still has everything it had."
  else
    warn "node is not on this host, so nothing was compared."
    warn "The old record is at $carry_from — diff it against deployments/arc.json by hand."
  fi
fi

want=$(grep -o 'const CACHE = "[^"]*"' dashboard/public/sw.js | cut -d'"' -f2)
ok "this commit's shell is $want"

say "Rebuilding"
# No `|| true` anywhere: a failed build must stop the script, because the old
# container survives it and would otherwise go on serving as though nothing
# happened.
docker compose up -d --build
ok "compose returned success"

say "Checking what is actually being served"
#
# Ask the container, not the host.
#
# docker-compose.yml `expose`s 8787 rather than publishing it — only Caddy binds
# a host port, on 80/443 — so `curl http://127.0.0.1:8787` from the host is
# answered by nothing at all. This step used to do exactly that and then declare
# the deploy failed on a container that was serving perfectly. The build had
# already succeeded, so the visible result was a red STOPPED after a good
# update, which teaches people to ignore the check.
#
# So: the host URL first (in case someone has published the port or set
# APP_URL to their real domain), then from inside the compose network. The image
# is node:22-slim — no curl, no wget — so node's own fetch does the asking.
version_json() {
  curl -fsS --max-time 5 "$APP_URL/api/version" 2>/dev/null && return 0
  docker compose exec -T tessera node -e '
    fetch("http://127.0.0.1:" + (process.env.PORT || 8787) + "/api/version")
      .then((r) => r.text()).then((t) => process.stdout.write(t))
      .catch(() => process.exit(1));
  ' 2>/dev/null
}

got=""
for _ in $(seq 1 30); do
  got=$(version_json | grep -o '"shell":"[^"]*"' | cut -d'"' -f4 || true)
  [ -n "$got" ] && break
  sleep 2
done

[ -n "$got" ] || die "the app never answered /api/version, on the host or inside the container. Try: docker compose logs --tail=80"

if [ "$got" != "$want" ]; then
  printf '\n   the repo is at %s but the server reports %s\n' "$want" "$got"
  die "the container is not running this commit. Usually a cached layer: docker compose build --no-cache && docker compose up -d"
fi

ok "server is serving $got"
version_json | sed 's/^/   /'

# Did everything in .env actually reach the container?
#
# The compose file used to pass a hand-kept list of variables through, so a
# value added to .env was simply not there inside the container — and nothing
# failed, the app just behaved as though it were unset. A key correctly set on
# the host produced "no session key configured on this server" on the live
# site. The list is gone (env_file now carries the whole file), and this is the
# check that would have caught it in the first place.
if [ -f .env ]; then
  missing=""
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    docker compose exec -T tessera printenv "$name" >/dev/null 2>&1 || missing="$missing $name"
  done <<EOFVARS
$(grep -oE '^[[:space:]]*[A-Z_][A-Z0-9_]*=' .env | tr -d ' =')
EOFVARS
  if [ -n "$missing" ]; then
    say "Settings that did not reach the container"
    for name in $missing; do warn "$name is in .env but unset inside the container"; done
    warn "Compose needs v2.24+ for this file's env_file form — check: docker compose version"
  else
    ok "every variable in .env is set inside the container"
  fi
fi
printf '\n\033[32mUpdate complete.\033[0m If the page still looks unchanged, that is your browser:\n'
printf 'close every tab of the site and reopen it — the service worker answers before the network.\n\n'
