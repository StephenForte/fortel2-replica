#!/bin/sh
# Stock ForteL2 verifier: op-reth + op-node (no sequencer / batcher / proposer).
# Includes Render-oriented readiness/shutdown fixes from ForteL2 PRs #23–#25.
# Role is verifier: --full (prune, not archive) unless RETH_ARCHIVE=1,
# no --proofs-history. reth has no --archive flag; archive is omitting --full
# AND deleting a persisted $DATA_DIR/reth.toml (a prior --full boot writes
# [prune] segments there; omitting --full does not clear them). Do not
# hand-write a replacement toml — reth regenerates defaults on the next start.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
JWT_FILE="${JWT_FILE:-$DATA_DIR/jwt.txt}"
GENESIS="${GENESIS:-/config/genesis.json}"
ROLLUP="${ROLLUP:-/config/rollup.json}"
# Published read RPC = method filter. Render Web Service injects PORT (often 10000).
L2_HTTP_PORT="${PORT:-${L2_HTTP_PORT:-8545}}"
# Loopback-only op-reth HTTP behind the filter (never the published port).
# Name is historical (L2_GETH_HTTP_PORT); the EL is op-reth.
L2_GETH_HTTP_PORT="${L2_GETH_HTTP_PORT:-8546}"
L2_ENGINE_PORT="${L2_ENGINE_PORT:-8551}"
L2_NODE_RPC_PORT="${L2_NODE_RPC_PORT:-9545}"
RPC_FILTER_SCRIPT="${RPC_FILTER_SCRIPT:-/rpc-method-filter.py}"
L1_BLOCK_TIME="${L1_BLOCK_TIME:-12}"
# Seconds to wait for op-reth HTTP after start. 0 = keep waiting while the PID is alive
# (datadir open / crash recovery on constrained disks can exceed 60s).
RETH_READY_TIMEOUT_SECS="${RETH_READY_TIMEOUT_SECS:-0}"
# Replaces GETH_CACHE_MB. Pinned op-reth defaults --engine.cross-block-cache-size
# to 4096 MB, which OOMs Render Standard (2 GB). 256 MB is the starting knob;
# Phase B measures RSS before any plan change.
RETH_CROSS_BLOCK_CACHE_MB="${RETH_CROSS_BLOCK_CACHE_MB:-256}"
# Replaces the unbounded geth RPC/state cache. Default 5000 blocks is too large
# for a 2 GB verifier; keep a small positive cache.
RETH_RPC_CACHE_MAX_BLOCKS="${RETH_RPC_CACHE_MAX_BLOCKS:-256}"
# 1 = omit --full (reth default is archive: keep historical receipts/logs)
# and delete $DATA_DIR/reth.toml if present (stale prune segments from a
# prior --full boot). Unset or 0 = --full prune, as today; reth.toml is
# not touched. A pruned datadir cannot be un-pruned.
RETH_ARCHIVE="${RETH_ARCHIVE:-}"
# Optional Go soft memory cap (Go 1.19+). op-reth is Rust — GETH_GOMEMLIMIT
# does not apply. Keep this on Render Standard so op-node + the L1 router stay
# under the cgroup limit during L1 derivation bursts. Unset on ≥4GB hosts.
OP_NODE_GOMEMLIMIT="${OP_NODE_GOMEMLIMIT:-}"
# op-node default --l1.cache-size is 900 L1 blocks of receipts/txs — too big for 2 GB
# during catch-up. 0 is worse (expands to ~2400). Keep a small positive cache.
L1_CACHE_SIZE="${L1_CACHE_SIZE:-128}"
L1_MAX_CONCURRENCY="${L1_MAX_CONCURRENCY:-2}"
L1_RPC_MAX_BATCH_SIZE="${L1_RPC_MAX_BATCH_SIZE:-5}"
# How often to check that both long-running processes are alive.
PROCESS_POLL_INTERVAL_SECS="${PROCESS_POLL_INTERVAL_SECS:-1}"
# --l1.rpckind. Default quicknode when the router / FORCE=metered serves QuickNode.
# The router's public-overnight leg is publicnode (D-0105: 0 receipts) — initial
# sync must use L1_RPC_FORCE=metered; do not silently switch kind.
L1_RPC_KIND="${L1_RPC_KIND:-quicknode}"
# Marker for Docker HEALTHCHECK: absent → probe fails (health=starting during
# --start-period). Keep off the persistent volume so a prior run cannot leave
# a stale ready flag.
FORTEL2_EL_READY_FILE="${FORTEL2_EL_READY_FILE:-/tmp/fortel2-el-ready}"
rm -f "$FORTEL2_EL_READY_FILE"
FILTER_PID=""
# Optional first-boot snapshot (R-0014 / D-0123). Only this reth entrypoint
# restores.
# RETH_SNAPSHOT_URL + RETH_SNAPSHOT_SHA256 are operator-set. FORCE=1 is a
# one-shot replace of an existing db/ after a validated extract (paused 68 %
# disk) — also drops reth.toml (persisted prune config); unset after. A
# FORCE failure leaves the current db (and toml) in place.
RETH_SNAPSHOT_URL="${RETH_SNAPSHOT_URL:-}"
RETH_SNAPSHOT_SHA256="${RETH_SNAPSHOT_SHA256:-}"
RETH_SNAPSHOT_FORCE="${RETH_SNAPSHOT_FORCE:-}"

