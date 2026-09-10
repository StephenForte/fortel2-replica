#!/usr/bin/env bash
# Task 7 Phase B: sampled safe-block parity — staging reth gateway vs Mac sequencer EL.
# Staging is HTTPS (not loopback). optimism_syncStatus is not on the allowlist;
# overlap high-water is min(replica EL tip, live EL tip). Exit 0 only on a full match.
# With CHECK_RECEIPTS=1 (default), also compares first-tx receipts and one
# eth_getLogs range vs the live geth gateway. A null candidate receipt is a
# named FAIL (block + tx), never an AttributeError (D-0125 crash class).
set -euo pipefail

CANDIDATE="${CANDIDATE_RPC:-https://fortel2-replica-reth-rpc.onrender.com}"
LIVE="${LIVE_RPC:-http://127.0.0.1:9545}"
MIN_BLOCKS="${MIN_BLOCKS:-20}"
SLEEP_MS="${SLEEP_MS:-400}"
BLOCKS_CSV="${BLOCKS_CSV:-0,5,473031,473032,811872,811875}"
# Receipt/logs parity vs the live geth public gateway (archive evidence, D-0125).
RECEIPT_LIVE="${RECEIPT_LIVE_RPC:-https://fortel2-replica-rpc.onrender.com}"
RECEIPT_EXTRA_CSV="${RECEIPT_EXTRA_CSV:-100000,400000,700000}"
LOGS_FROM="${LOGS_FROM:-473031}"
LOGS_TO="${LOGS_TO:-483030}"
CHECK_RECEIPTS="${CHECK_RECEIPTS:-1}"

export CANDIDATE LIVE MIN_BLOCKS SLEEP_MS BLOCKS_CSV
export RECEIPT_LIVE RECEIPT_EXTRA_CSV LOGS_FROM LOGS_TO CHECK_RECEIPTS

python3 - <<'PY'
import json, os, subprocess, sys, time

CAND = os.environ["CANDIDATE"].rstrip("/")
LIVE = os.environ["LIVE"].rstrip("/")
MIN_BLOCKS = int(os.environ["MIN_BLOCKS"])
SLEEP_MS = int(os.environ["SLEEP_MS"])
BLOCKS_CSV = os.environ.get("BLOCKS_CSV") or ""
RECEIPT_LIVE = os.environ.get("RECEIPT_LIVE", "").rstrip("/")
RECEIPT_EXTRA_CSV = os.environ.get("RECEIPT_EXTRA_CSV") or ""
LOGS_FROM = os.environ.get("LOGS_FROM") or ""
LOGS_TO = os.environ.get("LOGS_TO") or ""
CHECK_RECEIPTS = os.environ.get("CHECK_RECEIPTS", "1") != "0"
FIELDS = ["number", "hash", "parentHash", "stateRoot", "receiptsRoot", "txCount"]
RECEIPT_FIELDS = ["blockHash", "status", "logs", "logsBloom"]


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


def first_tx_hash(block):
    if not block:
        return None
    txs = block.get("transactions") or []
    if not txs:
        return None
    t0 = txs[0]
    if isinstance(t0, str):
        return t0
    if isinstance(t0, dict):
        return t0.get("hash")
    return None


def receipt_fields(receipt):
    # D-0125 class: a null receipt must be a named FAIL, never AttributeError.
    if receipt is None:
        return None
    logs = receipt.get("logs") or []
    bloom = receipt.get("logsBloom")
    status = receipt.get("status")
    return {
        "blockHash": norm_hash(receipt.get("blockHash")),
        "status": None if status is None else str(status).strip().lower(),
        "logs": len(logs) if isinstance(logs, list) else 0,
        "logsBloom": None if bloom is None else str(bloom).strip().lower(),
    }


def parse_int_csv(raw):
    out = []
    for item in (raw or "").split(","):
        item = item.strip()
        if not item:
            continue
        out.append(int(item, 0) if item.lower().startswith("0x") else int(item))
    return out


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

