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

    def test_oversize_content_length_does_not_smuggle(self):
        """Pipelined second JSON-RPC after oversize CL must not be a second request."""
        import importlib.util
        import json
        import os
        import socket
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        spec = importlib.util.spec_from_file_location("rpc_method_filter", FILTER)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)

        seen: list = []

        class Upstream(BaseHTTPRequestHandler):
            server_version = "test-upstream/1"
            sys_version = ""

            def log_message(self, *_args) -> None:
                return

            def do_POST(self) -> None:
                n = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(n)
                seen.append(json.loads(body.decode()))
                payload = b'{"jsonrpc":"2.0","id":1,"result":"0x1"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        up = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=up.serve_forever, daemon=True).start()
        os.environ["L2_RPC_FILTER_UPSTREAM"] = f"http://127.0.0.1:{up.server_address[1]}"
        mod.STATE = mod.FilterState()
        filt = ThreadingHTTPServer(("127.0.0.1", 0), mod.Handler)
        threading.Thread(target=filt.serve_forever, daemon=True).start()
        try:
            second = b'{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
            sock = socket.create_connection(("127.0.0.1", filt.server_address[1]), timeout=5)
            sock.sendall(
                b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
                + f"Content-Length: {mod.MAX_BODY_BYTES + 1}\r\n\r\n".encode()
                + b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
                + f"Content-Length: {len(second)}\r\n\r\n".encode()
                + second
            )
            data = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
            sock.close()
            self.assertEqual(1, data.count(b"HTTP/1.1 "), data[:300])
            self.assertIn(b"400", data.split(b"\r\n", 1)[0])
            self.assertIn(b"Connection: close", data)
            self.assertEqual([], seen)
        finally:
            filt.shutdown()
            filt.server_close()
            up.shutdown()
            up.server_close()

    def test_long_chunk_size_line_without_newline_is_capped(self):
        import importlib.util
        import io

        spec = importlib.util.spec_from_file_location("rpc_method_filter", FILTER)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        buf = io.BytesIO(b"a" * (mod.MAX_LINE_BYTES + 4096))
        with self.assertRaises(ValueError) as ctx:
            mod.read_chunked_body(buf)
        self.assertIn("header line exceeds", str(ctx.exception))
        self.assertLessEqual(buf.tell(), mod.MAX_LINE_BYTES + 1)

    def test_trailer_flood_is_capped(self):
        import importlib.util
        import io

        spec = importlib.util.spec_from_file_location("rpc_method_filter", FILTER)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        flood = b"0\r\n" + b"x:1\r\n" * (mod.MAX_TRAILER_LINES + 8) + b"\r\n"
        with self.assertRaises(ValueError) as ctx:
            mod.read_chunked_body(io.BytesIO(flood))
        self.assertIn("trailer", str(ctx.exception).lower())

    def test_head_health_returns_200_without_body(self):
        import importlib.util
        import os
        import socket
        import threading
        from http.server import ThreadingHTTPServer

        spec = importlib.util.spec_from_file_location("rpc_method_filter", FILTER)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)

        saved = os.environ.get("L2_RPC_FILTER_UPSTREAM")
        os.environ["L2_RPC_FILTER_UPSTREAM"] = "http://127.0.0.1:9"
        mod.STATE = mod.FilterState()
        filt = ThreadingHTTPServer(("127.0.0.1", 0), mod.Handler)
        threading.Thread(target=filt.serve_forever, daemon=True).start()
        try:
            sock = socket.create_connection(("127.0.0.1", filt.server_address[1]), timeout=5)
            sock.sendall(b"HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
            sock.close()
            self.assertIn(b"200", data.split(b"\r\n", 1)[0])
            header, _, rest = data.partition(b"\r\n\r\n")
            self.assertEqual(b"", rest)
            self.assertIn(b"Content-Length:", header)
        finally:
            filt.shutdown()
            filt.server_close()
            if saved is None:
                os.environ.pop("L2_RPC_FILTER_UPSTREAM", None)
            else:
                os.environ["L2_RPC_FILTER_UPSTREAM"] = saved

    def test_remote_upstream_requires_access_env(self):
        import importlib.util
        import os

        spec = importlib.util.spec_from_file_location("rpc_method_filter", FILTER)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)

        saved = {
            k: os.environ.get(k)
            for k in (
                "L2_RPC_FILTER_UPSTREAM",
                "L2_RPC_FILTER_REMOTE_UPSTREAM_HOSTS",
                "CF_ACCESS_CLIENT_ID",
                "CF_ACCESS_CLIENT_SECRET",
            )
        }
        try:
            os.environ["L2_RPC_FILTER_UPSTREAM"] = "https://fortel2-write.ente.ltd"
            os.environ["L2_RPC_FILTER_REMOTE_UPSTREAM_HOSTS"] = "fortel2-write.ente.ltd"
            os.environ.pop("CF_ACCESS_CLIENT_ID", None)
            os.environ.pop("CF_ACCESS_CLIENT_SECRET", None)
            with self.assertRaises(SystemExit) as ctx:
                mod.FilterState()
            self.assertIn("CF_ACCESS", str(ctx.exception))

            os.environ["CF_ACCESS_CLIENT_ID"] = "id"
            os.environ["CF_ACCESS_CLIENT_SECRET"] = "secret"
            state = mod.FilterState()
            self.assertTrue(state.remote)
            self.assertEqual(state.access_id, "id")
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_loopback_upstream_ignores_access_env(self):
        import importlib.util
        import os

        spec = importlib.util.spec_from_file_location("rpc_method_filter", FILTER)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)

        saved = {
            k: os.environ.get(k)
            for k in (
                "L2_RPC_FILTER_UPSTREAM",
                "L2_RPC_FILTER_REMOTE_UPSTREAM_HOSTS",
                "CF_ACCESS_CLIENT_ID",
                "CF_ACCESS_CLIENT_SECRET",
            )
        }
        try:
            os.environ["L2_RPC_FILTER_UPSTREAM"] = "http://127.0.0.1:8546"
            os.environ.pop("L2_RPC_FILTER_REMOTE_UPSTREAM_HOSTS", None)
            os.environ["CF_ACCESS_CLIENT_ID"] = "id"
            os.environ["CF_ACCESS_CLIENT_SECRET"] = "secret"
            state = mod.FilterState()
            self.assertFalse(state.remote)
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
