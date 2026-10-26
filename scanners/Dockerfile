# BugChainIndexer scanner worker image.
# Runs the deployment watcher, funding gate, and unified scanner.
#
# Build context must be the repo root: docker build -f scanners/Dockerfile .
FROM node:22-alpine AS deps
# deno's npm installer builds this project's deps reliably; npm ETIMEDOUTs
# on some networks. Output layout is standard node_modules.
RUN apk add --no-cache curl ca-certificates deno
WORKDIR /app/scanners
COPY scanners/package.json scanners/package-lock.json* scanners/deno.lock* ./
RUN deno install --allow-scripts --node-modules-dir

FROM node:22-alpine
RUN apk add --no-cache curl ca-certificates tzdata
WORKDIR /app/scanners
COPY --from=deps /app/scanners/node_modules ./node_modules
COPY scanners/package.json ./

COPY scanners/common ./common
COPY scanners/config ./config
COPY scanners/core ./core
COPY scanners/utils ./utils
COPY scanners/tokens ./tokens
COPY scanners/run.sh ./run.sh
RUN chmod +x run.sh

# curl works everywhere, even where node's fetch stalls on IPv6-only DNS.
# Workers talk to CoinGecko and Telegram through it.
ENV NODE_OPTIONS=--dns-result-order=ipv4first

CMD ["node", "core/DeploymentScanner.js"]
