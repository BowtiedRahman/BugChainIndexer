/**
 * DeploymentScanner - contract deployment watcher
 *
 * Walks new blocks via eth_getBlockReceipts, records every contract created
 * per block (tx.to == null), enriches each deployment, and upserts it into
 * the shared addresses table with the enrichment columns added by ensureSchema.
 * A scan_cursor row per network makes the scan resumable across restarts.
 *
 * Usage: NETWORK=ethereum node core/DeploymentScanner.js
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { NETWORKS, CONFIG } = require('../config/networks');
const { ensureSchema, batchUpsertAddresses } = require('../common/database');

const NETWORK = process.env.NETWORK || 'ethereum';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || '3', 10);
const CHUNK = parseInt(process.env.DEPLOY_CHUNK || '100', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const cfg = NETWORKS[NETWORK];
  if (!cfg) {
    console.error(`[${NETWORK}] unknown network, not in config/networks.js`);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrls[0], cfg.chainId, {
    staticNetwork: true, batchMaxCount: 1
  });

  const pg = require('pg');
  const client = new pg.Client({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'bugchain_indexer',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
  });
  await client.connect();
  await ensureSchema(client);

  // Deployment cursor: resume from the last fully scanned block + 1.
  await client.query(`CREATE TABLE IF NOT EXISTS scan_cursor (
    network TEXT PRIMARY KEY, last_block BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

  const { rows } = await client.query(
    `SELECT last_block FROM scan_cursor WHERE network = $1`, [NETWORK]);

  // BACKFILL mode: FROM_BLOCK/TO_BLOCK env (block numbers) or FROM_DATE/TO_DATE
  // (YYYY-MM-DD, converted via binary search on block timestamps). Scans the
  // given range once, never updates scan_cursor, then exits. The live loop's
  // cursor stays untouched, so backfill and live scanning don't fight.
  const envFrom = process.env.FROM_BLOCK;
  const envTo = process.env.TO_BLOCK;
  const envFromDate = process.env.FROM_DATE;
  const envToDate = process.env.TO_DATE;
  let backfill = null;
  if (envFrom || envFromDate) {
    let fromB = envFrom ? Number(envFrom) : null;
    let toB = envTo ? Number(envTo) : null;
    const toTs = envToDate ? Math.floor(new Date(envToDate + 'T23:59:59Z').getTime() / 1000) : null;
    const fromTs = envFromDate ? Math.floor(new Date(envFromDate + 'T00:00:00Z').getTime() / 1000) : null;

    async function blockAtTimestamp(ts) {
      // binary search between a known low and high block
      let lo = 1, hi = await provider.getBlockNumber();
      let best = hi;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        let blk;
        for (let a = 0; a < 3; a++) {
          try { blk = await provider.getBlock(mid); break; } catch (e) { blk = null; await sleep(1000); }
        }
        if (!blk) { lo = mid + 1; continue; }
        if (blk.timestamp < ts) lo = mid + 1; else { best = mid; hi = mid - 1; }
      }
      return best;
    }

    if (fromB === null && fromTs !== null) {
      fromB = await blockAtTimestamp(fromTs);
      console.log(`[${NETWORK}] FROM_DATE ${envFromDate} -> block ${fromB}`);
    }
    if (toB === null && toTs !== null) {
      toB = (await blockAtTimestamp(toTs));
      console.log(`[${NETWORK}] TO_DATE ${envToDate} -> block ${toB}`);
    }
    if (toB === null) toB = (await provider.getBlockNumber()) - CONFIRMATIONS;
    if (fromB > toB) { console.error(`[${NETWORK}] empty range ${fromB}-${toB}`); process.exit(1); }
    backfill = { from: fromB, to: toB };
  }

  const liveFrom = rows.length
    ? Number(rows[0].last_block) + 1
    : (await provider.getBlockNumber());

  if (backfill) {
    console.log(`[${NETWORK}] BACKFILL mode: blocks ${backfill.from} -> ${backfill.to} (${backfill.to - backfill.from + 1} blocks)`);
    for (let n = backfill.from; n <= backfill.to; n += CHUNK) {
      const to = Math.min(n + CHUNK - 1, backfill.to);
      let total = 0;
      for (let b = n; b <= to; b++) {
        total += await scanBlock(provider, client, b);
      }
      console.log(`[${NETWORK}] backfill ${n}-${to} done (${total} deployments)`);
    }
    console.log(`[${NETWORK}] backfill complete, exiting`);
    process.exit(0);
  }

  let from = liveFrom;

  console.log(`[${NETWORK}] starting at block ${from}, confirmations=${CONFIRMATIONS}, chunk=${CHUNK}`);

  for (;;) {
    let head;
    try {
      head = (await provider.getBlockNumber()) - CONFIRMATIONS;
    } catch (e) {
      console.error(`[${NETWORK}] getBlockNumber failed, retrying: ${e.message.slice(0, 50)}`);
      await sleep(5000);
      continue;
    }
    if (head < from) { await sleep(5000); continue; }
    const to = Math.min(from + CHUNK - 1, head);

    let foundCount = 0;
    for (let n = from; n <= to; n++) {
      foundCount += await scanBlock(provider, client, n);
    }

    if (foundCount > 0) {
      console.log(`[${NETWORK}] scanned ${from}-${to}, ${foundCount} deployments`);
    }
    // Pace the chunk: ~2 blocks/sec keeps sustained 429s away on free tier.
    await sleep(CHUNK * 500);

    await client.query(`INSERT INTO scan_cursor (network, last_block)
      VALUES ($1,$2) ON CONFLICT (network) DO UPDATE SET
      last_block = EXCLUDED.last_block, updated_at = NOW()`, [NETWORK, to]);

    from = to + 1;
  }
}

/**
 * Scan one block's receipts for contract deployments, enrich, store.
 * Shared by the live loop and backfill mode. Returns deployments found.
 */
