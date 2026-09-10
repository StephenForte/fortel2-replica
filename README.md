# ForteL2 replica

A standalone **node** for the [ForteL2](https://github.com/StephenForte/ForteL2) learning L2 (chain ID **852**) that derives L2 state from **Ethereum Sepolia**.

This is now **its own project** — split out of the ForteL2 monorepo into a self-contained repository you can clone, run, and deploy on its own. It runs a **verifier** (op-reth + op-node) and is the package you give friends / deploy on Render. Local compose still uses `--full` (prune). The Render reth replica is **archive** (`RETH_ARCHIVE=1`, omit `--full`) so restored historical receipts/logs survive (D-0126). It is **not** the sequencer, batcher, proposer, or dApp — and it never needs operator private keys.

| Component | Role |
|---|---|
| op-reth | L2 execution (local `--full`; Render replica archive via `RETH_ARCHIVE=1`; no proofs store) |
| op-node | Verifier — derives L2 from L1 batches (`--l2.enginekind=reth`) |

Pinned images (immutable digest, D-0109 / R-0013): `Dockerfile.reth` uses `op-reth:v2.3.3` (`Reth Version: 2.3.0-dev` commit `9384bc53…`) and `op-node:v1.19.2`. That entrypoint fails closed if the binary is not that pin. Live `./Dockerfile` stays main's `op-geth:v1.101702.2` image (R-0013) so a main deploy cannot swap the live EL.

**Task 7 (in progress):** a **new** Render pserv `fortel2-replica-reth` (`Dockerfile.reth`) + 10 GB disk + staging gateway `fortel2-replica-reth-rpc`. The live geth pserv `fortel2-replica` and its 50 GB disk stay up until Phase C (routing flip + rename-swap). Phase B evidence on the snapshot-restored archive replica is in [`docs/2026-09-10-op-reth-phase-b.md`](./docs/2026-09-10-op-reth-phase-b.md) (R-0016).

**Status (Phase 3):** Operator-verified on Render against a fresh Phase 2b cutover — matching L2 block hashes with the Mac sequencer. Genesis/rollup in `config/` must stay in lockstep with ForteL2 after any Sepolia redeploy.

Handing this to a friend? See [`RUNNING.md`](./RUNNING.md) for a full walkthrough of running your own node.

## Quick start (laptop / VPS)

Needs Docker Compose and ~2 GB RAM. Foundry (`cast`) is optional. This path is **raw** op-reth + op-node on the host — not the Render method filter. Local smoke on publicnode may stall (D-0105: 0 receipts); use a receipts-capable Sepolia URL for a real sync.

```bash
git clone https://github.com/StephenForte/fortel2-replica.git
cd fortel2-replica
cp .env.example .env
# .env already has a public Sepolia URL for smoke tests; swap L1_RPC_URL
# for a dedicated provider if you will leave it running.
openssl rand -hex 32 > jwt.txt && chmod 600 jwt.txt
docker compose up -d
```

- L2 execution RPC: `http://127.0.0.1:9545`
- op-node RPC: `http://127.0.0.1:9547`

```bash
curl -s http://127.0.0.1:9545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# → {"result":"0x354"}  (852)

curl -s http://127.0.0.1:9547 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"optimism_syncStatus","params":[]}' | jq \
  '{current_l1:.result.current_l1.number, head_l1:.result.head_l1.number, safe_l2:.result.safe_l2.number}'
```

`current_l1` should climb toward `head_l1` right away. `safe_l2` staying `0` until derivation reaches posted batches is normal. Full walkthrough: [`RUNNING.md`](./RUNNING.md).

## Read RPC (live: Private Service)

The live Render deploy is a **Private Service** (`fortel2-replica`, `srv-d9fsgi3rjlhs73ceh6tg`, Oregon env `evm-d9h424715fvs73cq2gl0`). Public reads are two diskless Web Services on that same network (ForteL2 D-0031): `https://fortel2-replica-rpc.onrender.com` (L1-derived) and `https://fortel2-sequencer-rpc.onrender.com` (sequencer tip). SettlementOS still reads at `http://fortel2-replica:10000` (D-0032).

Clients on that network hit a **method-filter** on Render’s published `PORT` (default **10000**). The EL listens on loopback only (`127.0.0.1:8546`); op-node RPC is loopback-only (`127.0.0.1:9545`) and must never be exposed. Until Phase C the live pserv is still op-geth; the new pserv is op-reth.

| Fact | Detail |
|---|---|
| URL | Private: `http://fortel2-replica:10000`. Public replica: `https://fortel2-replica-rpc.onrender.com` (diskless gateway — see [Going public](#going-public)). Do not convert this replica. |
| Surface | Read-only JSON-RPC allowlist (`eth` / `net` / `web3` reads + log/block filters) |
| Writes | `eth_sendRawTransaction` is **rejected** (`-32601 method not allowed`) |
| Lag | ~3 minutes behind the sequencer is **normal** — the replica derives from L1 batches, not P2P tip-follow |
| Nightly window | Sequencer sleeps **23:45–03:00** `America/Los_Angeles`. The replica keeps serving whatever tip it already derived; new L2 progress pauses until the sequencer posts batches again after wake |
| Filters | `eth_newFilter` / `eth_newBlockFilter` IDs are in-memory and die on every deploy/restart — clients must re-create on filter-not-found (not an outage) |
| Rate limiting | On the replica itself: Render platform DDoS only — **no per-RPC / per-IP request rate limit** on Standard. Do **not** add an in-process limiter to `rpc-method-filter.py`. Per-IP limits belong on the diskless public gateway (and optional Cloudflare). |

Filter source: vendored from ForteL2 `scripts/rpc-method-filter.py` (see header in `rpc-method-filter.py`). **Security fixes must be applied in both repos** (ForteL2 first, then copy here).

### Do not convert this service to Web

Render cannot flip Private ↔ Web in place, and **cannot reattach `/data` to a new service**. The live disk is **50 GB**. Do not apply `render.yaml` as a **new** Blueprint onto the live Oregon pserv (`type: pserv` / `sizeGB: 20` would create a second replica with an empty disk and a full L1 resync).

A public URL is a **second, diskless** Web Service that proxies to this Private Service — not a new EL disk. See [Going public](#going-public). Task 7 staging reads use `fortel2-replica-reth-rpc` → `http://fortel2-replica-reth:10000` and must not replace the live public hostname.

### Revert

If a mistaken public replica (Web Service + its own disk) is created: delete that extra service. The live Private Service and its 50 GB `/data` stay as they are. Recreating `fortel2-replica` itself still means a **new disk and a full resync** — do not do that to “go private again.” To take a public gateway down, delete or suspend only `fortel2-replica-rpc` (or disable its custom domain). There is no `render.yaml` entry to remove — the gateway was never declared there (R-0008). SettlementOS keeps using `http://fortel2-replica:10000`.

## Task 7 — new op-reth replica (R-0013)

Operator-applied Blueprint additions. Do **not** re-apply the live `fortel2-replica` entry.

| Service | Type | Disk | Role |
|---|---|---|---|
| `fortel2-replica` | pserv (live, frozen) | `fortel2-replica-data` 50 GB | `./Dockerfile` (op-geth v1.101702.2). Do not point this service at `Dockerfile.reth`. |
| `fortel2-replica-reth` | pserv (new) | `fortel2-replica-reth-data` 10 GB | `Dockerfile.reth`. op-reth archive (`RETH_ARCHIVE=1`, omit `--full`). Bootstrap = snapshot restore (R-0014); set archive **before** first restore boot (a pruned datadir cannot be un-pruned). `L1_RPC_FORCE=public` after restore. |
| `fortel2-replica-reth-rpc` | web (staging, diskless) | none | Pre-repoint verification only. `REPLICA_UPSTREAM=http://fortel2-replica-reth:10000`. |
| `fortel2-replica-rpc` | web (live, Dashboard) | none | Public hostname — unchanged until Phase C env flip. |

Phase C (Steve-approved window): flip live gateway `REPLICA_UPSTREAM` → rename-swap (`fortel2-replica` → `fortel2-replica-geth`, `fortel2-replica-reth` → `fortel2-replica`) so SOS keeps `http://fortel2-replica:10000`. Rollback = reverse both; no disk mutation. Suspend the old service after 24 h; do not delete it.

### Snapshot bootstrap (R-0014 / D-0123)

Do not finish the from-genesis metered derive. Capture the Mac sequencer's `$DATA_DIR/l2/op-reth` **only while op-reth is stopped**, restore onto `fortel2-replica-reth`, then tip-follow on publicnode.

**Capture (operator, ~5 min, daytime — not 23:45):**

```bash
# 1. Save labels while the EL is still up (do not print JWT / L1 URLs)
python3 - <<'PY' > /tmp/fortel2-reth-labels.json
import json, urllib.request
url = "http://127.0.0.1:9545"
def blk(tag):
    body = json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":[tag, False]}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type":"application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=5).read())["result"]
latest, safe, finalized = blk("latest"), blk("safe"), blk("finalized")
json.dump({
    "l2_head": {"number": int(latest["number"], 16), "hash": latest["hash"]},
    "safe": {"hash": safe["hash"]},
    "finalized": {"hash": finalized["hash"]},
}, open("/dev/stdout","w"), indent=2)
print()
PY
# 2. Kickstart sleep (op-reth stops). Then:
unset FORTEL2_ENV
export DATA_DIR=… L2_CHAIN_ID=852   # Sepolia runtime dir
./scripts/snapshot-reth-state.sh --labels-json /tmp/fortel2-reth-labels.json
# 3. Kickstart wake. Verify the sequencer from outside.
```

The script refuses if the op-reth pid is alive. It packs `db/` + `static_files/` + `rocksdb/` (`--datadir.rocksdb` is a live store, not a cache). It writes `$DATA_DIR/snapshots/fortel2-852-reth-snapshot-<L2head>.tar.zst` plus `.sha256` and `.json`. Publish the tarball as a GitHub Release asset **only if it is under 2 GiB** (the script prints `bytes` and errors at the cap). The ForteL2 copy of this helper belongs at `scripts/snapshot-reth-state.sh` in that repo (this agent cannot push there).

**Mini dry-run (before Render):** restore the tarball into `$DATA_DIR/l2/spike-op-reth` (Task 2 throwaway), start with `FORTEL2_RETH_PROFILE=verifier ./scripts/start-op-reth-verifier.sh` (sidecar ports, publicnode L1). Prove (4) reth accepts the archive-captured datadir and (5) op-node starts derivation at an L1 origin near the capture-time safe head — not genesis `11545587`. Then `verify-reth-parity.sh` for ≥20 blocks. Stop and wipe the throwaway. The Mini `--full` dry-run proved restore + resume, but `--full` pruned historical receipts — **do not restore Render as `--full`**. Set `RETH_ARCHIVE=1` before the restore boot (D-0126). If the datadir is refused, or op-node walks from genesis, **stop and report**.

**Render:** dashboard-only env on `fortel2-replica-reth` (never Blueprint `value:`):

| Key | Value |
|---|---|
| `RETH_ARCHIVE` | `1` **before** restore — omit `--full` so historical receipts/logs/tx-lookup survive. Also removes a stale `$DATA_DIR/reth.toml` `[prune]` section left by a prior `--full` boot (omitting `--full` alone does not). Unset/0 = `--full` prune (irreversible). Other values exit 1. |
| `RETH_SNAPSHOT_URL` | HTTPS URL of the `.tar.zst` release asset |
| `RETH_SNAPSHOT_SHA256` | 64 hex chars from the `.sha256` manifest |
| `RETH_SNAPSHOT_FORCE` | `1` once to replace the paused 68 % `db/` + `static_files/` + `rocksdb/`; **unset after that boot** |
| `L1_RPC_FORCE` | `public` after restore (tip-follow) |

First restore boot logs: pin ok → genesis ok → download → sha256 ok → restore ok → op-node deriving near tip. `FORCE` replaces `db/` + `static_files/` + `rocksdb/` on this pserv **only after** extract succeeds; it never touches live geth. A FORCE failure leaves the paused derive in place.

History in the tarball is a copy of the sequencer. Independent derivation of that history was Task 3. From the snapshot onward this replica derives from L1. Friends (Task 8) reuse the same tarball + restore path.

## Going public

Keep the live Private Service and its 50 GB disk. Public replica reads go through the diskless Web Service `fortel2-replica-rpc` (`https://fortel2-replica-rpc.onrender.com`), which reverse-proxies to `http://fortel2-replica:10000` and rate-limits. SettlementOS stays on the private URL. The table below is that service's config — recreate from it only in a new environment.

**Repo first, then Dashboard.** The gateway image is `./gateway/Dockerfile` (build context `./gateway`; see [`gateway/README.md`](./gateway/README.md)). Live replica image is `./Dockerfile` (op-geth, unchanged). Task 7 image is `Dockerfile.reth` (op-reth + op-node). Pointing a Web Service at either replica path would boot a **second public verifier**. The Task 7 staging gateway is declared as `fortel2-replica-reth-rpc` in `render.yaml` (R-0013); live `fortel2-replica-rpc` stays Dashboard-created.

This section is the operator's entire configuration path. Gateway env is **not synced from `render.yaml`** — the gateway is not declared there (R-0008). Changing a key in the Dashboard means editing the table below too; nothing will catch the drift.

### Dashboard

Same GitHub repo, **second** service, same Oregon env as `fortel2-replica`. Live as `fortel2-replica-rpc` (`https://fortel2-replica-rpc.onrender.com`). Dashboard-created and unattached — do not attach it (or the replica) to this Blueprint.

| Field | Value |
|---|---|
| Create | **New → Web Service** (not **New → Blueprint**). A Blueprint apply cannot add a service into the existing Oregon environment alongside the unattached live pserv — it creates its own services, which is a second replica plus a gateway pointed at that new replica, not at the live 50 GB node (R-0008 / ForteL2 D-0031). |
| Repo | `StephenForte/fortel2-replica` |
| Name | `fortel2-replica-rpc` (never reuse `fortel2-replica`) |
| Region | **Oregon** (private DNS fails across regions) |
| Disk | **None** |
| Dockerfile path | `./gateway/Dockerfile` (not `./Dockerfile`) |
| Docker build context | `./gateway` |
| Health Check Path | `/healthz` |
| Env | Paste every row of the table below **except** `PORT`. Render injects `PORT`; do not set it. |
| Plan | Starter or higher (Free spins down after 15 minutes) |

If the first deploy fails because `gateway/` is missing from the tracked branch: leave Dockerfile Path as `./gateway/Dockerfile` and wait for that path to land. Do not “fix” that by switching back to `./Dockerfile`.

Gateway env (R-0005). This table is the authoritative operator copy — paste into **Environment**.

| Key | Default | Meaning |
|---|---|---|
| `PORT` | Render-injected | nginx listen port (not declared in `render.yaml`) |
| `REPLICA_UPSTREAM` | `http://fortel2-replica:10000` | upstream origin, scheme included (R-0004) |
| `RPC_RATE` | `20r/s` | `limit_req_zone` rate |
| `RPC_BURST` | `40` | `limit_req` burst |
| `RPC_REAL_IP_HEADER` | `CF-Connecting-IP` | header carrying the client IP. Render's edge is always Cloudflare; this is the default, not an optional override (R-0006 / R-0010). Set `X-Forwarded-For` only if you need the chain. |
| `RPC_MAX_BODY` | `1m` | `client_max_body_size`, matched to the filter's `MAX_BODY_BYTES` (1 MiB) |

After deploy, verify that rate limiting keys on the real client IP — see [`gateway/README.md`](./gateway/README.md). Do not skip that check; a wrong key puts every client in one bucket.

### Rate limit / DDoS

| Layer | Role |
|---|---|
| Cloudflare (optional) | Volumetric DDoS. CNAME the custom domain to the `onrender.com` hostname, orange-cloud. Add a WAF rate-limit rule (e.g. 20 req/s per IP, burst 40). |
| Gateway `limit_req` | Per-IP HTTP limit on the diskless Web Service (JSON-RPC batches count as one HTTP request). |
| Method filter | Writes, admin/debug/txpool, oversize/chunked bodies (1 MiB). Already on the replica. |
| Render edge | Platform DDoS only — no per-RPC / per-IP limit on Standard. |

Do not put a token bucket inside `rpc-method-filter.py`.

First version limits HTTP requests per IP only (R-0007). There is no method-level or cost-aware limiting — `eth_getLogs`, `eth_call`, and `eth_getProof` stay allowlisted and unweighted, and a JSON-RPC batch counts as one HTTP request. A client can still buy expensive work per request within the rate limit.

### Smoke test (once the gateway is live)

```bash
# health check
curl -sS https://fortel2-replica-rpc.onrender.com/healthz
# chain id 852
curl -s https://fortel2-replica-rpc.onrender.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# writes still rejected
curl -s https://fortel2-replica-rpc.onrender.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x"]}'
# private path unchanged
curl -s http://fortel2-replica:10000 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

Expect a healthy `/healthz`, `result: "0x354"` on reads, `-32601 method not allowed` on `eth_sendRawTransaction`, and HTTP `429` under a burst. Lag and the sequencer sleep window are the same as the private replica (~3 minutes behind; 23:45–03:00 Pacific).

## Public sequencer reads

The replica gateway above is L1-derived (~3 minutes behind the sequencer tip). SettlementOS Explorer needs a just-settled escrow hash in **seconds**, not minutes. Do **not** point the browser at `https://fortel2-write.ente.ltd` (Cloudflare Access 403; it accepts writes). Do **not** retarget `fortel2-replica-rpc` at the sequencer (R-0009).

A third diskless Web Service (`fortel2-sequencer-rpc`, `https://fortel2-sequencer-rpc.onrender.com`) runs the same method filter against the Access-gated sequencer. Browsers talk to this URL; Access headers stay on the server. The table below is that service's config.

### Dashboard

Same GitHub repo, **third** service, same Oregon env. Live as `fortel2-sequencer-rpc`. Dashboard-created — **New → Web Service**, unattached (R-0008). Python native, not Docker (the replica `Dockerfile` would boot a second verifier).

| Field | Value |
|---|---|
| Create | **New → Web Service** (not Blueprint, not the replica Dockerfile) |
| Repo | `StephenForte/fortel2-replica` |
| Name | `fortel2-sequencer-rpc` (never reuse `fortel2-replica` or `fortel2-replica-rpc`) |
| Region | **Oregon** |
| Runtime | **Python 3** |
| Build command | `python3 --version` |
| Start command | `sh sequencer-read/start.sh` |
| Health Check Path | `/` |
| Disk | **None** |
| Plan | Starter or higher (Free spins down after 15 minutes) |

Env (R-0009). Paste into **Environment**. Copy `CF_ACCESS_*` from SettlementOS — same service token, never commit, never `VITE_*`.

| Key | Value | Meaning |
|---|---|---|
| `PORT` | Render-injected | filter listen port; `start.sh` binds `0.0.0.0:$PORT` |
| `L2_RPC_FILTER_UPSTREAM` | `https://fortel2-write.ente.ltd` | sequencer JSON-RPC (Access-gated) |
| `L2_RPC_FILTER_REMOTE_UPSTREAM_HOSTS` | `fortel2-write.ente.ltd` | exact-hostname allowlist; unset keeps the replica loopback-only |
| `CF_ACCESS_CLIENT_ID` | from SettlementOS | Cloudflare Access service token id |
| `CF_ACCESS_CLIENT_SECRET` | from SettlementOS | Cloudflare Access service token secret |

SettlementOS **writes** stay on `fortel2-write.ente.ltd` + Access. SettlementOS **reads** stay on `http://fortel2-replica:10000`. The explorer puts this public URL **first** and `https://fortel2-replica-rpc.onrender.com` second (fallback when the sequencer is in its overnight window).

### Smoke test

```bash
# health (does not hit the sequencer)
curl -sS https://fortel2-sequencer-rpc.onrender.com/
# chain id 852
curl -s https://fortel2-sequencer-rpc.onrender.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# writes still rejected here — never forwarded
curl -s https://fortel2-sequencer-rpc.onrender.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x"]}'
```

Expect `{"ok":true,...}`, `result: "0x354"`, and `-32601 method not allowed` on the write. Tip reads should match the sequencer, not the replica head.

**Rate limit.** None in-process (R-0003). Render platform DDoS only until a `gateway/` nginx is put in front. The sequencer sleep window is **23:45–03:00** `America/Los_Angeles` — this door 502s/403s then; the explorer falls back to the replica.

## Render

**RAM:** Render **Starter (512MB) will OOM**. Use at least **Standard (~2GB)** for op-reth + op-node (+ optional L1 router) in one container. Live geth policy remains **Wave 1 on Standard** (R-0012) until Phase C. The new reth pserv starts on Standard; **do not change the plan until Phase B measures RSS**. Pinned op-reth defaults `--engine.cross-block-cache-size` to 4096 MB — that OOMs Standard. Set `RETH_CROSS_BLOCK_CACHE_MB=256` (R-0013). Mini archive RSS was 1.4 GB (D-0122); the Render reth replica is archive (`RETH_ARCHIVE=1`), not `--full`.

**OOM during derivation:** Logs like `decoded singular batch from channel` during L1 catch-up are normal but memory-heavy — op-node decodes batches in bursts while geth applies them. The usual 2 GB killer is op-node’s upstream `--l1.cache-size=900` (full L1 receipts), not the Python filter. Wave 1 (PR #39) is already in the tables below: `L1_CACHE_SIZE=128`, `L1_MAX_CONCURRENCY=2`, `L1_RPC_MAX_BATCH_SIZE=5`, `GETH_FDLIMIT=4096`, `--cache.noprefetch`. Measured 2026-08-17: catch-up RSS stayed **256–478 MB** for 12h after Wave 1 (Wave 0 peak was 2,125 MB, then exit 137).

If it OOMs again (exit 137 / “Ran out of memory”), confirm the plan is Standard (not Starter) and Wave 1 knobs are actually on the **dashboard** (this service is unattached — `render.yaml` does not sync). Then score a catch-up window (L2 `age` still hours/days, ignore the first 10 minutes after a deploy):

| Peak RSS while catching up | Do |
|---|---|
| Under 1,600 MB | Nothing. Wave 1 is holding. |
| Sustained 1,600–1,900 MB, CPU &lt; 70% | **Wave 2** env only: `GETH_CACHE_MB=64`, `GETH_GOMEMLIMIT=512MiB`, `OP_NODE_GOMEMLIMIT=512MiB`, `GOGC=50`. Revert if CPU pegs. |
| ≥2,000 MB or another 137 after Wave 1 | Skip Wave 2 → **Pro (4 GB)**. |

Never set `L1_CACHE_SIZE=0` (op-node expands that to ~2400). Do not tighten `GOMEMLIMIT` until the L1 cache is already 128.

**Daily check:** Cloud Agent **Daily replica health** (04:00 Pacific) reads last-24h replica RSS and QuickNode credits on **L2_Render** (this replica) vs **L2_mini** (sequencer). Warn if either endpoint or combined credits exceed ~3M/day. It uses Cloud Render plus QuickNode (skill `.cursor/skills/daily-replica-health`). The verdict is the automation's run transcript. It suggests Wave 2 — it does not change env or deploy. Do not run a local overnight loop.

### Blueprint vs dashboard-created services

`render.yaml` is the canonical copy of the **replica's** env values and a reference for a **greenfield** replica. It is **not** the deployment mechanism for anything that currently exists. Live `fortel2-replica`, `fortel2-replica-rpc`, and `fortel2-sequencer-rpc` are Dashboard-created and **unattached** to any Blueprint, permanently and by design (R-0008). Do not apply this file as a new Blueprint onto the live Oregon environment — that creates a second replica with an empty disk, not a gateway in front of the live node.

The `sync: false` / Blueprint-sync mechanics below stay accurate, but they describe a path nobody live is on. They matter only if you ever stand up a *new* private replica from **New → Blueprint** (not this live one, and not as a way to add the gateway).

**If a service is attached to this Blueprint** (greenfield replica only):

- Env vars with a literal `value:` in `render.yaml` are created/updated on each Blueprint sync.
- Keys with `sync: false` (`L1_RPC_URL`, `JWT_SECRET`) are prompted **only on first create**. Later syncs ignore them — set or rotate those secrets in the dashboard (**Environment**).
- Dashboard edits that conflict with Blueprint `value:` fields are overwritten on the next sync.

**Dashboard-created (unattached):** the live replica, the replica gateway, and the sequencer-read door. **New → Private Service** (replica) or **New → Web Service** (gateway / sequencer-read) without going through this Blueprint is not managed by `render.yaml`. Git pushes / Manual Deploy do **not** apply Blueprint env changes — paste the replica tables below into **Environment**, then redeploy. Gateway env is the table in [Going public](#going-public); sequencer-read env is the table in [Public sequencer reads](#public-sequencer-reads).

Genesis + rollup are **baked into the image** from `config/` — no secret-file upload needed.

Live `fortel2-replica` is already that Private Service (op-geth, until Phase C). **Do not deploy this op-reth image onto it.** Task 7 stands up `fortel2-replica-reth` on a new disk. A public URL is a **separate diskless Web Service** ([Going public](#going-public)), not a second copy of this replica. Staging verification uses `fortel2-replica-reth-rpc`.

#### Required secrets (`sync: false` in Blueprint)

| Variable | Example / notes |
|---|---|
| `L1_RPC_URL` | Render-only **QuickNode** Sepolia HTTPS URL (not the Mac mini endpoint). Required when `L1_RPC_SCHEDULE=business`. |
| `JWT_SECRET` | Optional. 64 hex chars to pin JWT across redeploys; omit to auto-generate on `/data`. |

#### Recommended env vars (match `render.yaml` `value:` keys)

On a Blueprint-managed service these come from sync. On a dashboard-created service, copy into **Environment → Environment Variables**:

| Variable | Value |
|---|---|
| `L1_BLOCK_TIME` | `12` |
| `GETH_CACHE_MB` | `128` (live geth only; ignored by op-reth) |
| `GETH_FDLIMIT` | `4096` (live geth only) |
| `GETH_GOMEMLIMIT` | `700MiB` (live geth only) |
| `RETH_CROSS_BLOCK_CACHE_MB` | `256` (new reth pserv — replaces `GETH_CACHE_MB`) |
| `RETH_RPC_CACHE_MAX_BLOCKS` | `256` |
| `OP_NODE_GOMEMLIMIT` | `768MiB` |
| `L1_RPC_KIND` | `quicknode` (reth pserv; after snapshot restore use `L1_RPC_FORCE=public`) |
| `L1_RPC_FORCE` | `metered` until snapshot restore (R-0014); then `public` |
| `L1_CACHE_SIZE` | `128` |
| `L1_MAX_CONCURRENCY` | `2` |
| `L1_RPC_MAX_BATCH_SIZE` | `5` |
| `TZ` | `America/Los_Angeles` |
| `L1_RPC_SCHEDULE` | `business` |
| `L1_USE_PUBLIC_RPC` | `0` |
| `L1_RPC_PUBLIC_URL` | `https://ethereum-sepolia-rpc.publicnode.com` |
| `L1_RPC_BUSINESS_START` | `9` |
| `L1_RPC_BUSINESS_END` | `17` |
| `L1_HTTP_POLL_INTERVAL` | `24s` |
| `L1_RPC_RATE_LIMIT` | `5` |

**What they do:**

- **Memory (live geth `GETH_*` / R-0012; new reth `RETH_*` / R-0013):** Keep the EL + op-node under the 2 GB cgroup during L1 derivation bursts. `L1_CACHE_SIZE` must stay a positive integer — `0` expands op-node’s cache to ~2400 L1 blocks and will OOM Standard. `GETH_GOMEMLIMIT` does nothing on op-reth (Rust).
- **L1 schedule (`L1_RPC_SCHEDULE`, `TZ`, `L1_RPC_*`):** QuickNode **09:00–17:00** Pacific, publicnode overnight via in-container router (no op-node restart at cutover).
- **Credit throttle (`L1_HTTP_POLL_INTERVAL`, `L1_RPC_RATE_LIMIT`):** slow L1 polling to limit QuickNode burn.

#### Optional overrides

| Variable | When to use |
|---|---|
| `L1_RPC_FORCE` | `public` or `metered` — pin upstream and skip the schedule |
| `L1_USE_PUBLIC_RPC` | `1` — same as `L1_RPC_FORCE=public` |
| `RETH_ARCHIVE` | `1` on `fortel2-replica-reth` **before** snapshot restore (D-0126). Omits `--full` (archive) and removes a stale `reth.toml` prune section. Unset/0 keeps `--full`. Never Blueprint-sync. |
| `RETH_SNAPSHOT_URL` | HTTPS URL of `fortel2-852-reth-snapshot-<L2head>.tar.zst` (R-0014). Empty = init from genesis |
| `RETH_SNAPSHOT_SHA256` | Required when URL is set. Refuse restore on mismatch |
| `RETH_SNAPSHOT_FORCE` | `1` once to replace an existing `db/` on `fortel2-replica-reth`. Unset after that boot. Never on live geth |
| `GETH_READY_TIMEOUT_SECS` | live geth only — wait forever for geth IPC during slow disk recovery |
| `RETH_READY_TIMEOUT_SECS` | `0` (default) — wait forever for op-reth HTTP during slow disk recovery |

#### Manual Private Service checklist (unattached only)

For a **new** replica somewhere else — not the live Oregon node, and not a substitute for [Going public](#going-public). The live `fortel2-replica` already exists; running this checklist in that environment creates a second disk and a full L1 resync.

1. **New → Private Service**. Runtime: **Docker**. Dockerfile path: `./Dockerfile` (repo root). Do **not** choose Web here — that would be a public replica with its own disk.
2. **Plan:** Standard (2 GB RAM) or Pro — not Starter.
3. Attach a **persistent disk** at `/data` (≥ 20 GB, per `render.yaml`; live geth is **50 GB**). This checklist deploys the root `./Dockerfile` (op-geth). The Task 7 reth service is separate: `fortel2-replica-reth-data` is 10 GB and the archive datadir measured ≈1.2 GB at ~823k blocks (D-0127); Phase B measures growth before resizing.
4. Set secrets + recommended env vars from the tables above.
5. Deploy / restart after dashboard env edits.

**Web Shell tip:** the live geth image has no `curl`. Use dashboard **Shell** with `python3`/`urllib` against `http://127.0.0.1:$PORT` (filter) or `http://127.0.0.1:8546` (loopback EL). The Task 7 reth image (`Dockerfile.reth`) includes `curl` + `zstd` for snapshot restore only. op-node is `http://127.0.0.1:9545` (loopback only). Do not print `L1_RPC_URL` or the JWT.

**Health check / long recovery:** until `entrypoint.sh` marks the EL ready (`/tmp/fortel2-el-ready`), the image `HEALTHCHECK` fails so Docker keeps `health=starting` for the 5m `start-period` (a passing probe would mark `healthy` immediately). After readiness, probes require a successful loopback `eth_blockNumber`. If constrained disks regularly need longer than 5m to open the datadir, raise `HEALTHCHECK --start-period` so recovery is not marked `unhealthy` mid-boot. Render’s HTTP `healthCheckPath: /` hits the method filter once it is up.

**QuickNode:** Prefer a dedicated endpoint token for this replica (**L2_Render**, not **L2_mini** / the Mac mini sequencer URL). Render outbound IPs are CIDR ranges (not stably allowlistable on QuickNode’s per-IP whitelist) — rotate the URL if leaked. Daytime schedule uses that endpoint; overnight / `L1_RPC_FORCE=public` / `L1_USE_PUBLIC_RPC=1` use publicnode. Treat ~**3 million credits/day** (per endpoint or combined) as the warn line — the daily automation flags it. L2_mini is usually the burner (`eth_getBlockByNumber`, `eth_blobBaseFee`, `eth_maxPriorityFeePerGas`); replica derivation on L2_Render should stay well under.

If you change genesis/rollup (ForteL2 Phase 2b redeploy), **wipe `/data`** (or recreate the disk) after deploying the new image so the replica does not keep the old L1 history.

After changing env vars in the dashboard (especially `sync: false` secrets), **Manual Deploy** or restart so the running container picks them up. Blueprint `value:` changes apply on Blueprint sync (Auto Sync or Manual Sync on the Blueprint page).

## Sync model

Derives from Sepolia L1 only — **no connection to the Mac mini sequencer** is required for safe/finalized heads. Unsafe tip may lag until batches land on L1.

## What not to share / commit

- No sequencer keys, harvest wallet, or `.env.sepolia`
- Do not commit real QuickNode URLs with tokens (use Render secrets / local `.env`)

## Keeping config in sync with ForteL2

Although this is a standalone repository, its `config/genesis.json` and `config/rollup.json` still describe the ForteL2 chain and must track it. Operators publish updated chain config into this repo from [ForteL2](https://github.com/StephenForte/ForteL2) after a Sepolia redeploy:

```bash
# in ForteL2
FORTEL2_ENV=.env.sepolia ./scripts/pack-replica-artifacts.sh
# then copy replica/config/{genesis,rollup}.json into this repo and push
# wipe Mac data-sepolia AND Render /data before restarting both
```

## License

Same learning / personal-use posture as ForteL2 — throwaway testnet only.
