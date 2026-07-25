#!/bin/sh
# Docker HEALTHCHECK for the single-container verifier.
#
# Entrypoint waits indefinitely (by default) for op-geth IPC during long
# datadir open / crash recovery. Docker's --start-period is a fixed window, so
# a naive attach-only check can mark the container unhealthy and trigger
# restarts before recovery finishes. Until entrypoint records readiness, treat
# probes as still-starting (exit 0). After that, require a live engine attach.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
# Ephemeral path (not on the persistent /data volume) so a previous run cannot
# leave a stale "ready" marker across container recreation.
READY_FILE="${FORTEL2_EL_READY_FILE:-/tmp/fortel2-el-ready}"

if [ ! -f "$READY_FILE" ]; then
  exit 0
fi

geth attach --exec "eth.blockNumber" "$DATA_DIR/geth.ipc" >/dev/null 2>&1 || exit 1
