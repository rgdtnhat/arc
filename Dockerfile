# Tessera — live dashboard + agent orchestrator, one self-contained container.
# Runs the autonomous agent against the Tessera contracts on Arc testnet and
# serves the dashboard on $PORT. Deploy to any Docker host (Render / Railway /
# Fly / a VM). For mainnet, point ARC_RPC_URL + the deployment addresses at
# your production chain and supply production wallet keys.
#
# Two stages, because the Solidity toolchain is a build-time need and a runtime
# liability. Hardhat, solc and their trees carry ~50 published advisories
# (`npm audit`); none of it is reachable from the server — nothing under
# agent/, shared/ or providers/ imports Hardhat, and nothing reads its build
# artifacts — but a single-stage image installed and shipped all of it anyway.
# The builder compiles; the runtime stage installs production dependencies only,
# so that whole tree is absent from what actually runs.

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Toolchain for any native npm builds (edr/keccak ship prebuilt, but be safe).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

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

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# A fresh production-only install rather than a copy of the builder's
# node_modules: `--omit=dev` is the whole point, and it also drops the native
# build toolchain from the final image.
#
# `tsx` is a production dependency of the agent for this reason — the app is
# served straight from its TypeScript sources via `node --import tsx`, so it is
# a runtime loader here, not a dev tool.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY contracts/package.json contracts/
COPY providers/package.json providers/
COPY agent/package.json agent/
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Application sources, taken from the builder so the generated ABIs and
# bytecode are the ones that compile produced.
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