# op-reth pin lines live in scripts/op-reth-pin-check.py (R-0022 parks
# v2.5.0; the executed v2.3.3 lines stay). This script calls that checker.
# Dockerfile.reth matches main and does not COPY the helper, so the image
# materializes the same bytes from the heredoc below. A unit test asserts
# the heredoc equals the file.
# R-0021 / ForteL2 D-0147. Measured `op-node --version` of the pinned image:
#   op-node version v1.19.8-9f76a9d2-1790167011
PIN_OP_NODE_VERSION='v1.19.8'
PIN_OP_NODE_COMMIT='9f76a9d2'
EXPECTED_L2_CHAIN_ID='852'
EXPECTED_GENESIS_HASH='0xe242b1a3312b509e7df1496847f0bd0b115cb66676b1e973a355296c99e2386d'

case "$RETH_READY_TIMEOUT_SECS" in
  ''|*[!0-9]*)
    echo "ERROR: RETH_READY_TIMEOUT_SECS must be a non-negative integer (got: $RETH_READY_TIMEOUT_SECS)" >&2
    exit 1
    ;;
esac

case "$RETH_CROSS_BLOCK_CACHE_MB" in
  ''|*[!0-9]*|0)
    echo "ERROR: RETH_CROSS_BLOCK_CACHE_MB must be a positive integer (got: $RETH_CROSS_BLOCK_CACHE_MB)" >&2
    exit 1
    ;;
esac

case "$RETH_RPC_CACHE_MAX_BLOCKS" in
  ''|*[!0-9]*|0)
    echo "ERROR: RETH_RPC_CACHE_MAX_BLOCKS must be a positive integer (got: $RETH_RPC_CACHE_MAX_BLOCKS)" >&2
    exit 1
    ;;
esac

case "$RETH_ARCHIVE" in
  ""|0|1) ;;
  *)
    echo "ERROR: RETH_ARCHIVE must be 0 or 1 (got: $RETH_ARCHIVE)" >&2
    exit 1
    ;;
esac

case "$L1_CACHE_SIZE" in
  ''|*[!0-9]*|0)
    echo "ERROR: L1_CACHE_SIZE must be a positive integer (got: $L1_CACHE_SIZE); 0 expands op-node's cache to ~2400 L1 blocks" >&2
    exit 1
    ;;
esac

case "$L1_MAX_CONCURRENCY" in
  ''|*[!0-9]*|0)
    echo "ERROR: L1_MAX_CONCURRENCY must be a positive integer (got: $L1_MAX_CONCURRENCY)" >&2
    exit 1
    ;;
esac

case "$L1_RPC_MAX_BATCH_SIZE" in
  ''|*[!0-9]*|0)
    echo "ERROR: L1_RPC_MAX_BATCH_SIZE must be a positive integer (got: $L1_RPC_MAX_BATCH_SIZE)" >&2
    exit 1
    ;;
esac

case "$PROCESS_POLL_INTERVAL_SECS" in
  ''|*[!0-9]*|0)
    echo "ERROR: PROCESS_POLL_INTERVAL_SECS must be a positive integer (got: $PROCESS_POLL_INTERVAL_SECS)" >&2
    exit 1
    ;;
esac

case "$L1_RPC_KIND" in
  ''|*[!a-zA-Z0-9_-]*)
    echo "ERROR: L1_RPC_KIND must be a non-empty provider kind (got: $L1_RPC_KIND)" >&2
    exit 1
    ;;
esac

# Near QuickNode credit cap / overrides (highest priority wins for direct URL):
#   L1_RPC_FORCE=public|metered  — pin upstream (skips schedule)
#   L1_USE_PUBLIC_RPC=1          — same as FORCE=public
#   L1_RPC_SCHEDULE=business     — 09:00–17:00 local TZ → QuickNode, else publicnode
#                                  via in-container JSON-RPC router (no op-node restart)
L1_RPC_PUBLIC_URL="${L1_RPC_PUBLIC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
L1_RPC_SCHEDULE="${L1_RPC_SCHEDULE:-off}"
L1_RPC_FORCE="${L1_RPC_FORCE:-}"
L1_RPC_ROUTER_SCRIPT="${L1_RPC_ROUTER_SCRIPT:-/l1_rpc_router.py}"
L1_RPC_LISTEN="${L1_RPC_LISTEN:-127.0.0.1:18545}"
L1_RPC_METERED_URL="${L1_RPC_URL:-}"
ROUTER_PID=""

