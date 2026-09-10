#!/usr/bin/env bash
# Capture $DATA_DIR/l2/op-reth db/ + static_files/ for a Render/friend restore.
# Sepolia (chain 852) only. READ-ONLY of the live sequencer datadir — never
# --wipe, never write into l2/op-reth. Capture is corrupt-by-design if op-reth
# is running: refuse when the pid file is alive or `op-reth node` is in the
# process table.
#
# Intended operator window (daytime, not 23:45):
#   1. Save labels from RPC (EL still up):
#        curl ... eth_getBlockByNumber latest/safe/finalized → labels.json
#   2. Kickstart sleep (op-reth stops)
#   3. DATA_DIR=… L2_CHAIN_ID=852 ./scripts/snapshot-reth-state.sh --labels-json labels.json
#   4. Kickstart wake (verify from outside)
#
# Do not export FORTEL2_ENV=.env.sepolia (role keys). Output:
#   $DATA_DIR/snapshots/fortel2-852-reth-snapshot-<L2head>.tar.zst
#   matching .sha256 manifest + .json metadata
#
# Restore: fortel2-replica entrypoint-reth.sh (RETH_SNAPSHOT_URL + SHA256).
# Friends / Task 8 use the same tarball. GitHub release assets cap at 2 GiB —
# this script measures and warns.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIN_RETH_VERSION='2.3.0-dev'
PIN_RETH_COMMIT='9384bc53d8c0c77e59cac83fdaaf3b372c6d2216'
GITHUB_ASSET_MAX_BYTES=$((2 * 1024 * 1024 * 1024))
GITHUB_ASSET_WARN_BYTES=$((GITHUB_ASSET_MAX_BYTES - 32 * 1024 * 1024))

usage() {
  cat <<'EOF'
usage: snapshot-reth-state.sh --labels-json PATH [--datadir PATH]

Capture db/ + static_files/ of the Sepolia op-reth datadir while the EL is STOPPED.

  --labels-json PATH   L2 head/safe/finalized as reth reported them (required).
                       Schema: {"l2_head":{"number":N,"hash":"0x…"},
                                "safe":{"hash":"0x…"},
                                "finalized":{"hash":"0x…"}}
  --datadir PATH       Override (must still resolve to $DATA_DIR/l2/op-reth)

Requires DATA_DIR (Sepolia runtime dir) and L2_CHAIN_ID=852. Refuses:
  - op-reth pid alive (pidfile or `op-reth node` process)
  - L2_CHAIN_ID other than 852 / FORTEL2_ENV=.env.sepolia
  - writes into l2/op-reth
  - packing jwt.txt, historical-proofs/, logs/, pids/, or anything outside db/ + static_files/

Output under $DATA_DIR/snapshots/. Prints size + head. Does not upload.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

LABELS_JSON=""
DATADIR_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --labels-json)
      LABELS_JSON="$2"
      shift 2
      ;;
    --datadir)
      DATADIR_ARG="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "${FORTEL2_ENV:-}" in
  .env.sepolia|.env.sepolia.*|/*/.env.sepolia|/*/.env.sepolia.*)
    echo "ERROR: refusing FORTEL2_ENV=${FORTEL2_ENV} — do not load Sepolia role keys" >&2
    echo "Unset FORTEL2_ENV. Export DATA_DIR and L2_CHAIN_ID=852 only." >&2
    exit 2
    ;;
esac

if [[ -z "${DATA_DIR:-}" ]]; then
  echo "ERROR: DATA_DIR must be set to the Sepolia runtime dir (never Phase 1 ./data)" >&2
  exit 2
fi

if [[ "${L2_CHAIN_ID:-}" != "852" ]]; then
  echo "ERROR: Sepolia-only — L2_CHAIN_ID must be 852 (got ${L2_CHAIN_ID:-<unset>})" >&2
  exit 2
fi

if [[ -z "$LABELS_JSON" ]]; then
  echo "ERROR: --labels-json is required (capture while EL is stopped; save latest/safe/finalized before sleep)" >&2
  exit 2
fi

if [[ ! -f "$LABELS_JSON" ]]; then
  echo "ERROR: labels file not found: $LABELS_JSON" >&2
  exit 2
fi

if ! command -v zstd >/dev/null 2>&1; then
  echo "ERROR: zstd is required (brew install zstd / apt install zstd)" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to validate labels and write metadata" >&2
  exit 1
