#!/usr/bin/env python3
"""Black-box tests for the verifier container entrypoint."""

import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import textwrap
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[1]
PIN_RETH_VERSION = "2.3.0-dev"
PIN_RETH_COMMIT = "9384bc53d8c0c77e59cac83fdaaf3b372c6d2216"
EXPECTED_GENESIS_HASH = (
    "0xe242b1a3312b509e7df1496847f0bd0b115cb66676b1e973a355296c99e2386d"
)

GENESIS_852 = json.dumps({"config": {"chainId": 852}})
ROLLUP_852 = json.dumps(
    {
        "l2_chain_id": 852,
        "genesis": {"l2": {"hash": EXPECTED_GENESIS_HASH}},
    }
)
PIN_VERSION_TEXT = (
    f"Reth Version: {PIN_RETH_VERSION}\n"
    f"Commit SHA: {PIN_RETH_COMMIT}\n"
)


class EntrypointTests(unittest.TestCase):
    def run_entrypoint(
        self,
        extra_env=None,
        create_config=True,
        prepare=None,
        after=None,
        timeout=8,
        genesis_text=GENESIS_852,
        rollup_text=ROLLUP_852,
    ):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bin_dir = root / "bin"
            data_dir = root / "data"
            bin_dir.mkdir()
            data_dir.mkdir()
            log = root / "commands.log"
            genesis = root / "genesis.json"
            rollup = root / "rollup.json"
            if create_config:
                genesis.write_text(genesis_text)
                rollup.write_text(rollup_text)

            self.write_executable(
                bin_dir / "op-reth",
                r'''#!/usr/bin/env python3
import json
import os
import signal
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log_path = os.environ["COMMAND_LOG"]
if "--version" in sys.argv:
    sys.stdout.write(os.environ.get("RETH_VERSION_TEXT", """'''
                + PIN_VERSION_TEXT
                + r'''"""))
    sys.exit(0)

with open(log_path, "a") as log:
    log.write("op-reth " + " ".join(sys.argv[1:]) + "\n")

if sys.argv[1:2] == ["init"]:
    os.makedirs(os.path.join(os.environ["DATA_DIR"], "db"), exist_ok=True)
    sys.exit(int(os.environ.get("RETH_INIT_EXIT", "0")))

if os.environ.get("RETH_EXIT_IMMEDIATELY"):
    sys.exit(int(os.environ["RETH_EXIT_IMMEDIATELY"]))

http_ok = os.environ.get("RETH_HTTP_OK", "1") not in ("0", "false", "FALSE")
port = int(os.environ.get("L2_GETH_HTTP_PORT", "8546"))

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(n)
        if not http_ok:
            self.send_error(500)
            return
        payload = b'{"jsonrpc":"2.0","id":1,"result":"0x0"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

httpd = None
if os.environ.get("RETH_BIND_HTTP", "1") != "0":
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

exit_after = float(os.environ.get("RETH_EXIT_AFTER_SECS", "0"))
exit_code = int(os.environ.get("RETH_EXIT_CODE", "0"))

def _exit(*_):
    if httpd is not None:
        httpd.shutdown()
    sys.exit(0)

signal.signal(signal.SIGTERM, _exit)
if exit_after > 0:
    time.sleep(exit_after)
    if httpd is not None:
        httpd.shutdown()
    sys.exit(exit_code)
while True:
    time.sleep(0.01)
''',
            )
            self.write_executable(
                bin_dir / "op-node",
                r'''#!/usr/bin/env python3
import os, sys, time
with open(os.environ["COMMAND_LOG"], "a") as log:
    if os.environ.get("GOMEMLIMIT"):
        log.write("op-node-env GOMEMLIMIT=" + os.environ["GOMEMLIMIT"] + "\n")
    log.write("op-node " + " ".join(sys.argv[1:]) + "\n")
time.sleep(float(os.environ.get("NODE_DELAY", "0")))
sys.exit(int(os.environ.get("NODE_EXIT", "0")))
''',
            )
            self.write_executable(
                bin_dir / "openssl",
                r'''#!/bin/sh
printf 'openssl %s\n' "$*" >>"$COMMAND_LOG"
printf '%064d\n' 0
''',
            )
            # Stub filter so entrypoint tests do not bind a real HTTP port.
            filter_script = root / "fake_rpc_filter.py"
            filter_script.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import os, time
                    with open(os.environ["COMMAND_LOG"], "a") as log:
                        log.write(
                            "filter listen="
                            + os.environ.get("L2_RPC_FILTER_LISTEN", "")
                            + " upstream="
                            + os.environ.get("L2_RPC_FILTER_UPSTREAM", "")
                            + "\\n"
                        )
                    time.sleep(float(os.environ.get("FILTER_DELAY", "30")))
                    """
                )
            )
            filter_script.chmod(0o755)
            jwt_file = data_dir / "jwt.txt"
            ready_file = data_dir / "fortel2-el-ready"
            http_port = self._free_port()
            env = {
                **os.environ,
                "PATH": f"{bin_dir}:{os.environ['PATH']}",
                "DATA_DIR": str(data_dir),
                "GENESIS": str(genesis),
                "ROLLUP": str(rollup),
                "L1_RPC_URL": "https://example.invalid",
                "COMMAND_LOG": str(log),
                "PROCESS_POLL_INTERVAL_SECS": "1",
                "RETH_READY_TIMEOUT_SECS": "2",
                "RPC_FILTER_SCRIPT": str(filter_script),
                # Always pin JWT into the temp tree so an inherited JWT_FILE
                # from the invoking shell/CI cannot escape the fixture.
                "JWT_FILE": str(jwt_file),
                # Pin readiness marker off /tmp so tests can assert on it.
                "FORTEL2_EL_READY_FILE": str(ready_file),
                "L2_GETH_HTTP_PORT": str(http_port),
                "L2_HTTP_PORT": "8545",
            }
            # Drop inherited JWT_SECRET so each test opts in explicitly;
            # otherwise the openssl "unset" branch is never exercised.
            env.pop("JWT_SECRET", None)
            env.update(extra_env or {})
            if prepare is not None:
                prepare(data_dir, env)
            # Re-pin after extras/prepare so callers cannot redirect JWT_FILE.
            env["JWT_FILE"] = str(jwt_file)
            # Keep a free HTTP port unless the caller overrode it.
            env.setdefault("L2_GETH_HTTP_PORT", str(http_port))
            started = time.monotonic()
            result = subprocess.run(
                ["/bin/sh", str(ROOT / "entrypoint-reth.sh")],
                env=env,
                text=True,
                capture_output=True,
                timeout=timeout,
            )
            elapsed = time.monotonic() - started
            log_text = log.read_text() if log.exists() else ""
            if after is not None:
                after(result, log_text, data_dir)
            return result, log_text, data_dir, elapsed

    @staticmethod
    def write_executable(path, contents):
        path.write_text(textwrap.dedent(contents))
        path.chmod(0o755)

    @staticmethod
    def _free_port():
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        return port

    def test_requires_l1_rpc_url(self):
        result, log, _, _ = self.run_entrypoint({"L1_RPC_URL": ""})
        self.assertEqual(1, result.returncode)
        self.assertIn("L1_RPC_URL is required", result.stderr)
        self.assertEqual("", log)

    def test_public_rpc_flag_overrides_metered_url(self):
        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "L1_RPC_URL": "https://metered.example/secret-token",
                "L1_USE_PUBLIC_RPC": "1",
            },
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn(
            "op-node --l1=https://ethereum-sepolia-rpc.publicnode.com",
            log,
        )
        self.assertNotIn("secret-token", log)
        self.assertNotIn("secret-token", result.stdout)
        self.assertIn("mode=public", result.stdout)
        self.assertIn("ethereum-sepolia-rpc.publicnode.com/<redacted>", result.stdout)

    def test_public_rpc_flag_allows_empty_l1_rpc_url(self):
        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "L1_RPC_URL": "",
                "L1_USE_PUBLIC_RPC": "1",
            },
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn(
            "op-node --l1=https://ethereum-sepolia-rpc.publicnode.com",
            log,
        )

    def test_rejects_invalid_l1_use_public_rpc(self):
        result, _, _, _ = self.run_entrypoint({"L1_USE_PUBLIC_RPC": "maybe"})
        self.assertEqual(1, result.returncode)
        self.assertIn("L1_USE_PUBLIC_RPC must be 0 or 1", result.stderr)

    def test_force_public_skips_schedule(self):
        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "L1_RPC_URL": "https://metered.example/token",
                "L1_RPC_SCHEDULE": "business",
                "L1_RPC_FORCE": "public",
            },
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("mode=public", result.stdout)
        self.assertIn(
            "op-node --l1=https://ethereum-sepolia-rpc.publicnode.com",
            log,
        )
        self.assertNotIn("schedule router", result.stdout)

    def test_business_schedule_starts_router(self):
        with tempfile.TemporaryDirectory() as temp:
            router = Path(temp) / "fake_router.py"
            router.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import os, time
                    with open(os.environ["COMMAND_LOG"], "a") as log:
                        log.write("router metered=" + os.environ.get("L1_RPC_METERED_URL", "") + "\\n")
                    time.sleep(float(os.environ.get("NODE_DELAY", "30")))
                    """
                )
            )
            router.chmod(0o755)
            result, log, _, _ = self.run_entrypoint(
                {
                    "JWT_SECRET": "a" * 64,
                    "L1_RPC_URL": "https://metered.example/secret-token",
                    "L1_RPC_SCHEDULE": "business",
                    "L1_RPC_ROUTER_SCRIPT": str(router),
                    "L1_RPC_LISTEN": "127.0.0.1:18545",
                    "TZ": "America/Los_Angeles",
                    "L1_RPC_BUSINESS_START": "9",
                    "L1_RPC_BUSINESS_END": "17",
                },
            )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("mode=schedule", result.stdout)
        self.assertIn("Starting L1 RPC schedule router", result.stdout)
        self.assertIn("op-node --l1=http://127.0.0.1:18545", log)
        self.assertIn("router metered=https://metered.example/secret-token", log)
        self.assertNotIn("secret-token", result.stdout)

    def test_business_schedule_requires_metered_url(self):
        result, _, _, _ = self.run_entrypoint(
            {
                "L1_RPC_URL": "",
                "L1_RPC_SCHEDULE": "business",
                "L1_USE_PUBLIC_RPC": "0",
            },
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("L1_RPC_SCHEDULE=business requires L1_RPC_URL", result.stderr)

    def test_rejects_invalid_numeric_settings(self):
        for name, value, message in (
            ("RETH_READY_TIMEOUT_SECS", "soon", "non-negative integer"),
            ("RETH_CROSS_BLOCK_CACHE_MB", "0", "positive integer"),
            ("RETH_CROSS_BLOCK_CACHE_MB", "many", "positive integer"),
            ("RETH_RPC_CACHE_MAX_BLOCKS", "0", "positive integer"),
            ("L1_CACHE_SIZE", "0", "positive integer"),
            ("L1_CACHE_SIZE", "big", "positive integer"),
            ("L1_MAX_CONCURRENCY", "0", "positive integer"),
            ("L1_RPC_MAX_BATCH_SIZE", "nope", "positive integer"),
            ("PROCESS_POLL_INTERVAL_SECS", "0", "positive integer"),
            ("PROCESS_POLL_INTERVAL_SECS", "nope", "positive integer"),
        ):
            with self.subTest(name=name, value=repr(value)):
                result, _, _, _ = self.run_entrypoint({name: value})
                self.assertEqual(1, result.returncode)
                self.assertIn(message, result.stderr)

    def test_rejects_invalid_reth_archive(self):
        for value in ("2", "yes"):
            with self.subTest(value=value):
                result, log, _, _ = self.run_entrypoint({"RETH_ARCHIVE": value})
                self.assertEqual(1, result.returncode)
                self.assertIn("RETH_ARCHIVE", result.stderr)
                self.assertEqual("", log)

    def test_requires_both_config_files(self):
        result, _, _, _ = self.run_entrypoint(create_config=False)
        self.assertEqual(1, result.returncode)
        self.assertIn("missing", result.stderr)

    def test_refuses_901_genesis(self):
        result, log, _, _ = self.run_entrypoint(
            {"JWT_SECRET": "a" * 64},
            genesis_text=json.dumps({"config": {"chainId": 901}}),
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("not 901", result.stderr)
        self.assertNotIn("op-reth init", log)
        self.assertNotIn("op-reth node", log)

    def test_refuses_wrong_genesis_hash(self):
        result, log, _, _ = self.run_entrypoint(
            {"JWT_SECRET": "a" * 64},
            rollup_text=json.dumps(
                {
                    "l2_chain_id": 852,
                    "genesis": {"l2": {"hash": "0xdeadbeef"}},
                }
            ),
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("refusing genesis hash", result.stderr)
        self.assertNotIn("op-reth init", log)

    def test_refuses_wrong_reth_pin(self):
        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "RETH_VERSION_TEXT": "Reth Version: 2.3.3\nCommit SHA: deadbeef\n",
            },
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("op-reth pin mismatch", result.stderr)
        self.assertEqual("", log)

    def test_initializes_and_starts_both_clients_with_expected_options(self):
        def after(result, log, data_dir):
            self.assertTrue((data_dir / "fortel2-el-ready").is_file())

        result, log, data_dir, _ = self.run_entrypoint(
            {"JWT_SECRET": "a" * 64},
            after=after,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("op-reth pin ok", result.stdout)
        self.assertIn("hash-check ok", result.stdout)
        self.assertIn("op-reth init --datadir=", log)
        self.assertIn("--chain=", log)
        self.assertIn("--full", log)
        self.assertIn("--rollup.disable-tx-pool-gossip", log)
        self.assertIn("--disable-discovery", log)
        self.assertIn("--max-peers=0", log)
        self.assertIn("--engine.cross-block-cache-size=256", log)
        self.assertIn("--rpc-cache.max-blocks=256", log)
        self.assertIn("--http.addr=127.0.0.1", log)
        self.assertIn("--http.api=eth,net,web3", log)
        self.assertNotIn("--proofs-history", log)
        self.assertNotIn("geth ", log)
        self.assertIn(
            "filter listen=0.0.0.0:8545 upstream=http://127.0.0.1:",
            log,
        )
        self.assertIn("op-node --l1=https://example.invalid", log)
        self.assertIn("--rpc.addr=127.0.0.1", log)
        self.assertIn("--l1.http-poll-interval=24s", log)
        self.assertIn("--l1.rpc-rate-limit=5", log)
        self.assertIn("--l1.cache-size=128", log)
        self.assertIn("--l1.max-concurrency=2", log)
        self.assertIn("--l1.rpc-max-batch-size=5", log)
        self.assertIn("--l1.rpckind=quicknode", log)
        self.assertIn("--l2.enginekind=reth", log)
        self.assertIn("--sequencer.enabled=false", log)
        self.assertIn("--p2p.disable=true", log)
        self.assertIn("mode=metered", result.stdout)
        self.assertFalse(data_dir.exists())  # temporary workspace was cleaned up

    def test_reth_archive_omits_full_and_prints_mode(self):
        def after(_result, _log, data_dir):
            self.assertEqual([], list(data_dir.rglob("reth.toml")))

        result, log, _, _ = self.run_entrypoint(
            {"JWT_SECRET": "a" * 64, "RETH_ARCHIVE": "1"},
            after=after,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        node_lines = [ln for ln in log.splitlines() if ln.startswith("op-reth node ")]
        self.assertEqual(1, len(node_lines), log)
        self.assertNotIn("--full", node_lines[0])
        self.assertNotIn("--archive", node_lines[0])
        self.assertNotIn("--full", log)
        self.assertIn(
            "op-reth: archive mode — retains historical receipts/logs (--full omitted)",
            result.stdout,
        )

    def test_reth_archive_zero_keeps_full(self):
        result, log, _, _ = self.run_entrypoint(
            {"JWT_SECRET": "a" * 64, "RETH_ARCHIVE": "0"},
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("--full", log)
        self.assertNotIn("archive mode", result.stdout)

    def test_generates_jwt_with_openssl_when_secret_unset(self):
        def prepare(_data_dir, env):
            # Explicitly clear even if extras/inherited env seeded a secret;
            # this test must exercise the openssl generation branch.
            env.pop("JWT_SECRET", None)

        def after(result, log, data_dir):
            jwt = data_dir / "jwt.txt"
            self.assertTrue(jwt.is_file())
            self.assertEqual("0" * 64, jwt.read_text().strip())
            self.assertEqual(0o600, jwt.stat().st_mode & 0o777)

        result, log, _, _ = self.run_entrypoint(prepare=prepare, after=after)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("openssl rand -hex 32", log)

    def test_reuses_existing_jwt_file(self):
        existing = "b" * 64

        def prepare(data_dir, env):
            jwt = data_dir / "jwt.txt"
            jwt.write_text(existing)
            jwt.chmod(0o600)
            env["JWT_SECRET"] = "c" * 64  # must not overwrite an existing file

        def after(result, log, data_dir):
            self.assertEqual(existing, (data_dir / "jwt.txt").read_text())

        result, log, _, _ = self.run_entrypoint(prepare=prepare, after=after)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("openssl", log)
        self.assertIn("jwt.txt", log)

    def test_writes_jwt_secret_env_when_file_missing(self):
        secret = "d" * 64

        def after(result, log, data_dir):
            jwt = data_dir / "jwt.txt"
            self.assertEqual(secret, jwt.read_text())
            self.assertEqual(0o600, jwt.stat().st_mode & 0o777)

        result, log, _, _ = self.run_entrypoint(
            {"JWT_SECRET": secret},
            after=after,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("openssl", log)

    def test_skips_reth_init_when_datadir_exists(self):
        def prepare(data_dir, _env):
            (data_dir / "db").mkdir()

        result, log, _, _ = self.run_entrypoint(
            {"JWT_SECRET": "a" * 64},
            prepare=prepare,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("op-reth init", log)
        self.assertIn("op-reth node", log)

    def test_propagates_reth_init_failure(self):
        result, log, _, _ = self.run_entrypoint(
            {"JWT_SECRET": "a" * 64, "RETH_INIT_EXIT": "9"},
        )
        self.assertEqual(9, result.returncode)
        self.assertIn("op-reth init", log)
        self.assertNotIn("op-node", log)

    def test_honors_l1_credit_and_port_overrides(self):
        el_port = self._free_port()
        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "L1_HTTP_POLL_INTERVAL": "30s",
                "L1_RPC_RATE_LIMIT": "5",
                "L1_BLOCK_TIME": "6",
                "RETH_CROSS_BLOCK_CACHE_MB": "128",
                "RETH_RPC_CACHE_MAX_BLOCKS": "64",
                "L1_CACHE_SIZE": "64",
                "L1_MAX_CONCURRENCY": "3",
                "L1_RPC_MAX_BATCH_SIZE": "8",
                "L1_RPC_KIND": "standard",
                "PORT": "10000",
                "L2_HTTP_PORT": "9999",  # PORT must win for the public filter
                "L2_GETH_HTTP_PORT": str(el_port),
                "L2_ENGINE_PORT": "8559",
                "L2_NODE_RPC_PORT": "9549",
            },
        )
        self.assertEqual(0, result.returncode, result.stderr)
        # Published PORT → filter; EL stays on L2_GETH_HTTP_PORT.
        self.assertIn(
            f"filter listen=0.0.0.0:10000 upstream=http://127.0.0.1:{el_port}",
            log,
        )
        self.assertIn(f"--http.port={el_port}", log)
        self.assertIn("--http.addr=127.0.0.1", log)
        self.assertIn("--engine.cross-block-cache-size=128", log)
        self.assertIn("--rpc-cache.max-blocks=64", log)
        self.assertIn("--authrpc.port=8559", log)
        self.assertIn("--l1.http-poll-interval=30s", log)
        self.assertIn("--l1.rpc-rate-limit=5", log)
        self.assertIn("--l1.cache-size=64", log)
        self.assertIn("--l1.max-concurrency=3", log)
        self.assertIn("--l1.rpc-max-batch-size=8", log)
        self.assertIn("--l1.rpckind=standard", log)
        self.assertIn("--l1.beacon.slot-duration-override=6", log)
        self.assertIn("--l2=http://127.0.0.1:8559", log)
        self.assertIn("--rpc.port=9549", log)

    def test_rejects_colliding_el_and_filter_ports(self):
        result, _, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "PORT": "8546",
                "L2_GETH_HTTP_PORT": "8546",
            },
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("must differ from published", result.stderr)

    def test_fails_when_filter_script_missing(self):
        result, _, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "RPC_FILTER_SCRIPT": "/nonexistent/rpc-method-filter.py",
            },
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("missing RPC method filter", result.stderr)

    def test_honors_op_node_gomemlimit(self):
        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "OP_NODE_GOMEMLIMIT": "768MiB",
            },
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("op-node-env GOMEMLIMIT=768MiB", log)
        self.assertIn("gomemlimit=768MiB", result.stdout)
        self.assertNotIn("geth-env", log)

    def test_propagates_op_node_failure(self):
        # Mock op-reth stays up until SIGTERM. The entrypoint must exit with
        # op-node's status promptly (cleanup kills op-reth) — not block on
        # wait(RETH_PID) until the unittest subprocess timeout fires.
        result, _, _, elapsed = self.run_entrypoint({"NODE_EXIT": "42"})
        self.assertEqual(42, result.returncode)
        self.assertLess(elapsed, 6)

    def test_exits_promptly_when_op_node_stops_while_reth_still_runs(self):
        result, _, _, elapsed = self.run_entrypoint(
            {"NODE_EXIT": "0", "PROCESS_POLL_INTERVAL_SECS": "1"},
        )
        self.assertEqual(0, result.returncode)
        self.assertLess(elapsed, 6)

    def test_fails_when_reth_dies_before_http_ready(self):
        result, _, _, _ = self.run_entrypoint(
            {"RETH_EXIT_IMMEDIATELY": "7", "NODE_DELAY": "3"},
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("op-reth exited before HTTP became ready", result.stderr)
        self.assertNotIn("op-node", result.stdout + result.stderr)

    def test_fails_when_reth_dies_after_becoming_ready(self):
        # Become ready (HTTP), start op-node, then have op-reth exit
        # while op-node is still alive so supervision takes the EL-death path.
        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                # Must exceed entrypoint's `sleep 1` after filter start, or EL
                # dies during that sleep and cleanup SIGTERMs op-node before it logs.
                "RETH_EXIT_AFTER_SECS": "2.5",
                "RETH_EXIT_CODE": "7",
                "NODE_DELAY": "5",
                "PROCESS_POLL_INTERVAL_SECS": "1",
            },
            timeout=12,
        )
        self.assertEqual(1, result.returncode, result.stderr)
        self.assertIn("op-reth exited while op-node was running", result.stderr)
        self.assertIn("op-node ", log)

    def test_times_out_when_http_never_succeeds(self):
        def after(result, log, data_dir):
            self.assertFalse((data_dir / "fortel2-el-ready").exists())

        result, _, _, _ = self.run_entrypoint(
            {"RETH_HTTP_OK": "0"},
            after=after,
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("timed out waiting", result.stderr)

    def test_clears_stale_ready_marker_before_wait(self):
        def prepare(data_dir, _env):
            marker = data_dir / "fortel2-el-ready"
            marker.write_text("stale")

        def after(result, log, data_dir):
            # Timeout path must not leave (or recreate) a ready marker.
            self.assertFalse((data_dir / "fortel2-el-ready").exists())

        result, _, _, _ = self.run_entrypoint(
            {"RETH_HTTP_OK": "0"},
            prepare=prepare,
            after=after,
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("timed out waiting", result.stderr)


    def _pack_reth_snapshot(self, payload_root):
        tar_path = payload_root.parent / "snap.tar"
        members = []
        if (payload_root / "db").is_dir():
            members.append("db")
        if (payload_root / "static_files").is_dir():
            members.append("static_files")
        if (payload_root / "rocksdb").is_dir():
            members.append("rocksdb")
        extra = [
            n
            for n in (
                "jwt.txt",
                "historical-proofs",
                "logs",
                "pids",
                "exex",
                "blobstore",
            )
            if (payload_root / n).exists()
        ]
        subprocess.run(
            ["tar", "-C", str(payload_root), "-cf", str(tar_path), *members, *extra],
            check=True,
        )
        zst = payload_root.parent / "snap.tar.zst"
        subprocess.run(["zstd", "-q", "-f", str(tar_path), "-o", str(zst)], check=True)
        data = zst.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        return data, digest

    def _serve_snapshot(self, data):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        return httpd

    def test_snapshot_refuses_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "db").mkdir()
            (root / "db" / "mdbx.dat").write_text("snap-db")
            (root / "static_files").mkdir()
            (root / "static_files" / "headers.0").write_text("hdr")
            data, digest = self._pack_reth_snapshot(root)
            httpd = self._serve_snapshot(data)

            def after(result, log, data_dir):
                self.assertFalse((data_dir / "db").exists())
                self.assertFalse((data_dir / ".reth-snapshot-work").exists())

            try:
                url = "http://127.0.0.1:%s/snap.tar.zst" % httpd.server_address[1]
                result, log, _, _ = self.run_entrypoint(
                    {
                        "JWT_SECRET": "a" * 64,
                        "RETH_SNAPSHOT_URL": url,
                        "RETH_SNAPSHOT_SHA256": "0" * 64,
                    },
                    after=after,
                )
            finally:
                httpd.shutdown()
                httpd.server_close()
        self.assertEqual(1, result.returncode, result.stderr)
        self.assertIn("snapshot sha256 mismatch", result.stderr)
        self.assertIn("expected: " + "0" * 64, result.stderr)
        self.assertNotIn("op-reth init", log)
        self.assertNotIn("op-reth node", log)

    def test_snapshot_restores_when_datadir_empty(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "db").mkdir()
            (root / "db" / "mdbx.dat").write_text("from-snap")
            (root / "static_files").mkdir()
            (root / "static_files" / "headers.0").write_text("hdr")
            (root / "rocksdb").mkdir()
            (root / "rocksdb" / "000001.sst").write_text("sst")
            data, digest = self._pack_reth_snapshot(root)
            httpd = self._serve_snapshot(data)

            def after(result, log, data_dir):
                self.assertEqual("from-snap", (data_dir / "db" / "mdbx.dat").read_text())
                self.assertTrue((data_dir / "static_files" / "headers.0").is_file())
                self.assertEqual("sst", (data_dir / "rocksdb" / "000001.sst").read_text())
                self.assertTrue((data_dir / "jwt.txt").is_file())
                self.assertFalse((data_dir / "jwt.txt").read_text() == "")

            try:
                url = "http://127.0.0.1:%s/snap.tar.zst" % httpd.server_address[1]
                result, log, data_dir, _ = self.run_entrypoint(
                    {
                        "JWT_SECRET": "a" * 64,
                        "RETH_SNAPSHOT_URL": url,
                        "RETH_SNAPSHOT_SHA256": digest,
                    },
                    after=after,
                )
            finally:
                httpd.shutdown()
                httpd.server_close()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("snapshot: sha256 ok", result.stdout)
        self.assertIn("snapshot: restore ok", result.stdout)
        self.assertIn("archive listing ok (db/ + static_files/ + rocksdb/", result.stdout)
        self.assertIn("op-reth pin ok", result.stdout)
        self.assertIn("hash-check ok", result.stdout)
        self.assertNotIn("op-reth init", log)
        self.assertIn("op-reth node", log)
        self.assertIn("--full", log)

    def test_snapshot_skips_when_db_present(self):
        def prepare(data_dir, _env):
            db = data_dir / "db"
            db.mkdir()
            (db / "mdbx.dat").write_text("keep-me")

        def after(result, log, data_dir):
            self.assertEqual("keep-me", (data_dir / "db" / "mdbx.dat").read_text())

        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                # Would fail if the entrypoint tried to download: nothing listens.
                "RETH_SNAPSHOT_URL": "http://127.0.0.1:1/missing.tar.zst",
                "RETH_SNAPSHOT_SHA256": "a" * 64,
            },
            prepare=prepare,
            after=after,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("skipping restore", result.stdout)
        self.assertNotIn("op-reth init", log)
        self.assertIn("op-reth node", log)

    def test_snapshot_force_replaces_existing_db(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "db").mkdir()
            (root / "db" / "mdbx.dat").write_text("new-snap")
            (root / "rocksdb").mkdir()
            (root / "rocksdb" / "000001.sst").write_text("sst")
            data, digest = self._pack_reth_snapshot(root)
            httpd = self._serve_snapshot(data)

            def prepare(data_dir, _env):
                db = data_dir / "db"
                db.mkdir()
                (db / "mdbx.dat").write_text("old-db")
                (data_dir / "static_files").mkdir()
                (data_dir / "static_files" / "old").write_text("old")
                (data_dir / "rocksdb").mkdir()
                (data_dir / "rocksdb" / "old.sst").write_text("stale")

            def after(result, log, data_dir):
                self.assertEqual("new-snap", (data_dir / "db" / "mdbx.dat").read_text())
                self.assertFalse((data_dir / "static_files" / "old").exists())
                self.assertFalse((data_dir / "rocksdb" / "old.sst").exists())
                self.assertEqual("sst", (data_dir / "rocksdb" / "000001.sst").read_text())
                self.assertEqual("a" * 64, (data_dir / "jwt.txt").read_text())

            try:
                url = "http://127.0.0.1:%s/snap.tar.zst" % httpd.server_address[1]
                result, log, _, _ = self.run_entrypoint(
                    {
                        "JWT_SECRET": "a" * 64,
                        "RETH_SNAPSHOT_URL": url,
                        "RETH_SNAPSHOT_SHA256": digest,
                        "RETH_SNAPSHOT_FORCE": "1",
                    },
                    prepare=prepare,
                    after=after,
                )
            finally:
                httpd.shutdown()
                httpd.server_close()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("FORCE staged replace of existing db", result.stdout)
        self.assertIn("FORCE replacing existing db/ after validated extract", result.stdout)
        self.assertIn("Unset FORCE after this boot", result.stderr)
        self.assertIn("snapshot: restore ok", result.stdout)
        self.assertNotIn("op-reth init", log)

    def test_snapshot_force_mismatch_keeps_existing_db(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "db").mkdir()
            (root / "db" / "mdbx.dat").write_text("new-snap")
            data, digest = self._pack_reth_snapshot(root)
            httpd = self._serve_snapshot(data)

            def prepare(data_dir, _env):
                db = data_dir / "db"
                db.mkdir()
                (db / "mdbx.dat").write_text("old-db")
                (data_dir / "static_files").mkdir()
                (data_dir / "static_files" / "old").write_text("old")
                (data_dir / "rocksdb").mkdir()
                (data_dir / "rocksdb" / "old.sst").write_text("stale")

            def after(result, log, data_dir):
                self.assertEqual("old-db", (data_dir / "db" / "mdbx.dat").read_text())
                self.assertEqual("old", (data_dir / "static_files" / "old").read_text())
                self.assertEqual("stale", (data_dir / "rocksdb" / "old.sst").read_text())
                self.assertFalse((data_dir / ".reth-snapshot-work").exists())

            try:
                url = "http://127.0.0.1:%s/snap.tar.zst" % httpd.server_address[1]
                result, log, _, _ = self.run_entrypoint(
                    {
                        "JWT_SECRET": "a" * 64,
                        "RETH_SNAPSHOT_URL": url,
                        "RETH_SNAPSHOT_SHA256": "0" * 64,
                        "RETH_SNAPSHOT_FORCE": "1",
                    },
                    prepare=prepare,
                    after=after,
                )
            finally:
                httpd.shutdown()
                httpd.server_close()
        self.assertEqual(1, result.returncode, result.stderr)
        self.assertIn("snapshot sha256 mismatch", result.stderr)
        self.assertNotIn("FORCE replacing existing db/ after validated extract", result.stdout)
        self.assertNotIn("op-reth init", log)
        self.assertNotIn("op-reth node", log)

    def test_snapshot_force_failed_download_keeps_existing_db(self):
        def prepare(data_dir, _env):
            db = data_dir / "db"
            db.mkdir()
            (db / "mdbx.dat").write_text("keep-me")

        def after(result, log, data_dir):
            self.assertEqual("keep-me", (data_dir / "db" / "mdbx.dat").read_text())

        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "RETH_SNAPSHOT_URL": "http://127.0.0.1:1/missing.tar.zst",
                "RETH_SNAPSHOT_SHA256": "a" * 64,
                "RETH_SNAPSHOT_FORCE": "1",
            },
            prepare=prepare,
            after=after,
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("snapshot download failed", result.stderr)
        self.assertNotIn("op-reth node", log)

    def test_snapshot_refuses_exex_in_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "db").mkdir()
            (root / "db" / "mdbx.dat").write_text("x")
            (root / "rocksdb").mkdir()
            (root / "rocksdb" / "000001.sst").write_text("sst")
            (root / "exex").mkdir()
            (root / "exex" / "wal").write_text("no")
            data, digest = self._pack_reth_snapshot(root)
            httpd = self._serve_snapshot(data)
            try:
                url = "http://127.0.0.1:%s/snap.tar.zst" % httpd.server_address[1]
                result, log, _, _ = self.run_entrypoint(
                    {
                        "JWT_SECRET": "a" * 64,
                        "RETH_SNAPSHOT_URL": url,
                        "RETH_SNAPSHOT_SHA256": digest,
                    },
                )
            finally:
                httpd.shutdown()
                httpd.server_close()
        self.assertEqual(1, result.returncode, result.stderr)
        self.assertIn("paths outside db/, static_files/, and rocksdb/", result.stderr)
        self.assertIn("exex", result.stderr)
        self.assertNotIn("op-reth node", log)

    def test_snapshot_refuses_jwt_in_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "db").mkdir()
            (root / "db" / "mdbx.dat").write_text("x")
            (root / "jwt.txt").write_text("e" * 64)
            data, digest = self._pack_reth_snapshot(root)
            httpd = self._serve_snapshot(data)
            try:
                url = "http://127.0.0.1:%s/snap.tar.zst" % httpd.server_address[1]
                result, log, _, _ = self.run_entrypoint(
                    {
                        "JWT_SECRET": "a" * 64,
                        "RETH_SNAPSHOT_URL": url,
                        "RETH_SNAPSHOT_SHA256": digest,
                    },
                )
            finally:
                httpd.shutdown()
                httpd.server_close()
        self.assertEqual(1, result.returncode, result.stderr)
        self.assertIn("jwt.txt", result.stderr)
        self.assertNotIn("op-reth node", log)

    def test_snapshot_url_requires_sha256(self):
        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "RETH_SNAPSHOT_URL": "http://127.0.0.1:1/snap.tar.zst",
            },
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("RETH_SNAPSHOT_SHA256 is empty", result.stderr)
        self.assertEqual("", log)

    def test_snapshot_force_requires_url(self):
        result, _, _, _ = self.run_entrypoint(
            {"JWT_SECRET": "a" * 64, "RETH_SNAPSHOT_FORCE": "1"},
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("RETH_SNAPSHOT_FORCE=1 requires RETH_SNAPSHOT_URL", result.stderr)

    def test_live_geth_entrypoint_never_restores_snapshot(self):
        geth = (ROOT / "entrypoint.sh").read_text(encoding="utf-8")
        docker = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertNotIn("RETH_SNAPSHOT", geth)
        self.assertNotIn("restore_reth_snapshot", geth)
        self.assertNotIn("op-reth", geth)
        self.assertIn("op-geth", docker)
        self.assertNotIn("RETH_SNAPSHOT", docker)


class HealthcheckTests(unittest.TestCase):
    def run_healthcheck(self, env):
        return subprocess.run(
            ["/bin/sh", str(ROOT / "healthcheck-reth.sh")],
            env={**os.environ, **env},
            text=True,
            capture_output=True,
            timeout=5,
        )

    def test_fails_while_entrypoint_still_starting(self):
        # Missing marker must fail (exit 1). Exit 0 would mark the container
        # healthy immediately; during --start-period only failures keep
        # health=starting.
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            ready = data_dir / "missing-ready"
            result = self.run_healthcheck(
                {
                    "DATA_DIR": str(data_dir),
                    "FORTEL2_EL_READY_FILE": str(ready),
                },
            )
            self.assertEqual(1, result.returncode)

    def test_requires_http_after_ready_marker(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            ready = Path(temp) / "ready"
            ready.write_text("")
            # Nothing listening → unhealthy once marked ready.
            result = self.run_healthcheck(
                {
                    "DATA_DIR": str(data_dir),
                    "FORTEL2_EL_READY_FILE": str(ready),
                    "L2_GETH_HTTP_PORT": "1",
                },
            )
            self.assertEqual(1, result.returncode)

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    return

                def do_POST(self):
                    n = int(self.headers.get("Content-Length", "0"))
                    self.rfile.read(n)
                    payload = b'{"jsonrpc":"2.0","id":1,"result":"0x1"}'
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)

            httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                result = self.run_healthcheck(
                    {
                        "DATA_DIR": str(data_dir),
                        "FORTEL2_EL_READY_FILE": str(ready),
                        "L2_GETH_HTTP_PORT": str(httpd.server_address[1]),
                    },
                )
                self.assertEqual(0, result.returncode, result.stderr)
            finally:
                httpd.shutdown()
                httpd.server_close()


if __name__ == "__main__":
    unittest.main()
