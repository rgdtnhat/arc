# Tessera — live dashboard + agent orchestrator, one self-contained container.
# Runs the autonomous agent against the Tessera contracts on Arc testnet and
# serves the dashboard on $PORT. Deploy to any Docker host (Render / Railway /
# Fly / a VM). For mainnet, point ARC_RPC_URL + the deployment addresses at
# your production chain and supply production wallet keys.
#
# Two stages, because the Solidity toolchain is a build-time need and a runtime
# liability. Hardhat and its tree carry published advisories (`npm audit`); none
# of it is reachable from the server — nothing under agent/, shared/ or
# providers/ imports Hardhat, and nothing reads its build artifacts — but a
# single-stage image installed and shipped all of it anyway. The builder
# compiles; the runtime stage installs production dependencies only.
#
# Nothing in either stage *requires* `apt`. That is deliberate: a host whose apt
# cannot verify Debian's signatures (a truncated InRelease from a full disk, an
# intercepting HTTP proxy, a skewed clock) would otherwise fail the build on a
# step that installs nothing the app needs.

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Optional, and the build continues without it.
#
#  · ca-certificates is already in the base image; this is belt and braces.
#  · python3/make/g++ only matter if a prebuilt native binary is missing for this
#    platform. The only two native packages in the tree (keccak, secp256k1) both
#    run `node-gyp-build || exit 0`, so they fall back to their prebuilds rather
#    than failing. Both are dev-only now in any case.
#
# So a broken apt must not stop the build — hence `|| echo`, not a hard failure.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  || echo "WARNING: apt is unavailable on this host; continuing with the base image's certificates and prebuilt native binaries"
RUN rm -rf /var/lib/apt/lists/*

# Install workspace deps first for better layer caching.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY contracts/package.json contracts/
COPY providers/package.json providers/
COPY agent/package.json agent/
RUN npm install --no-audit --no-fund

COPY . .

# Compile contracts (seeds the offline solc, then exports the ABIs and bytecode
# into shared/src/, which is what the app reads at run time).
RUN npm run compile --workspace contracts

# -------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim
WORKDIR /app

# No apt here at all. The only thing the previous version installed was
# ca-certificates, and the trust store is copied from the builder instead — same
# base image, so this is at worst a no-op and at best it supplies CAs the base
# lacks. Offline, deterministic, and one less way for the build to fail.
#
# `/etc/ssl/certs` only. It holds the bundle OpenSSL and Node actually read, and
# it exists in every Debian image. `/usr/share/ca-certificates` is only the source
# PEMs for update-ca-certificates, is not needed at run time, and — the reason
# this matters — does not exist unless the ca-certificates package installed,
# which is exactly the case where apt failed. `COPY` of a missing path is a build
# failure, so copying it would have put back the failure this stage removes.
COPY --from=builder /etc/ssl/certs /etc/ssl/certs

# A fresh production-only install rather than a copy of the builder's
# node_modules: `--omit=dev` is the whole point, and it also keeps the native
# build toolchain out of the final image.
#
# `tsx` is a production dependency of the agent for this reason — the app is
# served straight from its TypeScript sources via `node --import tsx`, so it is a
# runtime loader here, not a dev tool.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY contracts/package.json contracts/
COPY providers/package.json providers/
COPY agent/package.json agent/
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Application sources, taken from the builder so the generated ABIs and bytecode
# are the ones that compile produced.
COPY --from=builder /app/shared/src ./shared/src
COPY --from=builder /app/agent/src ./agent/src
COPY --from=builder /app/providers/src ./providers/src
COPY --from=builder /app/dashboard ./dashboard
COPY --from=builder /app/deployments ./deployments

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Providers + agent + dashboard, live against Arc.
CMD ["npm", "start"]
