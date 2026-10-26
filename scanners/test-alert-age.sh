#!/bin/bash
# Feedback loop: for each funded row, compute the TRUE age from the deployment
# block timestamp and compare against what the alert claimed (age from first_seen).
cd /home/od0gwu/projects/BugChainIndexer/scanners
node -e '
require("dotenv").config();
const { ethers } = require("ethers");
const { NETWORKS } = require("./config/networks.js");
const cfg = NETWORKS.ethereum;
const provider = new ethers.JsonRpcProvider(cfg.rpcUrls[0], 1, { staticNetwork: true, batchMaxCount: 1 });
const pg = require("pg");
(async () => {
  const c = new pg.Client({ host: process.env.PGHOST, port: 5432, database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD });
  await c.connect();
  const { rows } = await c.query("SELECT address, contract_name, fund, deployed, first_seen, risk_reasons FROM addresses WHERE status=\x27funded\x27");
  const now = Math.floor(Date.now() / 1000);
  for (const r of rows) {
    const seenAgeH = Math.round((now - r.first_seen) / 360) / 10;
    let blockAgeH = null, blockNum = null;
    if (r.deployed) {
      try {
        const b = await provider.getBlock(Number(r.deployed));
        if (b?.timestamp) { blockAgeH = Math.round((now - b.timestamp) / 360) / 10; blockNum = r.deployed; }
      } catch (e) {}
    }
    console.log(`${r.address.slice(0,12)} ${r.contract_name || "?"} $${r.fund} | seen-age: ${seenAgeH}h | block ${blockNum}: ${blockAgeH !== null ? blockAgeH + "h" : "no deploy block"}`);
  }
  await c.end();
})().catch(e => console.error("fail", e.message));
' 2>&1 | grep -v injected
