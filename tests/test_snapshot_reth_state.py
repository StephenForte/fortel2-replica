#!/usr/bin/env python3
"""Tests for scripts/snapshot-reth-state.sh (stopped-EL capture)."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "snapshot-reth-state.sh"
PIN_COMMIT = "9384bc53d8c0c77e59cac83fdaaf3b372c6d2216"


class SnapshotRethStateTests(unittest.TestCase):
    def run_script(self, env, args=None, timeout=15):
        merged = {**os.environ, **env}
        return subprocess.run(
            ["bash", str(SCRIPT), *(args or [])],
            env=merged,
            text=True,
            capture_output=True,
            timeout=timeout,
        )

    def labels(self, path, number=806000, head_hash=None, safe="0x" + "ab" * 32, finalized="0x" + "cd" * 32):
        if head_hash is None:
            head_hash = "0x" + "11" * 32
        path.write_text(
            json.dumps(
                {
                    "l2_head": {"number": number, "hash": head_hash},
                    "safe": {"hash": safe},
                    "finalized": {"hash": finalized},
                }
            )
        )
        return path

    def populate_datadir(self, data_dir, with_secrets=True):
        src = data_dir / "l2" / "op-reth"
        (src / "db").mkdir(parents=True)
        (src / "db" / "mdbx.dat").write_text("state")
        (src / "static_files").mkdir()
        (src / "static_files" / "headers.0").write_text("hdr")
        if with_secrets:
            (src / "jwt.txt").write_text("f" * 64)
            (src / "historical-proofs").mkdir()
            (src / "historical-proofs" / "proof.bin").write_text("do-not-pack")
            (src / "logs").mkdir()
            (src / "logs" / "op-reth.log").write_text("log")
            (data_dir / "pids").mkdir()
            (data_dir / "jwt").mkdir()
            (data_dir / "jwt" / "other.txt").write_text("outside")
        return src

    def test_refuses_without_data_dir(self):
        env = {**os.environ, "L2_CHAIN_ID": "852"}
        env.pop("DATA_DIR", None)
        result = subprocess.run(
            ["bash", str(SCRIPT), "--labels-json", "/dev/null"],
            env=env,
            text=True,
            capture_output=True,
            timeout=8,
        )
        self.assertEqual(2, result.returncode)
        self.assertIn("DATA_DIR must be set", result.stderr)

    def test_refuses_901(self):
        with tempfile.TemporaryDirectory() as temp:
            labels = self.labels(Path(temp) / "labels.json")
            result = self.run_script(
                {"DATA_DIR": temp, "L2_CHAIN_ID": "901"},
                ["--labels-json", str(labels)],
            )
        self.assertEqual(2, result.returncode)
        self.assertIn("L2_CHAIN_ID must be 852", result.stderr)

    def test_refuses_sepolia_env_file(self):
        with tempfile.TemporaryDirectory() as temp:
            labels = self.labels(Path(temp) / "labels.json")
            result = self.run_script(
                {
                    "DATA_DIR": temp,
                    "L2_CHAIN_ID": "852",
                    "FORTEL2_ENV": ".env.sepolia",
                },
                ["--labels-json", str(labels)],
            )
        self.assertEqual(2, result.returncode)
        self.assertIn("do not load Sepolia role keys", result.stderr)

    def test_refuses_spike_datadir(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            spike = data_dir / "l2" / "spike-op-reth"
            (spike / "db").mkdir(parents=True)
            labels = self.labels(data_dir / "labels.json")
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                ["--labels-json", str(labels), "--datadir", str(spike)],
            )
        self.assertEqual(2, result.returncode)
        self.assertIn("capture is", result.stderr)
        self.assertIn("op-reth", result.stderr)

    def test_refuses_when_pid_alive(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            self.populate_datadir(data_dir)
            proc = subprocess.Popen(["sleep", "30"])
            try:
                pid_dir = data_dir / "pids"
                pid_dir.mkdir(exist_ok=True)
                (pid_dir / "op-reth.pid").write_text(str(proc.pid))
                labels = self.labels(data_dir / "labels.json")
                result = self.run_script(
                    {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                    ["--labels-json", str(labels)],
                )
            finally:
                proc.terminate()
                proc.wait(timeout=5)
        self.assertEqual(1, result.returncode)
        self.assertIn("op-reth is running", result.stderr)
        self.assertIn(str(proc.pid), result.stderr)

    def test_stale_pidfile_does_not_block(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            self.populate_datadir(data_dir)
            pid_dir = data_dir / "pids"
            pid_dir.mkdir(exist_ok=True)
            (pid_dir / "op-reth.pid").write_text("99999999")
            labels = self.labels(data_dir / "labels.json", number=123)
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                ["--labels-json", str(labels)],
            )
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)
            archive = data_dir / "snapshots" / "fortel2-852-reth-snapshot-123.tar.zst"
            self.assertTrue(archive.is_file())

    def test_packs_db_and_static_files_excludes_secrets(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            src = self.populate_datadir(data_dir)
            labels = self.labels(data_dir / "labels.json", number=806123)
            started = time.monotonic()
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                ["--labels-json", str(labels)],
            )
            elapsed = time.monotonic() - started
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)
            self.assertLess(elapsed, 10)
            archive = data_dir / "snapshots" / "fortel2-852-reth-snapshot-806123.tar.zst"
            manifest = data_dir / "snapshots" / "fortel2-852-reth-snapshot-806123.sha256"
            meta_path = data_dir / "snapshots" / "fortel2-852-reth-snapshot-806123.json"
            self.assertTrue(archive.is_file())
            listing = subprocess.check_output(
                ["tar", "--zstd", "-tf", str(archive)],
                text=True,
            )
            self.assertIn("db/mdbx.dat", listing)
            self.assertIn("static_files/headers.0", listing)
            self.assertNotIn("jwt.txt", listing)
            self.assertNotIn("historical-proofs", listing)
            self.assertNotIn("logs/", listing)
            self.assertNotIn("pids/", listing)
            self.assertIn("listing asserted clean", result.stdout)
            self.assertIn("l2_head 806123", result.stdout)
            self.assertRegex(result.stdout, r"bytes [0-9]+")
            man = manifest.read_text().strip().split()
            self.assertEqual(64, len(man[0]))
            self.assertEqual("fortel2-852-reth-snapshot-806123.tar.zst", man[1])
            meta = json.loads(meta_path.read_text())
            self.assertEqual(852, meta["chain_id"])
            self.assertEqual(806123, meta["l2_head"]["number"])
            self.assertEqual(PIN_COMMIT, meta["reth_pin_commit"])
            self.assertIn("Task 3", meta["independence"])
            # Live datadir untouched besides the snapshots/ sibling.
            self.assertEqual("f" * 64, (src / "jwt.txt").read_text())
            self.assertTrue((src / "historical-proofs" / "proof.bin").is_file())
            self.assertFalse((data_dir / "l2" / "op-reth" / "snapshots").exists())

    def test_requires_labels_json(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            self.populate_datadir(data_dir)
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
            )
        self.assertEqual(2, result.returncode)
        self.assertIn("--labels-json is required", result.stderr)


if __name__ == "__main__":
    unittest.main()
