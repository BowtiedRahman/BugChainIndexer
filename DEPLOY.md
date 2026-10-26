# BugChainIndexer

A multi-EVM-chain contract deployment watcher and bug-hunt radar. Watches new block on each chain, records every fresh contract deployment, values funded contracts in USD, and pings Telegram when a new contract gets funded while unverified.

## Quick start (any Linux box with Docker)

```bash
git clone https://github.com/BowtiedRahman/BugChainIndexer
cd BugChainIndexer/scanners
cp .env.cloud.example .env     # fill in keys
docker compose up -d --build
docker compose logs -f         # watch it work
```

That boots Postgres plus 8 workers: deployment watchers and funding gates for ethereum, base, binance, and robinhood chain. Data survives restarts in the `pgdata` volume; every container has `restart: always`.

## What runs

| service | job |
|---|---|
| `deploy-<chain>` | walks new blocks via `eth_getBlockReceipts`, records every new contract, checks EIP-1967 proxy slots, verifies on Etherscan |
| `gate-<chain>` | every 15 min, values candidates in USD (native + ERC-20 via Alchemy enumeration), promotes those over `PROMOTE_MIN_USD`, fires Telegram alerts |
| `robinhood-watcher` | same deployment watch for Robinhood Chain (id 4663) over its public RPC, curl transport |
| `postgres` | the shared index. One `addresses` table with lifecycle (`candidate` -> `funded`), one `upgrades` table (empty until the UpgradeScanner exists), one `scan_cursor` per chain |

## Adding a chain

1. Add an entry to `scanners/config/networks.js` (chainId, rpcUrls, nativeCurrency).
2. Add two services to `docker-compose.yml`: `deploy-<chain>` and `gate-<chain>`, copying any existing pair.
3. Optionally set `<CHAIN>_RPC_URL` in `.env`.

## Key configuration (`scanners/.env`)

| var | meaning | default |
|---|---|---|
| `DEFAULT_ETHERSCAN_KEYS` | one key works on all chains (Etherscan V2) | required |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | alert destination | required for alerts |
| `PROMOTE_MIN_USD` | value a contract must hold to alert | 1000 |
| `MAX_DEPLOY_AGE_HOURS` | only contracts younger than this can alert | 24 |
| `<CHAIN>_RPC_URL` | override the public RPC per chain | unset = public |

## Deploying to a cloud VPS

Any Ubuntu 22.04+ box works (Oracle Cloud free ARM tier is $0/month and comfortably fits this stack):

```bash
cd scanners
./deploy.sh user@your-vps-ip
```

The script installs Docker, rsyncs the repo, copies your local `.env` (secrets never touch the git repo), and boots the stack. Rerun it any time to redeploy; it converges.

## Local development (non-Docker)

```bash
cd scanners
deno install --allow-scripts --node-modules-dir   # npm stalls on some networks
docker run -d --name bugchain-pg -e POSTGRES_PASSWORD=... -p 5432:5432 postgres:16
cp .env.example .env                              # set PGPASSWORD + keys
NETWORK=ethereum node core/DeploymentScanner.js   # one worker in foreground
```

## Regression checks

- `scanners/test-e2e-gate.sh`: seeds one 1-year-old and one 5-minute-old contract; the gate must promote only the fresh one. Guards against the "alerts fire on year-old contracts" bug.
- `scanners/test-alert-age.sh`: every funded row's `deployed` column must decode to a sane date. Guards against block-number/timestamp unit confusion.

## Repo layout

- `scanners/common/`: Scanner base class, RPC + Etherscan clients, DB schema
- `scanners/core/`: the workers (UnifiedScanner, DeploymentScanner, FundingGate, FundUpdater, DataRevalidator, RobinhoodWatcher)
- `scanners/config/networks.js`: per-chain config (rpc, keys, helper contracts)
- `contract/`: Foundry Solidity (BalanceHelper, contractValidator) - deployed on-chain helpers for batch reads
- `server/`: Express REST API over the same Postgres (not part of the default compose stack)
