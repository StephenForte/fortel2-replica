#!/usr/bin/env python3
"""Task 7 / Task 9 Blueprint guards: declared services only; no geth EL path."""

from pathlib import Path
import re
import unittest

try:
    import yaml
except ImportError:  # PyYAML is not a repo dependency; parse enough by hand.
    yaml = None


ROOT = Path(__file__).resolve().parents[1]
RENDER = ROOT / "render.yaml"

# Property C: assert the set, not the absence of one name.
EXPECTED_SERVICE_NAMES = (
    "fortel2-replica-reth",
    "fortel2-replica-reth-rpc",
)

# Files that can start an EL or declare a build. Historical records
# (DECISIONS.md, docs/) are excluded on purpose.
ACTIVE_EL_PATHS = (
    ROOT / "docker-compose.yml",
    ROOT / "render.yaml",
    ROOT / "Dockerfile.reth",
    ROOT / "entrypoint-reth.sh",
    ROOT / "healthcheck-reth.sh",
    ROOT / ".github" / "workflows" / "tests.yml",
)

RETIRED_GETH_FILES = ("Dockerfile", "entrypoint.sh", "healthcheck.sh")

OP_GETH_PIN = re.compile(
    r"images/op-geth|op-geth:v|--l2\.enginekind=geth|enginekind=geth"
)


def _service_blocks(text: str) -> list[str]:
    """Split render.yaml services: entries on top-level '- type:' lines."""
    services_at = text.index("\nservices:\n")
    body = text[services_at + len("\nservices:\n") :]
    parts = []
    current = []
    for line in body.splitlines(keepends=True):
        if line.startswith("  - type:"):
            if current:
                parts.append("".join(current))
            current = [line]
        elif current:
            current.append(line)
    if current:
        parts.append("".join(current))
    return parts


def _service_names(text: str) -> list[str]:
    names = []
    for block in _service_blocks(text):
        match = re.search(r"(?m)^\s+name: (\S+)\s*$", block)
        if match is None:
            raise AssertionError(f"service block has no name:\n{block[:200]}")
        names.append(match.group(1))
    return names


def _dockerfile_paths(text: str) -> list[str]:
    return re.findall(r"(?m)^\s+dockerfilePath: (\S+)\s*$", text)


