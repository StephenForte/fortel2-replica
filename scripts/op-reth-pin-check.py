#!/usr/bin/env python3
"""Shared op-reth pin check for entrypoint-reth.sh and CI.

check
    Read ``op-reth --version`` text on stdin. Exit 0 only when both expected
    lines appear as whole lines. On success, print the pin-ok line.

fetch-and-check
    Read the op-reth image reference from Dockerfile.reth (the only copy of
    the digest), download that image with curl, verify every blob's sha256,
    run the linux/amd64 binary's ``--version``, print that output verbatim,
    then apply this same check. Also require every flag entrypoint-reth.sh
    passes to op-reth to appear in the binary's help text.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

# Whole lines. The first push expects the Mac source-build version line so CI
# fails and logs what the published binary actually prints. Update both lines
# to that executed output; do not accept a substring, a bare tag, or a
# near-miss (2.5.0-dev, 2.5.00, an extra trailing character).
VERSION_LINE = "op-reth Version: 2.5.0"
COMMIT_LINE = "Commit SHA: 9f76a9d216f2d9aa99c5f45d7aad674acde93c14"

# Flags entrypoint-reth.sh passes to op-reth. init and node help are combined.
ENTRYPOINT_FLAGS = (
    "init",
    "node",
    "--datadir",
    "--chain",
    "--http",
    "--http.addr",
    "--http.port",
    "--http.api",
    "--http.corsdomain",
    "--authrpc.addr",
    "--authrpc.port",
    "--authrpc.jwtsecret",
    "--full",
    "--rollup.disable-tx-pool-gossip",
    "--disable-discovery",
    "--addr",
    "--max-peers",
    "--engine.cross-block-cache-size",
    "--rpc-cache.max-blocks",
)

# host / repository:tag@sha256:… AS reth
# repository is oplabs-tools-artifacts/images/op-reth (slashes inside the name).
FROM_RE = re.compile(
    r"^FROM\s+([^/\s]+)/(.+):([^\s@]+)@sha256:([0-9a-f]{64})\s+AS\s+reth\s*$",
    re.MULTILINE,
)

INDEX_ACCEPT = (
    "application/vnd.oci.image.index.v1+json, "
    "application/vnd.docker.distribution.manifest.list.v2+json"
)
MANIFEST_ACCEPT = (
    "application/vnd.oci.image.manifest.v1+json, "
    "application/vnd.docker.distribution.manifest.v2+json"
)


def whole_lines(text: str) -> list[str]:
    # Keep a final non-newline-terminated line. Do not strip spaces: a
    # near-miss that only differs by a trailing character must fail.
    if text.endswith("\n"):
        text = text[:-1]
    if text == "":
        return []
    return text.split("\n")


def check_text(text: str) -> bool:
    lines = whole_lines(text.replace("\r\n", "\n").replace("\r", "\n"))
    version_ok = VERSION_LINE in lines
    commit_ok = COMMIT_LINE in lines
    if version_ok and commit_ok:
        print(f"op-reth pin ok: {VERSION_LINE} / {COMMIT_LINE}")
        return True
    print("ERROR: op-reth pin mismatch", file=sys.stderr)
    print(f"  expected version line: {VERSION_LINE}", file=sys.stderr)
    print(f"  expected commit line: {COMMIT_LINE}", file=sys.stderr)
    flat = text.replace("\n", "\\n")
    print(f"  got: {flat}", file=sys.stderr)
    return False


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def read_pin_from_dockerfile(dockerfile: Path) -> tuple[str, str, str, str]:
    text = dockerfile.read_text(encoding="utf-8")
    matches = FROM_RE.findall(text)
    if len(matches) != 1:
        raise SystemExit(
            f"ERROR: expected exactly one 'FROM … AS reth' digest pin in {dockerfile}, found {len(matches)}"
        )
    registry, repository, tag, digest = matches[0]
    return registry, repository, tag, digest


def curl(url: str, dest: Path, accept: str | None, token: str | None) -> str:
    header_path = dest.with_suffix(dest.suffix + ".headers")
    cmd = [
        "curl",
        "-fsSL",
        "--retry",
        "3",
        "--retry-delay",
        "2",
        "-D",
        str(header_path),
        "-o",
        str(dest),
    ]
    if accept:
        cmd.extend(["-H", f"Accept: {accept}"])
    if token:
        cmd.extend(["-H", f"Authorization: Bearer {token}"])
    cmd.append(url)
    subprocess.run(cmd, check=True)
    return header_path.read_text(encoding="utf-8", errors="replace")


def header_value(headers: str, name: str) -> str | None:
    prefix = name.lower() + ":"
    found = None
    for line in headers.splitlines():
        if line.lower().startswith(prefix):
            found = line.split(":", 1)[1].strip()
    return found


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_blob(path: Path, headers: str, expected: str | None) -> str:
    """Body sha256 must match the digest we already have.

    Artifact Registry omits Docker-Content-Digest on a GET by digest. When
    that header is present it must still equal the body. A tag fetch (the
    index) always passes the pinned digest as ``expected``.
    """
    body = sha256_file(path)
    listed = header_value(headers, "docker-content-digest")
    if listed is not None and listed != f"sha256:{body}":
        raise SystemExit(
            f"ERROR: blob sha256 mismatch for {path.name}: header {listed} body sha256:{body}"
        )
    if expected is None and listed is None:
        raise SystemExit(f"ERROR: response missing docker-content-digest ({path.name})")
    if expected is not None and body != expected:
        raise SystemExit(
            f"ERROR: blob sha256:{body} != expected sha256:{expected} ({path.name})"
        )
    if listed is None:
        print(f"{path.name}: docker-content-digest omitted; body sha256:{body} matches")
    return body


def registry_token(registry: str, repository: str) -> str:
    url = (
        f"https://{registry}/v2/token?service={registry}"
        f"&scope=repository:{repository}:pull"
    )
    raw = subprocess.check_output(["curl", "-fsSL", "--retry", "3", url], text=True)
    return json.loads(raw)["token"]


def media_open_mode(media_type: str) -> str:
    if media_type.endswith("+gzip") or media_type.endswith(".gzip"):
        return "r:gz"
    if media_type.endswith("+zstd"):
        raise SystemExit(f"ERROR: zstd layer is not extracted by this checker ({media_type})")
    if media_type.endswith(".tar") or media_type.endswith("tar"):
        return "r:"
    raise SystemExit(f"ERROR: unsupported layer media type {media_type}")


def extract_op_reth(archive: Path, dest: Path, media_type: str) -> Path | None:
    """Copy usr/local/bin/op-reth out of one layer.

    The apko layer also contains absolute symlinks (etc/mtab -> /proc/mounts).
    Python 3.12's data filter refuses those, and this check does not need
    them. Only a regular file at that path is extracted, under a fixed name.
    """
    mode = media_open_mode(media_type)
    with tarfile.open(archive, mode) as tar:
        member = None
        for candidate in tar.getmembers():
            name = candidate.name.lstrip("./")
            if name == "usr/local/bin/op-reth":
                member = candidate
                break
        if member is None:
            return None
        if not member.isreg():
            raise SystemExit(
                f"ERROR: usr/local/bin/op-reth is not a regular file ({member.type})"
            )
        member.name = "op-reth"
        dest.mkdir(parents=True, exist_ok=True)
        tar.extract(member, dest, set_attrs=False)
    binary = dest / "op-reth"
    binary.chmod(0o755)
    return binary


def run_captured(binary: Path, args: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [str(binary), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=120,
        check=False,
    )


def flag_in_help(help_text: str, flag: str) -> bool:
    """True when flag is its own token, not only a prefix of a longer flag."""
    if flag.startswith("--"):
        return re.search(re.escape(flag) + r"(?![\w.-])", help_text) is not None
    return re.search(r"(?<![\w.-])" + re.escape(flag) + r"(?![\w.-])", help_text) is not None


def loader_failure(output: str, code: int) -> bool:
    lowered = output.lower()
    return code != 0 and (
        "glibc_" in lowered
        or "error while loading shared libraries" in lowered
        or "cannot execute" in lowered
        or "exec format error" in lowered
        or code == 127
    )


def fetch_and_check() -> int:
    dockerfile = repo_root() / "Dockerfile.reth"
    registry, repository, tag, index_digest = read_pin_from_dockerfile(dockerfile)
    token = registry_token(registry, repository)
    base = f"https://{registry}/v2/{repository}"
    work = Path(tempfile.mkdtemp(prefix="op-reth-pin-"))
    try:
        index_path = work / "index.json"
        index_headers = curl(
            f"{base}/manifests/{tag}",
            index_path,
            INDEX_ACCEPT,
            token,
        )
        got_index = require_blob(index_path, index_headers, index_digest)
        print(f"index digest sha256:{got_index}")
        index = json.loads(index_path.read_text(encoding="utf-8"))
        amd64 = None
        for manifest in index.get("manifests") or []:
            platform = manifest.get("platform") or {}
            if platform.get("os") == "linux" and platform.get("architecture") == "amd64":
                amd64 = manifest["digest"]
        if not amd64 or not amd64.startswith("sha256:"):
            raise SystemExit("ERROR: index has no linux/amd64 manifest")
        amd64_hex = amd64.split(":", 1)[1]
        print(f"linux/amd64 manifest {amd64}")
        manifest_path = work / "amd64.json"
        manifest_headers = curl(
            f"{base}/manifests/{amd64}",
            manifest_path,
            MANIFEST_ACCEPT,
            token,
        )
        require_blob(manifest_path, manifest_headers, amd64_hex)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        config = manifest["config"]
        config_path = work / "config.json"
        config_headers = curl(
            f"{base}/blobs/{config['digest']}",
            config_path,
            None,
            token,
        )
        require_blob(config_path, config_headers, config["digest"].split(":", 1)[1])
        binary = None
        for index_no, layer in enumerate(manifest["layers"]):
            layer_digest = layer["digest"]
            media_type = layer["mediaType"]
            layer_path = work / f"layer-{index_no}.blob"
            layer_headers = curl(
                f"{base}/blobs/{layer_digest}",
                layer_path,
                None,
                token,
            )
            require_blob(layer_path, layer_headers, layer_digest.split(":", 1)[1])
            print(f"layer {index_no} {layer_digest} {media_type} sha256 ok")
            found = extract_op_reth(layer_path, work / "bin", media_type)
            if found is not None:
                binary = found
        if binary is None or not binary.is_file():
            raise SystemExit("ERROR: pinned image has no usr/local/bin/op-reth")
        version = run_captured(binary, ["--version"])
        version_text = version.stdout.decode("utf-8", errors="replace")
        sys.stdout.write("===== op-reth --version (verbatim) =====\n")
        sys.stdout.write(version_text)
        if not version_text.endswith("\n"):
            sys.stdout.write("\n")
        sys.stdout.write(f"===== op-reth --version exit {version.returncode} =====\n")
        if loader_failure(version_text, version.returncode):
            print(
                "ERROR: op-reth failed to load on this runner; not updating the pin matcher",
                file=sys.stderr,
            )
            return 3
        help_text = ""
        for args in (["--help"], ["node", "--help"], ["init", "--help"]):
            proc = run_captured(binary, args)
            chunk = proc.stdout.decode("utf-8", errors="replace")
            help_text += chunk
            if proc.returncode != 0:
                print(
                    f"ERROR: {' '.join(args)} exited {proc.returncode}",
                    file=sys.stderr,
                )
                sys.stderr.write(chunk)
                return 2
        missing = [flag for flag in ENTRYPOINT_FLAGS if not flag_in_help(help_text, flag)]
        if missing:
            print(
                "ERROR: op-reth help is missing flags entrypoint-reth.sh passes: "
                + " ".join(missing),
                file=sys.stderr,
            )
            return 2
        print("op-reth help accepts every flag entrypoint-reth.sh passes")
        if not check_text(version_text):
            return 1
        return 0
    finally:
        # The workflow runner discards the job VM. Remove the extract anyway
        # so a rerun on a long-lived machine does not keep the layer around.
        subprocess.run(["rm", "-rf", str(work)], check=False)


def main(argv: list[str]) -> int:
    if argv == ["check"]:
        text = sys.stdin.read()
        return 0 if check_text(text) else 1
    if argv == ["fetch-and-check"]:
        return fetch_and_check()
    print(
        "usage: op-reth-pin-check.py check | fetch-and-check",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
