/**
 * FundingGate - promotes candidate contracts that hold value.
 *
 * Runs as a standalone worker between scanner runs. Checks candidates
 * (newest first) for native + ERC-20 balance in USD via Alchemy enumeration,
 * promotes those over the threshold to 'funded', and fires a Telegram alert
 * on each promotion. Verification and enrichment still happen at discovery
 * time in DeploymentScanner; the gate only decides who deserves attention.
 *
 * Usage: NETWORK=ethereum node core/FundingGate.js [--once]
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { NETWORKS } = require('../config/networks');

const NETWORK = process.env.NETWORK || 'ethereum';
const PROMOTE_MIN_USD = Number(process.env.PROMOTE_MIN_USD || 1000);
const GATE_BATCH = Number(process.env.GATE_BATCH || 500);
const RECHECK_AFTER = Number(process.env.GATE_RECHECK_SECONDS || 900); // 15 min
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// CoinGecko price lookup. curl subprocess, not node fetch: this machine's
// DNS hands out only AAAA records for api.coingecko.com and undici times
// out on them. curl handles it. Cache everything, CoinGecko free tier is
// 10-30 calls/min and the gate does hundreds per run.
const priceCache = new Map();
const PRICE_TTL_MS = 10 * 60 * 1000;

const { execFileSync } = require('child_process');

function httpGetJson(url, timeoutSec = 20) {
  const out = execFileSync('curl', ['-s', '--max-time', String(timeoutSec), url], {
    encoding: 'utf8', timeout: (timeoutSec + 5) * 1000
  });
  if (!out || out.trim() === '') throw new Error('empty response');
  return JSON.parse(out);
}

async function priceUsd(platformId, coinId) {
  const key = `${platformId}:${coinId}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.usd;
  // DefiLlama native prices via coingecko-compatible id.
  const json = await (await fetch(`https://coins.llama.fi/prices/current/coingecko:${coinId}`)).json();
  const usd = json.coins?.[`coingecko:${coinId}`]?.price || 0;
  priceCache.set(key, { usd, at: Date.now() });
  return usd;
}

async function getNativePriceUsd(cfg) {
  // Map native currency to its CoinGecko id. Mainnets only; extend as needed.
  const ids = { ETH: 'ethereum', BNB: 'binancecoin', POL: 'matic-network',
    AVAX: 'avalanche-2', GT: 'gigachain', XDAI: 'dai',
    MNT: 'mantle', OKB: 'okb', ETHO: null };
  const id = ids[cfg.nativeCurrency] || 'ethereum';
  if (!id) return 0;
  try { return await priceUsd('native', id); } catch (e) { return 0; }
}

/**
 * Total value held by `address` in USD. Native balance plus every ERC-20
 * the address holds, enumerated by Alchemy rather than a hardcoded list.
 */
async function portfolioUsd(provider, rpcUrl, address, nativePrice, platformId) {
  let usd = 0;
  try {
    const wei = await provider.getBalance(address);
    usd += Number(ethers.formatEther(wei)) * nativePrice;
  } catch (e) { /* native balance failed; continue with tokens */ }

  // Enumerate all ERC-20 holdings. alchemy_getTokenBalances paginates.
  let pageKey;
  do {
    const params = [address, 'erc20'];
    if (pageKey) params.push({ pageKey });
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances', params })
    });
    if (!res.ok) break;
    const json = await res.json();
    const balances = json.result?.tokenBalances ?? [];
    pageKey = json.result?.pageKey;

    // DefiLlama prices: free, no key, batched (up to ~100 coins per call),
    // and reachable via node fetch on this box where CoinGecko hangs.
    // Coin format: <platform>:<token address>. Fallback to CoinGecko stays
    // in git history; llama covers the same tokens.
    const held = balances.filter(t => t.tokenBalance && t.tokenBalance !== '0x0');
    const prices = {};
    if (held.length > 0) {
      const uncached = held.map(t => t.contractAddress.toLowerCase())
        .filter(a => { const h = priceCache.get(a); return !(h && Date.now() - h.at < PRICE_TTL_MS); })
        .slice(0, 100);
      if (uncached.length > 0) {
        try {
          const coins = uncached.map(a => `${platformId}:${a}`).join(',');
          const r = await fetch(`https://coins.llama.fi/prices/current/${coins}`);
          if (r.ok) {
            const j = await r.json();
            for (const [key, v] of Object.entries(j.coins || {})) {
              const addr = key.split(':')[1].toLowerCase();
              priceCache.set(addr, { usd: v.price || 0, at: Date.now() });
            }
            for (const a of uncached) {
              if (!priceCache.has(a)) priceCache.set(a, { usd: 0, at: Date.now() });
            }
          }
        } catch (e) { /* all prices 0 this round */ }
      }
      for (const a of held.map(t => t.contractAddress.toLowerCase())) {
        const h = priceCache.get(a);
        prices[a] = { usd: h ? h.usd : 0 };
      }
    }

    for (const t of held) {
      try {
        const key = t.contractAddress.toLowerCase();
        const decimalsHex = await provider.call({ to: t.contractAddress, data: '0x313ce567' });
        const decimals = parseInt(decimalsHex, 16);
        const amount = Number(BigInt(t.tokenBalance)) / (10 ** decimals);
        usd += amount * (prices[key]?.usd || 0);
      } catch (e) { /* skip unreadable token */ }
    }
  } while (pageKey);

  return usd;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  // curl transport: api.telegram.org is AAAA-only in local DNS, undici hangs.
  try {
    const payload = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
    const out = execFileSync('curl', [
      '-s', '--max-time', '20', '-X', 'POST',
      '-H', 'content-type: application/json', '-d', payload,
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
    ], { encoding: 'utf8', timeout: 25000 });
    const json = JSON.parse(out || '{}');
    return json.ok === true;
  } catch (e) { return false; }
}

