#!/bin/sh
# Docker HEALTHCHECK for the single-container verifier.
#
# Entrypoint waits indefinitely (by default) for op-geth IPC during long
# datadir open / crash recovery. Docker's --start-period is a fixed window
# where probe *failures* do not count toward --retries and the container
# stays "starting". Exit 0 always means healthy, so until entrypoint records
# readiness we must fail the probe (exit 1) — not succeed. After the marker
# exists, require a live engine attach.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
# Ephemeral path (not on the persistent /data volume) so a previous run cannot
# leave a stale "ready" marker across container recreation.
READY_FILE="${FORTEL2_EL_READY_FILE:-/tmp/fortel2-el-ready}"

if [ ! -f "$READY_FILE" ]; then
  # Not ready yet: fail so Docker keeps health=starting during --start-period
  # (a successful check would mark healthy immediately).
  exit 1
fi

geth attach --exec "eth.blockNumber" "$DATA_DIR/geth.ipc" >/dev/null 2>&1 || exit 1