fi

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Canonical live sequencer datadir. Sidecar / spike paths are refused.
SRC="${DATADIR_ARG:-$DATA_DIR/l2/op-reth}"
SRC="${SRC%/}"
ALLOWED="$DATA_DIR/l2/op-reth"
ALLOWED="${ALLOWED%/}"
if [[ "$SRC" != "$ALLOWED" ]]; then
  echo "ERROR: refusing datadir $SRC — capture is $ALLOWED only (not spike-op-reth, not op-geth)" >&2
  exit 2
fi

# Resolve symlinks after the allowlist compare so a symlink *named* op-reth
# still has to live at that path; refuse if it points at op-geth.
if command -v realpath >/dev/null 2>&1; then
  src_real="$(realpath "$SRC" 2>/dev/null || true)"
  if [[ -n "$src_real" && "$src_real" == *"/l2/op-geth"* ]]; then
    echo "ERROR: refusing datadir that resolves to op-geth: $src_real" >&2
    exit 2
  fi
fi

if [[ ! -d "$SRC/db" ]]; then
  echo "ERROR: missing $SRC/db — nothing to capture" >&2
  exit 1
fi

PID_DIR="${PID_DIR:-$DATA_DIR/pids}"
PIDFILE="$PID_DIR/op-reth.pid"
if [[ -f "$PIDFILE" ]]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "ERROR: op-reth is running (pid $pid from $PIDFILE); a tarball taken while the EL is open is corrupt-by-design" >&2
    exit 1
  fi
fi

if command -v pgrep >/dev/null 2>&1; then
  if pgrep -f '[o]p-reth node' >/dev/null 2>&1; then
    echo "ERROR: an 'op-reth node' process is alive; stop the EL before capture" >&2
    exit 1
  fi
fi

HEAD_META="$(python3 - "$LABELS_JSON" <<'PY'
import json, sys

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
head = data.get("l2_head") or {}
number = head.get("number")
h = head.get("hash")
if number is None or not h:
    print("ERROR: labels JSON needs l2_head.number and l2_head.hash", file=sys.stderr)
    sys.exit(2)
try:
    number = int(number)
except (TypeError, ValueError):
    print("ERROR: l2_head.number must be an integer", file=sys.stderr)
    sys.exit(2)
if number < 0:
    print("ERROR: l2_head.number must be >= 0", file=sys.stderr)
    sys.exit(2)
h = str(h).lower()
if not h.startswith("0x") or len(h) != 66:
    print("ERROR: l2_head.hash must be a 0x-prefixed 32-byte hex hash", file=sys.stderr)
    sys.exit(2)
safe = (data.get("safe") or {}).get("hash") or ""
finalized = (data.get("finalized") or {}).get("hash") or ""
print("%s\t%s\t%s\t%s" % (number, h, safe, finalized))
PY
)"

HEAD_NUM="${HEAD_META%%$'\t'*}"
rest="${HEAD_META#*$'\t'}"
HEAD_HASH="${rest%%$'\t'*}"
rest="${rest#*$'\t'}"
SAFE_HASH="${rest%%$'\t'*}"
FINALIZED_HASH="${rest#*$'\t'}"

OUT_DIR="${SNAPSHOT_OUT_DIR:-$DATA_DIR/snapshots}"
mkdir -p "$OUT_DIR"
BASE="fortel2-852-reth-snapshot-${HEAD_NUM}"
ARCHIVE="$OUT_DIR/${BASE}.tar.zst"
MANIFEST="$OUT_DIR/${BASE}.sha256"
META="$OUT_DIR/${BASE}.json"

# Pack from inside the datadir so members are db/ and static_files/ only.
# Never add jwt.txt, historical-proofs/, logs, or pids.
# BSD mktemp requires XXXXXX at the end of the template (no .tar suffix).
tmp_tar="$(mktemp "${TMPDIR:-/tmp}/fortel2-reth-snap.XXXXXX")"
cleanup_tmp() {
  rm -f "$tmp_tar"
}
trap cleanup_tmp EXIT

# COPYFILE_DISABLE / --no-xattrs: macOS bsdtar otherwise injects AppleDouble
# `._*` members (com.apple.provenance) that fail the db/static_files allowlist.
pack_tar() {
  COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar --no-xattrs "$@"
}