class RenderYamlTests(unittest.TestCase):
    def setUp(self):
        self.text = RENDER.read_text(encoding="utf-8")

    def test_do_not_re_apply_warning_survives(self):
        # D-0128: applying the Blueprint creates empty-disk services. This
        # is not geth-specific and must survive Task 9.
        self.assertIn("Do NOT re-apply", self.text)

    def test_render_yaml_service_set(self):
        names = _service_names(self.text)
        self.assertEqual(list(EXPECTED_SERVICE_NAMES), names)

    def test_no_service_points_at_retired_root_dockerfile(self):
        # A ./Dockerfile service block is how a merge would recreate the
        # R-0013 accident (EL image on the wrong disk / a new empty disk).
        for path in _dockerfile_paths(self.text):
            self.assertNotEqual(
                "./Dockerfile",
                path,
                "render.yaml must not point a service at the retired root Dockerfile",
            )
        self.assertFalse(
            (ROOT / "Dockerfile").exists(),
            "root Dockerfile must stay deleted (fail-safe if autoDeploy is re-enabled)",
        )

    def test_retired_geth_files_are_absent(self):
        for name in RETIRED_GETH_FILES:
            self.assertFalse(
                (ROOT / name).exists(),
                f"{name} must stay deleted — it was the geth EL surface",
            )

    def test_no_op_geth_image_pin_in_active_paths(self):
        # Property D: reintroducing an op-geth pin in a start path must fail.
        extra_dockerfiles = sorted(ROOT.glob("Dockerfile*"))
        paths = list(ACTIVE_EL_PATHS) + extra_dockerfiles
        seen = []
        for path in paths:
            if not path.exists():
                continue
            if path in seen:
                continue
            seen.append(path)
            text = path.read_text(encoding="utf-8")
            match = OP_GETH_PIN.search(text)
            self.assertIsNone(
                match,
                f"op-geth pin in {path.relative_to(ROOT)}: {match.group(0) if match else ''}",
            )

    def test_task7_objects_are_additive(self):
        self.assertIn("name: fortel2-replica-reth\n", self.text)
        self.assertIn("name: fortel2-replica-reth-data\n", self.text)
        self.assertIn("name: fortel2-replica-reth-rpc\n", self.text)
        self.assertIn("http://fortel2-replica-reth:10000", self.text)
        self.assertNotRegex(self.text, r"(?m)^      fromService:")
        reth = next(
            block
            for block in _service_blocks(self.text)
            if "name: fortel2-replica-reth\n" in block
            and "fortel2-replica-reth-rpc" not in block.split("name:", 1)[-1][:40]
        )
        self.assertIn("L1_RPC_FORCE", reth)
        self.assertIn("value: metered", reth)
        self.assertIn("RETH_CROSS_BLOCK_CACHE_MB", reth)
        self.assertIn("dockerfilePath: ./Dockerfile.reth\n", reth)
        self.assertNotIn("key: GETH_CACHE_MB", reth)
        self.assertNotIn("key: JWT_SECRET", reth)
        # Snapshot URL/hash are operator dashboard secrets, never Blueprint values
        # (a synced empty URL would be a no-op; a synced FORCE would wipe /data).
        self.assertNotIn("key: RETH_SNAPSHOT_URL", reth)
        self.assertNotIn("key: RETH_SNAPSHOT_SHA256", reth)
        self.assertNotIn("key: RETH_SNAPSHOT_FORCE", reth)
        self.assertIn("RETH_SNAPSHOT_URL", self.text)

    def test_reth_dockerfile_pins_by_digest(self):
        docker = (ROOT / "Dockerfile.reth").read_text(encoding="utf-8")
        self.assertIn(
            "op-reth:v2.3.3@sha256:eec35eaafb6f8b3d07c6844ff87c4f8af81fca088472b6a432435c53a36b8a4c",
            docker,
        )
        self.assertIn(
            "op-node:v1.19.2@sha256:3652c0faa7582e49c31a71f86bc5170167499aed7e382e92722f34beb233ef1a",
            docker,
        )
        self.assertIn(
            "ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254",
            docker,
        )
        self.assertNotIn("images/op-geth", docker)
        self.assertNotIn("COPY --from=geth", docker)
        self.assertIn("COPY --from=reth", docker)
        self.assertIn("COPY entrypoint-reth.sh", docker)
        self.assertIn("libstdc++6", docker)
        self.assertIn("curl", docker)
        self.assertIn("zstd", docker)
        reth = next(
            block
            for block in _service_blocks(self.text)
            if "name: fortel2-replica-reth\n" in block
            and "fortel2-replica-reth-rpc" not in block.split("name:", 1)[-1][:40]
        )
        self.assertIn("dockerfilePath: ./Dockerfile.reth\n", reth)
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        self.assertIn("dockerfile: Dockerfile.reth", compose)
        ci = (ROOT / ".github/workflows/tests.yml").read_text(encoding="utf-8")
        self.assertIn("entrypoint-reth.sh", ci)
        self.assertNotIn("entrypoint.sh\n", ci)
        self.assertNotIn("healthcheck.sh\n", ci)

    def test_reth_runtime_base_is_not_bookworm(self):
        # Official op-reth is wolfi-linked (glibc 2.38+/CXXABI_1.3.15).
        # bookworm-slim is glibc 2.36 and cannot load the binary.
        docker = (ROOT / "Dockerfile.reth").read_text(encoding="utf-8")
        from_lines = [
            line.split("#", 1)[0].strip()
            for line in docker.splitlines()
            if line.startswith("FROM ")
        ]
        self.assertTrue(from_lines)
        for line in from_lines:
            self.assertNotIn("bookworm", line)
            self.assertNotIn("debian:", line)
        runtime_from = [
            line
            for line in from_lines
            if " AS " not in line and " as " not in line
        ]
        self.assertEqual(1, len(runtime_from), runtime_from)
        self.assertRegex(
            runtime_from[0],
            r"^FROM ubuntu:24\.04@sha256:[0-9a-f]{64}$",
        )


if __name__ == "__main__":
    unittest.main()
