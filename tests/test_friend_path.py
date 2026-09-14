#!/usr/bin/env python3
"""Friend-path properties: loopback publish, provider pair, published hashes."""

from __future__ import annotations

import hashlib
import re
import textwrap
from pathlib import Path
from urllib.parse import urlparse
import unittest


ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.yml"
ENV_EXAMPLE = ROOT / ".env.example"
README = ROOT / "README.md"
GENESIS = ROOT / "config" / "genesis.json"
ROLLUP = ROOT / "config" / "rollup.json"

# In-container bind flags. Host `ports:` are a different field; these tests
# must be able to fail independently.
CONTAINER_ADDR_FLAGS = (
    "--http.addr",
    "--ws.addr",
    "--rpc.addr",
    "--authrpc.addr",
)
REQUIRED_CONTAINER_ADDR_FLAGS = (
    "--http.addr",
    "--authrpc.addr",
    "--rpc.addr",
)

LOOPBACK = frozenset({"127.0.0.1", "::1"})

# Hostname suffix → op-node --l1.rpckind. Unknown hosts fail closed so a new
# default URL cannot silently keep a stale kind.
KIND_BY_HOST_SUFFIX = (
    ("publicnode.com", "standard"),
    ("quiknode.pro", "quicknode"),
    ("quicknode.com", "quicknode"),
    ("alchemy.com", "alchemy"),
    ("infura.io", "infura"),
)


def _unquote(item: str) -> str:
    item = item.strip()
    if len(item) >= 2 and item[0] == item[-1] and item[0] in {'"', "'"}:
        return item[1:-1]
    return item


def parse_short_port(spec: str) -> dict:
    """Parse Compose short-syntax HOST:CONTAINER into host_ip / published / target.

    No host_ip means Docker publishes on every interface.
    """
    spec = _unquote(spec)
    protocol = None
    if "/" in spec:
        body, maybe_proto = spec.rsplit("/", 1)
        if maybe_proto in ("tcp", "udp"):
            spec, protocol = body, maybe_proto

    host_ip = None
    if spec.startswith("["):
        end = spec.index("]")
        host_ip = spec[1:end]
        rest = spec[end + 1 :].lstrip(":")
        parts = rest.split(":") if rest else []
    else:
        parts = spec.split(":")

    published = None
    target = None
    if host_ip is not None:
        if len(parts) == 2:
            published, target = parts
        elif len(parts) == 1:
            target = parts[0]
        else:
            raise ValueError(f"unparsed port spec: {spec!r}")
    elif len(parts) == 3:
        host_ip, published, target = parts
    elif len(parts) == 2:
        published, target = parts
    elif len(parts) == 1:
        target = parts[0]
    else:
        raise ValueError(f"unparsed port spec: {spec!r}")

    return {
        "host_ip": host_ip or None,
        "published": published or None,
        "target": target,
        "protocol": protocol,
    }


def is_loopback_host(host_ip: str | None) -> bool:
    return host_ip in LOOPBACK


def published_ports(compose_text: str) -> list[dict]:
    """Every host-published mapping under any service `ports:` list."""
    mappings: list[dict] = []
    lines = compose_text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.split("#", 1)[0].rstrip()
        ports_key = re.match(r"^(\s+)ports:\s*(.*)$", stripped)
        if not ports_key:
            i += 1
            continue
        indent = len(ports_key.group(1))
        rest = ports_key.group(2).strip()
        if rest.startswith("[") and rest.endswith("]"):
            inner = rest[1:-1].strip()
            if inner:
                for item in inner.split(","):
                    parsed = parse_short_port(item)
                    parsed["raw"] = item.strip()
                    mappings.append(parsed)
            i += 1
            continue
        i += 1
        current_long: dict | None = None
        while i < len(lines):
            nxt = lines[i]
            nxt_stripped = nxt.split("#", 1)[0].rstrip()
            if not nxt_stripped:
                i += 1
                continue
            nxt_indent = len(nxt) - len(nxt.lstrip(" "))
            if nxt_indent <= indent:
                break
            item_m = re.match(r"^\s+-\s+(.*)$", nxt_stripped)
            if item_m:
                if current_long is not None:
                    mappings.append(_long_port(current_long))
                    current_long = None
                body = item_m.group(1).strip()
                if re.match(r"^(target|published|host_ip|protocol|mode):", body):
                    current_long = {}
                    key, _, val = body.partition(":")
                    current_long[key.strip()] = _unquote(val)
                else:
                    parsed = parse_short_port(body)
                    parsed["raw"] = body
                    mappings.append(parsed)
                i += 1
                continue
            if current_long is not None:
                key, _, val = nxt_stripped.lstrip().partition(":")
                current_long[key.strip()] = _unquote(val)
                i += 1
                continue
            break
        if current_long is not None:
            mappings.append(_long_port(current_long))
    return mappings