case "${L1_RPC_FORCE}" in
  public|PUBLIC)
    L1_RPC_URL="$L1_RPC_PUBLIC_URL"
    L1_RPC_MODE=public
    L1_RPC_SCHEDULE=off
    ;;
  metered|METERED|quicknode|QUICKNODE|qn|QN)
    if [ -z "${L1_RPC_METERED_URL}" ]; then
      echo "ERROR: L1_RPC_FORCE=metered requires L1_RPC_URL (QuickNode)" >&2
      exit 1
    fi
    L1_RPC_URL="$L1_RPC_METERED_URL"
    L1_RPC_MODE=metered
    L1_RPC_SCHEDULE=off
    ;;
  "" ) ;;
  *)
    echo "ERROR: L1_RPC_FORCE must be public, metered, or empty (got: ${L1_RPC_FORCE})" >&2
    exit 1
    ;;
esac

if [ -z "${L1_RPC_FORCE}" ]; then
  case "${L1_USE_PUBLIC_RPC:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      L1_RPC_URL="$L1_RPC_PUBLIC_URL"
      L1_RPC_MODE=public
      L1_RPC_SCHEDULE=off
      ;;
    0|false|FALSE|no|NO|off|OFF|"")
      L1_RPC_MODE=metered
      ;;
    *)
      echo "ERROR: L1_USE_PUBLIC_RPC must be 0 or 1 (got: ${L1_USE_PUBLIC_RPC})" >&2
      exit 1
      ;;
  esac
fi

case "${L1_RPC_SCHEDULE}" in
  business|BUSINESS|1|true|TRUE|yes|YES|on|ON)
    L1_RPC_SCHEDULE=business
    ;;
  off|OFF|0|false|FALSE|no|NO|"")
    L1_RPC_SCHEDULE=off
    ;;
  *)
    echo "ERROR: L1_RPC_SCHEDULE must be business or off (got: ${L1_RPC_SCHEDULE})" >&2
    exit 1
    ;;
esac

if [ "$L1_RPC_SCHEDULE" = "business" ]; then
  if [ -z "${L1_RPC_METERED_URL}" ]; then
    echo "ERROR: L1_RPC_SCHEDULE=business requires L1_RPC_URL (QuickNode / metered)" >&2
    exit 1
  fi
  case "$L1_RPC_METERED_URL" in
    *publicnode*|*rpc.sepolia.org*)
      echo "WARN: L1_RPC_URL looks like a public RPC — business hours will not use QuickNode" >&2
      ;;
  esac
  L1_RPC_MODE=schedule
fi

if [ -z "${L1_RPC_URL:-}" ] && [ "$L1_RPC_SCHEDULE" != "business" ]; then
  echo "ERROR: L1_RPC_URL is required (Ethereum Sepolia HTTPS)" >&2
  echo "  Or set L1_USE_PUBLIC_RPC=1 / L1_RPC_FORCE=public to use ${L1_RPC_PUBLIC_URL}" >&2
  exit 1
fi

if [ ! -f "$GENESIS" ] || [ ! -f "$ROLLUP" ]; then
  echo "ERROR: missing $GENESIS and/or $ROLLUP" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 required for genesis hash-check and RPC method filter" >&2
  exit 1
fi

if ! command -v op-reth >/dev/null 2>&1; then
  echo "ERROR: op-reth binary not found on PATH" >&2
  exit 1
fi

# Fail closed unless --version prints the whole lines in the shared checker.
# That runs before snapshot restore and before op-reth opens the datadir.
# The heredoc is filled in immediately below this function.
_materialize_pin_check() {
  cat > "$1" <<'END_OP_RETH_PIN_CHECK'
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

# Whole lines from the executed v2.3.3 binary (R-0022 parks v2.5.0).
# A trailing character, a bare tag, or the Mac v2.5.0 lines do not match.
VERSION_LINE = "Reth Version: 2.3.0-dev"
COMMIT_LINE = "Commit SHA: 9384bc53d8c0c77e59cac83fdaaf3b372c6d2216"

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
END_OP_RETH_PIN_CHECK
}

if [ -z "${OP_RETH_PIN_CHECK:-}" ]; then
  _entrypoint_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
  if [ -f "$_entrypoint_dir/scripts/op-reth-pin-check.py" ]; then
    OP_RETH_PIN_CHECK="$_entrypoint_dir/scripts/op-reth-pin-check.py"
  elif [ -f /op-reth-pin-check.py ]; then
    OP_RETH_PIN_CHECK=/op-reth-pin-check.py
  else
    OP_RETH_PIN_CHECK=$(mktemp)
    _materialize_pin_check "$OP_RETH_PIN_CHECK"
  fi
fi
if [ ! -f "$OP_RETH_PIN_CHECK" ]; then
  echo "ERROR: missing op-reth pin check at $OP_RETH_PIN_CHECK" >&2
  exit 1
