#!/usr/bin/env python3
"""VENDORED from ForteL2 — do not treat this as the canonical copy.

Source: StephenForte/ForteL2 scripts/rpc-method-filter.py
Copied from commit: 21b2bb66ab3d70ca96cad0fc3dfc0745204e7f54
  (merged to ForteL2 main via PR #71 / eb7cdaa02f470f2c406073efd065de05be3dda04)
Includes round-1 chunked-body fix: yes

MR-2 adaptations in this repo (keep in sync when pulling fixes from ForteL2):
  - ALLOWED_METHODS derived from T5-D1 then minus eth_sendRawTransaction (read-only)
  - Listen host may be 0.0.0.0 (Render publishes this process; geth stays loopback)
  - Upstream remains loopback-only

Fixes for the filter logic must be applied in BOTH repos (ForteL2 first, then here).

Public read-path JSON-RPC method filter for the fortel2-replica verifier.

Forwards only an explicit allowlist of eth/net/web3 *read* methods to loopback
op-geth. Render's edge dials this process — never op-geth or op-node directly.

Allowlist semantics (fail closed):
  - exact method string match only (no prefix, no case/whitespace normalisation)
  - every element of a JSON-RPC batch is checked independently
  - unknown methods (including invented eth_* names) are rejected

Env:
  L2_RPC_FILTER_LISTEN     host:port (default 0.0.0.0:10000);
                           host must be loopback or 0.0.0.0
  L2_RPC_FILTER_UPSTREAM   http(s) URL of op-geth (default http://127.0.0.1:8546);
                           host must be loopback
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional
from urllib.parse import urlparse

# Exact T5-D1 allowlist from ForteL2 @ 21b2bb66ab3d70ca96cad0fc3dfc0745204e7f54.
# Prefix matching is intentionally NOT used (eth_evilMustFail stays rejected).
_T5_D1_ALLOWED_METHODS: frozenset[str] = frozenset(
    {
        # web3
        "web3_clientVersion",
        "web3_sha3",
        # net
        "net_version",
        "net_listening",
        "net_peerCount",
        # eth — read + write surface SOS / wallets need
        "eth_blobBaseFee",
        "eth_blockNumber",
        "eth_call",
        "eth_chainId",
        "eth_createAccessList",
        "eth_estimateGas",
        "eth_feeHistory",
        "eth_gasPrice",
        "eth_getBalance",
        "eth_getBlockByHash",
        "eth_getBlockByNumber",
        "eth_getBlockReceipts",
        "eth_getBlockTransactionCountByHash",
        "eth_getBlockTransactionCountByNumber",
        "eth_getCode",
        "eth_getLogs",
        "eth_getProof",
        "eth_getRawTransactionByBlockHashAndIndex",
        "eth_getRawTransactionByBlockNumberAndIndex",
        "eth_getRawTransactionByHash",
        "eth_getStorageAt",
        "eth_getTransactionByBlockHashAndIndex",
        "eth_getTransactionByBlockNumberAndIndex",
        "eth_getTransactionByHash",
        "eth_getTransactionCount",
        "eth_getTransactionReceipt",
        "eth_getUncleByBlockHashAndIndex",
        "eth_getUncleByBlockNumberAndIndex",
        "eth_getUncleCountByBlockHash",
        "eth_getUncleCountByBlockNumber",
        "eth_maxPriorityFeePerGas",
        "eth_protocolVersion",
        "eth_sendRawTransaction",
        "eth_syncing",
        # eth — log/block filters (operator decision 2026-08-12).
        # Deliberately omitted: eth_newPendingTransactionFilter (mempool surface).
        "eth_newFilter",
        "eth_newBlockFilter",
        "eth_getFilterChanges",
        "eth_getFilterLogs",
        "eth_uninstallFilter",
    }
)

# MR-2: public replica is read-only — drop the write method; keep everything else.
ALLOWED_METHODS: frozenset[str] = _T5_D1_ALLOWED_METHODS - frozenset(
    {"eth_sendRawTransaction"}
)

JSONRPC_METHOD_NOT_FOUND = -32601
JSONRPC_INVALID_REQUEST = -32600
JSONRPC_PARSE_ERROR = -32700
JSONRPC_SERVER_ERROR = -32000

# Cap request bodies — cloudflared may deliver chunked; never read unbounded.
MAX_BODY_BYTES = 1_048_576  # 1 MiB


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def is_method_allowed(method: Any) -> bool:
    """True only when method is an exact allowlisted string."""
    return isinstance(method, str) and method in ALLOWED_METHODS


def reject_response(req_id: Any, message: str, code: int = JSONRPC_METHOD_NOT_FOUND) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    }


def filter_single(obj: Any) -> Optional[dict]:
    """Return a JSON-RPC error dict if this call must not be forwarded, else None."""
    if not isinstance(obj, dict):
        return reject_response(None, "invalid request", JSONRPC_INVALID_REQUEST)
    req_id = obj.get("id", None)
    method = obj.get("method", None)
    if not isinstance(method, str):
        return reject_response(req_id, "invalid request: method must be a string", JSONRPC_INVALID_REQUEST)
    if not is_method_allowed(method):
        return reject_response(req_id, f"method not allowed: {method}", JSONRPC_METHOD_NOT_FOUND)
    return None


def classify_body(parsed: Any) -> tuple[str, list[Any], list[Optional[dict]]]:
    """
    Classify a parsed JSON-RPC body.

    Returns (kind, items, rejects) where kind is 'single', 'batch', or 'empty_batch'.
    For 'empty_batch', items is [] and rejects holds a single error Response object
    (JSON-RPC 2.0: empty array → one Response, not []).
    For 'batch'/'single', items and rejects are the same length.
    """
    if isinstance(parsed, list):
        if len(parsed) == 0:
            return (
                "empty_batch",
                [],
                [reject_response(None, "empty batch", JSONRPC_INVALID_REQUEST)],
            )
        rejects = [filter_single(item) for item in parsed]
        return "batch", parsed, rejects
    if isinstance(parsed, dict):
        return "single", [parsed], [filter_single(parsed)]
    # Non-object / non-array JSON value
    return "single", [parsed], [reject_response(None, "invalid request", JSONRPC_INVALID_REQUEST)]


def require_listen_host(host: str) -> str:
    """Allow loopback (local/dev) or 0.0.0.0 (Render-published public read door)."""
    if host not in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
        raise SystemExit(
            f"ERROR: L2_RPC_FILTER_LISTEN host must be loopback or 0.0.0.0 "
            f"(got {host!r})"
        )
    return host


# Back-compat alias for ForteL2 self-test naming; public listen uses require_listen_host.
def require_loopback_listen(host: str) -> str:
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit(
            f"ERROR: L2_RPC_FILTER_LISTEN host must be loopback "
            f"(127.0.0.1/localhost/::1), got {host!r}"
        )
    return host


def require_http_url(name: str, url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise SystemExit(f"ERROR: {name} must be an http(s) URL with a host")
    return url


def require_loopback_upstream(url: str) -> str:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit(
            f"ERROR: L2_RPC_FILTER_UPSTREAM must be loopback "
            f"(got host {host!r})"
        )
    return url


def _transfer_encoding_is_chunked(te_header: str) -> bool:
    # RFC 7230: if Transfer-Encoding is present, chunked is the final encoding.
    parts = [p.strip().lower() for p in te_header.split(",") if p.strip()]
    return bool(parts) and parts[-1] == "chunked"


def read_chunked_body(rfile, max_bytes: int = MAX_BODY_BYTES) -> bytes:
    """Decode an HTTP/1.1 chunked body; reject if total exceeds max_bytes."""
    chunks: list[bytes] = []
    total = 0
    while True:
        size_line = rfile.readline()
        if not size_line:
            raise ValueError("truncated chunked body")
        size_line = size_line.strip()
        if b";" in size_line:
            size_line = size_line.split(b";", 1)[0].strip()
        try:
            size = int(size_line, 16)
        except ValueError as exc:
            raise ValueError("bad chunk size") from exc
        if size < 0:
            raise ValueError("bad chunk size")
        if size == 0:
            # Consume optional trailers until the terminating blank line.
            while True:
                trailer = rfile.readline()
                if trailer in (b"\r\n", b"\n", b""):
                    break
            break
        if total + size > max_bytes:
            raise ValueError(f"body exceeds max {max_bytes} bytes")
        data = rfile.read(size)
        if len(data) < size:
            raise ValueError("truncated chunk")
        chunks.append(data)
        total += size
        crlf = rfile.read(2)
        if crlf != b"\r\n":
            raise ValueError("missing chunk CRLF")
    return b"".join(chunks)


def read_http_body(headers, rfile, max_bytes: int = MAX_BODY_BYTES) -> bytes:
    """
    Read a request body supporting Content-Length and Transfer-Encoding: chunked.

    cloudflared (HTTP/1.1 to origin) often emits chunked when the inbound length
    is unknown — that is the normal SOS path once the tunnel is up.
    """
    te = headers.get("Transfer-Encoding", "") or ""
    if _transfer_encoding_is_chunked(te):
        return read_chunked_body(rfile, max_bytes=max_bytes)
    if te.strip():
        # Non-chunked TE (e.g. gzip alone) is not supported on this door.
        raise ValueError(f"unsupported Transfer-Encoding: {te!r}")
    raw_len = headers.get("Content-Length", "0") or "0"
    try:
        length = int(raw_len)
    except ValueError as exc:
        raise ValueError("bad Content-Length") from exc
    if length < 0:
        raise ValueError("negative Content-Length")
    if length > max_bytes:
        raise ValueError(f"body exceeds max {max_bytes} bytes")
    if length == 0:
        return b""
    data = rfile.read(length)
    if len(data) < length:
        raise ValueError("truncated body")
    return data


STATE: Optional["FilterState"] = None


class FilterState:
    def __init__(self) -> None:
        upstream = _env("L2_RPC_FILTER_UPSTREAM", "http://127.0.0.1:8546")
        self.upstream = require_loopback_upstream(require_http_url("L2_RPC_FILTER_UPSTREAM", upstream))


def _forward(body: bytes, content_type: str) -> tuple[int, bytes, str]:
    assert STATE is not None
    req = urllib.request.Request(
        STATE.upstream,
        data=body,
        method="POST",
        headers={
            "Content-Type": content_type or "application/json",
            "User-Agent": "fortel2-rpc-method-filter/1",
        },
    )
    try:
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = resp.read()
            ctype = resp.headers.get("Content-Type", "application/json")
            return resp.status, payload, ctype
    except urllib.error.HTTPError as err:
        payload = err.read()
        ctype = err.headers.get("Content-Type", "application/json")
        return err.code, payload, ctype


def _write_json(handler: BaseHTTPRequestHandler, status: int, payload: bytes, ctype: str = "application/json") -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def handle_jsonrpc_body(body: bytes, content_type: str) -> tuple[int, bytes, str]:
    """Pure-ish entry: filter then forward. Returns (http_status, body, content_type)."""
    try:
        parsed = json.loads(body.decode("utf-8") if body else "null")
    except (UnicodeDecodeError, json.JSONDecodeError):
        err = reject_response(None, "parse error", JSONRPC_PARSE_ERROR)
        return 200, json.dumps(err).encode(), "application/json"

    kind, items, rejects = classify_body(parsed)

    if kind == "empty_batch":
        # Do not zip([], [err]) — that silently drops the synthesised error.
        return 200, json.dumps(rejects[0]).encode(), "application/json"

    if kind == "single":
        reject = rejects[0]
        if reject is not None:
            return 200, json.dumps(reject).encode(), "application/json"
        return _forward(body, content_type)

    # Batch: if every element is allowed, forward the original body unchanged.
    if all(r is None for r in rejects):
        return _forward(body, content_type)

    # Mixed / all-rejected batch: check each element independently.
    # Forward allowed calls one-by-one; synthesise errors for the rest.
    # Preserve request order in the response array.
    out: list[Any] = []
    http_status = 200
    for item, reject in zip(items, rejects):
        if reject is not None:
            out.append(reject)
            continue
        status, payload, _ctype = _forward(json.dumps(item).encode(), "application/json")
        # Propagate the first non-2xx upstream status (matches single-call
        # passthrough). Later differing codes are ignored so clients still see
        # *a* failure rather than a silent HTTP 200 wrapping upstream 429/5xx.
        if not (200 <= status < 300) and http_status == 200:
            http_status = status
        try:
            out.append(json.loads(payload.decode("utf-8")))
        except (UnicodeDecodeError, json.JSONDecodeError):
            req_id = item.get("id") if isinstance(item, dict) else None
            out.append(
                reject_response(
                    req_id,
                    f"upstream returned non-JSON (HTTP {status})",
                    JSONRPC_SERVER_ERROR,
                )
            )
    return http_status, json.dumps(out).encode(), "application/json"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Suppress "Server: BaseHTTP/0.6 Python/x.y" on a tunnel-facing door.
    server_version = "fortel2-rpc-filter/1"
    sys_version = ""

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_POST(self) -> None:  # noqa: N802
        try:
            body = read_http_body(self.headers, self.rfile)
        except ValueError as exc:
            msg = reject_response(None, f"bad request body: {exc}", JSONRPC_INVALID_REQUEST)
            _write_json(self, 400, json.dumps(msg).encode())
            return
        ctype = self.headers.get("Content-Type", "application/json")
        try:
            status, payload, out_ctype = handle_jsonrpc_body(body, ctype)
        except Exception as exc:  # noqa: BLE001
            msg = reject_response(None, f"filter error: {exc}", JSONRPC_SERVER_ERROR)
            _write_json(self, 502, json.dumps(msg).encode())
            return
        _write_json(self, status, payload, out_ctype)

    def do_GET(self) -> None:  # noqa: N802
        assert STATE is not None
        body = (
            f'{{"ok":true,"upstream":"{STATE.upstream}",'
            f'"allowed":{len(ALLOWED_METHODS)}}}\n'
        ).encode()
        _write_json(self, 200, body)


def self_test() -> None:
    """Property checks for test-helpers.sh (no live op-geth required)."""
    import io
    import json
    import socket
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    assert is_method_allowed("eth_blockNumber") is True
    # MR-2: write method present in T5-D1 source set, stripped for public reads.
    assert "eth_sendRawTransaction" in _T5_D1_ALLOWED_METHODS
    assert is_method_allowed("eth_sendRawTransaction") is False
    for m in (
        "eth_newFilter",
        "eth_newBlockFilter",
        "eth_getFilterChanges",
        "eth_getFilterLogs",
        "eth_uninstallFilter",
    ):
        assert is_method_allowed(m) is True, m
    assert is_method_allowed("eth_newPendingTransactionFilter") is False  # mempool
    assert is_method_allowed("eth_newFilterEvil") is False  # prefix trap after #6
    assert is_method_allowed("admin_peers") is False
    assert is_method_allowed("debug_traceBlockByNumber") is False
    assert is_method_allowed("miner_start") is False
    assert is_method_allowed("txpool_status") is False
    assert is_method_allowed("foo_bar") is False
    assert is_method_allowed("eth_evilMustFail") is False  # prefix trap
    assert is_method_allowed("Eth_blockNumber") is False  # case
    assert is_method_allowed("eth_blockNumber ") is False  # whitespace
    assert is_method_allowed(None) is False
    assert require_listen_host("0.0.0.0") == "0.0.0.0"
    assert require_listen_host("127.0.0.1") == "127.0.0.1"
    try:
        require_listen_host("1.2.3.4")
        raise AssertionError("require_listen_host should have exited")
    except SystemExit as exc:
        assert "0.0.0.0" in str(exc) or "loopback" in str(exc).lower()

    kind, _items, rejects = classify_body(
        [
            {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []},
            {"jsonrpc": "2.0", "id": 2, "method": "admin_peers", "params": []},
        ]
    )
    assert kind == "batch"
    assert rejects[0] is None
    assert rejects[1] is not None and rejects[1]["error"]["code"] == JSONRPC_METHOD_NOT_FOUND
    assert "admin_peers" in rejects[1]["error"]["message"]

    # Empty batch → single -32600 object (not []).
    kind, items, rejects = classify_body([])
    assert kind == "empty_batch" and items == []
    status, payload, _ctype = handle_jsonrpc_body(b"[]", "application/json")
    assert status == 200
    empty_resp = json.loads(payload)
    assert isinstance(empty_resp, dict)
    assert empty_resp["error"]["code"] == JSONRPC_INVALID_REQUEST

    # Chunked body decoding (unit).
    raw = b'{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
    chunked = f"{len(raw):x}\r\n".encode() + raw + b"\r\n0\r\n\r\n"
    assert read_chunked_body(io.BytesIO(chunked)) == raw

    class _Hdr(dict):
        def get(self, k, default=None):  # noqa: A003
            for key, val in self.items():
                if key.lower() == k.lower():
                    return val
            return default

    assert (
        read_http_body(_Hdr({"Transfer-Encoding": "chunked"}), io.BytesIO(chunked)) == raw
    )

    seen: list[Any] = []
    upstream_status = {"code": 200}

    class Upstream(BaseHTTPRequestHandler):
        server_version = "test-upstream/1"
        sys_version = ""

        def log_message(self, *_args) -> None:  # noqa: A003
            return

        def do_POST(self) -> None:  # noqa: N802
            n = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(n)
            seen.append(json.loads(body.decode()))
            code = upstream_status["code"]
            if code == 200:
                payload = b'{"jsonrpc":"2.0","id":1,"result":"0x1"}'
            else:
                payload = b'{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"busy"}}'
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    up = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    up_port = up.server_address[1]
    threading.Thread(target=up.serve_forever, daemon=True).start()

    global STATE
    os.environ["L2_RPC_FILTER_UPSTREAM"] = f"http://127.0.0.1:{up_port}"
    STATE = FilterState()

    status, payload, _ctype = handle_jsonrpc_body(
        b'{"jsonrpc":"2.0","id":9,"method":"foo_bar","params":[]}',
        "application/json",
    )
    assert status == 200
    assert json.loads(payload)["error"]["code"] == JSONRPC_METHOD_NOT_FOUND
    assert seen == []

    status, payload, _ctype = handle_jsonrpc_body(
        json.dumps(
            [
                {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []},
                {"jsonrpc": "2.0", "id": 2, "method": "admin_peers", "params": []},
            ]
        ).encode(),
        "application/json",
    )
    resp = json.loads(payload)
    assert status == 200
    assert isinstance(resp, list) and len(resp) == 2
    assert resp[0].get("result") == "0x1"
    assert resp[1]["error"]["code"] == JSONRPC_METHOD_NOT_FOUND
    assert len(seen) == 1
    assert seen[0]["method"] == "eth_blockNumber"

    # Mixed batch must surface upstream non-2xx (not collapse to HTTP 200).
    seen.clear()
    upstream_status["code"] = 503
    status, payload, _ctype = handle_jsonrpc_body(
        json.dumps(
            [
                {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []},
                {"jsonrpc": "2.0", "id": 2, "method": "admin_peers", "params": []},
            ]
        ).encode(),
        "application/json",
    )
    assert status == 503, status
    mixed = json.loads(payload)
    assert mixed[1]["error"]["code"] == JSONRPC_METHOD_NOT_FOUND
    upstream_status["code"] = 200

    try:
        require_loopback_listen("0.0.0.0")
        raise AssertionError("require_loopback_listen should have exited")
    except SystemExit as exc:
        assert "loopback" in str(exc).lower() or "127.0.0.1" in str(exc)

    # End-to-end: chunked allowed reaches upstream; chunked denied is filtered.
    filt = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    filt_port = filt.server_address[1]
    threading.Thread(target=filt.serve_forever, daemon=True).start()

    def _raw_post(port: int, headers: bytes, body_payload: bytes) -> tuple[bytes, bytes]:
        s = socket.create_connection(("127.0.0.1", port), timeout=5)
        s.sendall(
            b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
            + headers
            + b"\r\n"
            + body_payload
        )
        data = b""
        while b"\r\n\r\n" not in data or (
            b"Content-Length:" in data
            and len(data.split(b"\r\n\r\n", 1)[1])
            < int(
                [
                    l.split(b":", 1)[1].strip()
                    for l in data.split(b"\r\n\r\n", 1)[0].split(b"\r\n")
                    if l.lower().startswith(b"content-length:")
                ][0]
            )
        ):
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
        s.close()
        hdr, body = data.split(b"\r\n\r\n", 1)
        return hdr, body

    seen.clear()
    allow_body = b'{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
    allow_chunk = f"{len(allow_body):x}\r\n".encode() + allow_body + b"\r\n0\r\n\r\n"
    hdr, body = _raw_post(filt_port, b"Transfer-Encoding: chunked\r\n", allow_chunk)
    assert b"Python/" not in hdr  # banner suppressed
    assert b"BaseHTTP/" not in hdr
    assert json.loads(body).get("result") == "0x1"
    assert len(seen) == 1 and seen[0]["method"] == "eth_blockNumber"

    seen.clear()
    deny_body = b'{"jsonrpc":"2.0","id":1,"method":"admin_peers","params":[]}'
    deny_chunk = f"{len(deny_body):x}\r\n".encode() + deny_body + b"\r\n0\r\n\r\n"
    _hdr, body = _raw_post(filt_port, b"Transfer-Encoding: chunked\r\n", deny_chunk)
    assert json.loads(body)["error"]["code"] == JSONRPC_METHOD_NOT_FOUND
    assert seen == []  # must still filter after reading chunked body

    filt.shutdown()
    up.shutdown()
    print("rpc-method-filter self-test ok", flush=True)


def main() -> int:
    global STATE
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        self_test()
        return 0

    listen = _env("L2_RPC_FILTER_LISTEN", "0.0.0.0:10000")
    if ":" not in listen:
        raise SystemExit(f"ERROR: L2_RPC_FILTER_LISTEN must be host:port (got {listen!r})")
    host, port_s = listen.rsplit(":", 1)
    host = require_listen_host(host)
    try:
        port = int(port_s)
    except ValueError as exc:
        raise SystemExit(f"ERROR: bad L2_RPC_FILTER_LISTEN port in {listen!r}") from exc
    if port < 1 or port > 65535:
        raise SystemExit(f"ERROR: L2_RPC_FILTER_LISTEN port out of range: {port}")

    STATE = FilterState()
    print(
        f"rpc-method-filter: listening on http://{host}:{port} "
        f"upstream={STATE.upstream} allowlist={len(ALLOWED_METHODS)} methods",
        flush=True,
    )
    server = ThreadingHTTPServer((host, port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