async function runOnce(provider, rpcUrl, client, cfg, nativePrice, platformId) {
  const now = Math.floor(Date.now() / 1000);

  // Candidates due for a balance check, newest first. Fresh deploys are the
  // ones being funded right now, so they get checked before old candidates.
  // Contracts only: EOAs are wallets, not bug-hunt targets, and an EOA that
  // holds money is normal, not a signal.
  // Fresh only: the alert is "new contract just got funded". A MAX_DEPLOY_AGE_HOURS
  // window on the deployment block (not row time) keeps old contracts from
  // triggering alerts when they merely move money. 0 disables the filter.
  const maxDeployAge = Number(process.env.MAX_DEPLOY_AGE_HOURS || 24);
  const ageCutoff = maxDeployAge > 0
    ? Math.floor(now - maxDeployAge * 3600) * 1000
    : 0;
  const { rows } = await client.query(`
    SELECT address, deployer, verified, proxy, risk_score, risk_reasons, first_seen, deployed
    FROM addresses
    WHERE network = $1 AND status = 'candidate'
      AND balance_checked_at < $2
      AND NOT ('EOA' = ANY(tags))
      AND 'Contract' = ANY(tags)
      AND deployed IS NOT NULL AND deployed > 0 AND deployed * 1000 >= $4
    ORDER BY first_seen DESC LIMIT $3`,
    [NETWORK, now - RECHECK_AFTER, GATE_BATCH, ageCutoff]);

  let promoted = 0;
  for (const row of rows) {
    // Double-check the address actually has code. The tag may be stale or
    // wrong; a wallet with money is not a bug-hunt target.
    let code = '0x';
    try { code = await provider.getCode(row.address); } catch (e) { /* treat as EOA */ }
    if (code === '0x') {
      await client.query(`
        UPDATE addresses SET balance_checked_at = $1,
          tags = array_append(array_remove(tags, 'Contract'), 'EOA')
        WHERE address = $2 AND network = $3`,
        [now, row.address, NETWORK]);
      continue;
    }

    const usd = await portfolioUsd(provider, rpcUrl, row.address, nativePrice, platformId);
    const qualifies = usd >= PROMOTE_MIN_USD;

    // Refresh verification state at promotion time. The discovery-time flag
    // can be stale (Etherscan may have verified the contract since).
    if (qualifies) {
      const etherscan = require('../common/core.js');

      // Backfill deployment facts when discovery left them blank, so the
      // alert prints the real deploy date and the row keeps them forever.
      if (!row.deployer || !row.deployed) {
        try {
          const cc = await etherscan.etherscanRequest(NETWORK, {
            module: 'contract', action: 'getcontractcreation', contractaddresses: row.address
          });
          const c0 = Array.isArray(cc?.result) ? cc.result[0] : null;
          if (c0?.blockNumber && c0.blockNumber !== '0') {
            const blockNum = Number(c0.blockNumber);
            const deployer = (c0.contractCreator || '').toLowerCase();
            let deployTs = null;
            try {
              const blk = await provider.getBlock(blockNum);
              deployTs = blk?.timestamp || null;
            } catch (e) { /* keep null; block may be pruned */ }
            // `deployed` stores a unix-seconds timestamp everywhere else in
            // the schema (Scanner.initialize, alerts, indexes). Block numbers
            // here would render as 1970 dates and break the age filter.
            await client.query(`
              UPDATE addresses SET deployer = $1, deploy_tx = $2, deployed = $3
              WHERE address = $4 AND network = $5`,
              [deployer, c0.txHash || null, deployTs, row.address, NETWORK]);
            row.deployed = deployTs;
            row.deployer = deployer;
          }
        } catch (e) { /* deployment lookup failed; keep nulls */ }
      }

      try {
        const src = await etherscan.etherscanRequest(NETWORK, {
          module: 'contract', action: 'getsourcecode', address: row.address
        });
        const r0 = Array.isArray(src?.result) ? src.result[0] : null;
        if (r0) {
          const isVerified = Boolean(r0.SourceCode && String(r0.SourceCode).trim() !== '');
          row.verified = isVerified;
          row.contractName = r0.ContractName || null;
          await client.query(`
            UPDATE addresses SET verified = $1, contract_name = COALESCE($2, contract_name)
            WHERE address = $3 AND network = $4`,
            [isVerified, r0.ContractName || null, row.address, NETWORK]);
        }
      } catch (e) { /* keep discovery-time state */ }
    }
    if (qualifies && !row.verified) {
      // A funded but unverified contract is the highest-priority target.
      // Record it now so the alert and the database agree.
      const reasons = row.risk_reasons || [];
      if (!reasons.includes('unverified')) reasons.push('unverified');
      await client.query(`
        UPDATE addresses SET risk_score = GREATEST(risk_score, 30),
          risk_reasons = $1
        WHERE address = $2 AND network = $3`,
        [reasons, row.address, NETWORK]);
      row.risk_score = Math.max(row.risk_score, 30);
      row.risk_reasons = reasons;
    }

    if (qualifies) {
      await client.query(`
        UPDATE addresses SET
          fund = $1, balance_checked_at = $2,
          status = 'funded',
          funded_at = COALESCE(funded_at, $2)
        WHERE address = $3 AND network = $4`,
        [Math.floor(usd), now, row.address, NETWORK]);
      promoted++;

      // Age the deployment honestly: block time, not row-insert time.
      let ageMin = null;
      try {
        const block = await provider.getBlock(Number(row.deployed));
        if (block?.timestamp) ageMin = Math.round((now - block.timestamp) / 60);
      } catch (e) { /* fall back to first_seen */ }
      if (ageMin === null) ageMin = Math.round((now - row.first_seen) / 60);

      const riskTags = (row.risk_reasons || []).join(', ') || 'none';
      const msg =
`<b>New funded contract on ${NETWORK}</b>
Address: <code>${row.address}</code>
${row.contractName ? 'Name: ' + row.contractName + '\n' : ''}Value: $${Math.floor(usd).toLocaleString()}
Age: ${ageMin < 60 ? ageMin + ' min' : ageMin < 1440 ? Math.round(ageMin/60) + ' hours' : Math.round(ageMin/1440) + ' days'}
Verified: ${row.verified ? 'yes' : 'NO'}
Proxy: ${row.proxy ? 'yes' : 'no'}
Risk: ${row.risk_score} (${riskTags})
Deployer: <code>${row.deployer || 'unknown'}</code>`;
      const sent = await sendTelegram(msg);
      console.log(`[${NETWORK}] PROMOTED ${row.address} $${Math.floor(usd).toLocaleString()} alert=${sent}`);
    } else {
      await client.query(`
        UPDATE addresses SET fund = $1, balance_checked_at = $2
        WHERE address = $3 AND network = $4`,
        [Math.floor(usd), now, row.address, NETWORK]);
    }

    await sleep(150); // stay under Alchemy free-tier compute units
  }

  return { checked: rows.length, promoted };
}