fi
RETH_VER="$(op-reth --version 2>&1 || true)"
if ! printf '%s\n' "$RETH_VER" | python3 "$OP_RETH_PIN_CHECK" check; then
  exit 1
fi

# Fail closed unless op-node is the Glamsterdam pin. v1.19.8 must not match
# v1.19.80: the character after the version is non-digit, or the version ends
# the text. The pin-ok line is printed later, next to the op-node start, so a
# boot that never launches op-node does not claim the pin.
if ! command -v op-node >/dev/null 2>&1; then
  echo "ERROR: op-node binary not found on PATH" >&2
  exit 1
fi
NODE_VER="$(op-node --version 2>&1 || true)"
case "$NODE_VER" in
  *"${PIN_OP_NODE_VERSION}"[!0-9]*|*"${PIN_OP_NODE_VERSION}") ;;
  *)
    echo "ERROR: op-node pin mismatch" >&2
    echo "  expected: op-node version ${PIN_OP_NODE_VERSION}-${PIN_OP_NODE_COMMIT}-… (no digit after ${PIN_OP_NODE_VERSION})" >&2
    echo "  got: $(printf '%s' "$NODE_VER" | tr '\n' ' ')" >&2
    exit 1
    ;;
esac
case "$NODE_VER" in
  *"${PIN_OP_NODE_COMMIT}"*) ;;
  *)
    echo "ERROR: op-node pin mismatch" >&2
    echo "  expected: op-node version ${PIN_OP_NODE_VERSION}-${PIN_OP_NODE_COMMIT}-… (no digit after ${PIN_OP_NODE_VERSION})" >&2
    echo "  got: $(printf '%s' "$NODE_VER" | tr '\n' ' ')" >&2
    exit 1
    ;;
esac

# Hash-check baked-in 852 artifacts; refuse 901 / any other genesis.
if ! python3 - "$GENESIS" "$ROLLUP" "$EXPECTED_L2_CHAIN_ID" "$EXPECTED_GENESIS_HASH" <<'PY'
import json, sys

genesis_path, rollup_path, want_id, want_hash = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
want_chain = int(want_id)
with open(genesis_path, encoding="utf-8") as fh:
    genesis = json.load(fh)
chain = (genesis.get("config") or {}).get("chainId")
if chain != want_chain:
    print(
        "ERROR: refusing chain %s genesis — op-reth init is ForteL2 852 only (not 901)"
        % (chain if chain is not None else "<missing>"),
        file=sys.stderr,
    )
    sys.exit(1)
with open(rollup_path, encoding="utf-8") as fh:
    rollup = json.load(fh)
l2_id = rollup.get("l2_chain_id")
if l2_id != want_chain:
    print(
        "ERROR: refusing rollup l2_chain_id %s — op-reth init is ForteL2 852 only (not 901)"
        % (l2_id if l2_id is not None else "<missing>"),
        file=sys.stderr,
    )
    sys.exit(1)
got_hash = ((rollup.get("genesis") or {}).get("l2") or {}).get("hash")
if got_hash != want_hash:
    print(
        "ERROR: refusing genesis hash %s (want %s)"
        % (got_hash or "<missing>", want_hash),
        file=sys.stderr,
    )
    sys.exit(1)
print("genesis/rollup hash-check ok chain=%s hash=%s" % (want_chain, want_hash))
PY
then
  exit 1
fi

mkdir -p "$DATA_DIR"
if [ ! -f "$JWT_FILE" ]; then
  if [ -n "${JWT_SECRET:-}" ]; then
    printf '%s' "$JWT_SECRET" > "$JWT_FILE"
  else
    openssl rand -hex 32 > "$JWT_FILE"
  fi
  chmod 600 "$JWT_FILE"
fi

# R-0014 / R-0015: bootstrap from a stopped-EL snapshot instead of re-deriving
# from genesis. Pin + 852 genesis hash-check already ran (fail-fast). Restore
# never writes jwt.txt (fresh in-container). This path lives only here.
# FORCE replace also drops reth.toml so a fresh datadir cannot inherit a
# prior --full prune config.
snapshot_force_enabled() {
  case "${RETH_SNAPSHOT_FORCE}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    ""|0|false|FALSE|no|NO|off|OFF) return 1 ;;
    *)
      echo "ERROR: RETH_SNAPSHOT_FORCE must be 0 or 1 (got: ${RETH_SNAPSHOT_FORCE})" >&2
      exit 1
      ;;
  esac
}

normalize_snapshot_sha256() {
  s=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d ' \t\n\r')
  s=${s#0x}
  case "$s" in
    ""|*[!0-9a-f]*)
      echo "ERROR: RETH_SNAPSHOT_SHA256 must be 64 hex chars (got: ${1:-<empty>})" >&2
      exit 1
      ;;
  esac
  if [ "${#s}" -ne 64 ]; then
    echo "ERROR: RETH_SNAPSHOT_SHA256 must be 64 hex chars (got length ${#s})" >&2
    exit 1
  fi
  printf '%s' "$s"
}

