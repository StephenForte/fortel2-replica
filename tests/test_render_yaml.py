#!/usr/bin/env python3
"""Task 7 / Task 9 Blueprint guards: declared services only; no geth EL path."""

import hashlib
import importlib.util
import io
from pathlib import Path
import re
import tarfile
import tempfile
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
            "op-reth:v2.6.0@sha256:0bf70098c274127ecdf8bfb95851d646deb12622ab8319379b630434dcc61d6c",
            docker,
        )
        self.assertNotIn(
            "op-reth:v2.3.3@sha256:eec35eaafb6f8b3d07c6844ff87c4f8af81fca088472b6a432435c53a36b8a4c",
            docker,
        )
        self.assertNotIn(
            "op-reth:v2.5.0@sha256:6a19f905d87a363eae26a7a79f7e08f95036f20589d239a2aeccd104530e7692",
            docker,
        )
        self.assertIn(
            "op-node:v1.19.8@sha256:adc6578b8b3c1cd065405c17bf593008ad21c3fc91cef6db72d370344432ba11",
            docker,
        )
        self.assertNotIn("ubuntu:24.04", docker)
        self.assertNotIn("images/op-geth", docker)
        self.assertNotIn("COPY --from=geth", docker)
        self.assertNotIn("COPY --from=reth", docker)
        self.assertIn("\nFROM reth\n", docker)
        self.assertIn("COPY --from=node", docker)
        self.assertIn("COPY entrypoint-reth.sh", docker)
        self.assertIn("COPY scripts/op-reth-pin-check.py /op-reth-pin-check.py", docker)
        self.assertIn("gnutar=1.35-r12", docker)
        self.assertIn("python-3.13-base=3.13.16_git20261002-r2", docker)
        self.assertIn("python3-as-3.13=0.1.0-r5", docker)
        self.assertIn("openssl-4.0=4.0.3-r4", docker)
        self.assertIn("zstd=1.5.7-r10", docker)
        self.assertIn("tzdata=2026e-r0", docker)
        self.assertIn("adduser -u 10001", docker)
        self.assertNotIn("apt-get", docker)
        reth = next(
            block
            for block in _service_blocks(self.text)
            if "name: fortel2-replica-reth\n" in block
            and "fortel2-replica-reth-rpc" not in block.split("name:", 1)[-1][:40]
        )
        self.assertIn("dockerfilePath: ./Dockerfile.reth\n", reth)
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        self.assertIn("dockerfile: Dockerfile.reth", compose)
        self.assertIn(
            "op-reth:v2.6.0@sha256:0bf70098c274127ecdf8bfb95851d646deb12622ab8319379b630434dcc61d6c",
            compose,
        )
        self.assertNotIn(
            "eec35eaafb6f8b3d07c6844ff87c4f8af81fca088472b6a432435c53a36b8a4c",
            compose,
        )
        self.assertNotIn("6a19f905d87a363eae26a7a79f7e08f95036f20589d239a2aeccd104530e7692", compose)
        spec = importlib.util.spec_from_file_location(
            "op_reth_pin_check", ROOT / "scripts" / "op-reth-pin-check.py"
        )
        pin_check = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pin_check)
        registry, repository, tag, digest = pin_check.read_pin_from_dockerfile(
            ROOT / "Dockerfile.reth"
        )
        self.assertEqual("us-docker.pkg.dev", registry)
        self.assertEqual("oplabs-tools-artifacts/images/op-reth", repository)
        self.assertEqual("v2.6.0", tag)
        self.assertEqual(
            "0bf70098c274127ecdf8bfb95851d646deb12622ab8319379b630434dcc61d6c",
            digest,
        )
        ci = (ROOT / ".github/workflows/tests.yml").read_text(encoding="utf-8")
        self.assertIn("entrypoint-reth.sh", ci)
        self.assertIn("docker build --platform linux/amd64 -f Dockerfile.reth", ci)
        self.assertIn("id fortel2", ci)
        self.assertIn("/op-reth-pin-check.py check", ci)
        self.assertNotIn("fetch-and-check", ci)
        self.assertNotIn(
            "eec35eaafb6f8b3d07c6844ff87c4f8af81fca088472b6a432435c53a36b8a4c",
            ci,
        )
        self.assertNotIn(
            "6a19f905d87a363eae26a7a79f7e08f95036f20589d239a2aeccd104530e7692",
            ci,
        )
        self.assertNotIn("sh -n entrypoint.sh", ci)
        self.assertNotIn("sh -n healthcheck.sh", ci)
        self.assertIn("sh -n entrypoint-reth.sh", ci)
        self.assertIn("sh -n healthcheck-reth.sh", ci)

    def test_digest_fetch_allows_missing_content_digest_header(self):
        # GET-by-digest on Artifact Registry omits Docker-Content-Digest.
        # The body hash still has to match the digest from the parent manifest.
        spec = importlib.util.spec_from_file_location(
            "op_reth_pin_check", ROOT / "scripts" / "op-reth-pin-check.py"
        )
        pin_check = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pin_check)
        payload = b"manifest-bytes"
        expected = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "amd64.json"
            path.write_bytes(payload)
            got = pin_check.require_blob(path, "HTTP/2 200\ncontent-type: application/json\n", expected)
        self.assertEqual(expected, got)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "amd64.json"
            path.write_bytes(payload)
            with self.assertRaises(SystemExit):
                pin_check.require_blob(
                    path,
                    "HTTP/2 200\ndocker-content-digest: sha256:deadbeef\n",
                    expected,
                )

    def test_extracts_op_reth_and_ignores_absolute_symlink(self):
        spec = importlib.util.spec_from_file_location(
            "op_reth_pin_check", ROOT / "scripts" / "op-reth-pin-check.py"
        )
        pin_check = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pin_check)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / "layer.tar"
            with tarfile.open(archive, "w") as tar:
                payload = b"op-reth-bytes"
                info = tarfile.TarInfo("usr/local/bin/op-reth")
                info.size = len(payload)
                info.mode = 0o755
                tar.addfile(info, fileobj=io.BytesIO(payload))
                link = tarfile.TarInfo("etc/mtab")
                link.type = tarfile.SYMTYPE
                link.linkname = "/proc/mounts"
                tar.addfile(link)
            dest = root / "out"
            got = pin_check.extract_op_reth(
                archive, dest, "application/vnd.oci.image.layer.v1.tar"
            )
            self.assertEqual(payload, got.read_bytes())
            self.assertEqual(got.name, "op-reth")

    def test_op_node_pin_rejects_pre_glamsterdam(self):
        # v1.19.2 cannot hash Glamsterdam headers (blockAccessListHash / slotNumber).
        old_tag = "op-node:v1.19.2"
        old_digest = "3652c0faa7582e49c31a71f86bc5170167499aed7e382e92722f34beb233ef1a"
        new_pin = (
            "op-node:v1.19.8@sha256:"
            "adc6578b8b3c1cd065405c17bf593008ad21c3fc91cef6db72d370344432ba11"
        )
        for path in (ROOT / "Dockerfile.reth", ROOT / "docker-compose.yml"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn(old_tag, text, path.name)
            self.assertNotIn(old_digest, text, path.name)
            self.assertIn(new_pin, text, path.name)

    def test_reth_runtime_base_is_not_bookworm(self):
        # The runtime stage is the pinned Wolfi op-reth image (`FROM reth`),
        # not ubuntu and not debian bookworm. bookworm's glibc cannot load
        # this binary; ubuntu:24.04 cannot either (glibc 2.39 vs 2.44).
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
        self.assertEqual(["FROM reth"], runtime_from)

    def test_gateway_default_upstream_matches_blueprint(self):
        """The image default must name a host that still exists.

        Every deployed gateway sets REPLICA_UPSTREAM explicitly, so this
        default is only reached when that env var is lost — which is exactly
        when a wrong value is hardest to diagnose. It pointed at
        `fortel2-replica` until 2026-09-14, a host deleted with the geth pserv
        (R-0019); the fallback would have failed to resolve and taken public
        read down. Keyed off the Blueprint rather than a hardcoded string so
        the two cannot drift apart.
        """
        dockerfile = (ROOT / "gateway" / "Dockerfile").read_text(encoding="utf-8")
        match = re.search(r"REPLICA_UPSTREAM=(\S+?)\s*\\", dockerfile)
        self.assertIsNotNone(match, "no REPLICA_UPSTREAM default in gateway/Dockerfile")
        default = match.group(1)

        blueprint = re.findall(
            r"- key: REPLICA_UPSTREAM\s*\n\s*value: (\S+)", self.text
        )
        self.assertTrue(blueprint, "no REPLICA_UPSTREAM value in render.yaml")
        self.assertIn(
            default,
            blueprint,
            f"gateway default {default!r} is not a REPLICA_UPSTREAM the Blueprint uses",
        )
        # Belt and braces: never the retired geth slug, whatever else changes.
        self.assertNotIn("//fortel2-replica:", default)


if __name__ == "__main__":
    unittest.main()
