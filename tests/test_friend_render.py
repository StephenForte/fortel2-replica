#!/usr/bin/env python3
"""Friend Render path + untrusted-reference parity properties."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
RUNNING = ROOT / "RUNNING.md"
README = ROOT / "README.md"
DECISIONS = ROOT / "DECISIONS.md"
OPERATOR_PARITY = SCRIPTS / "verify-reth-parity.sh"
FRIEND_SH = SCRIPTS / "check-friend-parity.sh"
FRIEND_PY = SCRIPTS / "check_friend_parity.py"

sys.path.insert(0, str(SCRIPTS))
import check_friend_parity  # noqa: E402
import parity_compare  # noqa: E402


def _heading_section(text: str, heading: str) -> str:
    """Return markdown from `## heading` up to the next same-level heading."""
    pattern = rf"(?m)^## {re.escape(heading)}\s*$"
    match = re.search(pattern, text)
    if not match:
        raise AssertionError(f"missing heading {heading!r}")
    start = match.start()
    nxt = re.search(r"(?m)^## ", text[match.end() :])
    end = match.end() + nxt.start() if nxt else len(text)
    return text[start:end]


def friend_render_section() -> str:
    return _heading_section(RUNNING.read_text(encoding="utf-8"), "On Render")


def friend_readme_bits() -> str:
    """README bits a friend is sent to before operator Render tables."""
    text = README.read_text(encoding="utf-8")
    intro = text.split("## Chain identity", 1)[0]
    quick = _heading_section(text, "Quick start (laptop / VPS)")
    return intro + "\n" + quick


GENESIS_HASH = "0x" + "11" * 32
OTHER_HASH = "0x" + "22" * 32


def _block(number: int, block_hash: str) -> dict:
    return {
        "number": hex(number),
        "hash": block_hash,
        "parentHash": "0x" + "00" * 32,
        "stateRoot": "0x" + "aa" * 32,
        "receiptsRoot": "0x" + "bb" * 32,
        "transactions": [],
    }


class ScriptedRpc:
    """Map url → method → value or exception."""

    def __init__(self, table: dict[str, dict]):
        self.table = {url.rstrip("/"): dict(methods) for url, methods in table.items()}

    def __call__(self, url: str, method: str, params: list) -> object:
        slot = self.table[url.rstrip("/")]
        key = method
        if method == "eth_getBlockByNumber":
            key = (method, int(params[0], 16))
        if key not in slot and method == "eth_getBlockByNumber":
            key = method
        value = slot[key]
        if isinstance(value, Exception):
            raise value
        return value


def _agreeing_pair(node="http://127.0.0.1:9545", ref="http://127.0.0.1:18545"):
    genesis = _block(0, GENESIS_HASH)
    return node, ref, ScriptedRpc(
        {
            node: {
                "eth_chainId": hex(852),
                "eth_blockNumber": hex(0),
                ("eth_getBlockByNumber", 0): genesis,
            },
            ref: {
                "eth_chainId": hex(852),
                "eth_blockNumber": hex(0),
                ("eth_getBlockByNumber", 0): genesis,
            },
        }
    )


class FriendParityFailClosedTests(unittest.TestCase):
    NODE = "http://127.0.0.1:9545"
    REF = "http://127.0.0.1:18545"

    def test_reference_unreachable_is_named(self):
        rpc = ScriptedRpc(
            {
                self.NODE: {"eth_chainId": hex(852)},
                self.REF: {
                    "eth_chainId": check_friend_parity.RpcError(
                        "unreachable", "connection refused"
                    ),
                },
            }
        )
        result = check_friend_parity.run_check(self.NODE, self.REF, rpc=rpc)
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("REFERENCE_UNREACHABLE", result.stderr)
        self.assertNotIn("REFERENCE_NULL", result.stderr)
        self.assertNotIn("REFERENCE_CHAIN_ID", result.stderr)
        self.assertNotIn("DIVERGENCE", result.stderr)

    def test_reference_null_is_named(self):
        rpc = ScriptedRpc(
            {
                self.NODE: {"eth_chainId": hex(852)},
                self.REF: {"eth_chainId": None},
            }
        )
        result = check_friend_parity.run_check(self.NODE, self.REF, rpc=rpc)
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("REFERENCE_NULL", result.stderr)
        self.assertNotIn("REFERENCE_UNREACHABLE", result.stderr)
        self.assertNotIn("REFERENCE_CHAIN_ID", result.stderr)

    def test_reference_chain_id_is_named(self):
        rpc = ScriptedRpc(
            {
                self.NODE: {"eth_chainId": hex(852)},
                self.REF: {"eth_chainId": hex(1)},
            }
        )
        result = check_friend_parity.run_check(self.NODE, self.REF, rpc=rpc)
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("REFERENCE_CHAIN_ID", result.stderr)
        self.assertNotIn("REFERENCE_UNREACHABLE", result.stderr)
        self.assertNotIn("REFERENCE_NULL", result.stderr)
        self.assertNotIn("DIVERGENCE", result.stderr)

    def test_divergence_is_disagreement_not_blame(self):
        rpc = ScriptedRpc(
            {
                self.NODE: {
                    "eth_chainId": hex(852),
                    "eth_blockNumber": hex(0),
                    ("eth_getBlockByNumber", 0): _block(0, GENESIS_HASH),
                },
                self.REF: {
                    "eth_chainId": hex(852),
                    "eth_blockNumber": hex(0),
                    ("eth_getBlockByNumber", 0): _block(0, OTHER_HASH),
                },
            }
        )
        result = check_friend_parity.run_check(self.NODE, self.REF, rpc=rpc)
        self.assertEqual(5, result.exit_code)
        blob = result.stderr + result.stdout
        self.assertIn(check_friend_parity.DIVERGENCE_PREFIX, blob)
        self.assertIn(check_friend_parity.DIVERGENCE_NOT_VERDICT, blob)
        self.assertIn("disagree", blob)
        self.assertIn("not a verdict against your node", blob)
        self.assertNotRegex(blob, r"(?i)you are wrong")
        self.assertNotRegex(blob, r"(?i)your node is (wrong|incorrect|broken)")
        self.assertNotIn("debug_setHead", blob)

    def test_matching_headers_exit_zero(self):
        node, ref, rpc = _agreeing_pair()
        result = check_friend_parity.run_check(node, ref, rpc=rpc)
        self.assertEqual(0, result.exit_code)
        self.assertIn("no divergence", result.stdout)
        self.assertNotIn("DIVERGENCE", result.stderr)
        self.assertNotIn("debug_setHead", result.stdout)

    def test_incomplete_blocks_do_not_match(self):
        incomplete = {"number": "0x0"}
        rpc = ScriptedRpc(
            {
                self.NODE: {
                    "eth_chainId": hex(852),
                    "eth_blockNumber": hex(0),
                    ("eth_getBlockByNumber", 0): incomplete,
                },
                self.REF: {
                    "eth_chainId": hex(852),
                    "eth_blockNumber": hex(0),
                    ("eth_getBlockByNumber", 0): incomplete,
                },
            }
        )
        result = check_friend_parity.run_check(self.NODE, self.REF, rpc=rpc)
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("REFERENCE_NULL", result.stderr)
        self.assertNotIn(" MATCH", result.stdout)
        self.assertNotIn("no divergence", result.stdout)

    def test_malformed_node_head_is_node_null(self):
        rpc = ScriptedRpc(
            {
                self.NODE: {
                    "eth_chainId": hex(852),
                    "eth_blockNumber": "not-a-quantity",
                },
                self.REF: {
                    "eth_chainId": hex(852),
                    "eth_blockNumber": hex(0),
                },
            }
        )
        result = check_friend_parity.run_check(self.NODE, self.REF, rpc=rpc)
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("NODE_NULL", result.stderr)
        self.assertNotIn("REFERENCE_NULL", result.stderr)


def _jsonrpc_server(result_for: dict):
    """Serve programmed JSON-RPC results on a free loopback port."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length))
            method = body["method"]
            if method not in result_for:
                self.send_response(404)
                self.end_headers()
                return
            raw = json.dumps(
                {"jsonrpc": "2.0", "id": body.get("id", 1), "result": result_for[method]}
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, fmt, *args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return f"http://{host}:{port}", server


class FriendParityHttpTests(unittest.TestCase):
    """Fail-closed names through urllib, not the ScriptedRpc double."""

    def tearDown(self):
        for attr in ("_servers",):
            for server in getattr(self, attr, []):
                server.shutdown()
                server.server_close()

    def _serve(self, result_for):
        url, server = _jsonrpc_server(result_for)
        self._servers = getattr(self, "_servers", []) + [server]
        return url

    def test_http_reference_unreachable(self):
        result = check_friend_parity.run_check(
            "http://127.0.0.1:1",
            "http://127.0.0.1:1",
        )
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("REFERENCE_UNREACHABLE", result.stderr)

    def test_http_reference_null(self):
        ref = self._serve({"eth_chainId": None})
        result = check_friend_parity.run_check("http://127.0.0.1:1", ref)
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("REFERENCE_NULL", result.stderr)
        self.assertNotIn("REFERENCE_UNREACHABLE", result.stderr)
        self.assertNotIn("REFERENCE_CHAIN_ID", result.stderr)

    def test_http_reference_chain_id(self):
        ref = self._serve({"eth_chainId": hex(1)})
        result = check_friend_parity.run_check("http://127.0.0.1:1", ref)
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("REFERENCE_CHAIN_ID", result.stderr)
        self.assertNotIn("REFERENCE_UNREACHABLE", result.stderr)
        self.assertNotIn("REFERENCE_NULL", result.stderr)

    def test_bash_syntax(self):
        proc = subprocess.run(
            ["bash", "-n", str(FRIEND_SH)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(0, proc.returncode, proc.stderr)

    def test_wrapper_runs_against_local_servers(self):
        genesis = _block(0, GENESIS_HASH)

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length))
                method = body["method"]
                if method == "eth_chainId":
                    result = hex(852)
                elif method == "eth_blockNumber":
                    result = hex(0)
                elif method == "eth_getBlockByNumber":
                    result = genesis
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                raw = json.dumps({"jsonrpc": "2.0", "id": body.get("id", 1), "result": result}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, fmt, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            host, port = server.server_address
            url = f"http://{host}:{port}"
            env = os.environ.copy()
            env["NODE_RPC"] = url
            env["REFERENCE_RPC"] = url
            env["PYTHONPATH"] = str(SCRIPTS)
            proc = subprocess.run(
                [str(FRIEND_SH)],
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(0, proc.returncode, proc.stderr + proc.stdout)
        self.assertIn("no divergence", proc.stdout)

    def test_wrapper_runs_when_three_files_are_colocated(self):
        genesis = _block(0, GENESIS_HASH)
        url, server = _jsonrpc_server(
            {
                "eth_chainId": hex(852),
                "eth_blockNumber": hex(0),
                "eth_getBlockByNumber": genesis,
            }
        )
        try:
            with tempfile.TemporaryDirectory() as tmp:
                dest = Path(tmp)
                for name in (
                    "check-friend-parity.sh",
                    "check_friend_parity.py",
                    "parity_compare.py",
                ):
                    shutil.copy(SCRIPTS / name, dest / name)
                env = os.environ.copy()
                env["NODE_RPC"] = url
                env["REFERENCE_RPC"] = url
                env.pop("PYTHONPATH", None)
                proc = subprocess.run(
                    ["bash", str(dest / "check-friend-parity.sh")],
                    capture_output=True,
                    text=True,
                    env=env,
                    check=False,
                )
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(0, proc.returncode, proc.stderr + proc.stdout)
        self.assertIn("no divergence", proc.stdout)

    def test_wrapper_names_unreachable_reference(self):
        env = os.environ.copy()
        env["NODE_RPC"] = "http://127.0.0.1:1"
        env["REFERENCE_RPC"] = "http://127.0.0.1:1"
        env["PYTHONPATH"] = str(SCRIPTS)
        proc = subprocess.run(
            [str(FRIEND_SH)],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        self.assertNotEqual(0, proc.returncode)
        self.assertIn("REFERENCE_UNREACHABLE", proc.stderr)

    def test_operator_fields_match_shared_module(self):
        text = OPERATOR_PARITY.read_text(encoding="utf-8")
        match = re.search(r"FIELDS = \[([^\]]+)\]", text)
        self.assertIsNotNone(match, "operator script lost its FIELDS list")
        quoted = re.findall(r'"([^"]+)"', match.group(1))
        self.assertEqual(list(parity_compare.FIELDS), quoted)

    def test_default_reference_is_operator_public_and_untrusted(self):
        self.assertEqual(
            check_friend_parity.DEFAULT_REFERENCE,
            "https://fortel2-replica-rpc.onrender.com",
        )
        header = FRIEND_SH.read_text(encoding="utf-8")
        self.assertIn("untrusted", header.lower())
        self.assertIn("disagree", header)


class FriendRenderDocsTests(unittest.TestCase):
    def test_disk_and_ram_figures_match_stated_sources(self):
        section = friend_render_section()
        decisions = DECISIONS.read_text(encoding="utf-8")
        running = RUNNING.read_text(encoding="utf-8")

        self.assertIn("D-0122", section)
        self.assertRegex(section, r"≈1–2 GB")
        self.assertIn("`--full` state ≈1–2 GB", decisions)
        self.assertRegex(running, r"D-0122 sizing for `--full` state is ≈1–2 GB")

        self.assertIn("10 GB", section)
        self.assertIn("R-0019", section)
        self.assertIn("Render offers fixed sizes and 25 is not one", decisions)
        self.assertIn("1, 10, 20, and 50 GB", section)

        self.assertIn("not been measured", section)
        self.assertIn("170 MB/day", section)
        self.assertIn("R-0017", section)
        self.assertIn("archive", section.lower())

        self.assertRegex(section, r"512 MB")
        self.assertRegex(section, r"2 GB")
        self.assertRegex(running, r"~2 GB RAM")
        readme = README.read_text(encoding="utf-8")
        self.assertIn("Starter (512MB) will OOM", readme)
        self.assertIn("Standard (~2GB)", readme)

    def test_friend_render_omits_operator_surfaces(self):
        section = friend_render_section()
        readme_friend = friend_readme_bits()
        for blob, label in ((section, "RUNNING.md §On Render"), (readme_friend, "README friend bits")):
            for needle in (
                "REPLICA_UPSTREAM",
                "RPC_RATE",
                "RPC_BURST",
                "RETH_SNAPSHOT",
                "L1_RPC_FORCE",
            ):
                self.assertNotIn(needle, blob, f"{label} mentions operator surface {needle}")

        self.assertRegex(section, r"(?i)do not set `RETH_ARCHIVE`")
        self.assertNotRegex(section, r"(?i)(?<![Dd]o not set `)Set `RETH_ARCHIVE=1`")
        self.assertNotRegex(section, r"RETH_ARCHIVE=1 before")
        for match in re.finditer(r"RETH_ARCHIVE=1", section):
            sentence = section[max(0, match.start() - 80) : match.end() + 120]
            self.assertTrue(
                re.search(r"(?i)do not set|omits `--full`|grows", sentence),
                f"RETH_ARCHIVE=1 appears as an instruction: {sentence!r}",
            )

        self.assertIn("Private Service", section)
        self.assertIn("not **New → Web Service**", section)
        self.assertIn("Shell", section)
        self.assertIn("same directory", section)

    def test_friend_parity_is_documented_as_untrusted(self):
        section = _heading_section(
            RUNNING.read_text(encoding="utf-8"),
            "Check against a reference (untrusted)",
        )
        self.assertIn("check-friend-parity.sh", section)
        self.assertIn("disagree", section)
        self.assertIn("untrusted", section.lower())
        self.assertIn("REFERENCE_UNREACHABLE", section)
        self.assertIn("REFERENCE_NULL", section)
        self.assertIn("REFERENCE_CHAIN_ID", section)
        self.assertIn("never suggests `debug_setHead`", section)
        readme_friend = friend_readme_bits()
        self.assertIn("check-friend-parity.sh", readme_friend)


if __name__ == "__main__":
    unittest.main()
