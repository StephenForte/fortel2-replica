#!/usr/bin/env python3
"""Black-box tests for the verifier container entrypoint."""

import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]


class EntrypointTests(unittest.TestCase):
    def run_entrypoint(
        self,
        extra_env=None,
        create_config=True,
        prepare=None,
        after=None,
        timeout=8,
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
                genesis.write_text("{}")
                rollup.write_text("{}")

            self.write_executable(
                bin_dir / "geth",
                r'''#!/usr/bin/env python3
import os, signal, socket, sys, time
with open(os.environ["COMMAND_LOG"], "a") as log:
    log.write("geth " + " ".join(sys.argv[1:]) + "\n")
if sys.argv[1:2] == ["init"]:
    os.makedirs(os.path.join(os.environ["DATA_DIR"], "geth"), exist_ok=True)
    sys.exit(int(os.environ.get("GETH_INIT_EXIT", "0")))
if sys.argv[1:2] == ["attach"]:
    open(os.path.join(os.environ["DATA_DIR"], "attached"), "a").close()
    sys.exit(int(os.environ.get("GETH_ATTACH_EXIT", "0")))
if os.environ.get("GETH_EXIT_IMMEDIATELY"):
    sys.exit(int(os.environ["GETH_EXIT_IMMEDIATELY"]))
sock = socket.socket(socket.AF_UNIX)
path = os.path.join(os.environ["DATA_DIR"], "geth.ipc")
try:
    os.unlink(path)
except FileNotFoundError:
    pass
sock.bind(path)
exit_after = float(os.environ.get("GETH_EXIT_AFTER_SECS", "0"))
exit_code = int(os.environ.get("GETH_EXIT_CODE", "0"))
attached = os.path.join(os.environ["DATA_DIR"], "attached")

def _exit(*_):
    sys.exit(0)

signal.signal(signal.SIGTERM, _exit)
if exit_after > 0:
    # Only start the exit countdown after engine-API attach succeeds,
    # so this exercises the post-ready supervision path.
    for _ in range(500):
        if os.path.exists(attached):
            break
        time.sleep(0.01)
    time.sleep(exit_after)
    sys.exit(exit_code)
while True:
    time.sleep(.01)
''',
            )
            self.write_executable(
                bin_dir / "op-node",
                r'''#!/usr/bin/env python3
import os, sys, time
with open(os.environ["COMMAND_LOG"], "a") as log:
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
            jwt_file = data_dir / "jwt.txt"
            env = {
                **os.environ,
                "PATH": f"{bin_dir}:{os.environ['PATH']}",
                "DATA_DIR": str(data_dir),
                "GENESIS": str(genesis),
                "ROLLUP": str(rollup),
                "L1_RPC_URL": "https://example.invalid",
                "COMMAND_LOG": str(log),
                "PROCESS_POLL_INTERVAL_SECS": "1",
                "GETH_READY_TIMEOUT_SECS": "2",
                # Always pin JWT into the temp tree so an inherited JWT_FILE
                # from the invoking shell/CI cannot escape the fixture.
                "JWT_FILE": str(jwt_file),
            }
            # Drop inherited JWT_SECRET so each test opts in explicitly;
            # otherwise the openssl "unset" branch is never exercised.
            env.pop("JWT_SECRET", None)
            env.update(extra_env or {})
            if prepare is not None:
                prepare(data_dir, env)
            # Re-pin after extras/prepare so callers cannot redirect JWT_FILE.
            env["JWT_FILE"] = str(jwt_file)
            started = time.monotonic()
            result = subprocess.run(
                ["/bin/sh", str(ROOT / "entrypoint.sh")],
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

    def test_requires_l1_rpc_url(self):
        result, log, _, _ = self.run_entrypoint({"L1_RPC_URL": ""})
        self.assertEqual(1, result.returncode)
        self.assertIn("L1_RPC_URL is required", result.stderr)
        self.assertEqual("", log)

    def test_rejects_invalid_numeric_settings(self):
        for name, value, message in (
            ("GETH_READY_TIMEOUT_SECS", "soon", "non-negative integer"),
            ("GETH_CACHE_MB", "many", "non-negative integer"),
            ("PROCESS_POLL_INTERVAL_SECS", "0", "positive integer"),
            ("PROCESS_POLL_INTERVAL_SECS", "nope", "positive integer"),
        ):
            with self.subTest(name=name, value=repr(value)):
                result, _, _, _ = self.run_entrypoint({name: value})
                self.assertEqual(1, result.returncode)
                self.assertIn(message, result.stderr)

    def test_requires_both_config_files(self):
        result, _, _, _ = self.run_entrypoint(create_config=False)
        self.assertEqual(1, result.returncode)
        self.assertIn("missing", result.stderr)

    def test_initializes_and_starts_both_clients_with_expected_options(self):
        result, log, data_dir, _ = self.run_entrypoint({"JWT_SECRET": "a" * 64})
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("geth init --datadir=", log)
        self.assertIn("--cache=256", log)
        self.assertIn("op-node --l1=https://example.invalid", log)
        self.assertIn("--l1.http-poll-interval=12s", log)
        self.assertIn("--l1.rpc-rate-limit=20", log)
        self.assertIn("--sequencer.enabled=false", log)
        self.assertFalse(data_dir.exists())  # temporary workspace was cleaned up

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

    def test_skips_geth_init_when_datadir_exists(self):
        def prepare(data_dir, _env):
            (data_dir / "geth").mkdir()

        result, log, _, _ = self.run_entrypoint(
            {"JWT_SECRET": "a" * 64},
            prepare=prepare,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("geth init", log)
        self.assertIn("geth --datadir=", log)

    def test_propagates_geth_init_failure(self):
        result, log, _, _ = self.run_entrypoint(
            {"JWT_SECRET": "a" * 64, "GETH_INIT_EXIT": "9"},
        )
        self.assertEqual(9, result.returncode)
        self.assertIn("geth init", log)
        self.assertNotIn("op-node", log)

    def test_honors_l1_credit_and_port_overrides(self):
        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "L1_HTTP_POLL_INTERVAL": "30s",
                "L1_RPC_RATE_LIMIT": "5",
                "L1_BLOCK_TIME": "6",
                "GETH_CACHE_MB": "128",
                "PORT": "8545",
                "L2_HTTP_PORT": "9999",  # PORT must win
                "L2_AUTH_PORT": "8559",
                "L2_NODE_RPC_PORT": "9549",
            },
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("--http.port=8545", log)
        self.assertIn("--cache=128", log)
        self.assertIn("--authrpc.port=8559", log)
        self.assertIn("--l1.http-poll-interval=30s", log)
        self.assertIn("--l1.rpc-rate-limit=5", log)
        self.assertIn("--l1.beacon.slot-duration-override=6", log)
        self.assertIn("--l2=http://127.0.0.1:8559", log)
        self.assertIn("--rpc.port=9549", log)

    def test_propagates_op_node_failure(self):
        # Mock geth stays up until SIGTERM. The entrypoint must exit with
        # op-node's status promptly (cleanup kills geth) — not block on
        # wait(GETH_PID) until the unittest subprocess timeout fires.
        result, _, _, elapsed = self.run_entrypoint({"NODE_EXIT": "42"})
        self.assertEqual(42, result.returncode)
        self.assertLess(elapsed, 6)

    def test_exits_promptly_when_op_node_stops_while_geth_still_runs(self):
        result, _, _, elapsed = self.run_entrypoint(
            {"NODE_EXIT": "0", "PROCESS_POLL_INTERVAL_SECS": "1"},
        )
        self.assertEqual(0, result.returncode)
        self.assertLess(elapsed, 6)

    def test_fails_when_geth_dies_before_engine_api_ready(self):
        result, _, _, _ = self.run_entrypoint(
            {"GETH_EXIT_IMMEDIATELY": "7", "NODE_DELAY": "3"},
        )
        self.assertEqual(1, result.returncode)
        self.assertIn("op-geth exited before engine API became ready", result.stderr)
        self.assertNotIn("op-node", result.stdout + result.stderr)

    def test_fails_when_geth_dies_after_becoming_ready(self):
        # Become ready (IPC + attach), start op-node, then have geth exit
        # while op-node is still alive so supervision takes the geth-death path.
        result, log, _, _ = self.run_entrypoint(
            {
                "JWT_SECRET": "a" * 64,
                "GETH_EXIT_AFTER_SECS": "0.5",
                "GETH_EXIT_CODE": "7",
                "NODE_DELAY": "5",
                "PROCESS_POLL_INTERVAL_SECS": "1",
            },
            timeout=12,
        )
        self.assertEqual(1, result.returncode, result.stderr)
        self.assertIn("op-geth exited while op-node was running", result.stderr)
        self.assertIn("op-node ", log)

    def test_times_out_when_ipc_attach_never_succeeds(self):
        result, _, _, _ = self.run_entrypoint({"GETH_ATTACH_EXIT": "1"})
        self.assertEqual(1, result.returncode)
        self.assertIn("timed out waiting", result.stderr)


if __name__ == "__main__":
    unittest.main()