redact_snapshot_url() {
  u="$1"
  case "$u" in
    http://*|https://*)
      printf '%s\n' "$u" | sed -E 's#(https?://[^/]+).*#\1/<redacted>#'
      ;;
    *)
      printf '%s' "<redacted>"
      ;;
  esac
}

restore_reth_snapshot() {
  if [ -z "$RETH_SNAPSHOT_URL" ]; then
    if snapshot_force_enabled; then
      echo "ERROR: RETH_SNAPSHOT_FORCE=1 requires RETH_SNAPSHOT_URL" >&2
      exit 1
    fi
    return 0
  fi
  if [ -z "$RETH_SNAPSHOT_SHA256" ]; then
    echo "ERROR: RETH_SNAPSHOT_URL is set but RETH_SNAPSHOT_SHA256 is empty — refuse to restore without a pinned hash" >&2
    exit 1
  fi
  want_sha=$(normalize_snapshot_sha256 "$RETH_SNAPSHOT_SHA256")
  if [ -d "$DATA_DIR/db" ] && ! snapshot_force_enabled; then
    echo "snapshot: datadir already has db/; skipping restore (set RETH_SNAPSHOT_FORCE=1 to replace)"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "ERROR: curl required to download RETH_SNAPSHOT_URL" >&2
    exit 1
  fi
  if ! command -v zstd >/dev/null 2>&1; then
    echo "ERROR: zstd required to extract a reth snapshot" >&2
    exit 1
  fi
  work="$DATA_DIR/.reth-snapshot-work"
  rm -rf "$work"
  mkdir -p "$work/extract"
  archive="$work/snapshot.tar.zst"
  url_log=$(redact_snapshot_url "$RETH_SNAPSHOT_URL")
  replacing=0
  if snapshot_force_enabled && [ -d "$DATA_DIR/db" ]; then
    replacing=1
    echo "WARN: RETH_SNAPSHOT_FORCE=1 will replace existing db/, static_files/, and rocksdb/ (jwt.txt kept; reth.toml dropped) only after download, sha256, listing, and extract succeed. Unset FORCE after this boot — a later restart with FORCE still set will replace again. Needs free space for the tarball beside the current db." >&2
    echo "snapshot: FORCE staged replace of existing db/ (jwt.txt kept; reth.toml dropped; current db stays until extract ok)"
  fi
  echo "snapshot: downloading ${url_log}"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "$archive" "$RETH_SNAPSHOT_URL"; then
    echo "ERROR: snapshot download failed" >&2
    rm -rf "$work"
    exit 1
  fi
  got_sha=$(sha256sum "$archive" | awk '{print $1}')
  if [ "$got_sha" != "$want_sha" ]; then
    echo "ERROR: snapshot sha256 mismatch" >&2
    echo "  expected: $want_sha" >&2
    echo "  got:      $got_sha" >&2
    rm -rf "$work"
    exit 1
  fi
  echo "snapshot: sha256 ok"
  listing=$(tar --zstd -tf "$archive") || {
    echo "ERROR: snapshot archive is not a readable tar.zst" >&2
    rm -rf "$work"
    exit 1
  }
  if printf '%s\n' "$listing" | grep -Eiq '(^|/)jwt\.txt$|(^|/)historical-proofs(/|$)|(^|/)pids(/|$)|(^|/)logs(/|$)'; then
    echo "ERROR: snapshot archive contains jwt.txt, historical-proofs/, pids/, or logs/ — refuse" >&2
    printf '%s\n' "$listing" >&2
    rm -rf "$work"
    exit 1
  fi
  if printf '%s\n' "$listing" | grep -Eiq '(^|/)\.\.(/|$)|^/'; then
    echo "ERROR: snapshot archive contains path traversal or absolute paths — refuse" >&2
    printf '%s\n' "$listing" >&2
    rm -rf "$work"
    exit 1
  fi
  extras=$(printf '%s\n' "$listing" | grep -Ev '^(\./)?(db|static_files|rocksdb)(/.*)?$' || true)
  if [ -n "$extras" ]; then
    echo "ERROR: snapshot archive contains paths outside db/, static_files/, and rocksdb/ — refuse" >&2
    printf '%s\n' "$extras" >&2
    rm -rf "$work"
    exit 1
  fi
  echo "snapshot: archive listing ok (db/ + static_files/ + rocksdb/; no jwt/proofs)"
  if ! tar --zstd -xf "$archive" -C "$work/extract"; then
    echo "ERROR: snapshot extract failed" >&2
    rm -rf "$work"
    exit 1
  fi
  extract_root="$work/extract"
  if [ -d "$extract_root/db" ] || [ -d "$extract_root/static_files" ]; then
    :
  elif [ -d "$extract_root/./db" ]; then
    :
  else
    echo "ERROR: snapshot extract did not produce db/ or static_files/" >&2
    rm -rf "$work"
    exit 1
  fi
  # Swap only after a validated extract. A FORCE mismatch/download failure
  # must leave the paused derive in place (Codex review on R-0014).
  if [ "$replacing" -eq 1 ]; then
    echo "snapshot: FORCE replacing existing db/ after validated extract"
    rm -rf "$DATA_DIR/db" "$DATA_DIR/static_files" "$DATA_DIR/rocksdb"
    rm -f "$DATA_DIR/reth.toml"
  fi
  if [ -d "$extract_root/db" ]; then
    rm -rf "$DATA_DIR/db"
    mv "$extract_root/db" "$DATA_DIR/db"
  fi
  if [ -d "$extract_root/static_files" ]; then
    rm -rf "$DATA_DIR/static_files"
    mv "$extract_root/static_files" "$DATA_DIR/static_files"
  fi
  if [ -d "$extract_root/rocksdb" ]; then
    rm -rf "$DATA_DIR/rocksdb"
    mv "$extract_root/rocksdb" "$DATA_DIR/rocksdb"
  fi
  rm -rf "$work"
  if [ ! -d "$DATA_DIR/db" ]; then
    echo "ERROR: snapshot restore finished without $DATA_DIR/db" >&2
    exit 1
  fi
  echo "snapshot: restore ok sha256=$got_sha"
}

