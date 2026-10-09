#!/usr/bin/env python3
"""The committed bridge config must be the generator output, byte for byte.

A hand-written JSON that merely shares a few fields stays green after
config/rollup.json changes, and the public bridge would send Sepolia ETH to
a stale OptimismPortal. These tests regenerate the file and compare bytes.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
ROLLUP_PATH = ROOT / "config" / "rollup.json"
CONFIG_PATH = ROOT / "gateway" / "bridge" / "bridge-config.json"
GENERATOR = ROOT / "scripts" / "gen-bridge-config.py"

# Path segments that would publish a credential. {hash} is a template slot.
_API_KEY_SEGMENT = re.compile(
    r"(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret|password|bearer)"
    r"|^(?:sk|pk|rk)[_-][A-Za-z0-9]+"
    r"|[A-Za-z0-9_-]{32,}"
)
_DECIMAL_WEI = re.compile(r"^[0-9]+$")
_ADDRESS = re.compile(r"^0x[0-9a-f]{40}$")
# Retired chain id. Reject the value, not the digit sequence: a genesis hash
# or address may legally contain the characters 851.
_LEGACY_CHAIN_ID = 851
_LEGACY_CHAIN_HEX = hex(_LEGACY_CHAIN_ID)


def _load_generator():
    spec = importlib.util.spec_from_file_location("gen_bridge_config", GENERATOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {GENERATOR}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GEN = _load_generator()


def _walk(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from _walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk(item)
    else:
        yield value


def _legacy_chain_hits(value):
    """Yield where chain id 851 appears as a number or as its own hex string."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield from (
                f"{key}.{hit}" for hit in _legacy_chain_hits(item)
            )
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from (
                f"[{index}].{hit}" for hit in _legacy_chain_hits(item)
            )
    elif type(value) is int and value == _LEGACY_CHAIN_ID:
        yield "value"
    elif isinstance(value, str) and value.lower() in (
        str(_LEGACY_CHAIN_ID),
        _LEGACY_CHAIN_HEX,
    ):
        yield "value"


class BridgeConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.committed = CONFIG_PATH.read_bytes()
        cls.rollup = json.loads(ROLLUP_PATH.read_text(encoding="utf-8"))
        cls.generated = GEN.render_bytes(cls.rollup)
        cls.config = json.loads(cls.committed.decode("utf-8"))

    def test_committed_file_equals_generator_bytes(self):
        self.assertEqual(self.generated, self.committed)
        self.assertTrue(self.committed.endswith(b"\n"))
        self.assertNotIn(b"\r", self.committed)

    def test_check_cli_exits_zero_when_committed_file_matches(self):
        proc = subprocess.run(
            [sys.executable, str(GENERATOR), "--check"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual("", proc.stdout)
        self.assertEqual("", proc.stderr)

    def test_rollup_derived_fields_match_rollup_json(self):
        cfg = self.config
        rollup = self.rollup
        self.assertEqual("852-sepolia-2026-10-08.1", cfg["configVersion"])
        self.assertEqual(rollup["l1_chain_id"], cfg["l1"]["chainId"])
        self.assertEqual(rollup["l2_chain_id"], cfg["l2"]["chainId"])
        self.assertEqual(hex(rollup["l1_chain_id"]), cfg["l1"]["chainIdHex"])
        self.assertEqual(hex(rollup["l2_chain_id"]), cfg["l2"]["chainIdHex"])
        self.assertEqual(
            rollup["genesis"]["l2"]["hash"].lower(),
            cfg["l2"]["genesisHash"],
        )
        self.assertEqual(
            rollup["deposit_contract_address"].lower(),
            cfg["contracts"]["optimismPortal"],
        )
        self.assertEqual(
            rollup["l1_system_config_address"].lower(),
            cfg["contracts"]["systemConfig"],
        )
        for field in (
            cfg["contracts"]["optimismPortal"],
            cfg["contracts"]["systemConfig"],
            cfg["contracts"]["metamaskDelegationManager"],
        ):
            self.assertRegex(field, _ADDRESS)
            self.assertEqual(field, field.lower())
        self.assertEqual(
            cfg["l2"]["genesisHash"],
            cfg["l2"]["genesisHash"].lower(),
        )
        self.assertRegex(cfg["l2"]["genesisHash"], r"^0x[0-9a-f]{64}$")

    def test_chain_id_851_appears_nowhere(self):
        hits = list(_legacy_chain_hits(self.config))
        self.assertEqual([], hits)
        for side in ("l1", "l2"):
            self.assertNotEqual(_LEGACY_CHAIN_ID, self.config[side]["chainId"])
            self.assertNotEqual(
                _LEGACY_CHAIN_HEX,
                self.config[side]["chainIdHex"],
            )

    def test_digits_851_inside_a_hash_are_not_chain_851(self):
        cfg = json.loads(self.committed.decode("utf-8"))
        cfg["l2"]["genesisHash"] = "0x" + ("851" * 21) + "ab"
        self.assertIn("851", cfg["l2"]["genesisHash"])
        self.assertEqual([], list(_legacy_chain_hits(cfg)))

    def test_chain_id_field_851_is_rejected(self):
        cfg = json.loads(self.committed.decode("utf-8"))
        cfg["l2"]["chainId"] = _LEGACY_CHAIN_ID
        cfg["l2"]["chainIdHex"] = _LEGACY_CHAIN_HEX
        hits = list(_legacy_chain_hits(cfg))
        self.assertIn("l2.chainId.value", hits)
        self.assertIn("l2.chainIdHex.value", hits)

    def test_urls_have_no_credentials_query_or_api_key_segments(self):
        seen = False
        for value in _walk(self.config):
            if not isinstance(value, str) or "://" not in value:
                continue
            seen = True
            parts = urlsplit(value)
            self.assertTrue(parts.scheme, value)
            self.assertTrue(parts.hostname, value)
            self.assertIsNone(parts.username, value)
            self.assertIsNone(parts.password, value)
            self.assertEqual("", parts.query, value)
            self.assertEqual("", parts.fragment, value)
            self.assertNotIn("@", parts.netloc, value)
            self.assertNotIn("?", value)
            for segment in parts.path.split("/"):
                if segment in ("", "{hash}"):
                    continue
                self.assertIsNone(
                    _API_KEY_SEGMENT.search(segment),
                    f"api-key-like path segment {segment!r} in {value}",
                )
        self.assertTrue(seen, "bridge config has no absolute URLs to check")

    def test_deposit_cap_gas_and_quote_ttl(self):
        deposit = self.config["deposit"]
        self.assertEqual("20000000000000000", deposit["capWei"])
        self.assertRegex(deposit["capWei"], _DECIMAL_WEI)
        cap = int(deposit["capWei"])
        self.assertEqual(20000000000000000, cap)
        self.assertEqual("100000", deposit["l2GasLimit"])
        self.assertEqual(60, deposit["quoteTtlSeconds"])
        self.assertGreater(len(deposit["presetsWei"]), 0)
        for preset in deposit["presetsWei"]:
            self.assertRegex(preset, _DECIMAL_WEI)
            self.assertLessEqual(int(preset), cap)

    def test_mutated_rollup_fails_check_with_a_diff(self):
        mutated = json.loads(json.dumps(self.rollup))
        mutated["deposit_contract_address"] = "0x" + "11" * 20
        self.assertNotEqual(self.committed, GEN.render_bytes(mutated))
        with tempfile.TemporaryDirectory() as tmp:
            rollup_path = Path(tmp) / "rollup.json"
            rollup_path.write_text(json.dumps(mutated), encoding="utf-8")
            proc = subprocess.run(
                [
                    sys.executable,
                    str(GENERATOR),
                    "--check",
                    "--rollup",
                    str(rollup_path),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertNotEqual(0, proc.returncode)
        self.assertIn("optimismPortal", proc.stderr)
        self.assertIn("0x" + "11" * 20, proc.stderr)
        self.assertIn("---", proc.stderr)
