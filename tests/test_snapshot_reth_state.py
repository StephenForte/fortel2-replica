#!/usr/bin/env python3
"""Tests for scripts/snapshot-reth-state.sh (stopped-EL capture)."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "snapshot-reth-state.sh"
PIN_CHECK = ROOT / "scripts" / "op-reth-pin-check.py"

# Measured v2.3.3 --version lines (R-0022). These are the stub's output, not
# a second copy of the expected pin. The expected lines are PIN.VERSION_LINE
# and PIN.COMMIT_LINE from scripts/op-reth-pin-check.py.
V233_VERSION_TEXT = (
    "Reth Version: 2.3.0-dev\n"
    "Commit SHA: 9384bc53d8c0c77e59cac83fdaaf3b372c6d2216\n"
)


def _load_pin_module():
    spec = importlib.util.spec_from_file_location("op_reth_pin_check", PIN_CHECK)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {PIN_CHECK}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not isinstance(module.VERSION_LINE, str) or module.VERSION_LINE == "":
        raise RuntimeError("VERSION_LINE empty")
    if not isinstance(module.COMMIT_LINE, str) or module.COMMIT_LINE == "":
        raise RuntimeError("COMMIT_LINE empty")
    return module


PIN = _load_pin_module()


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
        (src / "rocksdb").mkdir()
        (src / "rocksdb" / "000001.sst").write_text("sst")
        (src / "exex").mkdir()
        (src / "exex" / "wal").write_text("exex")
        (src / "blobstore").mkdir()
        (src / "blobstore" / "blob").write_text("blob")
        (src / "reth.toml").write_text("datadir")
        (src / "discovery-secret").write_text("secret")
        (src / "known-peers.json").write_text("[]")
        (src / "invalid_block_hooks").mkdir()
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

    def write_stub(self, directory, text):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "op-reth"
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import sys\n"
            f"sys.stdout.write({text!r})\n",
            encoding="utf-8",
        )
        path.chmod(0o755)
        return path

    def matching_text(self):
        return f"{PIN.VERSION_LINE}\n{PIN.COMMIT_LINE}\n"

    def assert_no_archive(self, data_dir):
        archives = list(Path(data_dir).rglob("*.tar.zst"))
        self.assertEqual([], archives)

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
                stub = self.write_stub(data_dir / "bin", self.matching_text())
                result = self.run_script(
                    {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                    ["--labels-json", str(labels), "--op-reth-bin", str(stub)],
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
            stub = self.write_stub(data_dir / "bin", self.matching_text())
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                ["--labels-json", str(labels), "--op-reth-bin", str(stub)],
            )
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)
            archive = data_dir / "snapshots" / "fortel2-852-reth-snapshot-123.tar.zst"
            self.assertTrue(archive.is_file())

    def test_packs_db_and_static_files_excludes_secrets(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            src = self.populate_datadir(data_dir)
            labels = self.labels(data_dir / "labels.json", number=806123)
            stub = self.write_stub(data_dir / "bin", self.matching_text())
            started = time.monotonic()
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                ["--labels-json", str(labels), "--op-reth-bin", str(stub)],
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
            self.assertIn("rocksdb/000001.sst", listing)
            self.assertNotIn("jwt.txt", listing)
            self.assertNotIn("historical-proofs", listing)
            self.assertNotIn("logs/", listing)
            self.assertNotIn("pids/", listing)
            self.assertNotIn("exex/", listing)
            self.assertNotIn("blobstore/", listing)
            self.assertNotIn("reth.toml", listing)
            self.assertNotIn("discovery-secret", listing)
            self.assertNotIn("known-peers.json", listing)
            self.assertNotIn("invalid_block_hooks", listing)
            self.assertIn("listing asserted clean", result.stdout)
            self.assertIn("l2_head 806123", result.stdout)
            self.assertRegex(result.stdout, r"bytes [0-9]+")
            man = manifest.read_text().strip().split()
            self.assertEqual(64, len(man[0]))
            self.assertEqual("fortel2-852-reth-snapshot-806123.tar.zst", man[1])
            meta = json.loads(meta_path.read_text())
            self.assertEqual(852, meta["chain_id"])
            self.assertEqual(806123, meta["l2_head"]["number"])
            self.assertEqual(PIN.VERSION_LINE, meta["reth_expected_version_line"])
            self.assertEqual(PIN.COMMIT_LINE, meta["reth_expected_commit_line"])
            self.assertIs(True, meta["reth_pin_match"])
            self.assertEqual(self.matching_text(), meta["reth_version_text"])
            self.assertEqual(str(stub), meta["op_reth_bin"])
            self.assertNotIn("reth_pin_version", meta)
            self.assertNotIn("reth_pin_commit", meta)
            self.assertEqual(["db/", "static_files/", "rocksdb/"], meta["includes"])
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

    def test_mktemp_template_is_bsd_safe(self):
        text = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('mktemp "${TMPDIR:-/tmp}/fortel2-reth-snap.XXXXXX"', text)
        self.assertNotIn("XXXXXX.tar", text)

    def test_tar_disables_macos_copyfile(self):
        text = SCRIPT.read_text(encoding="utf-8")
        self.assertIn("COPYFILE_DISABLE=1", text)
        self.assertIn("--no-xattrs", text)
        self.assertIn("pack_tar", text)

    def test_appledouble_sibling_is_not_packed(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            src = self.populate_datadir(data_dir)
            (src / "._db").write_text("appledouble")
            labels = self.labels(data_dir / "labels.json", number=9)
            stub = self.write_stub(data_dir / "bin", self.matching_text())
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                ["--labels-json", str(labels), "--op-reth-bin", str(stub)],
            )
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)
            archive = data_dir / "snapshots" / "fortel2-852-reth-snapshot-9.tar.zst"
            listing = subprocess.check_output(
                ["tar", "--zstd", "-tf", str(archive)],
                text=True,
            )
            self.assertNotIn("._db", listing)
            self.assertIn("db/mdbx.dat", listing)

    def test_matching_stub_records_verbatim_pin(self):
        text = self.matching_text() + "Build Timestamp: 1790802614\n"
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            self.populate_datadir(data_dir)
            stub = self.write_stub(data_dir / "bin", text)
            labels = self.labels(data_dir / "labels.json", number=42)
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                ["--labels-json", str(labels), "--op-reth-bin", str(stub)],
            )
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)
            meta_path = data_dir / "snapshots" / "fortel2-852-reth-snapshot-42.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            self.assertIs(True, meta["reth_pin_match"])
            self.assertEqual(text, meta["reth_version_text"])
            self.assertEqual(PIN.VERSION_LINE, meta["reth_expected_version_line"])
            self.assertEqual(PIN.COMMIT_LINE, meta["reth_expected_commit_line"])
            self.assertEqual(str(stub), meta["op_reth_bin"])
            self.assertNotIn("reth_pin_version", meta)
            self.assertNotIn("reth_pin_commit", meta)

    def test_refuses_v233_before_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            self.populate_datadir(data_dir)
            stub = self.write_stub(data_dir / "bin", V233_VERSION_TEXT)
            labels = self.labels(data_dir / "labels.json", number=7)
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                ["--labels-json", str(labels), "--op-reth-bin", str(stub)],
            )
            self.assertNotEqual(0, result.returncode, result.stdout)
            self.assertIn("op-reth pin mismatch", result.stderr)
            self.assert_no_archive(data_dir)

    def test_refuses_near_miss_before_archive(self):
        cases = {
            "version-suffix": f"{PIN.VERSION_LINE}-dev\n{PIN.COMMIT_LINE}\n",
            "wrong-commit": f"{PIN.VERSION_LINE}\nCommit SHA: {'ab' * 20}\n",
        }
        for name, text in cases.items():
            with self.subTest(name=name):
                with tempfile.TemporaryDirectory() as temp:
                    data_dir = Path(temp)
                    self.populate_datadir(data_dir)
                    stub = self.write_stub(data_dir / "bin", text)
                    labels = self.labels(data_dir / "labels.json", number=8)
                    result = self.run_script(
                        {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                        ["--labels-json", str(labels), "--op-reth-bin", str(stub)],
                    )
                    self.assertNotEqual(0, result.returncode, result.stdout)
                    self.assertIn("op-reth pin mismatch", result.stderr)
                    self.assert_no_archive(data_dir)

    def test_allow_pin_mismatch_records_false(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            self.populate_datadir(data_dir)
            stub = self.write_stub(data_dir / "bin", V233_VERSION_TEXT)
            labels = self.labels(data_dir / "labels.json", number=11)
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                [
                    "--labels-json",
                    str(labels),
                    "--op-reth-bin",
                    str(stub),
                    "--allow-pin-mismatch",
                ],
            )
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)
            self.assertIn("WARN", result.stderr)
            meta_path = data_dir / "snapshots" / "fortel2-852-reth-snapshot-11.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            self.assertIs(False, meta["reth_pin_match"])
            self.assertEqual(V233_VERSION_TEXT, meta["reth_version_text"])
            self.assertEqual(PIN.VERSION_LINE, meta["reth_expected_version_line"])
            self.assertEqual(PIN.COMMIT_LINE, meta["reth_expected_commit_line"])
            self.assertEqual(str(stub), meta["op_reth_bin"])

    def test_slashless_bin_runs_the_checked_file(self):
        # -f/-x on a slashless name inspect ./op-reth. Execution must use that
        # file, not a different op-reth earlier on PATH.
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            self.populate_datadir(data_dir)
            cwd = data_dir / "cwd"
            good = self.write_stub(cwd, self.matching_text())
            path_dir = data_dir / "pathbin"
            self.write_stub(path_dir, V233_VERSION_TEXT)
            labels = self.labels(data_dir / "labels.json", number=15)
            env = {
                **os.environ,
                "DATA_DIR": str(data_dir),
                "L2_CHAIN_ID": "852",
                "PATH": str(path_dir) + os.pathsep + os.environ.get("PATH", ""),
            }
            result = subprocess.run(
                [
                    "bash",
                    str(SCRIPT),
                    "--labels-json",
                    str(labels),
                    "--op-reth-bin",
                    good.name,
                ],
                cwd=cwd,
                env=env,
                text=True,
                capture_output=True,
                timeout=15,
            )
            combined = result.stderr + result.stdout
            self.assertIn("op-reth pin ok", result.stdout, combined)
            self.assertNotIn("Reth Version: 2.3.0-dev", combined)
            if result.returncode == 0:
                meta_path = data_dir / "snapshots" / "fortel2-852-reth-snapshot-15.json"
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                self.assertIs(True, meta["reth_pin_match"])
                self.assertEqual(self.matching_text(), meta["reth_version_text"])
                self.assertEqual(good.name, meta["op_reth_bin"])
            else:
                self.assertIn("op-reth node", result.stderr)
                self.assert_no_archive(data_dir)

    def test_missing_op_reth_bin_is_usage_error(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            self.populate_datadir(data_dir)
            labels = self.labels(data_dir / "labels.json", number=3)
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                ["--labels-json", str(labels)],
            )
            self.assertEqual(2, result.returncode, result.stderr + result.stdout)
            self.assertIn("--op-reth-bin is required", result.stderr)
            self.assert_no_archive(data_dir)

    def test_refuses_missing_or_nonexecutable_bin(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            self.populate_datadir(data_dir)
            labels = self.labels(data_dir / "labels.json", number=4)
            missing = data_dir / "bin" / "op-reth"
            for extra in ([], ["--allow-pin-mismatch"]):
                with self.subTest(kind="missing", extra=extra):
                    result = self.run_script(
                        {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                        ["--labels-json", str(labels), "--op-reth-bin", str(missing), *extra],
                    )
                    self.assertNotEqual(0, result.returncode, result.stdout)
                    self.assertIn("not an executable file", result.stderr)
                    self.assert_no_archive(data_dir)
            present = data_dir / "bin" / "op-reth"
            present.parent.mkdir(parents=True, exist_ok=True)
            present.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            present.chmod(0o644)
            result = self.run_script(
                {"DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                ["--labels-json", str(labels), "--op-reth-bin", str(present)],
            )
            self.assertNotEqual(0, result.returncode, result.stdout)
            self.assertIn("not an executable file", result.stderr)
            self.assert_no_archive(data_dir)

    def test_empty_pin_lines_do_not_match(self):
        """A checker that exports empty lines, or that is missing, must not match."""
        fake = (
            "VERSION_LINE = ''\n"
            "COMMIT_LINE = ''\n"
            "def check_text(text):\n"
            "    print('op-reth pin ok: bypass')\n"
            "    return True\n"
        )
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            self.populate_datadir(data_dir)
            labels = self.labels(data_dir / "labels.json", number=5)
            stub = self.write_stub(data_dir / "bin", self.matching_text())
            script_dir = data_dir / "scripts"
            script_dir.mkdir()
            script = script_dir / "snapshot-reth-state.sh"
            script.write_bytes(SCRIPT.read_bytes())
            script.chmod(0o755)
            (script_dir / "op-reth-pin-check.py").write_text(fake, encoding="utf-8")
            result = subprocess.run(
                [
                    "bash",
                    str(script),
                    "--labels-json",
                    str(labels),
                    "--op-reth-bin",
                    str(stub),
                ],
                env={**os.environ, "DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                text=True,
                capture_output=True,
                timeout=15,
            )
            self.assertNotEqual(0, result.returncode, result.stdout + result.stderr)
            self.assertIn("empty", result.stderr)
            self.assert_no_archive(data_dir)

            (script_dir / "op-reth-pin-check.py").unlink()
            result = subprocess.run(
                [
                    "bash",
                    str(script),
                    "--labels-json",
                    str(labels),
                    "--op-reth-bin",
                    str(stub),
                ],
                env={**os.environ, "DATA_DIR": str(data_dir), "L2_CHAIN_ID": "852"},
                text=True,
                capture_output=True,
                timeout=15,
            )
            self.assertNotEqual(0, result.returncode, result.stdout + result.stderr)
            self.assertIn("empty", result.stderr)
            self.assert_no_archive(data_dir)


if __name__ == "__main__":
    unittest.main()
