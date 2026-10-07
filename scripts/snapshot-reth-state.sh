#!/usr/bin/env bash
# Capture $DATA_DIR/l2/op-reth db/ + static_files/ + rocksdb/ for a Render/friend restore.
# Sepolia (chain 852) only. READ-ONLY of the live sequencer datadir — never
# --wipe, never write into l2/op-reth. Capture is corrupt-by-design if op-reth
# is running: refuse when the pid file is alive or `op-reth node` is in the
# process table.
#
# Intended operator window (daytime, not 23:45):
#   1. Save labels from RPC (EL still up):
#        curl ... eth_getBlockByNumber latest/safe/finalized → labels.json
#   2. Kickstart sleep (op-reth stops)
#   3. DATA_DIR=… L2_CHAIN_ID=852 ./scripts/snapshot-reth-state.sh \
#        --labels-json labels.json --op-reth-bin /path/to/op-reth
#   4. Kickstart wake (verify from outside)
#
# The expected op-reth lines come from scripts/op-reth-pin-check.py
# (VERSION_LINE / COMMIT_LINE). This script does not keep a second copy.
# --version must contain both whole lines or the script exits before any
# archive. --allow-pin-mismatch records reth_pin_match=false and warns.
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
GITHUB_ASSET_MAX_BYTES=$((2 * 1024 * 1024 * 1024))
GITHUB_ASSET_WARN_BYTES=$((GITHUB_ASSET_MAX_BYTES - 32 * 1024 * 1024))

usage() {
  cat <<'EOF'
usage: snapshot-reth-state.sh --labels-json PATH --op-reth-bin PATH [--datadir PATH] [--allow-pin-mismatch]

Capture db/ + static_files/ + rocksdb/ of the Sepolia op-reth datadir while the EL is STOPPED.

  --labels-json PATH   L2 head/safe/finalized as reth reported them (required).
                       Schema: {"l2_head":{"number":N,"hash":"0x…"},
                                "safe":{"hash":"0x…"},
                                "finalized":{"hash":"0x…"}}
  --op-reth-bin PATH   op-reth binary this capture describes (required).
                       Runs PATH --version. Both expected whole lines must
                       appear. The lines are VERSION_LINE and COMMIT_LINE in
                       scripts/op-reth-pin-check.py.
  --datadir PATH       Override (must still resolve to $DATA_DIR/l2/op-reth)
  --allow-pin-mismatch Record reth_pin_match=false and continue. Default is
                       to refuse, before any archive, when --version does not
                       contain both expected lines.

Requires DATA_DIR (Sepolia runtime dir) and L2_CHAIN_ID=852. Refuses:
  - op-reth pid alive (pidfile or `op-reth node` process)
  - L2_CHAIN_ID other than 852 / FORTEL2_ENV=.env.sepolia
  - writes into l2/op-reth
  - packing jwt.txt, historical-proofs/, logs/, pids/, exex/, blobstore/, or anything outside db/ + static_files/ + rocksdb/

Output under $DATA_DIR/snapshots/. Prints size + head. Does not upload.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

LABELS_JSON=""
DATADIR_ARG=""
OP_RETH_BIN=""
ALLOW_PIN_MISMATCH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --labels-json)
      LABELS_JSON="${2:-}"
      shift 2
      ;;
    --op-reth-bin)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --op-reth-bin requires a path" >&2
        usage >&2
        exit 2
      fi
      OP_RETH_BIN="$2"
      shift 2
      ;;
    --datadir)
      DATADIR_ARG="${2:-}"
      shift 2
      ;;
    --allow-pin-mismatch)
      ALLOW_PIN_MISMATCH=1
      shift
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

if [[ -z "$OP_RETH_BIN" ]]; then
  echo "ERROR: --op-reth-bin is required (path to the op-reth binary this capture describes)" >&2
  usage >&2
  exit 2
fi

