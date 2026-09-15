"""Shared header-comparison helpers for replica parity tools.

`scripts/verify-reth-parity.sh` is the operator tool (candidate vs Mac
sequencer, including receipts). `scripts/check_friend_parity.py` is the
friend command (own node vs an untrusted reference). Both must compare the
same block fields so a later edit cannot silently diverge.

This module does not perform I/O. It never writes, and it never suggests
rewinding a chain.
"""

from __future__ import annotations

from typing import Any

# Keep in lockstep with FIELDS in scripts/verify-reth-parity.sh (tested).
FIELDS: tuple[str, ...] = (
    "number",
    "hash",
    "parentHash",
    "stateRoot",
    "receiptsRoot",
    "txCount",
)


def hx(v: Any) -> int | None:
    if v is None:
        return None
    if isinstance(v, int):
        return v
    s = str(v).strip()
    return int(s, 16) if s.startswith("0x") else int(s)


def norm_hash(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip().lower()
    if not s.startswith("0x"):
        s = "0x" + s
    return "0x" + s[2:].zfill(64)


def block_fields(block: Any) -> dict[str, Any] | None:
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


def mismatched_fields(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    return [name for name in FIELDS if left.get(name) != right.get(name)]
