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

# ## Why this still runs as root
#
# `USER node` is the obvious hardening and it is deliberately not here yet.
# `docker-compose.yml` bind-mounts `./deployments` from the host, and a bind
# mount keeps the host's ownership whatever the image does — so an image-side
# `chown` does not reach it. Deploying a contract from the dashboard writes
# `deployments/arc.local.json`, which is how a freshly deployed address
# outranks the committed record; as `node` that write fails with EACCES, is
# caught, and the override is silently not persisted. Every later deploy would
# then need a hand-patch, which is the exact failure that file exists to stop.
#
# To adopt it: `chown -R 1000:1000 deployments` on the host first (1000 is
# `node` in this image), then add `RUN mkdir -p /app/state && chown -R
# node:node /app` and `USER node` here. Worth doing on a host where that step
# can be verified; not worth doing blind, because the failure is quiet.

# Providers + agent + dashboard, live against Arc.
CMD ["npm", "start"]
