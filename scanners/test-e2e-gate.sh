#!/bin/bash
# End-to-end regression test for the old-alert bug:
# 1. Seed a fake candidate whose deployed timestamp is 1 year old + is a real contract.
#    Expect: gate does NOT promote it (age filter).
# 2. Seed a fake candidate deployed 5 minutes ago (real code, funded).
#    Expect: gate promotes it, alert fires, age prints "minutes".
set -e
cd /home/od0gwu/projects/BugChainIndexer/scanners
NOW=$(date +%s)
OLD=$((NOW - 31536000))   # 1 year ago
FRESH=$((NOW - 300))      # 5 min ago
# real deployed contract addresses (code exists), fake values
OLD_ADDR=0x5fbaa3a3b489199338fbd85f7e3d444dc0504f33
FRESH_ADDR=0xc9b4bc7c15423fcfe6b75ab5118ba773945a3a46

docker exec bugchain-pg psql -U postgres -d bugchain_indexer -q -c "
UPDATE addresses SET status='candidate', fund=0, balance_checked_at=0, deployed=$OLD, first_seen=$NOW WHERE address='$OLD_ADDR';
UPDATE addresses SET status='candidate', fund=0, balance_checked_at=0, deployed=$FRESH, first_seen=$NOW WHERE address='$FRESH_ADDR';"

env NETWORK=ethereum GATE_RECHECK_SECONDS=0 GATE_BATCH=10 node core/FundingGate.js --once 2>&1 | grep -E 'PROMOTED|gate pass'

echo "--- verdict ---"
OLD_STATUS=$(docker exec bugchain-pg psql -U postgres -d bugchain_indexer -tAc "SELECT status FROM addresses WHERE address='$OLD_ADDR'")
FRESH_STATUS=$(docker exec bugchain-pg psql -U postgres -d bugchain_indexer -tAc "SELECT status FROM addresses WHERE address='$FRESH_ADDR'")
if [ "$OLD_STATUS" = "candidate" ] && [ "$FRESH_STATUS" = "funded" ]; then
  echo "PASS: old contract stayed candidate, fresh contract promoted"
else
  echo "FAIL: old=$OLD_STATUS fresh=$FRESH_STATUS"
fi