def _long_port(fields: dict) -> dict:
    return {
        "host_ip": fields.get("host_ip") or None,
        "published": str(fields["published"]) if fields.get("published") else None,
        "target": str(fields["target"]) if fields.get("target") else None,
        "protocol": fields.get("protocol"),
        "raw": dict(fields),
    }


def _yaml_list_item(line: str) -> str | None:
    """Return the value of a YAML sequence item, or None if the line is not one."""
    stripped = line.split("#", 1)[0].strip()
    if stripped.startswith("- "):
        return _unquote(stripped[2:].strip())
    if stripped == "-":
        return ""
    return None


def container_addr_flags(compose_text: str) -> dict[str, list[str]]:
    """Map --*.addr flag name → values found in command lists (not ports:)."""
    found: dict[str, list[str]] = {name: [] for name in CONTAINER_ADDR_FLAGS}
    in_ports = False
    ports_indent = 0
    for raw in compose_text.splitlines():
        code = raw.split("#", 1)[0].rstrip()
        if not code.strip():
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if in_ports:
            if indent > ports_indent:
                continue
            in_ports = False
        if re.match(r"^\s+ports:\s*", code):
            in_ports = True
            ports_indent = indent
            continue
        item = _yaml_list_item(raw)
        if item is None:
            continue
        for name in CONTAINER_ADDR_FLAGS:
            prefix = name + "="
            if item.startswith(prefix):
                found[name].append(item[len(prefix) :])
    return found


def env_example_assignments(text: str) -> dict[str, str]:
    values = {}
    for line in text.splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip()
    return values


def compose_interpolation_defaults(compose_text: str, key: str) -> set[str]:
    """Return every ${KEY:-fallback} default for key in compose (code only)."""
    found = set()
    pattern = re.compile(rf"\$\{{{re.escape(key)}:-([^}}]+)\}}")
    for raw in compose_text.splitlines():
        code = raw.split("#", 1)[0]
        found.update(pattern.findall(code))
    return found


