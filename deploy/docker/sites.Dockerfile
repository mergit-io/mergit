# Builds the two static sites the way render.yaml did, and exports only the built files (no running container).
# Use deploy/server/build-sites.sh, which passes the build args; by hand, from the repository root:
#   docker build -f deploy/docker/sites.Dockerfile --target web-dist --output out/web .
#   docker build -f deploy/docker/sites.Dockerfile --target app-dist --output out/app --build-arg VITE_ESCROW=0x... .
# Node 22.12 is what frontend/package.json requires. scripts/build-wasm.sh installs Rust and wasm-pack itself.
FROM node:22.12-bookworm AS base
WORKDIR /src
COPY . .
WORKDIR /src/frontend

# mergit.site: the design over mock data.
FROM base AS web-build
RUN npm ci && npm run build

FROM scratch AS web-dist
COPY --from=web-build /src/frontend/dist /

# mergit.site and app.mergit.site: the frontend on live data. Vite bakes these in at build time.
FROM base AS app-build
ARG VITE_API_URL
ARG VITE_AUTH_ORIGIN
ARG VITE_GATEWAY_URL
ARG VITE_STORE_URL
ARG VITE_ESCROW
ARG VITE_RECEIPT_REGISTRY
ARG VITE_IDENTITY
ARG VITE_USDC
ARG VITE_DEPLOY_BLOCK
ARG VITE_RPC_URL=https://sepolia.base.org
ARG VITE_CHAIN_ID=84532
ARG VITE_CHAIN_NAME="Base Sepolia"
ENV VITE_DATA_MODE=live
RUN bash scripts/build-wasm.sh && npm ci && npm run build

FROM scratch AS app-dist
COPY --from=app-build /src/frontend/dist /
