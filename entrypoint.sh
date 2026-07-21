#!/bin/sh
# Stock ForteL2 verifier: op-geth + op-node (no sequencer / batcher / proposer).
# Includes Render-oriented readiness/shutdown fixes from ForteL2 PRs #23–#25.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
JWT_FILE="${JWT_FILE:-$DATA_DIR/jwt.txt}"
GENESIS="${GENESIS:-/config/genesis.json}"
ROLLUP="${ROLLUP:-/config/rollup.json}"
# Render Web Service injects PORT — prefer it for EL HTTP when set.
L2_HTTP_PORT="${PORT:-${L2_HTTP_PORT:-8545}}"
L2_AUTH_PORT="${L2_AUTH_PORT:-8551}"
L2_NODE_RPC_PORT="${L2_NODE_RPC_PORT:-9545}"
L1_BLOCK_TIME="${L1_BLOCK_TIME:-12}"
# Seconds to wait for op-geth IPC after start. 0 = keep waiting while the PID is alive
# (datadir open / crash recovery on constrained disks can exceed 60s).
GETH_READY_TIMEOUT_SECS="${GETH_READY_TIMEOUT_SECS:-0}"
# geth default --cache is 1024MB and will OOM Render Starter (512MB). Keep low on small plans.
GETH_CACHE_MB="${GETH_CACHE_MB:-256}"

case "$GETH_READY_TIMEOUT_SECS" in
  ''|*[!0-9]*)
    echo "ERROR: GETH_READY_TIMEOUT_SECS must be a non-negative integer (got: $GETH_READY_TIMEOUT_SECS)" >&2
    exit 1
    ;;
esac

case "$GETH_CACHE_MB" in
  ''|*[!0-9]*)
    echo "ERROR: GETH_CACHE_MB must be a non-negative integer (got: $GETH_CACHE_MB)" >&2
    exit 1
    ;;
esac

if [ -z "${L1_RPC_URL:-}" ]; then
  echo "ERROR: L1_RPC_URL is required (Ethereum Sepolia HTTPS)" >&2
  exit 1
fi

if [ ! -f "$GENESIS" ] || [ ! -f "$ROLLUP" ]; then
  echo "ERROR: missing $GENESIS and/or $ROLLUP" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
if [ ! -f "$JWT_FILE" ]; then
  if [ -n "${JWT_SECRET:-}" ]; then
    printf '%s' "$JWT_SECRET" > "$JWT_FILE"
  else
    openssl rand -hex 32 > "$JWT_FILE"
  fi
  chmod 600 "$JWT_FILE"
fi

if [ ! -d "$DATA_DIR/geth" ]; then
  echo "Initializing op-geth datadir"
  geth init --datadir="$DATA_DIR" --state.scheme=hash "$GENESIS"
fi

echo "Starting op-geth (verifier EL) on :$L2_HTTP_PORT (cache=${GETH_CACHE_MB}MB, gcmode=full)"
geth \
  --datadir="$DATA_DIR" \
  --http --http.addr=0.0.0.0 --http.port="$L2_HTTP_PORT" \
  --http.api=eth,net,web3,debug,txpool \
  --http.vhosts=* --http.corsdomain=* \
  --authrpc.addr=127.0.0.1 --authrpc.port="$L2_AUTH_PORT" --authrpc.vhosts=* \
  --authrpc.jwtsecret="$JWT_FILE" \
  --syncmode=full --gcmode=full \
  --cache="$GETH_CACHE_MB" \
  --rollup.disabletxpoolgossip=true \
  --nodiscover --maxpeers=0 \
  --verbosity=3 &
GETH_PID=$!

cleanup() {
  if [ -n "${NODE_PID:-}" ]; then
    kill "$NODE_PID" 2>/dev/null || true
  fi
  kill "$GETH_PID" 2>/dev/null || true
  if [ -n "${NODE_PID:-}" ]; then
    wait "$NODE_PID" 2>/dev/null || true
  fi
  wait "$GETH_PID" 2>/dev/null || true
}
trap cleanup INT TERM

# Wait for engine API: require IPC + a successful attach, not merely a live PID.
# Do not kill a still-alive geth after a short fixed window — persistent
# datadirs can take minutes to open IPC during startup/crash recovery.
if [ "$GETH_READY_TIMEOUT_SECS" -eq 0 ]; then
  echo "Waiting for op-geth engine API (no timeout while pid $GETH_PID is alive)..."
else
  echo "Waiting for op-geth engine API (up to ${GETH_READY_TIMEOUT_SECS}s)..."
fi
i=0
ready=0
while true; do
  if ! kill -0 "$GETH_PID" 2>/dev/null; then
    echo "ERROR: op-geth exited before engine API became ready" >&2
    wait "$GETH_PID" || true
    exit 1
  fi
  if [ -S "$DATA_DIR/geth.ipc" ] \
    && geth attach --exec "eth.blockNumber" "$DATA_DIR/geth.ipc" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [ "$GETH_READY_TIMEOUT_SECS" -gt 0 ] && [ "$i" -ge "$GETH_READY_TIMEOUT_SECS" ]; then
    break
  fi
  if [ "$i" -gt 0 ] && [ $((i % 30)) -eq 0 ]; then
    echo "Still waiting for op-geth IPC at $DATA_DIR/geth.ipc (${i}s elapsed; pid $GETH_PID alive)"
  fi
  sleep 1
  i=$((i + 1))
done
if [ "$ready" -ne 1 ]; then
  echo "ERROR: timed out waiting for op-geth IPC/RPC at $DATA_DIR/geth.ipc after ${i}s" >&2
  kill "$GETH_PID" 2>/dev/null || true
  wait "$GETH_PID" 2>/dev/null || true
  exit 1
fi
echo "op-geth engine API ready after ${i}s"

echo "Starting op-node (L1 derivation / verifier)"
op-node \
  --l1="$L1_RPC_URL" \
  --l1.rpckind=standard \
  --l1.trustrpc=true \
  --l1.beacon.ignore=true \
  --l1.beacon.slot-duration-override="$L1_BLOCK_TIME" \
  --l2="http://127.0.0.1:${L2_AUTH_PORT}" \
  --l2.jwt-secret="$JWT_FILE" \
  --l2.enginekind=geth \
  --rollup.config="$ROLLUP" \
  --sequencer.enabled=false \
  --verifier.l1-confs=1 \
  --p2p.disable=true \
  --rpc.addr=0.0.0.0 \
  --rpc.port="$L2_NODE_RPC_PORT" \
  --log.level=info &
NODE_PID=$!

wait "$NODE_PID"
cleanup
