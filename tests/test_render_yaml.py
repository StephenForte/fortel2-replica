#!/usr/bin/env python3
"""Task 7 Blueprint guards: live entry frozen; new objects additive only."""

from pathlib import Path
import unittest

try:
    import yaml
except ImportError:  # PyYAML is not a repo dependency; parse enough by hand.
    yaml = None


ROOT = Path(__file__).resolve().parents[1]
RENDER = ROOT / "render.yaml"


def _service_blocks(text: str) -> list[str]:
    """Split render.yaml services: entries on top-level '- type:' lines."""
    services_at = text.index("\nservices:\n")
    body = text[services_at + len("\nservices:\n") :]
    parts = []
    current = []
    for line in body.splitlines(keepends=True):
        if line.startswith("  - type:") and current:
            parts.append("".join(current))
            current = [line]
        else:
            current.append(line)
    if current:
        parts.append("".join(current))
    return parts


class RenderYamlTests(unittest.TestCase):
    def setUp(self):
        self.text = RENDER.read_text(encoding="utf-8")

    def test_live_entry_is_frozen_snapshot(self):
        # The live Oregon pserv + 50 GB disk must not be rewritten. A new
        # apply of this block creates a second empty-disk replica (R-0008).
        self.assertIn("name: fortel2-replica\n", self.text)
        self.assertIn("name: fortel2-replica-data\n", self.text)
        self.assertIn("      - key: GETH_CACHE_MB\n        value: \"128\"\n", self.text)
        self.assertIn("      - key: JWT_SECRET\n        sync: false\n", self.text)
        self.assertIn("Do NOT re-apply", self.text)
        live = _service_blocks(self.text)[0]
        self.assertIn("name: fortel2-replica\n", live)
        self.assertIn("name: fortel2-replica-data\n", live)
        self.assertNotIn("fortel2-replica-reth", live)

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
        self.assertNotIn("key: GETH_CACHE_MB", reth)
        self.assertNotIn("key: JWT_SECRET", reth)

    def test_dockerfile_pins_reth_by_digest(self):
        docker = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn(
            "op-reth:v2.3.3@sha256:eec35eaafb6f8b3d07c6844ff87c4f8af81fca088472b6a432435c53a36b8a4c",
            docker,
        )
        self.assertIn(
            "op-node:v1.19.2@sha256:3652c0faa7582e49c31a71f86bc5170167499aed7e382e92722f34beb233ef1a",
            docker,
        )
        self.assertNotIn("images/op-geth", docker)
        self.assertNotIn("COPY --from=geth", docker)
        self.assertIn("COPY --from=reth", docker)


if __name__ == "__main__":
    unittest.main()
