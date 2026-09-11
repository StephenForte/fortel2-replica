#!/usr/bin/env bash
# Compare the live public replica RPC EL tip to the Mac sequencer.
# Default REPLICA_L2_RPC_URL is the live public hostname (reth after R-0017).
# Staging fortel2-replica-reth-rpc is suspended 2026-09-12.
# optimism_syncStatus is not on the public allowlist — infer L1-origin
# progress from L2 block timestamps when the node RPC is unreachable.
# The lag gate requires live op-node safe_l2; it does not treat the
# sequencer EL (unsafe) tip as safe.
set -euo pipefail

REPLICA="${REPLICA_L2_RPC_URL:-https://fortel2-replica-rpc.onrender.com}"
LIVE="${LIVE_L2_RPC_URL:-http://127.0.0.1:9545}"
LIVE_NODE="${LIVE_NODE_RPC_URL:-http://127.0.0.1:9547}"
MAX_SAFE_LAG="${REPLICA_MAX_SAFE_LAG:-12}" # ~2 L1 epochs * 6 L2 blocks/epoch

export REPLICA LIVE LIVE_NODE MAX_SAFE_LAG

python3 - <<'PY'
import json, os, subprocess, sys, time
from datetime import datetime, timezone

REPLICA = os.environ["REPLICA"].rstrip("/")
LIVE = os.environ["LIVE"].rstrip("/")
LIVE_NODE = os.environ["LIVE_NODE"].rstrip("/")
MAX_LAG = int(os.environ["MAX_SAFE_LAG"])


def rpc(url, method, params, timeout=30):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    proc = subprocess.run(
        ["curl", "-sS", "-m", str(timeout), url, "-H", "content-type: application/json", "-d", payload],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return None, f"{method} failed: {proc.stderr.strip() or proc.stdout}"
    try:
        body = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        return None, f"{method} bad JSON: {e} {proc.stdout[:200]}"
    if body.get("error"):
        return None, body["error"]
    return body.get("result"), None


def hx(v):
    if v is None:
        return None
    s = str(v)
    return int(s, 16) if isinstance(v, str) and s.startswith("0x") else int(v)


print("=== Replica sync check ===")
print(f"replica: {REPLICA}")
print(f"live EL: {LIVE}")
print(f"sampled_at: {datetime.now(timezone.utc).isoformat()}")

cid_r, err = rpc(REPLICA, "eth_chainId", [])
cid_l, err2 = rpc(LIVE, "eth_chainId", [])
if err or err2:
    print(f"ERROR: chainId replica={err} live={err2}", file=sys.stderr)
    sys.exit(1)
if hx(cid_r) != 852 or hx(cid_l) != 852:
    print(f"ERROR: chain id replica={cid_r} live={cid_l} (want 852)", file=sys.stderr)
    sys.exit(1)

bn_r, err = rpc(REPLICA, "eth_blockNumber", [])
bn_l, err2 = rpc(LIVE, "eth_blockNumber", [])
if err or err2:
    print(f"ERROR: blockNumber replica={err} live={err2}", file=sys.stderr)
    sys.exit(1)
tip_r, tip_l = hx(bn_r), hx(bn_l)
print(f"EL tip: replica={tip_r} live={tip_l} lag={tip_l - tip_r}")

blk, err = rpc(REPLICA, "eth_getBlockByNumber", ["latest", False])
if err or not blk:
    print(f"ERROR: replica latest block: {err}", file=sys.stderr)
    sys.exit(1)
ts = hx(blk.get("timestamp"))
print(
    f"replica latest hash={blk.get('hash')} ts={ts} "
    f"iso={datetime.fromtimestamp(ts, timezone.utc).isoformat()} "
    f"age_s={int(time.time()) - ts}"
)

st, err = rpc(LIVE_NODE, "optimism_syncStatus", [], timeout=10)
safe_l = None
origin_l = None
if err:
    print(f"live op-node syncStatus unavailable: {err}")
else:
    safe = (st or {}).get("safe_l2") or {}
    origin = safe.get("l1origin") or safe.get("l1_origin") or {}
    safe_l = hx(safe.get("number"))
    origin_l = hx(origin.get("number") if isinstance(origin, dict) else None)
    print(f"live safe_l2={safe_l} live_l1origin={origin_l}")

sync, err = rpc(REPLICA, "optimism_syncStatus", [])
if err:
    print(f"replica optimism_syncStatus not exposed ({err}) — infer from EL")
else:
    print(f"replica syncStatus: {json.dumps(sync)}")

if safe_l is None:
    print(
        "ERROR: live op-node safe_l2 unavailable; refusing to treat sequencer EL tip as safe",
        file=sys.stderr,
    )
    sys.exit(1)
lag = safe_l - tip_r
print(f"lag vs live safe_l2: {lag} (max {MAX_LAG})")
if tip_r < 1:
    print("ERROR: replica tip is still genesis", file=sys.stderr)
    sys.exit(1)
if lag > MAX_LAG:
    print(f"ERROR: replica lag {lag} exceeds REPLICA_MAX_SAFE_LAG={MAX_LAG}", file=sys.stderr)
    sys.exit(1)
print("OK — replica appears synced within lag budget.")
PY
