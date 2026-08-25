# Tessera — live dashboard + agent orchestrator, one self-contained container.
# Runs the autonomous agent against the Tessera contracts on Arc testnet and
# serves the dashboard on $PORT. Deploy to any Docker host (Render / Railway /
# Fly / a VM). For mainnet, point ARC_RPC_URL + the deployment addresses at your
# production chain and supply production wallet keys.
#
# ## One stage, production dependencies only
#
# This used to install the whole workspace — including Hardhat, solc and
# @nomicfoundation/edr, about 220 MB of it — and run `hardhat compile`. All of
# that was wasted:
#
#  · The app never reads Hardhat's build artifacts. It imports the ABIs and
#    deploy bytecode from `@tessera/shared`, and `shared/src/abi.ts` +
#    `shared/src/bytecode.ts` are **generated and committed** (by
#    `contracts/scripts/export-abi.cjs`, run from `npm run compile` on a
#    developer machine or in CI). Compiling in the image regenerated those two
#    files byte for byte and changed nothing.
#  · So the toolchain was installed, used once to reproduce committed files, and
#    then either shipped (the original single stage) or thrown away (the
#    two-stage version) — in both cases paying full price in build disk.
#
# That price is the reason this is now one stage: on a small VPS the build hit
# `ENOSPC: no space left on device` during `npm install`. Production-only is
# ~95 packages instead of ~390, and there is nothing to compile.
#
# `npm run compile` still exists and CI still runs it — that is where a change to
# a `.sol` file gets turned into the committed ABI, and `npm run abi:check`
# fails the build if the two ever drift.
#
# ## No apt
#
# Nothing here needs it, deliberately: a host whose apt cannot verify Debian's
# signatures (a truncated InRelease from a full disk, an intercepting HTTP proxy,
# a skewed clock) would otherwise fail the build on a step installing nothing the
# app uses. `ca-certificates` is in the base image, and the only native packages
# in the tree are dev-only and fall back to prebuilt binaries anyway.
FROM node:22-bookworm-slim
WORKDIR /app

# Manifests first, so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY contracts/package.json contracts/
COPY providers/package.json providers/
COPY agent/package.json agent/

# `--omit=dev` is what keeps the Solidity toolchain out. It is also why `tsx` is
# a production dependency of the agent: the app is served straight from its
# TypeScript sources via `node --import tsx`, so it is a runtime loader here, not
# a dev tool. Cleaning the cache in the same layer keeps it out of the image.
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Application sources. Explicit paths rather than `COPY . .` so the image cannot
# pick up a stray local build directory, and so adding one does not silently
# grow it.
COPY shared/src ./shared/src
COPY agent/src ./agent/src
COPY providers/src ./providers/src
COPY dashboard ./dashboard
COPY deployments ./deployments

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# ## Why this runs as root, after two attempts at not doing
#
# `USER node` is the obvious hardening and it is deliberately not here. Twice
# now it has broken a live deployment for a marginal gain, and the second
# failure is the one that settles it:
#
#  1. `chown -R node:node /app` filled a small VPS's disk. A recursive chown
#     rewrites every file's metadata, and in an overlay build that copies all
#     ~95 production packages into a new layer. Narrowing it to `/app/state`
#     fixed that.
#  2. `/app/state` is a **named volume that already exists**. Docker seeds a
#     volume's ownership from the image only when the volume is new, and this
#     one has carried the admin store, config and history since the first
#     deploy — so it stays root-owned, the app cannot write it, and the process
#     dies at boot before the HTTP server is up. The container starts, reports
#     healthy to compose, and answers nothing.
#
# Making it work needs `chown -R 1000:1000` on the volume *and* on the
# bind-mounted `deployments/`, on every host, remembered forever. That is a
# manual step whose absence is a silent outage, traded against an unprivileged
# process in a single-tenant container on a testnet. It is not worth it here.
#
# What did survive from those attempts, and is worth keeping: the deploy record
# falls back to STATE_DIR when `deployments/` is not writable, and the app now
# refuses to start with a named reason when STATE_DIR cannot be written —
# rather than exiting silently, which is what made this cost an evening.
#
# To adopt it later: `docker compose down`, `chown -R 1000:1000` both the
# volume's mountpoint and `deployments/`, then add `USER node` back. Verify
# with `docker compose exec tessera id` before trusting it.
RUN mkdir -p /app/state

# Providers + agent + dashboard, live against Arc.
CMD ["npm", "start"]