async function main() {
  const once = process.argv.includes('--once');
  const cfg = NETWORKS[NETWORK];
  if (!cfg) { console.error(`[${NETWORK}] unknown network`); process.exit(1); }

  const rpcUrl = cfg.rpcUrls[0];
  // staticNetwork + batchMaxCount=1: ethers' network autodetect and request
  // batching both stall against some Alchemy responses on this machine.
  const provider = new ethers.JsonRpcProvider(rpcUrl, cfg.chainId, {
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

  // CoinGecko platform id per network, for token price lookups.
  const platforms = { ethereum: 'ethereum', binance: 'binance-smart-chain',
    polygon: 'polygon-pos', arbitrum: 'arbitrum-one', optimism: 'optimistic-ethereum',
    base: 'base', avalanche: 'avalanche', gnosis: 'xdai' };
  const platformId = platforms[NETWORK] || 'ethereum';
  const nativePrice = await getNativePriceUsd(cfg);

  console.log(`[${NETWORK}] FundingGate: min $${PROMOTE_MIN_USD}, batch ${GATE_BATCH}, native $${nativePrice}`);

  if (once) {
    const r = await runOnce(provider, rpcUrl, client, cfg, nativePrice, platformId);
    console.log(`[${NETWORK}] gate pass: checked ${r.checked}, promoted ${r.promoted}`);
    await client.end();
    return;
  }

  for (;;) {
    try {
      const r = await runOnce(provider, rpcUrl, client, cfg, nativePrice, platformId);
      if (r.checked > 0) {
        console.log(`[${new Date().toISOString()}][${NETWORK}] gate: checked ${r.checked}, promoted ${r.promoted}`);
      }
    } catch (e) {
      console.error(`[${NETWORK}] gate error: ${e.message}`);
    }
    await sleep(RECHECK_AFTER * 1000);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
