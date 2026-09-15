#!/usr/bin/env bash
# Friend-node header check vs an untrusted reference RPC.
#
# Your node is the subject. The reference is a comparator, not the chain.
# A mismatch means the two disagree — not that your node is wrong.
# Read-only. Never writes, never feeds the reference into derivation, never
# suggests debug_setHead. Fail-closed on an unreachable reference, a null
# result, or a reference on a different chain id.
#
# This is not a mode of scripts/verify-reth-parity.sh. That script is the
# operator tool (public replica vs Mac sequencer, including receipts). Header
# comparison uses scripts/parity_compare.py so the field set cannot drift;
# tests key the operator script's FIELDS off that module.
#
# Usage (from a clone; node must be reachable from here):
#   ./scripts/check-friend-parity.sh
#   NODE_RPC=http://127.0.0.1:9545 REFERENCE_RPC=https://fortel2-replica-rpc.onrender.com \
#     ./scripts/check-friend-parity.sh
#
# Laptop / VPS compose: default NODE_RPC is loopback :9545.
# Render Private Service: run from Dashboard Shell with
#   NODE_RPC=http://127.0.0.1:${PORT:-10000}
# The image does not bake this script in. Copy the three files into the
# same directory (Render Shell) or run from a clone as ./scripts/...
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
export NODE_RPC="${NODE_RPC:-http://127.0.0.1:9545}"
export REFERENCE_RPC="${REFERENCE_RPC:-https://fortel2-replica-rpc.onrender.com}"

# Colocated copy (Render Shell) first; then repo layout (scripts/ in a clone).
if [[ -f "${HERE}/check_friend_parity.py" ]]; then
  export PYTHONPATH="${HERE}${PYTHONPATH:+:${PYTHONPATH}}"
  exec python3 "${HERE}/check_friend_parity.py" "$@"
fi
ROOT="$(cd "${HERE}/.." && pwd)"
export PYTHONPATH="${ROOT}/scripts${PYTHONPATH:+:${PYTHONPATH}}"
exec python3 "${ROOT}/scripts/check_friend_parity.py" "$@"
