#!/bin/sh
# Docker HEALTHCHECK for the single-container verifier.
#
# Entrypoint waits indefinitely (by default) for op-reth HTTP during long
# datadir open / crash recovery. Docker's --start-period is a fixed window
# where probe *failures* do not count toward --retries and the container
# stays "starting". Exit 0 always means healthy, so until entrypoint records
# readiness we must fail the probe (exit 1) — not succeed. After the marker
# exists, require a live loopback eth_blockNumber (no geth attach).
set -eu

# Ephemeral path (not on the persistent /data volume) so a previous run cannot
# leave a stale "ready" marker across container recreation.
READY_FILE="${FORTEL2_EL_READY_FILE:-/tmp/fortel2-el-ready}"
L2_GETH_HTTP_PORT="${L2_GETH_HTTP_PORT:-8546}"

if [ ! -f "$READY_FILE" ]; then
  # Not ready yet: fail so Docker keeps health=starting during --start-period
  # (a successful check would mark healthy immediately).
  exit 1
fi

python3 -c '
import sys
import urllib.request

port = sys.argv[1]
url = "http://127.0.0.1:%s" % port
body = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}"
req = urllib.request.Request(
    url,
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
urllib.request.urlopen(req, timeout=2).read()
' "$L2_GETH_HTTP_PORT" >/dev/null 2>&1 || exit 1
