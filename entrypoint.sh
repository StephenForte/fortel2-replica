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
L2_ENGINE_PORT="${L2_ENGINE_PORT:-8551}"
L2_NODE_RPC_PORT="${L2_NODE_RPC_PORT:-9545}"
L1_BLOCK_TIME="${L1_BLOCK_TIME:-12}"
# Seconds to wait for op-geth IPC after start. 0 = keep waiting while the PID is alive
# (datadir open / crash recovery on constrained disks can exceed 60s).
GETH_READY_TIMEOUT_SECS="${GETH_READY_TIMEOUT_SECS:-0}"
# geth default --cache is 1024MB and will OOM Render Starter (512MB). Keep low on small plans.
GETH_CACHE_MB="${GETH_CACHE_MB:-256}"
# Optional Go soft memory caps (Go 1.19+). Set on Render Standard so op-geth + op-node +
# the L1 router stay under the cgroup limit during L1 derivation bursts. Unset on ≥4GB hosts.
GETH_GOMEMLIMIT="${GETH_GOMEMLIMIT:-}"
OP_NODE_GOMEMLIMIT="${OP_NODE_GOMEMLIMIT:-}"
# How often to check that both long-running processes are alive.
PROCESS_POLL_INTERVAL_SECS="${PROCESS_POLL_INTERVAL_SECS:-1}"
# Marker for Docker HEALTHCHECK: absent → probe fails (health=starting during
# --start-period). Keep off the persistent volume so a prior run cannot leave
# a stale ready flag.
FORTEL2_EL_READY_FILE="${FORTEL2_EL_READY_FILE:-/tmp/fortel2-el-ready}"
rm -f "$FORTEL2_EL_READY_FILE"

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

case "$PROCESS_POLL_INTERVAL_SECS" in
  ''|*[!0-9]*|0)
    echo "ERROR: PROCESS_POLL_INTERVAL_SECS must be a positive integer (got: $PROCESS_POLL_INTERVAL_SECS)" >&2
    exit 1
    ;;
esac

# Near QuickNode credit cap / overrides (highest priority wins for direct URL):
#   L1_RPC_FORCE=public|metered  — pin upstream (skips schedule)
#   L1_USE_PUBLIC_RPC=1          — same as FORCE=public
#   L1_RPC_SCHEDULE=business     — 09:00–17:00 local TZ → QuickNode, else publicnode
#                                  via in-container JSON-RPC router (no op-node restart)
L1_RPC_PUBLIC_URL="${L1_RPC_PUBLIC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
L1_RPC_SCHEDULE="${L1_RPC_SCHEDULE:-off}"
L1_RPC_FORCE="${L1_RPC_FORCE:-}"
L1_RPC_ROUTER_SCRIPT="${L1_RPC_ROUTER_SCRIPT:-/l1_rpc_router.py}"
L1_RPC_LISTEN="${L1_RPC_LISTEN:-127.0.0.1:18545}"
L1_RPC_METERED_URL="${L1_RPC_URL:-}"
ROUTER_PID=""

case "${L1_RPC_FORCE}" in
  public|PUBLIC)
    L1_RPC_URL="$L1_RPC_PUBLIC_URL"
    L1_RPC_MODE=public
    L1_RPC_SCHEDULE=off
    ;;
  metered|METERED|quicknode|QUICKNODE|qn|QN)
    if [ -z "${L1_RPC_METERED_URL}" ]; then
      echo "ERROR: L1_RPC_FORCE=metered requires L1_RPC_URL (QuickNode)" >&2
      exit 1
    fi
    L1_RPC_URL="$L1_RPC_METERED_URL"
    L1_RPC_MODE=metered
    L1_RPC_SCHEDULE=off
    ;;
  "" ) ;;
  *)
    echo "ERROR: L1_RPC_FORCE must be public, metered, or empty (got: ${L1_RPC_FORCE})" >&2
    exit 1
    ;;
esac

if [ -z "${L1_RPC_FORCE}" ]; then
  case "${L1_USE_PUBLIC_RPC:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      L1_RPC_URL="$L1_RPC_PUBLIC_URL"
      L1_RPC_MODE=public
      L1_RPC_SCHEDULE=off
      ;;
    0|false|FALSE|no|NO|off|OFF|"")
      L1_RPC_MODE=metered
      ;;
    *)
      echo "ERROR: L1_USE_PUBLIC_RPC must be 0 or 1 (got: ${L1_USE_PUBLIC_RPC})" >&2
      exit 1
      ;;
  esac
