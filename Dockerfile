# Tessera — live dashboard demo, one self-contained container.
# Boots a local chain, deploys the contracts, runs the autonomous agent
# scenario, and serves the dashboard on $PORT. Deploy to any Docker host
# (Render / Railway / Fly / a VM).
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

# Compile contracts at build time (seeds the offline solc + caches artifacts,
# so the local chain the demo spawns starts fast and never needs the network).
RUN npm run compile --workspace contracts

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Persistent demo: local chain + deploy + providers + agent + dashboard.
CMD ["npm", "run", "demo"]