pack_tar -C "$SRC" -cf "$tmp_tar" db
if [[ -d "$SRC/static_files" ]]; then
  pack_tar -C "$SRC" -rf "$tmp_tar" static_files
fi

listing="$(tar -tf "$tmp_tar")"
if printf '%s\n' "$listing" | grep -Eiq '(^|/)jwt\.txt$|(^|/)historical-proofs(/|$)|(^|/)pids(/|$)|(^|/)logs(/|$)'; then
  echo "ERROR: archive listing contains jwt.txt / historical-proofs / pids / logs — refuse to write" >&2
  printf '%s\n' "$listing" >&2
  exit 1
fi
extras="$(printf '%s\n' "$listing" | grep -Ev '^(\./)?(db|static_files)(/.*)?$' || true)"
if [[ -n "$extras" ]]; then
  echo "ERROR: archive listing contains paths outside db/ and static_files/" >&2
  printf '%s\n' "$extras" >&2
  exit 1
fi

zstd -q -f -T0 -o "$ARCHIVE" "$tmp_tar"
BYTES="$(wc -c < "$ARCHIVE" | tr -d ' ')"
SHA="$(file_sha256 "$ARCHIVE")"
printf '%s  %s\n' "$SHA" "$(basename "$ARCHIVE")" > "$MANIFEST"

CAPTURED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
RETH_VER=""
if command -v op-reth >/dev/null 2>&1; then
  RETH_VER="$(op-reth --version 2>&1 | tr '\n' ' ' || true)"
fi

python3 - "$META" "$HEAD_NUM" "$HEAD_HASH" "$SAFE_HASH" "$FINALIZED_HASH" \
  "$CAPTURED_AT" "$SHA" "$BYTES" "$ARCHIVE" "$PIN_RETH_COMMIT" "$PIN_RETH_VERSION" \
  "$RETH_VER" <<'PY'
import json, sys

(
    meta_path,
    number,
    head_hash,
    safe_hash,
    finalized_hash,
    captured_at,
    sha256,
    nbytes,
    archive,
    pin_commit,
    pin_version,
    reth_ver,
) = sys.argv[1:]
payload = {
    "chain_id": 852,
    "captured_at": captured_at,
    "reth_pin_version": pin_version,
    "reth_pin_commit": pin_commit,
    "reth_version_text": reth_ver.strip() or None,
    "l2_head": {"number": int(number), "hash": head_hash},
    "safe": {"hash": safe_hash or None},
    "finalized": {"hash": finalized_hash or None},
    "datadir": "l2/op-reth",
    "includes": ["db/", "static_files/"],
    "excludes": ["historical-proofs/", "jwt.txt", "logs/", "pids/"],
    "archive": archive.split("/")[-1],
    "sha256": sha256,
    "bytes": int(nbytes),
    "github_release_limit_bytes": 2147483648,
    "independence": (
        "History is a copy of the sequencer state; independent derivation of "
        "that history was already proven by Task 3 (genesis→safe head parity). "
        "From the snapshot onward the replica derives independently from L1."
    ),
}
with open(meta_path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
PY

echo "snapshot: wrote $ARCHIVE"
echo "snapshot: sha256 $SHA"
echo "snapshot: bytes $BYTES"
echo "snapshot: l2_head $HEAD_NUM $HEAD_HASH"
if [[ -n "$SAFE_HASH" ]]; then
  echo "snapshot: safe $SAFE_HASH"
fi
if [[ -n "$FINALIZED_HASH" ]]; then
  echo "snapshot: finalized $FINALIZED_HASH"
fi
echo "snapshot: manifest $MANIFEST"
echo "snapshot: metadata $META"
echo "snapshot: listing asserted clean (no jwt.txt / historical-proofs / logs / pids)"

if [[ "$BYTES" -ge "$GITHUB_ASSET_MAX_BYTES" ]]; then
  echo "ERROR: archive is $BYTES bytes — GitHub release assets cap at 2 GiB. Split before publishing." >&2
  exit 3
fi
if [[ "$BYTES" -ge "$GITHUB_ASSET_WARN_BYTES" ]]; then
  echo "WARN: archive is $BYTES bytes (within 32 MiB of the 2 GiB GitHub asset cap). Measure before promising a single release asset." >&2
fi

# Unused: keep SCRIPT_DIR referenced so a copy sitting next to lib.sh is obvious.
: "$SCRIPT_DIR"