fi

case "${L1_RPC_SCHEDULE}" in
  business|BUSINESS|1|true|TRUE|yes|YES|on|ON)
    L1_RPC_SCHEDULE=business
    ;;
  off|OFF|0|false|FALSE|no|NO|"")
    L1_RPC_SCHEDULE=off
    ;;
  *)
    echo "ERROR: L1_RPC_SCHEDULE must be business or off (got: ${L1_RPC_SCHEDULE})" >&2
    exit 1
    ;;
esac

if [ "$L1_RPC_SCHEDULE" = "business" ]; then
  if [ -z "${L1_RPC_METERED_URL}" ]; then
    echo "ERROR: L1_RPC_SCHEDULE=business requires L1_RPC_URL (QuickNode / metered)" >&2
    exit 1
  fi
  case "$L1_RPC_METERED_URL" in
    *publicnode*|*rpc.sepolia.org*)
      echo "WARN: L1_RPC_URL looks like a public RPC — business hours will not use QuickNode" >&2
      ;;
  esac
  L1_RPC_MODE=schedule
fi

if [ -z "${L1_RPC_URL:-}" ] && [ "$L1_RPC_SCHEDULE" != "business" ]; then
  echo "ERROR: L1_RPC_URL is required (Ethereum Sepolia HTTPS)" >&2
  echo "  Or set L1_USE_PUBLIC_RPC=1 / L1_RPC_FORCE=public to use ${L1_RPC_PUBLIC_URL}" >&2
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

GETH_MEM_LOG=""
[ -n "$GETH_GOMEMLIMIT" ] && GETH_MEM_LOG=", gomemlimit=${GETH_GOMEMLIMIT}"
echo "Starting op-geth (verifier EL) on :$L2_HTTP_PORT (cache=${GETH_CACHE_MB}MB, gcmode=full${GETH_MEM_LOG})"
env ${GETH_GOMEMLIMIT:+GOMEMLIMIT=$GETH_GOMEMLIMIT} geth \
  --datadir="$DATA_DIR" \
  --http --http.addr=0.0.0.0 --http.port="$L2_HTTP_PORT" \
  --http.api=eth,net,web3,debug,txpool \
  --http.vhosts=* --http.corsdomain=* \
  --authrpc.addr=127.0.0.1 --authrpc.port="$L2_ENGINE_PORT" --authrpc.vhosts=* \
  --authrpc.jwtsecret="$JWT_FILE" \
  --syncmode=full --gcmode=full \
  --cache="$GETH_CACHE_MB" \
  --cache.preimages=false \
  --rollup.disabletxpoolgossip=true \
  --nodiscover --maxpeers=0 \
  --verbosity=3 &
GETH_PID=$!

