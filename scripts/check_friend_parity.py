"""Compare a friend's own node to an untrusted reference RPC.

The friend's node is the subject. The reference is a comparator only: a
mismatch means the two disagree, not that the friend is wrong. This
process is read-only (eth_chainId / eth_blockNumber / eth_getBlockByNumber).
It never writes, never feeds the reference into derivation, and never
suggests debug_setHead.

Ambiguity is fail-closed and named:
  REFERENCE_UNREACHABLE, REFERENCE_NULL, REFERENCE_CHAIN_ID
plus the symmetric NODE_* names when the subject is the problem.

Default reference is the operator public hostname for convenience; wording
and exit status still treat it as untrusted.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlparse

from parity_compare import block_fields, hx, mismatched_fields

DEFAULT_NODE = "http://127.0.0.1:9545"
DEFAULT_REFERENCE = "https://fortel2-replica-rpc.onrender.com"
EXPECTED_CHAIN_ID = 852

# Distinct from "your node is wrong". Tests assert this wording.
DIVERGENCE_PREFIX = "DIVERGENCE: you and this reference disagree"
DIVERGENCE_NOT_VERDICT = (
    "This is not a verdict against your node. Investigate both sides; "
    "do not wipe a datadir on the say-so of a reference."
)


class RpcError(Exception):
    def __init__(self, kind: str, message: str):
        self.kind = kind
        super().__init__(message)


@dataclass
class CheckResult:
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    lines: list[str] = field(default_factory=list)


def rpc_urllib(
    url: str,
    method: str,
    params: list[Any],
    timeout: float = 30,
) -> Any:
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    ).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RpcError("unreachable", str(exc) or type(exc).__name__) from exc
    try:
        body = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RpcError("unreachable", f"bad JSON: {exc}") from exc
    if not isinstance(body, dict):
        raise RpcError("unreachable", "response is not a JSON object")
    if body.get("error"):
        raise RpcError("unreachable", f"JSON-RPC error: {body['error']}")
    return body.get("result")


def _named(side: str, kind: str) -> str:
    return f"{side.upper()}_{kind.upper()}"


def _fail(code: int, name: str, detail: str) -> CheckResult:
    msg = f"ERROR: {name}: {detail}"
    return CheckResult(exit_code=code, stderr=msg, lines=[msg])


def _call(
    rpc: Callable[..., Any],
    url: str,
    method: str,
    params: list[Any],
    side: str,
) -> CheckResult | Any:
    try:
        result = rpc(url, method, params)
    except RpcError as exc:
        return _fail(2 if exc.kind == "unreachable" else 3, _named(side, exc.kind), str(exc))
    except Exception as exc:  # noqa: BLE001 — fail closed, never a silent pass
        return _fail(2, _named(side, "unreachable"), str(exc))
    return result


def overlap_heights(node_head: int, reference_head: int) -> list[int]:
    hi = min(node_head, reference_head)
    if hi < 0:
        return []
    heights = [0]
    if hi >= 5:
        heights.append(5)
    if hi not in heights:
        heights.append(hi)
    return sorted(set(heights))


def run_check(
    node_rpc: str,
    reference_rpc: str,
    rpc: Callable[..., Any] | None = None,
) -> CheckResult:
    node_url = node_rpc.rstrip("/")
    ref_url = reference_rpc.rstrip("/")
    call = rpc or rpc_urllib

    if not urlparse(node_url).scheme or not urlparse(ref_url).scheme:
        return _fail(2, "REFERENCE_UNREACHABLE", "NODE_RPC and REFERENCE_RPC must be http(s) URLs")

    ref_chain = _call(call, ref_url, "eth_chainId", [], "reference")
    if isinstance(ref_chain, CheckResult):
        return ref_chain
    if ref_chain is None:
        return _fail(3, "REFERENCE_NULL", "eth_chainId returned null")
    try:
        ref_cid = hx(ref_chain)
    except (TypeError, ValueError) as exc:
        return _fail(3, "REFERENCE_NULL", f"eth_chainId not a number: {exc}")
    if ref_cid != EXPECTED_CHAIN_ID:
        return _fail(
            4,
            "REFERENCE_CHAIN_ID",
            f"reference chain id is {ref_cid} (want {EXPECTED_CHAIN_ID}); "
            "not compared further",
        )

    node_chain = _call(call, node_url, "eth_chainId", [], "node")
    if isinstance(node_chain, CheckResult):
        return node_chain
    if node_chain is None:
        return _fail(3, "NODE_NULL", "eth_chainId returned null")
    try:
        node_cid = hx(node_chain)
    except (TypeError, ValueError) as exc:
        return _fail(3, "NODE_NULL", f"eth_chainId not a number: {exc}")
    if node_cid != EXPECTED_CHAIN_ID:
        return _fail(
            4,
            "NODE_CHAIN_ID",
            f"node chain id is {node_cid} (want {EXPECTED_CHAIN_ID}); "
            "not compared further",
        )

    ref_head_raw = _call(call, ref_url, "eth_blockNumber", [], "reference")
    if isinstance(ref_head_raw, CheckResult):
        return ref_head_raw
    if ref_head_raw is None:
        return _fail(3, "REFERENCE_NULL", "eth_blockNumber returned null")
    node_head_raw = _call(call, node_url, "eth_blockNumber", [], "node")
    if isinstance(node_head_raw, CheckResult):
        return node_head_raw
    if node_head_raw is None:
        return _fail(3, "NODE_NULL", "eth_blockNumber returned null")
    try:
        ref_head = hx(ref_head_raw)
        node_head = hx(node_head_raw)
    except (TypeError, ValueError) as exc:
        return _fail(3, "REFERENCE_NULL", f"eth_blockNumber not a number: {exc}")
    if ref_head is None:
        return _fail(3, "REFERENCE_NULL", "eth_blockNumber returned null")
    if node_head is None:
        return _fail(3, "NODE_NULL", "eth_blockNumber returned null")

    heights = overlap_heights(node_head, ref_head)
    out: list[str] = [
        f"node={node_url} head={node_head}  reference={ref_url} head={ref_head} (untrusted)",
        f"overlap_heights={heights}",
    ]
    if not heights:
        return _fail(
            3,
            "REFERENCE_NULL",
            f"no overlapping heights (node head={node_head} reference head={ref_head})",
        )

    mismatched: list[str] = []
    for n in heights:
        params = [hex(n), False]
        ref_block = _call(call, ref_url, "eth_getBlockByNumber", params, "reference")
        if isinstance(ref_block, CheckResult):
            return ref_block
        if ref_block is None:
            return _fail(3, "REFERENCE_NULL", f"eth_getBlockByNumber({n}) returned null")
        node_block = _call(call, node_url, "eth_getBlockByNumber", params, "node")
        if isinstance(node_block, CheckResult):
            return node_block
        if node_block is None:
            return _fail(3, "NODE_NULL", f"eth_getBlockByNumber({n}) returned null")
        rf = block_fields(ref_block)
        nf = block_fields(node_block)
        if rf is None:
            return _fail(3, "REFERENCE_NULL", f"block {n} missing fields")
        if nf is None:
            return _fail(3, "NODE_NULL", f"block {n} missing fields")
        bad = mismatched_fields(nf, rf)
        if bad:
            mismatched.append(
                f"{DIVERGENCE_PREFIX} at block {n} fields={bad} "
                f"node={nf} reference={rf}. {DIVERGENCE_NOT_VERDICT}"
            )
            continue
        out.append(
            f"  block {n} hash={nf['hash']} MATCH (same header as this reference)"
        )

    if mismatched:
        err = "\n".join(mismatched)
        return CheckResult(
            exit_code=5,
            stdout="\n".join(out) + "\n",
            stderr=err,
            lines=out + mismatched,
        )

    out.append(
        f"no divergence on overlapping heights {heights} vs this untrusted reference"
    )
    text = "\n".join(out) + "\n"
    return CheckResult(exit_code=0, stdout=text, lines=out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Compare your ForteL2 node to a reference RPC without trusting "
            "the reference for derivation."
        )
    )
    parser.add_argument(
        "--node",
        default=os.environ.get("NODE_RPC", DEFAULT_NODE),
        help=f"your node RPC (default {DEFAULT_NODE} or $NODE_RPC)",
    )
    parser.add_argument(
        "--reference",
        default=os.environ.get("REFERENCE_RPC", DEFAULT_REFERENCE),
        help="untrusted comparator (default operator public URL or $REFERENCE_RPC)",
    )
    args = parser.parse_args(argv)
    result = run_check(args.node, args.reference)
    if result.stdout:
        sys.stdout.write(result.stdout if result.stdout.endswith("\n") else result.stdout + "\n")
    if result.stderr:
        sys.stderr.write(result.stderr if result.stderr.endswith("\n") else result.stderr + "\n")
    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
