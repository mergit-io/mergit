# The Arkiv write sidecar (ETHGlobal Mumbai "Build on Arkiv" track): holds the service wallet's
# private key, never the control plane's own process. Build from this directory:
#   docker build -t mergit-arkiv-sidecar:local chain/arkiv
FROM node:22-slim AS builder
WORKDIR /src
COPY package.json package-lock.json .
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-slim
RUN useradd --system --uid 10001 arkiv
WORKDIR /app
COPY --from=builder /src/node_modules node_modules
COPY package.json .
COPY src src
USER arkiv
EXPOSE 8088
CMD ["node", "src/server.js"]
