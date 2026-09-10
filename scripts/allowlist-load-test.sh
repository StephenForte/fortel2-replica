#!/usr/bin/env bash
# Phase B: write-reject + admin_/debug_ refusal, then allowlist p95 + error rate.
set -euo pipefail

URL="${REPLICA_L2_RPC_URL:-https://fortel2-replica-reth-rpc.onrender.com}"
N="${LOAD_N:-40}"
export URL N

python3 - <<'PY'
import json, os, statistics, subprocess, sys, time

URL = os.environ["URL"].rstrip("/")
N = int(os.environ["N"])


def rpc(method, params, timeout=30):
    # curl is the Mini's allowlisted HTTPS path; urllib hits a 403 proxy here.
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    t0 = time.perf_counter()
    proc = subprocess.run(
        [
            "curl", "-sS", "-m", str(timeout), "-w", "\n%{http_code}",
            URL, "-H", "content-type: application/json", "-d", payload,
        ],
        capture_output=True,
        text=True,
    )
    elapsed = (time.perf_counter() - t0) * 1000
    if proc.returncode != 0:
        return None, {"error": {"message": proc.stderr.strip() or proc.stdout}}, elapsed
    raw = proc.stdout.rsplit("\n", 1)
    body_txt, http_s = (raw[0], raw[1]) if len(raw) == 2 else (proc.stdout, "")
    try:
        http = int(http_s) if http_s.strip().isdigit() else None
    except ValueError:
        http = None
    try:
        body = json.loads(body_txt)
    except json.JSONDecodeError:
        body = {"error": {"message": body_txt[:200]}}
    return http, body, elapsed


def code_of(body):
    err = body.get("error") or {}
    return err.get("code")


print(f"allowlist load-test url={URL} n={N}")

# Write + privileged methods must be JSON-RPC -32601 (filter), not forwarded.
refusals = [
    ("eth_sendRawTransaction", ["0x"]),
    ("admin_nodeInfo", []),
    ("debug_traceTransaction", ["0x" + "00" * 32]),
]
refuse_fail = 0
for method, params in refusals:
    http, body, ms = rpc(method, params)
    code = code_of(body)
    ok = code == -32601
    print(f"  refuse {method} http={http} code={code} {ms:.0f}ms {'OK' if ok else 'FAIL'}")
    if not ok:
        refuse_fail += 1
if refuse_fail:
    print(f"ERROR: {refuse_fail} refusal check(s) failed (want -32601)", file=sys.stderr)
    sys.exit(1)

latencies = []
errors = 0
for i in range(N):
    http, body, ms = rpc("eth_blockNumber", [])
    latencies.append(ms)
    if http != 200 or body.get("error") or body.get("result") is None:
        errors += 1
        print(f"  sample {i} FAIL http={http} body={body} {ms:.0f}ms")

latencies.sort()
p95 = latencies[min(len(latencies) - 1, int(round(0.95 * (len(latencies) - 1))))]
err_rate = errors / N
print(
    f"eth_blockNumber n={N} errors={errors} error_rate={err_rate:.3f} "
    f"p50={statistics.median(latencies):.0f}ms p95={p95:.0f}ms max={latencies[-1]:.0f}ms"
)
if err_rate > 0.01:
    print(f"ERROR: error rate {err_rate:.3f} exceeds 1%", file=sys.stderr)
    sys.exit(1)
print("allowlist-load-test: PASS")
PY