cleanup() {
  if [ -n "${NODE_PID:-}" ]; then
    kill "$NODE_PID" 2>/dev/null || true
  fi
  if [ -n "${ROUTER_PID:-}" ]; then
    kill "$ROUTER_PID" 2>/dev/null || true
  fi
  kill "$GETH_PID" 2>/dev/null || true
  if [ -n "${NODE_PID:-}" ]; then
    wait "$NODE_PID" 2>/dev/null || true
  fi
  if [ -n "${ROUTER_PID:-}" ]; then
    wait "$ROUTER_PID" 2>/dev/null || true
  fi
  wait "$GETH_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
# Signal HEALTHCHECK that EL is ready; probes may now succeed (healthy).
: >"$FORTEL2_EL_READY_FILE"
echo "op-geth engine API ready after ${i}s"

# Credit-budget defaults (Render catch-up previously burned ~3M+ credits/half-day
# at rate-limit=20). Override via Render env / .env.
L1_HTTP_POLL="${L1_HTTP_POLL_INTERVAL:-24s}"
L1_RPC_RATE_LIMIT="${L1_RPC_RATE_LIMIT:-5}"

if [ "$L1_RPC_MODE" = "schedule" ]; then
  if [ ! -f "$L1_RPC_ROUTER_SCRIPT" ]; then
    echo "ERROR: missing L1 router script at $L1_RPC_ROUTER_SCRIPT" >&2
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 required for L1_RPC_SCHEDULE=business" >&2
    exit 1
  fi
  export L1_RPC_METERED_URL L1_RPC_PUBLIC_URL L1_RPC_LISTEN
  export L1_RPC_BUSINESS_START="${L1_RPC_BUSINESS_START:-9}"
  export L1_RPC_BUSINESS_END="${L1_RPC_BUSINESS_END:-17}"
  # Leave L1_RPC_FORCE empty so the router follows the clock; use FORCE / USE_PUBLIC
  # above to skip schedule entirely.
  unset L1_RPC_FORCE 2>/dev/null || true
  echo "Starting L1 RPC schedule router (${L1_RPC_BUSINESS_START}:00-${L1_RPC_BUSINESS_END}:00 tz=${TZ:-UTC} listen=${L1_RPC_LISTEN})"
  python3 "$L1_RPC_ROUTER_SCRIPT" &
  ROUTER_PID=$!
  # Brief wait so op-node does not race an unbound port.
  sleep 1
  if ! kill -0 "$ROUTER_PID" 2>/dev/null; then
    echo "ERROR: L1 RPC router exited immediately" >&2
    wait "$ROUTER_PID" || true
    exit 1
  fi
  L1_RPC_URL="http://${L1_RPC_LISTEN}"
  L1_RPC_LOG="http://${L1_RPC_LISTEN} (schedule ${L1_RPC_BUSINESS_START}:00-${L1_RPC_BUSINESS_END}:00 ${TZ:-UTC})"
else
  # Redact path tokens (QuickNode) from logs — host only.
  L1_RPC_LOG="$L1_RPC_URL"
  case "$L1_RPC_LOG" in
    http://*|https://*)
      L1_RPC_LOG="$(printf '%s\n' "$L1_RPC_LOG" | sed -E 's#(https?://[^/]+).*#\1/<redacted>#')"
      ;;
  esac
fi

NODE_MEM_LOG=""
[ -n "$OP_NODE_GOMEMLIMIT" ] && NODE_MEM_LOG=" gomemlimit=${OP_NODE_GOMEMLIMIT}"
echo "Starting op-node (L1 derivation / verifier; mode=${L1_RPC_MODE} l1=${L1_RPC_LOG} poll=${L1_HTTP_POLL} rpc-rate-limit=${L1_RPC_RATE_LIMIT}${NODE_MEM_LOG})"
env ${OP_NODE_GOMEMLIMIT:+GOMEMLIMIT=$OP_NODE_GOMEMLIMIT} op-node \
  --l1="$L1_RPC_URL" \
  --l1.rpckind=standard \
  --l1.trustrpc=true \
  --l1.http-poll-interval="$L1_HTTP_POLL" \
  --l1.rpc-rate-limit="$L1_RPC_RATE_LIMIT" \
  --l1.beacon.ignore=true \
  --l1.beacon.slot-duration-override="$L1_BLOCK_TIME" \
  --l2="http://127.0.0.1:${L2_ENGINE_PORT}" \
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

# Waiting for op-node alone can leave a superficially healthy container running
# forever after geth crashes. Supervise children and propagate op-node's
# status when it is the first process to stop.
while kill -0 "$GETH_PID" 2>/dev/null && kill -0 "$NODE_PID" 2>/dev/null; do
  if [ -n "${ROUTER_PID}" ] && ! kill -0 "$ROUTER_PID" 2>/dev/null; then
    echo "ERROR: L1 RPC router exited while op-node was running" >&2
    exit 1
  fi
  sleep "$PROCESS_POLL_INTERVAL_SECS"
done

# Check op-node first: if it has stopped (whether alone or concurrently with
# geth), its exit status is the one we want to propagate. Exit immediately
# after reaping op-node — do not wait on GETH_PID here, or a still-running
# geth would block container exit and look healthy while the verifier is dead.
# The EXIT trap's cleanup kills and reaps geth. Only when op-node is still
# alive do we know geth must be the one that exited, since the loop above
# only breaks once at least one child has died.
if ! kill -0 "$NODE_PID" 2>/dev/null; then
  NODE_EXIT=0
  wait "$NODE_PID" || NODE_EXIT=$?
  exit "$NODE_EXIT"
fi

echo "ERROR: op-geth exited while op-node was running" >&2
wait "$GETH_PID" 2>/dev/null || true
exit 1
