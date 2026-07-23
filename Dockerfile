# Tessera — live dashboard + agent orchestrator, one self-contained container.
# Runs the autonomous agent against the Tessera contracts on Arc testnet and
# serves the dashboard on $PORT. Deploy to any Docker host (Render / Railway /
# Fly / a VM). For mainnet, point ARC_RPC_URL + the deployment addresses at
# your production chain and supply production wallet keys.
FROM node:22-bookworm-slim

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

# App source.
COPY . .

# Compile contracts at build time (seeds the offline solc + caches artifacts).
RUN npm run compile --workspace contracts

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Providers + agent + dashboard, live against Arc.
CMD ["npm", "start"]