async function scanBlock(provider, client, n) {
  // Alchemy free tier 429s under sustained eth_getBlockReceipts load and
  // returns an empty body. Retry with backoff; give up after 5 tries.
  let receipts = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      receipts = await provider.send('eth_getBlockReceipts', [ethers.toBeHex(n)]);
      if (receipts) break;
    } catch (e) {
      if (attempt < 4) {
        await sleep(2000 * (attempt + 1));
      } else {
        console.error(`[${NETWORK}] block ${n} receipts failed after 5 attempts: ${e.message.slice(0, 60)}`);
      }
    }
  }
  if (!receipts) return 0;

  // Block timestamp for the deployment record. `deployed` is unix-seconds
  // everywhere else in the schema; storing the block number here rendered
  // 1970 dates and broke the gate's age filter.
  let blockTs = null;
  try {
    const blk = await provider.getBlock(n);
    blockTs = blk?.timestamp || null;
  } catch (e) { blockTs = null; }

  let count = 0;
  for (const r of receipts) {
    if (r.contractAddress &&
        r.contractAddress !== '0x0000000000000000000000000000000000000000') {
      count++;
      await enrichAndStore(provider, client, {
        address: r.contractAddress.toLowerCase(),
        deployer: (r.from || '').toLowerCase(),
        deployTx: r.transactionHash,
        blockNumber: n,
        blockTimestamp: blockTs
      });
    }
  }
  return count;
}

/**
 * Enrich a single deployment: EIP-1967 proxy slot check, Etherscan verification,
 * simple risk scoring, then store. Enrichment failures degrade to unverified
 * rows with risk_reasons recorded - a failed lookup must not lose the deployment.
 */
async function enrichAndStore(provider, client, deployment) {
  const { address, deployer, deployTx, blockNumber, blockTimestamp } = deployment;

  // EIP-1967 implementation slot
  const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  let proxy = false;
  let implementation = null;
  try {
    const slot = await provider.getStorage(address, EIP1967_IMPL);
    const impl = slot.toLowerCase();
    if (impl !== '0x' + '0'.repeat(64)) {
      proxy = true;
      // slot value stores address in the low 160 bits
      implementation = '0x' + impl.slice(-40);
    }
  } catch (e) { /* treat as non-proxy */ }

  // Etherscan verification
  const etherscan = require('../common/core.js');
  let verified = false;
  let contractName = null;
  let compilerVersion = null;
  let licenseType = null;
  let sourceCode = null;
  let abi = null;
  try {
    const src = await etherscan.etherscanRequest(NETWORK, {
      module: 'contract', action: 'getsourcecode', address
    });
    const row = Array.isArray(src?.result) ? src.result[0] : null;
    if (row) {
      contractName = row.ContractName || null;
      compilerVersion = row.CompilerVersion || null;
      licenseType = row.License || null;
      const hasSource = row.SourceCode && String(row.SourceCode).trim() !== '';
      verified = Boolean(row.SourceCode || row.ABI) && hasSource !== false;
      if (row.ABI && row.ABI !== 'Contract Source Code Not Verified (EIP-155)') {
        try { abi = JSON.parse(row.ABI); } catch (e) { abi = null; }
      }
      if (hasSource) sourceCode = String(row.SourceCode);
    }
  } catch (e) {
    // leave verified=false; risk scoring records this below
  }

  // Risk scoring
  const riskReasons = [];
  let riskScore = 0;
  if (!verified) { riskScore += 30; riskReasons.push('unverified'); }
  if (proxy) { riskScore += 20; riskReasons.push('proxy'); }
  if (!deployer) { riskScore += 10; riskReasons.push('unknown_deployer'); }
  if (blockNumber - (deployment.firstSeen || blockNumber) < 10) {
    riskReasons.push('fresh');
  }

  const now = Math.floor(Date.now() / 1000);
  await batchUpsertAddresses(client, [{
    address,
    network: NETWORK,
    tags: verified ? ['Contract', 'Verified', 'Deployment'] : ['Contract', 'Unverified', 'Deployment'],
    contractName,
    deployed: blockTimestamp || Math.floor(Date.now() / 1000),
    lastUpdated: now,
    firstSeen: now,
    verified,
    proxy,
    implementation,
    compilerVersion,
    licenseType,
    sourceCode,
    abi,
    deployer,
    deployTx,
    riskScore,
    riskReasons
  }], { batchSize: 10 });

  console.log(`[${NETWORK}] deployed ${address} proxy=${proxy} verified=${verified} risk=${riskScore}`);
}

main().catch(e => { console.error(e); process.exit(1); });
