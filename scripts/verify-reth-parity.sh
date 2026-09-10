#!/usr/bin/env bash
# Task 7 Phase B: sampled safe-block parity — staging reth gateway vs Mac sequencer EL.
# Staging is HTTPS (not loopback). optimism_syncStatus is not on the allowlist;
# overlap high-water is min(replica EL tip, live EL tip). Exit 0 only on a full match.
set -euo pipefail

CANDIDATE="${CANDIDATE_RPC:-https://fortel2-replica-reth-rpc.onrender.com}"
LIVE="${LIVE_RPC:-http://127.0.0.1:9545}"
MIN_BLOCKS="${MIN_BLOCKS:-20}"
SLEEP_MS="${SLEEP_MS:-400}"
BLOCKS_CSV="${BLOCKS_CSV:-0,5,473031,473032}"

export CANDIDATE LIVE MIN_BLOCKS SLEEP_MS BLOCKS_CSV

python3 - <<'PY'
import json, os, subprocess, sys, time

CAND = os.environ["CANDIDATE"].rstrip("/")
LIVE = os.environ["LIVE"].rstrip("/")
MIN_BLOCKS = int(os.environ["MIN_BLOCKS"])
SLEEP_MS = int(os.environ["SLEEP_MS"])
BLOCKS_CSV = os.environ.get("BLOCKS_CSV") or ""
FIELDS = ["number", "hash", "parentHash", "stateRoot", "receiptsRoot", "txCount"]


def fail(msg, code=1):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def hx(v):
    if v is None:
        return None
    if isinstance(v, int):
        return v
    s = str(v).strip()
    return int(s, 16) if s.startswith("0x") else int(s)


def norm_hash(v):
    if v is None:
        return None
    s = str(v).strip().lower()
    if not s.startswith("0x"):
        s = "0x" + s
    return "0x" + s[2:].zfill(64)


_rpc_id = 0


def rpc(url, method, params, label):
    global _rpc_id
    _rpc_id += 1
    payload = json.dumps({"jsonrpc": "2.0", "id": _rpc_id, "method": method, "params": params})
    if SLEEP_MS:
        time.sleep(SLEEP_MS / 1000.0)
    proc = subprocess.run(
        ["curl", "-sS", "-m", "90", url, "-H", "content-type: application/json", "-d", payload],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        fail(f"{label} RPC {method} failed: {proc.stderr.strip() or proc.stdout}")
    try:
        body = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        fail(f"{label} RPC {method} bad JSON: {e} {proc.stdout[:200]}")
    if body.get("error"):
        fail(f"{label} RPC {method} error: {body['error']}")
    return body.get("result")


def block_fields(block):
    if not block:
        return None
    txs = block.get("transactions") or []
    return {
        "number": hx(block.get("number")),
        "hash": norm_hash(block.get("hash")),
        "parentHash": norm_hash(block.get("parentHash")),
        "stateRoot": norm_hash(block.get("stateRoot")),
        "receiptsRoot": norm_hash(block.get("receiptsRoot")),
        "txCount": len(txs) if isinstance(txs, list) else 0,
    }


def sample_heights(hi, extra, minimum):
    pins = []
    for raw in extra:
        raw = raw.strip()
        if not raw:
            continue
        pins.append(int(raw, 0) if raw.lower().startswith("0x") else int(raw))
    chosen = [p for p in pins if 0 <= p <= hi]
    if 0 not in chosen and hi >= 0:
        chosen.append(0)
    if 5 not in chosen and hi >= 5:
        chosen.append(5)
    if hi not in chosen:
        chosen.append(hi)
    remaining = max(minimum, len(set(chosen))) - len(set(chosen))
    if remaining > 0 and hi > 0:
        for i in range(1, remaining + 1):
            chosen.append(round(i * hi / (remaining + 1)))
    out = sorted({n for n in chosen if 0 <= n <= hi})
    n = 0
    while len(out) < minimum and n <= hi:
        if n not in out:
            out.append(n)
        n += 1
    return sorted(out)


cid_c = hx(rpc(CAND, "eth_chainId", [], "candidate"))
cid_l = hx(rpc(LIVE, "eth_chainId", [], "live"))
if cid_c != 852 or cid_l != 852:
    fail(f"chain id mismatch candidate={cid_c} live={cid_l} (want 852)")

head_c = hx(rpc(CAND, "eth_blockNumber", [], "candidate"))
head_l = hx(rpc(LIVE, "eth_blockNumber", [], "live"))
print(f"heads candidate_el={head_c} live_el={head_l}")
hi = min(head_c, head_l)
if hi < 5:
    fail(f"overlap high-water {hi} is below block 5; replica has not derived far enough")

extra = [x for x in BLOCKS_CSV.split(",") if x.strip()]
missing_pins = []
for raw in extra:
    n = int(raw, 0) if raw.lower().startswith("0x") else int(raw)
    if n > hi:
        missing_pins.append(n)
heights = sample_heights(hi, extra, MIN_BLOCKS)
if len(heights) < MIN_BLOCKS:
    fail(f"overlap high-water {hi} yields {len(heights)} samples; need >= {MIN_BLOCKS}")
if 0 not in heights or (hi >= 5 and 5 not in heights):
    fail(f"sample list must include 0 and 5 (got {heights})")
print(f"samples={len(heights)} heights={heights}")
if missing_pins:
    print(f"WARN: pinned heights not yet derived on replica: {missing_pins}")

mismatches = 0
for n in heights:
    fc = block_fields(rpc(CAND, "eth_getBlockByNumber", [hex(n), False], "candidate"))
    fl = block_fields(rpc(LIVE, "eth_getBlockByNumber", [hex(n), False], "live"))
    if fc is None or fl is None:
        fail(f"missing block {n} on candidate or live")
    bad = [f for f in FIELDS if fc.get(f) != fl.get(f)]
    if bad:
        mismatches += 1
        print(
            f"MISMATCH block={n} fields={bad} candidate={fc} live={fl}",
            file=sys.stderr,
        )
        continue
    print(
        f"  block {n} hash={fc['hash']} parent={fc['parentHash']} "
        f"state={fc['stateRoot']} receipts={fc['receiptsRoot']} "
        f"txCount={fc['txCount']} MATCH"
    )

if mismatches:
    fail(f"{mismatches} sampled block(s) mismatched")
if missing_pins and os.environ.get("ALLOW_MISSING_PINS") != "1":
    fail(
        f"replica tip {head_c} has not reached pinned heights {missing_pins}; "
        "parity incomplete until catch-up"
    )
print(f"full-match: staging gateway = live sequencer ({len(heights)} blocks)")
print(f"verify-reth-parity: PASS ({len(heights)} blocks)")
PY