restore_reth_snapshot

if [ ! -d "$DATA_DIR/db" ] && [ ! -d "$DATA_DIR/static_files" ]; then
  echo "Initializing op-reth datadir (852; mid-chain rewind = wipe + re-derive, never debug_setHead)"
  op-reth init --datadir="$DATA_DIR" --chain="$GENESIS"
fi

if [ "$L2_GETH_HTTP_PORT" = "$L2_HTTP_PORT" ]; then
  echo "ERROR: L2_GETH_HTTP_PORT ($L2_GETH_HTTP_PORT) must differ from published L2_HTTP_PORT/PORT ($L2_HTTP_PORT)" >&2
  exit 1
fi

# Unquoted $RETH_PRUNE_FLAG: empty must not become an argv slot. Do not invent
# --archive — reth has no such flag; archive is the absence of --full.
# Delete reth.toml unconditionally under archive (if present). Parsing out
# [prune] would need a TOML writer; reth's schema drifts and a hand-authored
# file can be rejected at boot. reth regenerates defaults on the next start.
# After an archive boot the rewritten file has empty [prune.segments] — that
# is correct; the next archive start deletes it again (harmless).
RETH_PRUNE_FLAG="--full"
if [ "$RETH_ARCHIVE" = "1" ]; then
  RETH_PRUNE_FLAG=""
  echo "op-reth: archive mode — retains historical receipts/logs (--full omitted)"
  if [ -f "$DATA_DIR/reth.toml" ]; then
    rm -f "$DATA_DIR/reth.toml"
    echo "op-reth: removed stale prune config from $DATA_DIR/reth.toml (RETH_ARCHIVE=1)"
  fi
  echo "Starting op-reth (verifier EL, archive) loopback :$L2_GETH_HTTP_PORT (cross-block-cache=${RETH_CROSS_BLOCK_CACHE_MB}MB rpc-cache-blocks=${RETH_RPC_CACHE_MAX_BLOCKS}; public filter :$L2_HTTP_PORT)"
else
  echo "Starting op-reth (verifier EL, --full) loopback :$L2_GETH_HTTP_PORT (cross-block-cache=${RETH_CROSS_BLOCK_CACHE_MB}MB rpc-cache-blocks=${RETH_RPC_CACHE_MAX_BLOCKS}; public filter :$L2_HTTP_PORT)"
fi
op-reth node \
  --chain="$GENESIS" \
  --datadir="$DATA_DIR" \
  --http \
  --http.addr=127.0.0.1 \
  --http.port="$L2_GETH_HTTP_PORT" \
  --http.api=eth,net,web3 \
  --http.corsdomain=* \
  --authrpc.addr=127.0.0.1 \
  --authrpc.port="$L2_ENGINE_PORT" \
  --authrpc.jwtsecret="$JWT_FILE" \
  $RETH_PRUNE_FLAG \
  --rollup.disable-tx-pool-gossip \
  --disable-discovery \
  --addr=127.0.0.1 \
  --max-peers=0 \
  --engine.cross-block-cache-size="$RETH_CROSS_BLOCK_CACHE_MB" \
  --rpc-cache.max-blocks="$RETH_RPC_CACHE_MAX_BLOCKS" &
RETH_PID=$!

