#!/usr/bin/env python3
"""Tests for the vendored public-read RPC method filter (MR-2)."""

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FILTER = ROOT / "rpc-method-filter.py"


class RpcMethodFilterTests(unittest.TestCase):
    def test_self_test_ok(self):
        result = subprocess.run(
            ["python3", str(FILTER), "--self-test"],
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(0, result.returncode, result.stderr + result.stdout)
        self.assertIn("rpc-method-filter self-test ok", result.stdout)

    def test_send_raw_transaction_rejected_in_allowlist(self):
        # Import as a module without starting the server.
        import importlib.util

        spec = importlib.util.spec_from_file_location("rpc_method_filter", FILTER)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        self.assertIn("eth_sendRawTransaction", mod._T5_D1_ALLOWED_METHODS)
        self.assertNotIn("eth_sendRawTransaction", mod.ALLOWED_METHODS)
        self.assertFalse(mod.is_method_allowed("eth_sendRawTransaction"))
        self.assertTrue(mod.is_method_allowed("eth_newFilter"))
        self.assertFalse(mod.is_method_allowed("eth_newPendingTransactionFilter"))

    def test_mixed_batch_isolates_disallowed(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("rpc_method_filter", FILTER)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        kind, _items, rejects = mod.classify_body(
            [
                {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []},
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "eth_sendRawTransaction",
                    "params": ["0x00"],
                },
            ]
        )
        self.assertEqual("batch", kind)
        self.assertIsNone(rejects[0])
        self.assertIsNotNone(rejects[1])
        self.assertEqual(mod.JSONRPC_METHOD_NOT_FOUND, rejects[1]["error"]["code"])
        self.assertIn("eth_sendRawTransaction", rejects[1]["error"]["message"])

    def test_chunked_body_unit(self):
        import importlib.util
        import io

        spec = importlib.util.spec_from_file_location("rpc_method_filter", FILTER)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        raw = b'{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
        chunked = f"{len(raw):x}\r\n".encode() + raw + b"\r\n0\r\n\r\n"
        self.assertEqual(raw, mod.read_chunked_body(io.BytesIO(chunked)))

    def test_disallowed_notification_omits_response(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("rpc_method_filter", FILTER)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        self.assertTrue(
            mod.is_jsonrpc_notification(
                {"jsonrpc": "2.0", "method": "admin_peers", "params": []}
            )
        )
        self.assertFalse(
            mod.is_jsonrpc_notification(
                {"jsonrpc": "2.0", "id": None, "method": "admin_peers", "params": []}
            )
        )
        self.assertIs(
            mod.filter_single(
                {"jsonrpc": "2.0", "method": "eth_sendRawTransaction", "params": ["0x"]}
            ),
            mod.OMIT_RESPONSE,
        )
        status, payload, _ctype = mod.handle_jsonrpc_body(
            b'{"jsonrpc":"2.0","method":"eth_sendRawTransaction","params":["0x"]}',
            "application/json",
        )
        self.assertEqual(200, status)
        self.assertEqual(b"", payload)

    def test_mixed_batch_omits_notification_error(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("rpc_method_filter", FILTER)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        kind, _items, rejects = mod.classify_body(
            [
                {"jsonrpc": "2.0", "method": "admin_peers", "params": []},
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "eth_sendRawTransaction",
                    "params": ["0x00"],
                },
            ]
        )
        self.assertEqual("batch", kind)
        self.assertIs(rejects[0], mod.OMIT_RESPONSE)
        self.assertIsInstance(rejects[1], dict)
        self.assertIn("eth_sendRawTransaction", rejects[1]["error"]["message"])


if __name__ == "__main__":
    unittest.main()