receipt_ok = 0
if CHECK_RECEIPTS:
    if not RECEIPT_LIVE:
        fail("CHECK_RECEIPTS=1 but RECEIPT_LIVE is empty")
    receipt_heights = []
    for n in parse_int_csv(BLOCKS_CSV) + parse_int_csv(RECEIPT_EXTRA_CSV):
        if n not in receipt_heights:
            receipt_heights.append(n)
    print(
        f"receipt live={RECEIPT_LIVE} heights={receipt_heights} "
        f"logs={LOGS_FROM}-{LOGS_TO}"
    )
    for n in receipt_heights:
        blk = rpc(CAND, "eth_getBlockByNumber", [hex(n), False], "candidate")
        if blk is None:
            fail(f"missing block {n} on candidate (receipt check)")
        txh = first_tx_hash(blk)
        if txh is None:
            print(f"  receipt block {n} SKIP (no txs)")
            continue
        cand_rcpt = rpc(CAND, "eth_getTransactionReceipt", [txh], "candidate")
        if cand_rcpt is None:
            fail(f"candidate null receipt block={n} tx={txh}")
        live_rcpt = rpc(RECEIPT_LIVE, "eth_getTransactionReceipt", [txh], "receipt-live")
        if live_rcpt is None:
            fail(f"receipt-live null receipt block={n} tx={txh}")
        fc = receipt_fields(cand_rcpt)
        fl = receipt_fields(live_rcpt)
        bad = [f for f in RECEIPT_FIELDS if fc.get(f) != fl.get(f)]
        if bad:
            fail(
                f"receipt mismatch block={n} tx={txh} fields={bad} "
                f"candidate={fc} live={fl}"
            )
        print(
            f"  receipt block {n} tx={txh} blockHash={fc['blockHash']} "
            f"status={fc['status']} logs={fc['logs']} MATCH"
        )
        receipt_ok += 1

    try:
        logs_from = int(LOGS_FROM, 0) if str(LOGS_FROM).lower().startswith("0x") else int(LOGS_FROM)
        logs_to = int(LOGS_TO, 0) if str(LOGS_TO).lower().startswith("0x") else int(LOGS_TO)
    except (TypeError, ValueError):
        fail(f"LOGS_FROM/LOGS_TO must be integers (got {LOGS_FROM!r} {LOGS_TO!r})")
    filt = {"fromBlock": hex(logs_from), "toBlock": hex(logs_to)}
    live_logs = rpc(RECEIPT_LIVE, "eth_getLogs", [filt], "receipt-live")
    cand_logs = rpc(CAND, "eth_getLogs", [filt], "candidate")
    if not isinstance(live_logs, list) or not isinstance(cand_logs, list):
        fail(f"eth_getLogs did not return a list live={type(live_logs)} candidate={type(cand_logs)}")
    if len(live_logs) < 1:
        fail(
            f"receipt-live eth_getLogs {logs_from}-{logs_to} returned 0 logs; "
            "need a range with >0 logs on the live geth gateway"
        )
    if len(cand_logs) != len(live_logs):
        fail(
            f"eth_getLogs count mismatch range={logs_from}-{logs_to} "
            f"candidate={len(cand_logs)} live={len(live_logs)}"
        )

    def log_key(lg):
        if not isinstance(lg, dict):
            return None
        topics = lg.get("topics") or []
        return {
            "address": str(lg.get("address") or "").lower(),
            "topics0": str(topics[0]).lower() if topics else None,
            "blockNumber": hx(lg.get("blockNumber")),
        }

    ck = log_key(cand_logs[0] if cand_logs else None)
    lk = log_key(live_logs[0] if live_logs else None)
    if ck != lk:
        fail(
            f"eth_getLogs first-log mismatch range={logs_from}-{logs_to} "
            f"candidate={ck} live={lk}"
        )
    print(
        f"  logs {logs_from}-{logs_to} count={len(cand_logs)} "
        f"first address={ck['address']} topics0={ck['topics0']} "
        f"block={ck['blockNumber']} MATCH"
    )
    print(f"receipt-match: {receipt_ok} receipts + eth_getLogs {logs_from}-{logs_to}")

print(f"verify-reth-parity: PASS ({len(heights)} blocks)")
PY
