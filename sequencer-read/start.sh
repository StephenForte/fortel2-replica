#!/bin/sh
# Public sequencer-read door: the method filter on $PORT, forwarding
# allowlisted reads to fortel2-write.ente.ltd with Cloudflare Access headers.
# Replica entrypoint.sh is unchanged — this script is only for the diskless
# Web Service documented in README.md §"Public sequencer reads".
set -eu
cd "$(dirname "$0")/.."
export L2_RPC_FILTER_LISTEN="0.0.0.0:${PORT:-10000}"
exec python3 rpc-method-filter.py