cleanup() {
  if [ -n "${NODE_PID:-}" ]; then
    kill "$NODE_PID" 2>/dev/null || true
  fi
  if [ -n "${FILTER_PID:-}" ]; then
    kill "$FILTER_PID" 2>/dev/null || true
  fi
  if [ -n "${ROUTER_PID:-}" ]; then
    kill "$ROUTER_PID" 2>/dev/null || true
  fi
  kill "$RETH_PID" 2>/dev/null || true
  if [ -n "${NODE_PID:-}" ]; then
    wait "$NODE_PID" 2>/dev/null || true
  fi
  if [ -n "${FILTER_PID:-}" ]; then
    wait "$FILTER_PID" 2>/dev/null || true
  fi
  if [ -n "${ROUTER_PID:-}" ]; then
    wait "$ROUTER_PID" 2>/dev/null || true
  fi
  wait "$RETH_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

el_http_ready() {
  python3 -c '
import sys
import urllib.request

port = sys.argv[1]
url = "http://127.0.0.1:%s" % port
body = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}"
req = urllib.request.Request(
    url,
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
urllib.request.urlopen(req, timeout=2).read()
' "$L2_GETH_HTTP_PORT"
}

# Wait for engine/HTTP: require a successful eth_blockNumber, not merely a live PID.
# Do not kill a still-alive op-reth after a short fixed window — persistent
# datadirs can take minutes to open during startup/crash recovery.
if [ "$RETH_READY_TIMEOUT_SECS" -eq 0 ]; then
  echo "Waiting for op-reth HTTP (no timeout while pid $RETH_PID is alive)..."
else
  echo "Waiting for op-reth HTTP (up to ${RETH_READY_TIMEOUT_SECS}s)..."
fi
i=0
ready=0
while true; do
  if ! kill -0 "$RETH_PID" 2>/dev/null; then
    echo "ERROR: op-reth exited before HTTP became ready" >&2
    wait "$RETH_PID" || true
    exit 1
  fi
  if el_http_ready >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [ "$RETH_READY_TIMEOUT_SECS" -gt 0 ] && [ "$i" -ge "$RETH_READY_TIMEOUT_SECS" ]; then
    break
  fi
  if [ "$i" -gt 0 ] && [ $((i % 30)) -eq 0 ]; then
    echo "Still waiting for op-reth HTTP at 127.0.0.1:${L2_GETH_HTTP_PORT} (${i}s elapsed; pid $RETH_PID alive)"
  fi
  sleep 1
  i=$((i + 1))
done
if [ "$ready" -ne 1 ]; then
  echo "ERROR: timed out waiting for op-reth HTTP at 127.0.0.1:${L2_GETH_HTTP_PORT} after ${i}s" >&2
  kill "$RETH_PID" 2>/dev/null || true
  wait "$RETH_PID" 2>/dev/null || true
  exit 1
fi
# Signal HEALTHCHECK that EL is ready; probes may now succeed (healthy).
: >"$FORTEL2_EL_READY_FILE"
echo "op-reth HTTP ready after ${i}s"

# Public read door: allowlist proxy on the published port; op-reth stays loopback.
if [ ! -f "$RPC_FILTER_SCRIPT" ]; then
  echo "ERROR: missing RPC method filter at $RPC_FILTER_SCRIPT" >&2
  exit 1
fi
export L2_RPC_FILTER_LISTEN="0.0.0.0:${L2_HTTP_PORT}"
export L2_RPC_FILTER_UPSTREAM="http://127.0.0.1:${L2_GETH_HTTP_PORT}"
echo "Starting RPC method filter on ${L2_RPC_FILTER_LISTEN} → ${L2_RPC_FILTER_UPSTREAM}"
python3 "$RPC_FILTER_SCRIPT" &
FILTER_PID=$!
sleep 1
if ! kill -0 "$FILTER_PID" 2>/dev/null; then
  echo "ERROR: RPC method filter exited immediately" >&2
  wait "$FILTER_PID" || true
  exit 1
fi

# Credit-budget defaults (Render catch-up previously burned ~3M+ credits/half-day
# at rate-limit=20). Override via Render env / .env.
L1_HTTP_POLL="${L1_HTTP_POLL_INTERVAL:-24s}"
L1_RPC_RATE_LIMIT="${L1_RPC_RATE_LIMIT:-5}"

if [ "$L1_RPC_MODE" = "schedule" ]; then
  if [ ! -f "$L1_RPC_ROUTER_SCRIPT" ]; then
    echo "ERROR: missing L1 router script at $L1_RPC_ROUTER_SCRIPT" >&2
    exit 1
  fi
  export L1_RPC_METERED_URL L1_RPC_PUBLIC_URL L1_RPC_LISTEN
  export L1_RPC_BUSINESS_START="${L1_RPC_BUSINESS_START:-9}"
  export L1_RPC_BUSINESS_END="${L1_RPC_BUSINESS_END:-17}"
  # Leave L1_RPC_FORCE empty so the router follows the clock; use FORCE / USE_PUBLIC
  # above to skip schedule entirely.
  unset L1_RPC_FORCE 2>/dev/null || true
  echo "Starting L1 RPC schedule router (${L1_RPC_BUSINESS_START}:00-${L1_RPC_BUSINESS_END}:00 tz=${TZ:-UTC} listen=${L1_RPC_LISTEN})"
  python3 "$L1_RPC_ROUTER_SCRIPT" &
  ROUTER_PID=$!
  # Brief wait so op-node does not race an unbound port.
  sleep 1
  if ! kill -0 "$ROUTER_PID" 2>/dev/null; then
    echo "ERROR: L1 RPC router exited immediately" >&2
    wait "$ROUTER_PID" || true
    exit 1
  fi
  L1_RPC_URL="http://${L1_RPC_LISTEN}"
  L1_RPC_LOG="http://${L1_RPC_LISTEN} (schedule ${L1_RPC_BUSINESS_START}:00-${L1_RPC_BUSINESS_END}:00 ${TZ:-UTC})"
else
  # Redact path tokens (QuickNode) from logs — host only.
  L1_RPC_LOG="$L1_RPC_URL"
  case "$L1_RPC_LOG" in
    http://*|https://*)
      L1_RPC_LOG="$(printf '%s\n' "$L1_RPC_LOG" | sed -E 's#(https?://[^/]+).*#\1/<redacted>#')"
      ;;
  esac
fi

NODE_MEM_LOG=""
[ -n "$OP_NODE_GOMEMLIMIT" ] && NODE_MEM_LOG=" gomemlimit=${OP_NODE_GOMEMLIMIT}"
echo "op-node pin ok: ${PIN_OP_NODE_VERSION} commit ${PIN_OP_NODE_COMMIT}"
echo "Starting op-node (L1 derivation / verifier; mode=${L1_RPC_MODE} l1=${L1_RPC_LOG} rpckind=${L1_RPC_KIND} poll=${L1_HTTP_POLL} rpc-rate-limit=${L1_RPC_RATE_LIMIT} l1-cache=${L1_CACHE_SIZE} max-concurrency=${L1_MAX_CONCURRENCY} rpc-max-batch=${L1_RPC_MAX_BATCH_SIZE}${NODE_MEM_LOG})"
env ${OP_NODE_GOMEMLIMIT:+GOMEMLIMIT=$OP_NODE_GOMEMLIMIT} op-node \
  --l1="$L1_RPC_URL" \
  --l1.rpckind="$L1_RPC_KIND" \
  --l1.trustrpc=true \
  --l1.http-poll-interval="$L1_HTTP_POLL" \
  --l1.rpc-rate-limit="$L1_RPC_RATE_LIMIT" \
  --l1.cache-size="$L1_CACHE_SIZE" \
  --l1.max-concurrency="$L1_MAX_CONCURRENCY" \
  --l1.rpc-max-batch-size="$L1_RPC_MAX_BATCH_SIZE" \
  --l1.beacon.ignore=true \
  --l1.beacon.slot-duration-override="$L1_BLOCK_TIME" \
  --l2="http://127.0.0.1:${L2_ENGINE_PORT}" \
  --l2.jwt-secret="$JWT_FILE" \
  --l2.enginekind=reth \
  --rollup.config="$ROLLUP" \
  --sequencer.enabled=false \
  --verifier.l1-confs=1 \
  --p2p.disable=true \
  --rpc.addr=127.0.0.1 \
  --rpc.port="$L2_NODE_RPC_PORT" \
  --log.level=info &
NODE_PID=$!

# Waiting for op-node alone can leave a superficially healthy container running
# forever after the EL crashes. Supervise children and propagate op-node's
# status when it is the first process to stop.
while kill -0 "$RETH_PID" 2>/dev/null && kill -0 "$NODE_PID" 2>/dev/null; do
  if [ -n "${ROUTER_PID}" ] && ! kill -0 "$ROUTER_PID" 2>/dev/null; then
    echo "ERROR: L1 RPC router exited while op-node was running" >&2
    exit 1
  fi
  if [ -n "${FILTER_PID}" ] && ! kill -0 "$FILTER_PID" 2>/dev/null; then
    echo "ERROR: RPC method filter exited while op-node was running" >&2
    exit 1
  fi
  sleep "$PROCESS_POLL_INTERVAL_SECS"
done

# Check op-node first: if it has stopped (whether alone or concurrently with
# op-reth), its exit status is the one we want to propagate. Exit immediately
# after reaping op-node — do not wait on RETH_PID here, or a still-running
# EL would block container exit and look healthy while the verifier is dead.
# The EXIT trap's cleanup kills and reaps op-reth. Only when op-node is still
# alive do we know op-reth must be the one that exited, since the loop above
# only breaks once at least one child has died.
if ! kill -0 "$NODE_PID" 2>/dev/null; then
  NODE_EXIT=0
  wait "$NODE_PID" || NODE_EXIT=$?
  exit "$NODE_EXIT"
fi

echo "ERROR: op-reth exited while op-node was running" >&2
wait "$RETH_PID" 2>/dev/null || true
exit 1
