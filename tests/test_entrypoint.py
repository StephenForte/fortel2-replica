#!/usr/bin/env python3
"""Black-box tests for the verifier container entrypoint."""

import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]


class EntrypointTests(unittest.TestCase):
    def run_entrypoint(self, extra_env=None, create_config=True):
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
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
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
                "#!/bin/sh\nprintf '%064d\\n' 0\n",
            )
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
            }
            env.update(extra_env or {})
            result = subprocess.run(
                ["/bin/sh", str(ROOT / "entrypoint.sh")],
                env=env,
                text=True,
                capture_output=True,
                timeout=8,
            )
            return result, log.read_text() if log.exists() else "", data_dir

    @staticmethod
    def write_executable(path, contents):
        path.write_text(textwrap.dedent(contents))
        path.chmod(0o755)

    def test_requires_l1_rpc_url(self):
        result, log, _ = self.run_entrypoint({"L1_RPC_URL": ""})
        self.assertEqual(1, result.returncode)
        self.assertIn("L1_RPC_URL is required", result.stderr)
        self.assertEqual("", log)

    def test_rejects_invalid_numeric_settings(self):
        for name, value, message in (
            ("GETH_READY_TIMEOUT_SECS", "soon", "non-negative integer"),
            ("GETH_CACHE_MB", "many", "non-negative integer"),
            ("PROCESS_POLL_INTERVAL_SECS", "0", "positive integer"),
        ):
            with self.subTest(name=name):
                result, _, _ = self.run_entrypoint({name: value})
                self.assertEqual(1, result.returncode)
                self.assertIn(message, result.stderr)

    def test_requires_both_config_files(self):
        result, _, _ = self.run_entrypoint(create_config=False)
        self.assertEqual(1, result.returncode)
        self.assertIn("missing", result.stderr)

    def test_initializes_and_starts_both_clients_with_expected_options(self):
        result, log, data_dir = self.run_entrypoint({"JWT_SECRET": "a" * 64})
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("geth init --datadir=", log)
        self.assertIn("--cache=256", log)
        self.assertIn("op-node --l1=https://example.invalid", log)
        self.assertIn("--l1.http-poll-interval=12s", log)
        self.assertIn("--l1.rpc-rate-limit=20", log)
        self.assertIn("--sequencer.enabled=false", log)
        self.assertFalse(data_dir.exists())  # temporary workspace was cleaned up

    def test_propagates_op_node_failure(self):
        # Mock geth stays up until SIGTERM. The entrypoint must exit with
        # op-node's status promptly (cleanup kills geth) — not block on
        # wait(GETH_PID) until the unittest subprocess timeout fires.
        result, _, _ = self.run_entrypoint({"NODE_EXIT": "42"})
        self.assertEqual(42, result.returncode)

    def test_exits_promptly_when_op_node_stops_while_geth_still_runs(self):
        result, _, _ = self.run_entrypoint(
            {"NODE_EXIT": "0", "PROCESS_POLL_INTERVAL_SECS": "1"},
        )
        self.assertEqual(0, result.returncode)

    def test_fails_when_geth_dies_after_becoming_ready(self):
        result, _, _ = self.run_entrypoint(
            {"GETH_EXIT_IMMEDIATELY": "7", "NODE_DELAY": "3"}
        )
        self.assertEqual(1, result.returncode)
        self.assertRegex(result.stderr, r"op-geth exited (before engine API|while op-node)")

    def test_times_out_when_ipc_attach_never_succeeds(self):
        result, _, _ = self.run_entrypoint({"GETH_ATTACH_EXIT": "1"})
        self.assertEqual(1, result.returncode)
        self.assertIn("timed out waiting", result.stderr)


if __name__ == "__main__":
    unittest.main()
