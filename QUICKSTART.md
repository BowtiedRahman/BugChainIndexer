# BugChainIndexer quickstart

A radar for fresh contract deployments on EVM chains. Watches every new block, records each new contract, prices the ones that hold money, and pings Telegram when a fresh contract gets funded while unverified.

## What runs

Three kinds of workers, all driven by `radar.sh` on a dev box or `docker compose` on a server:

1. **DeploymentScanner** walks blocks via `eth_getBlockReceipts`, records every new contract, checks the EIP-1967 proxy slot, verifies the source on Etherscan.
2. **FundingGate** runs every 15 minutes, prices candidates in USD (native + all ERC-20 via Alchemy token enumeration, prices from DefiLlama), promotes those over `PROMOTE_MIN_USD`, fires the Telegram alert. Only contracts under `MAX_DEPLOY_AGE_HOURS` (default 24) can alert.
3. **Postgres** holds the index: one `addresses` table with a `candidate` -> `funded` lifecycle, plus a per-chain `scan_cursor`.

## Local quickstart (laptop)

```bash
git clone https://github.com/BowtiedRahman/BugChainIndexer
cd BugChainIndexer/scanners
deno install --allow-scripts --node-modules-dir   # deps; npm stalls on some networks
docker run -d --name bugchain-pg -e POSTGRES_PASSWORD=<pw> -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=bugchain_indexer -p 5432:5432 postgres:16
cp .env.example .env                              # set PGPASSWORD + Etherscan key
```

Then control everything with one script from the repo root:

```bash
./radar.sh start      # postgres + scanners + gates for all active chains
./radar.sh status     # workers alive, row counts, per-chain cursor
./radar.sh stop       # workers down; postgres and data stay
./radar.sh logs       # tail everything
```

After a laptop reboot: `./radar.sh status` shows what died, `./radar.sh start` brings it all back. Data always survives; it lives in the Postgres volume.

## Cloud quickstart (any Ubuntu VPS)

```bash
cd scanners
./deploy.sh user@SERVER_IP        # installs docker, syncs repo, copies .env, boots stack
```

Or by hand on the server:

```bash
git clone https://github.com/BowtiedRahman/BugChainIndexer
cd BugChainIndexer/scanners
cp .env.cloud.example .env        # fill in keys
docker compose up -d --build
docker compose logs -f
```

Yes, everything runs in Docker containers on the cloud path: Postgres and 6+ workers, each its own container, all `restart: always`. Data lives in the `pgdata` volume and survives reboots and rebuilds. `docker compose down -v` is the only way to lose it.

## Chains

```bash
./radar.sh chains                 # known chains, which are active
./radar.sh add linea              # activate a known chain
./radar.sh remove linea           # deactivate (data stays in postgres)
./radar.sh newchain <slug> <chainId> <rpcUrl> <symbol>
                                  # add a brand-new chain + activate
```

Active chains live in `scanners/chains.txt`, one per line. That file is the source of truth.

## Backfill: scan history

The live scanner only sees blocks from when it started. To sweep the past:

```bash
./radar.sh backfill binance 2025-09-01              # sept 1 until now
./radar.sh backfill binance 2025-09-01 2025-10-01   # bounded range
./radar.sh backfill binance 48000000 49500000       # block numbers
```

Runs in the foreground. Never touches the live cursor, so you can backfill while the live scanner runs. Rate is ~2 blocks/sec on free RPC tiers; a month of BSC is millions of blocks, so plan accordingly.

## Config cheat sheet (`scanners/.env`)

| var | what it does | default |
|---|---|---|
| `DEFAULT_ETHERSCAN_KEYS` | verification + deployment metadata, one key covers all chains | required |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | where alerts go | required for alerts |
| `PROMOTE_MIN_USD` | value threshold for alerts | 1000 |
| `MAX_DEPLOY_AGE_HOURS` | contracts older than this never alert | 24 |
| `<CHAIN>_RPC_URL` | per-chain RPC override (Alchemy recommended) | public RPCs |

## Reading the data

```bash
docker exec bugchain-pg psql -U postgres -d bugchain_indexer -c "
  SELECT address, contract_name, fund, verified, risk_reasons
  FROM addresses WHERE status='funded' ORDER BY fund DESC;"
```

`status='funded'` means the gate priced it above your threshold. `risk_reasons` says why it's interesting: `unverified` is the big one, nobody has read that code.

## Troubleshooting

- **No alerts for hours**: check `radar.sh status`. Workers die when the terminal that launched them closes unless launched via `radar.sh start` (it uses `setsid`). Postgres "DOWN" after a reboot is normal; `start` fixes it.
- **Values showing 0**: DefiLlama rate limits or unknown tokens. The gate rechecks every 15 minutes; values correct over time.
- **`eth_getLogs` rejected on ethereum**: Alchemy free tier caps it at 10 blocks. Already handled via `maxLogBlockRange` in `config/networks.js`.
- **Scanner exits on 429**: it retries with backoff and self-heals; if it truly dies, `radar.sh start` relaunches.