# -f/-x on a slashless name inspect ./name, but Bash executes a slashless
# command via PATH. Run the file that was checked. Metadata still stores
# the path the operator passed.
if [[ "$OP_RETH_BIN" == */* ]]; then
  OP_RETH_EXEC="$OP_RETH_BIN"
else
  OP_RETH_EXEC="./$OP_RETH_BIN"
fi

# Pin check before the running-EL refusal and before any archive. A running
# EL still refuses below, after this check, so a matching binary cannot pack
# while op-reth is up. An empty expected line would match every binary, so a
# failed import or a blank VERSION_LINE / COMMIT_LINE refuses.
snap_work=""
tmp_tar=""
cleanup_tmp() {
  if [[ -n "${tmp_tar}" ]]; then
    rm -f "$tmp_tar"
  fi
  if [[ -n "${snap_work}" ]]; then
    rm -rf "$snap_work"
  fi
}
trap cleanup_tmp EXIT

if [[ ! -f "$OP_RETH_EXEC" || ! -x "$OP_RETH_EXEC" ]]; then
  echo "ERROR: --op-reth-bin is not an executable file: $OP_RETH_BIN" >&2
  exit 1
fi

PIN_CHECK="$SCRIPT_DIR/op-reth-pin-check.py"
if [[ ! -f "$PIN_CHECK" ]]; then
  echo "ERROR: missing $PIN_CHECK; refusing an empty pin (an empty expected line would match every binary)" >&2
  exit 1
fi

snap_work="$(mktemp -d "${TMPDIR:-/tmp}/fortel2-reth-pin.XXXXXX")"
version_file="$snap_work/version.txt"
pin_result="$snap_work/pin.json"
if ! "$OP_RETH_EXEC" --version >"$version_file" 2>&1; then
  echo "ERROR: $OP_RETH_BIN --version failed; refusing before any archive" >&2
  exit 1
fi
if ! python3 - "$PIN_CHECK" "$version_file" "$pin_result" "$ALLOW_PIN_MISMATCH" <<'PY'
import contextlib
import importlib.util
import io
import json
import sys
from pathlib import Path

pin_path, version_path, result_path, allow_flag = sys.argv[1:5]
allow = allow_flag == "1"

def die(message):
    print("ERROR: %s" % message, file=sys.stderr)
    raise SystemExit(1)

spec = importlib.util.spec_from_file_location("op_reth_pin_check", pin_path)
if spec is None or spec.loader is None:
    die(
        "cannot load %s; refusing an empty pin "
        "(an empty expected line would match every binary)" % pin_path
    )
module = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(module)
except Exception as exc:
    die(
        "import of op-reth pin check failed (%s); refusing an empty pin "
        "(an empty expected line would match every binary)" % exc
    )

def require_line(name):
    value = getattr(module, name, None)
    if not isinstance(value, str) or value == "" or "\n" in value or "\r" in value:
        die(
            "%s from %s is missing or empty; refusing because an empty "
            "expected line would match every binary" % (name, pin_path)
        )
    return value

version_line = require_line("VERSION_LINE")
commit_line = require_line("COMMIT_LINE")
if not hasattr(module, "check_text"):
    die("op-reth pin check has no check_text; refusing an empty pin")
text = Path(version_path).read_text(encoding="utf-8", errors="replace")
stdout_buf = io.StringIO()
stderr_buf = io.StringIO()
with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
    matched = bool(module.check_text(text))
if matched:
    sys.stdout.write(stdout_buf.getvalue())
else:
    err = stderr_buf.getvalue()
    if err:
        sys.stderr.write(err)
    else:
        print("ERROR: op-reth pin mismatch", file=sys.stderr)
    if not allow:
        raise SystemExit(1)
Path(result_path).write_text(
    json.dumps(
        {
            "match": matched,
            "version_line": version_line,
            "commit_line": commit_line,
        }
    ),
    encoding="utf-8",
)
PY
then
  echo "ERROR: refusing before any archive" >&2
  exit 1
fi

pin_match="$(python3 -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); print("true" if data.get("match") is True else "false" if data.get("match") is False else "bad")' "$pin_result")" || {
  echo "ERROR: could not read pin result; refusing before any archive" >&2
  exit 1
}
if [[ "$pin_match" == "false" ]]; then
  echo "WARN: op-reth pin mismatch; recording reth_pin_match=false (--allow-pin-mismatch)" >&2
elif [[ "$pin_match" != "true" ]]; then
  echo "ERROR: pin result match flag is not true or false; refusing before any archive" >&2
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

# Pack from inside the datadir so members are db/, static_files/, rocksdb/ only.
# rocksdb/ is a first-class datadir store (--datadir.rocksdb), not a cache.
# Never add jwt.txt, historical-proofs/, logs, or pids.
# BSD mktemp requires XXXXXX at the end of the template (no .tar suffix).
tmp_tar="$(mktemp "${TMPDIR:-/tmp}/fortel2-reth-snap.XXXXXX")"

# COPYFILE_DISABLE / --no-xattrs: macOS bsdtar otherwise injects AppleDouble
# `._*` members (com.apple.provenance) that fail the db/static_files/rocksdb allowlist.
pack_tar() {
  COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar --no-xattrs "$@"
}

pack_tar -C "$SRC" -cf "$tmp_tar" db
if [[ -d "$SRC/static_files" ]]; then
  pack_tar -C "$SRC" -rf "$tmp_tar" static_files
fi
if [[ -d "$SRC/rocksdb" ]]; then
  pack_tar -C "$SRC" -rf "$tmp_tar" rocksdb
fi

listing="$(tar -tf "$tmp_tar")"
if printf '%s\n' "$listing" | grep -Eiq '(^|/)jwt\.txt$|(^|/)historical-proofs(/|$)|(^|/)pids(/|$)|(^|/)logs(/|$)'; then
  echo "ERROR: archive listing contains jwt.txt / historical-proofs / pids / logs — refuse to write" >&2
  printf '%s\n' "$listing" >&2
  exit 1
fi
extras="$(printf '%s\n' "$listing" | grep -Ev '^(\./)?(db|static_files|rocksdb)(/.*)?$' || true)"
if [[ -n "$extras" ]]; then
  echo "ERROR: archive listing contains paths outside db/, static_files/, and rocksdb/" >&2
  printf '%s\n' "$extras" >&2
  exit 1
fi

zstd -q -f -T0 -o "$ARCHIVE" "$tmp_tar"
BYTES="$(wc -c < "$ARCHIVE" | tr -d ' ')"
SHA="$(file_sha256 "$ARCHIVE")"
printf '%s  %s\n' "$SHA" "$(basename "$ARCHIVE")" > "$MANIFEST"

CAPTURED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

INCLUDES='["db/"'
if [[ -d "$SRC/static_files" ]]; then
  INCLUDES+=', "static_files/"'
fi
if [[ -d "$SRC/rocksdb" ]]; then
  INCLUDES+=', "rocksdb/"'
fi
INCLUDES+=']'

python3 - "$META" "$HEAD_NUM" "$HEAD_HASH" "$SAFE_HASH" "$FINALIZED_HASH" \
  "$CAPTURED_AT" "$SHA" "$BYTES" "$ARCHIVE" "$pin_result" "$version_file" \
  "$OP_RETH_BIN" "$INCLUDES" <<'PY'
import json, sys
from pathlib import Path

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
    pin_result,
    version_file,
    op_reth_bin,
    includes_json,
) = sys.argv[1:]
pin = json.loads(Path(pin_result).read_text(encoding="utf-8"))
version_line = pin.get("version_line")
commit_line = pin.get("commit_line")
if not isinstance(version_line, str) or version_line == "":
    print("ERROR: pin result version line is empty; refusing to write metadata", file=sys.stderr)
    sys.exit(1)
if not isinstance(commit_line, str) or commit_line == "":
    print("ERROR: pin result commit line is empty; refusing to write metadata", file=sys.stderr)
    sys.exit(1)
if pin.get("match") not in (True, False):
    print("ERROR: pin result match flag is missing", file=sys.stderr)
    sys.exit(1)
payload = {
    "chain_id": 852,
    "captured_at": captured_at,
    "op_reth_bin": op_reth_bin,
    "reth_expected_version_line": version_line,
    "reth_expected_commit_line": commit_line,
    "reth_version_text": Path(version_file).read_text(encoding="utf-8", errors="replace"),
    "reth_pin_match": pin["match"],
    "l2_head": {"number": int(number), "hash": head_hash},
    "safe": {"hash": safe_hash or None},
    "finalized": {"hash": finalized_hash or None},
    "datadir": "l2/op-reth",
    "includes": json.loads(includes_json),
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
