#!/usr/bin/env python3
"""Generate gateway/bridge/bridge-config.json from config/rollup.json.

config/ is outside the gateway Docker build context, so the public artifact
is generated and committed. `--check` prints a unified diff and exits
non-zero when the committed file is not the bytes this script would write.
A later rollup.json edit then fails CI until the artifact is regenerated.

Shape and key order follow docs/2026-10-08-bridge-plan.md. Chain ids, the
L2 genesis hash, OptimismPortal, and SystemConfig are read from rollup.json.
chainIdHex is hex(chainId). Every other field is a constant in this file.
"""

from __future__ import annotations

import argparse
import difflib
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROLLUP = ROOT / "config" / "rollup.json"
DEFAULT_OUT = ROOT / "gateway" / "bridge" / "bridge-config.json"

# Verbatim. Bump only with a chain reset or a contract change (R-0025).
CONFIG_VERSION = "852-sepolia-2026-10-08.1"

# Constants from the bridge-config.json shape in the bridge plan.
L1_NAME = "Sepolia"
L1_RPC = "https://sepolia.gateway.tenderly.co"
L1_EXPLORER_TX = "https://sepolia.etherscan.io/tx/{hash}"

L2_NAME = "ForteL2 Sepolia"
L2_SEQUENCER_RPC = "https://fortel2-sequencer-rpc.onrender.com/"
L2_REPLICA_RPC = "/"
L2_EXPLORER_TX = (
    "https://settlementos-explorer-ihgo.onrender.com/fortel2-sepolia/tx/{hash}"
)

METAMASK_DELEGATION_MANAGER = "0xdb9b1e94b5b69df7e401ddbede43491141047db3"

L2_GAS_LIMIT = "100000"
CAP_WEI = "20000000000000000"
PRESETS_WEI = (
    "1000000000000000",
    "2000000000000000",
    "5000000000000000",
)
DEFAULT_WEI = "2000000000000000"
QUOTE_TTL_SECONDS = 60
L1_GAS_FLOOR = "500000"
L1_GAS_CEILING = "1000000"
L1_GAS_MULTIPLIER = 2
POLL_SECONDS = 12


class RollupError(ValueError):
    """rollup.json is missing a field the bridge config copies."""


def _require_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RollupError(f"{label} must be an integer, got {value!r}")
    if value < 0:
        raise RollupError(f"{label} must be >= 0, got {value}")
    return value


def _lower_hex(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise RollupError(f"{label} must be a non-empty string, got {value!r}")
    return value.lower()


def chain_id_hex(chain_id: int) -> str:
    """Lowercase 0x hex of a chain id, with no extra zero padding."""
    return hex(chain_id)


def build_config(rollup: dict) -> dict:
    """Return the bridge config object. Key order is the public shape."""
    if not isinstance(rollup, dict):
        raise RollupError("rollup.json must be a JSON object")
    l1_chain_id = _require_int(rollup.get("l1_chain_id"), "l1_chain_id")
    l2_chain_id = _require_int(rollup.get("l2_chain_id"), "l2_chain_id")
    try:
        genesis_hash = rollup["genesis"]["l2"]["hash"]
    except (KeyError, TypeError) as exc:
        raise RollupError("rollup.json is missing genesis.l2.hash") from exc
    return {
        "configVersion": CONFIG_VERSION,
        "l1": {
            "chainId": l1_chain_id,
            "chainIdHex": chain_id_hex(l1_chain_id),
            "name": L1_NAME,
            "rpc": L1_RPC,
            "explorerTx": L1_EXPLORER_TX,
        },
        "l2": {
            "chainId": l2_chain_id,
            "chainIdHex": chain_id_hex(l2_chain_id),
            "name": L2_NAME,
            "genesisHash": _lower_hex(genesis_hash, "genesis.l2.hash"),
            "sequencerRpc": L2_SEQUENCER_RPC,
            "replicaRpc": L2_REPLICA_RPC,
            "explorerTx": L2_EXPLORER_TX,
        },
        "contracts": {
            "optimismPortal": _lower_hex(
                rollup.get("deposit_contract_address"),
                "deposit_contract_address",
            ),
            "systemConfig": _lower_hex(
                rollup.get("l1_system_config_address"),
                "l1_system_config_address",
            ),
            "metamaskDelegationManager": METAMASK_DELEGATION_MANAGER.lower(),
        },
        "deposit": {
            "l2GasLimit": L2_GAS_LIMIT,
            "capWei": CAP_WEI,
            "presetsWei": list(PRESETS_WEI),
            "defaultWei": DEFAULT_WEI,
            "quoteTtlSeconds": QUOTE_TTL_SECONDS,
            "l1GasFloor": L1_GAS_FLOOR,
            "l1GasCeiling": L1_GAS_CEILING,
            "l1GasMultiplier": L1_GAS_MULTIPLIER,
            "pollSeconds": POLL_SECONDS,
        },
    }


def render_bytes(rollup: dict) -> bytes:
    """indent=2, LF, trailing newline. Wei values stay decimal strings."""
    text = json.dumps(build_config(rollup), indent=2, ensure_ascii=False) + "\n"
    if "\r" in text:
        raise RollupError("generator produced a CR; refusing to emit the file")
    return text.encode("utf-8")


def load_rollup(path: Path) -> dict:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RollupError(f"cannot read {path}: {exc}") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RollupError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise RollupError(f"{path} must be a JSON object")
    return data


def unified_diff(committed: bytes, generated: bytes, path: Path) -> str:
    committed_text = committed.decode("utf-8", errors="replace")
    generated_text = generated.decode("utf-8")
    lines = difflib.unified_diff(
        committed_text.splitlines(keepends=True),
        generated_text.splitlines(keepends=True),
        fromfile=str(path),
        tofile="generated from rollup.json",
    )
    return "".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero and print a diff if the committed file differs",
    )
    parser.add_argument(
        "--rollup",
        type=Path,
        default=DEFAULT_ROLLUP,
        help="rollup.json to read (default: config/rollup.json)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="bridge-config.json to write or check",
    )
    args = parser.parse_args(argv)
    try:
        generated = render_bytes(load_rollup(args.rollup))
    except RollupError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if args.check:
        if not args.out.is_file():
            print(f"missing {args.out}", file=sys.stderr)
            return 1
        committed = args.out.read_bytes()
        if committed == generated:
            return 0
        print(f"{args.out} does not match generator output", file=sys.stderr)
        diff = unified_diff(committed, generated, args.out)
        sys.stderr.write(diff)
        if diff and not diff.endswith("\n"):
            sys.stderr.write("\n")
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(generated)
    return 0


if __name__ == "__main__":
    sys.exit(main())
