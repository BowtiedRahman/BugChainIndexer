// Robinhood chain deployment watcher. curl-transport (this box's undici
// times out on AAAA-only DNS). Own state: scan_cursor network='robinhood'.
require('dotenv').config({ path: '/home/od0gwu/projects/BugChainIndexer/scanners/.env' });
const { execFileSync } = require('child_process');
const pg = require('pg');
const { batchUpsertAddresses } = require('/home/od0gwu/projects/BugChainIndexer/scanners/common/database.js');
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const ZERO = '0x0000000000000000000000000000000000000000';
const CONF = 3, CHUNK = 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rpc(method, params) {
  for (let a = 0; a < 4; a++) {
    try {
      const out = execFileSync('curl', ['-s', '--max-time', '20', '-X', 'POST', RPC,
        '-H', 'content-type: application/json',
        '-d', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })], { encoding: 'utf8', timeout: 25000 });
      if (out && out.trim()) return JSON.parse(out);
    } catch (e) { /* retry */ }
    sleep(1500 * (a + 1));
  }
  return null;
}
const hex = n => '0x' + n.toString(16);

(async () => {
  const c = new pg.Client({ host: process.env.PGHOST, port: 5432, database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD });
  await c.connect();

  for (;;) {
    const { rows } = await c.query(`SELECT last_block FROM scan_cursor WHERE network='robinhood'`);
    const headRes = rpc('eth_blockNumber', []);
    if (!headRes?.result) { await sleep(5000); continue; }
    const head = parseInt(headRes.result, 16) - CONF;
    let from = (rows.length && Number(rows[0].last_block) > 0) ? Number(rows[0].last_block) + 1 : head;

    while (from <= head) {
      const to = Math.min(from + CHUNK - 1, head);
      let found = 0;
      for (let n = from; n <= to; n++) {
        const resp = rpc('eth_getBlockReceipts', [hex(n)]);
        const recs = resp?.result || [];
        const rowsToWrite = [];
        for (const r of recs) {
          if (r.contractAddress && r.contractAddress !== ZERO) {
            rowsToWrite.push({
              address: r.contractAddress.toLowerCase(), network: 'robinhood',
              tags: ['Contract', 'Unverified', 'Deployment'],
              deployer: (r.from || '').toLowerCase(), deployTx: r.transactionHash,
              deployed: null, firstSeen: Math.floor(Date.now()/1000), lastUpdated: Math.floor(Date.now()/1000),
              riskScore: 30, riskReasons: ['unverified','fresh']
            });
          }
        }
        if (rowsToWrite.length) {
          try { await batchUpsertAddresses(c, rowsToWrite, { batchSize: 10 }); found += rowsToWrite.length; } catch (e) { console.error('db', e.message.slice(0,50)); }
        }
        await sleep(600);
      }
      await c.query(`INSERT INTO scan_cursor (network,last_block) VALUES ('robinhood',$1) ON CONFLICT (network) DO UPDATE SET last_block=EXCLUDED.last_block, updated_at=NOW()`, [to]);
      console.log(`[${new Date().toISOString()}] robinhood scanned ${from}-${to}, ${found} deployments`);
      from = to + 1;
    }
    await sleep(5000);
  }
})().catch(e => { console.error(e); process.exit(1); });
