# BugChainIndexer

A multi-EVM-chain address indexer being converted into a whitehat bug-hunt radar.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature-slug>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), recorded as a `Status:` line per issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.

## Layout

- `scanners/` is the core. `common/` holds the shared Scanner base, RPC/Etherscan clients, and database schema. `core/` holds the workers: `UnifiedScanner` (transfer-event indexer), `DeploymentScanner` (block-by-block deployment watcher), `FundingGate` (promotes funded candidates, fires Telegram alerts), `FundUpdater`, `DataRevalidator`.
- `contract/` is Foundry Solidity for on-chain batch helpers (`BalanceHelper`, `contractValidator`).
- `server/` is the Express REST API over the shared Postgres database.

## Environment facts agents must know

- Postgres runs in Docker (`bugchain-pg`, port 5432, db `bugchain_indexer`). Start it with `docker start bugchain-pg`.
- Scanner deps are installed with deno (`deno install`), not npm. npm/yarn stall on this network.
- Keys live in `scanners/.env` (untracked): Etherscan, Alchemy RPCs per network, Telegram bot token and chat id. Never commit them, never print them.
- `scanners/core/DeploymentScanner.js` and `FundingGate.js` run as continuous workers. `run.sh` has cases: `unified`, `deployments`, `gate`, `funds`, `revalidate`.
- This machine's DNS serves AAAA-only records for some hosts (coingecko, telegram). node `fetch` times out; use `curl` subprocess or `ethers.JsonRpcProvider` with `staticNetwork: true, batchMaxCount: 1`.
- Alchemy free tier caps `eth_getLogs` at 10 blocks on ethereum (handled via `maxLogBlockRange` in `config/networks.js`) and rate-limits sustained `eth_getBlockReceipts` (handled by retry + pacing in DeploymentScanner).
