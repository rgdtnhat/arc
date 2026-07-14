#!/usr/bin/env bash
# SessionStart hook: make the repo ready to build and test in a fresh web session.
# - installs workspace deps if missing
# - seeds Hardhat's solc cache from npm (some environments block the solc host)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "[tessera] installing dependencies…"
  npm install --silent >/dev/null 2>&1 || npm install
fi

# Seed the offline Solidity compiler so `npm test` / `npm run demo` work.
node contracts/scripts/seed-compiler.cjs || true

echo "[tessera] ready — try: npm test   or   npm run demo"