def kind_for_url(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    for suffix, kind in KIND_BY_HOST_SUFFIX:
        if host == suffix or host.endswith("." + suffix):
            return kind
    raise AssertionError(
        f"no L1_RPC_KIND mapping for host {host!r} in URL {url!r}"
    )


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def readme_published_hash(readme: str, filename: str) -> str:
    pattern = rf"`config/{re.escape(filename)}`\s*\|\s*`([0-9a-f]{{64}})`"
    match = re.search(pattern, readme)
    if not match:
        raise AssertionError(
            f"README.md must publish a 64-hex sha256 next to `config/{filename}`"
        )
    return match.group(1)


class PortClassifierTests(unittest.TestCase):
    """The loopback property is only as strong as this classifier."""

    def test_unprefixed_short_syntax_is_not_loopback(self):
        parsed = parse_short_port("9545:8545")
        self.assertIsNone(parsed["host_ip"])
        self.assertFalse(is_loopback_host(parsed["host_ip"]))

    def test_wildcard_prefix_is_not_loopback(self):
        parsed = parse_short_port("0.0.0.0:9545:8545")
        self.assertEqual("0.0.0.0", parsed["host_ip"])
        self.assertFalse(is_loopback_host(parsed["host_ip"]))

    def test_loopback_prefix_is_loopback(self):
        parsed = parse_short_port("127.0.0.1:9545:8545")
        self.assertEqual("127.0.0.1", parsed["host_ip"])
        self.assertTrue(is_loopback_host(parsed["host_ip"]))

    def test_wide_publish_does_not_fail_the_addr_scanner(self):
        # Wrong-place "fix" vs host publish must be able to fail separately.
        text = textwrap.dedent(
            """
            services:
              op-reth:
                command:
                  - --http.addr=0.0.0.0
                  - --authrpc.addr=0.0.0.0
                  - --rpc.addr=0.0.0.0
                ports:
                  - "9545:8545"
            """
        )
        mappings = published_ports(text)
        self.assertFalse(is_loopback_host(mappings[0]["host_ip"]))
        flags = container_addr_flags(text)
        self.assertEqual(["0.0.0.0"], flags["--http.addr"])
        self.assertEqual(["0.0.0.0"], flags["--authrpc.addr"])
        self.assertEqual(["0.0.0.0"], flags["--rpc.addr"])

    def test_loopback_bind_inside_container_does_not_fail_the_port_scanner(self):
        text = textwrap.dedent(
            """
            services:
              op-reth:
                command:
                  - --http.addr=127.0.0.1
                  - --authrpc.addr=127.0.0.1
                  - --rpc.addr=127.0.0.1
                ports:
                  - "127.0.0.1:9545:8545"
            """
        )
        mappings = published_ports(text)
        self.assertTrue(is_loopback_host(mappings[0]["host_ip"]))
        flags = container_addr_flags(text)
        self.assertEqual(["127.0.0.1"], flags["--http.addr"])


class FriendPathTests(unittest.TestCase):
    def test_every_host_publish_binds_loopback(self):
        mappings = published_ports(COMPOSE.read_text(encoding="utf-8"))
        self.assertTrue(mappings, "docker-compose.yml publishes no ports")
        for mapping in mappings:
            self.assertTrue(
                is_loopback_host(mapping["host_ip"]),
                f"host publish is not loopback: {mapping!r}",
            )

    def test_container_bind_addresses_remain_unspecified(self):
        flags = container_addr_flags(COMPOSE.read_text(encoding="utf-8"))
        for name in REQUIRED_CONTAINER_ADDR_FLAGS:
            values = flags[name]
            self.assertTrue(values, f"{name} missing from docker-compose.yml")
            for value in values:
                self.assertEqual(
                    "0.0.0.0",
                    value,
                    f"{name} must stay 0.0.0.0 (in-container bind), not {value!r}",
                )
        for name, values in flags.items():
            for value in values:
                self.assertEqual(
                    "0.0.0.0",
                    value,
                    f"{name} must stay 0.0.0.0 (in-container bind), not {value!r}",
                )

    def test_env_example_kind_matches_default_url(self):
        values = env_example_assignments(ENV_EXAMPLE.read_text(encoding="utf-8"))
        url = values.get("L1_RPC_URL")
        kind = values.get("L1_RPC_KIND")
        self.assertTrue(url, "L1_RPC_URL missing from .env.example")
        self.assertTrue(kind, "L1_RPC_KIND missing from .env.example")
        self.assertEqual(kind_for_url(url), kind)

    def test_compose_l1_rpc_kind_fallback_matches_env_example(self):
        # A friend who writes .env without L1_RPC_KIND must get the same
        # kind .env.example ships. Hardcoding "standard" here would let
        # both files drift together. Key the assertion off both files.
        values = env_example_assignments(ENV_EXAMPLE.read_text(encoding="utf-8"))
        example_kind = values.get("L1_RPC_KIND")
        self.assertTrue(example_kind, "L1_RPC_KIND missing from .env.example")
        defaults = compose_interpolation_defaults(
            COMPOSE.read_text(encoding="utf-8"),
            "L1_RPC_KIND",
        )
        self.assertTrue(
            defaults,
            "docker-compose.yml has no ${L1_RPC_KIND:-...} fallback",
        )
        self.assertEqual({example_kind}, defaults)

    def test_readme_published_hashes_match_config_files(self):
        readme = README.read_text(encoding="utf-8")
        genesis_hash = sha256_file(GENESIS)
        rollup_hash = sha256_file(ROLLUP)
        self.assertEqual(readme_published_hash(readme, "genesis.json"), genesis_hash)
        self.assertEqual(readme_published_hash(readme, "rollup.json"), rollup_hash)
        self.assertIn("852", readme)
        self.assertIn("0xe242b1a3312b509e7df1496847f0bd0b115cb66676b1e973a355296c99e2386d", readme)

    def test_sha256sums_is_checkable_and_matches_config(self):
        """config/SHA256SUMS must be usable with `shasum -c` and stay in sync.

        The friend runbook's verification step is only fail-closed if this file
        is both parseable by shasum/sha256sum AND correct. A stale entry here
        would exit 0 against the wrong artifact, which is worse than no check.
        """
        sums_path = ROOT / "config" / "SHA256SUMS"
        self.assertTrue(sums_path.exists(), "config/SHA256SUMS is missing")
        entries = {}
        for line in sums_path.read_text(encoding="utf-8").splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            # GNU/BSD format is "<64 hex><two spaces><name>"; anything else
            # would make `shasum -c` report a malformed line and pass anyway.
            match = re.fullmatch(r"([0-9a-f]{64})  (\S+)", line)
            self.assertIsNotNone(match, f"not a checkable sums line: {line!r}")
            entries[match.group(2)] = match.group(1)

        self.assertEqual(
            {"genesis.json", "rollup.json"},
            set(entries),
            "SHA256SUMS must cover exactly the two published artifacts",
        )
        self.assertEqual(entries["genesis.json"], sha256_file(GENESIS))
        self.assertEqual(entries["rollup.json"], sha256_file(ROLLUP))

        # Paths are relative to config/, so `cd config && shasum -c SHA256SUMS`
        # resolves them. An absolute or ../-prefixed path would break that.
        for name in entries:
            self.assertNotIn("/", name, f"{name} must be relative to config/")

    def test_runbooks_use_the_checking_form_not_the_printing_form(self):
        """`shasum -a 256 <file>` prints digests; only -c exits non-zero.

        Both platform lines are checked, not just one: a doc that reverted its
        macOS line while keeping the Linux one is broken for macOS readers, and
        an "at least one match" assertion would pass it.
        """
        for doc in (README, ROOT / "RUNNING.md"):
            text = doc.read_text(encoding="utf-8")
            # Assert presence rather than skipping: a doc that dropped
            # SHA256SUMS and reverted to the printing form would otherwise skip
            # every assertion below, so the test would pass for exactly the
            # complete rollback it exists to prevent (Codex/Bugbot on #55).
            self.assertIn(
                "SHA256SUMS",
                text,
                f"{doc.name} no longer references SHA256SUMS at all",
            )
            for form in (r"shasum -a 256 -c SHA256SUMS", r"sha256sum -c SHA256SUMS"):
                self.assertRegex(
                    text,
                    form,
                    f"{doc.name} is missing the checking form: {form}",
                )
            # The printing form against the artifacts themselves exits 0 even
            # when they are wrong, so it must not appear as the verify step.
            for printing in (
                r"shasum -a 256 (config/)?genesis\.json",
                r"(?<!# )sha256sum (config/)?genesis\.json",
            ):
                self.assertNotRegex(
                    text,
                    printing,
                    f"{doc.name} still shows the printing form as verification",
                )



if __name__ == "__main__":
    unittest.main()
