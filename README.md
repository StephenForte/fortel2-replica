# ForteL2 replica

A standalone **node** for the [ForteL2](https://github.com/StephenForte/ForteL2) learning L2 (chain ID **852**) that derives L2 state from **Ethereum Sepolia**.

This is now **its own project** — split out of the ForteL2 monorepo into a self-contained repository you can clone, run, and deploy on its own. It runs a **verifier** (op-geth + op-node) and is the package you give friends / deploy on Render. It is **not** the sequencer, batcher, proposer, or dApp — and it never needs operator private keys.

| Component | Role |
|---|---|
| op-geth | L2 execution (full sync, not archive) |
| op-node | Verifier — derives L2 from L1 batches |

Pinned images: `op-node:v1.19.2`, `op-geth:v1.101702.2` (OP Labs).

**Status (Phase 3):** Operator-verified on Render against a fresh Phase 2b cutover — matching L2 block hashes with the Mac sequencer. Genesis/rollup in `config/` must stay in lockstep with ForteL2 after any Sepolia redeploy.

Handing this to a friend? See [`RUNNING.md`](./RUNNING.md) for a full walkthrough of running your own node.

## Quick start (laptop / VPS)

```bash
git clone https://github.com/StephenForte/fortel2-replica.git
cd fortel2-replica
cp .env.example .env
# set L1_RPC_URL to a Sepolia HTTPS endpoint (QuickNode recommended)
openssl rand -hex 32 > jwt.txt && chmod 600 jwt.txt
docker compose up -d
```

- L2 EL: `http://127.0.0.1:9545`
- op-node: `http://127.0.0.1:9547`

```bash
cast chain-id --rpc-url http://127.0.0.1:9545   # → 852
cast block-number --rpc-url http://127.0.0.1:9545
cast rpc optimism_syncStatus --rpc-url http://127.0.0.1:9547 | jq '{safe:.safe_l2.number, unsafe:.unsafe_l2.number}'
```

## Read RPC (live: Private Service)

The live Render deploy is a **Private Service** (`fortel2-replica`, `srv-d9fsgi3rjlhs73ceh6tg`, Oregon env `evm-d9h424715fvs73cq2gl0`). There is **no** public `onrender.com` URL today (ForteL2 D-0031). SettlementOS reads at `http://fortel2-replica:10000` on the same private network (D-0032).

Clients on that network hit a **method-filter** on Render’s published `PORT` (default **10000**). op-geth listens on loopback only (`127.0.0.1:8546`); op-node RPC is loopback-only (`127.0.0.1:9545`) and must never be exposed.

| Fact | Detail |
|---|---|
| URL | Private: `http://fortel2-replica:10000`. Public hostname only via a **diskless** reverse-proxy Web Service (see [Going public](#going-public)) — not by converting this replica. |
| Surface | Read-only JSON-RPC allowlist (`eth` / `net` / `web3` reads + log/block filters) |
| Writes | `eth_sendRawTransaction` is **rejected** (`-32601 method not allowed`) |
| Lag | ~3 minutes behind the sequencer is **normal** — the replica derives from L1 batches, not P2P tip-follow |
| Nightly window | Sequencer sleeps **23:45–03:00** `America/Los_Angeles`. The replica keeps serving whatever tip it already derived; new L2 progress pauses until the sequencer posts batches again after wake |
| Filters | `eth_newFilter` / `eth_newBlockFilter` IDs are in-memory and die on every deploy/restart — clients must re-create on filter-not-found (not an outage) |
| Rate limiting | On the replica itself: Render platform DDoS only — **no per-RPC / per-IP request rate limit** on Standard. Do **not** add an in-process limiter to `rpc-method-filter.py`. Per-IP limits belong on the diskless public gateway (and optional Cloudflare). |

Filter source: vendored from ForteL2 `scripts/rpc-method-filter.py` (see header in `rpc-method-filter.py`). **Security fixes must be applied in both repos** (ForteL2 first, then copy here).

### Do not convert this service to Web

Render cannot flip Private ↔ Web in place, and **cannot reattach `/data` to a new service**. The live disk is **50 GB**. Do not apply `render.yaml` as a **new** Blueprint (`type: web` / `sizeGB: 20` would create a second replica with an empty disk and a full L1 resync).

A public URL is a **second, diskless** Web Service that proxies to this Private Service — not a new geth disk. See [Going public](#going-public).

### Revert

If a mistaken public replica (Web Service + its own disk) is created: delete that extra service. The live Private Service and its 50 GB `/data` stay as they are. Recreating `fortel2-replica` itself still means a **new disk and a full resync** — do not do that to “go private again.” To take a public gateway down, delete or suspend only `fortel2-replica-rpc` (or disable its custom domain). SettlementOS keeps using `http://fortel2-replica:10000`.

## Going public

Keep the live Private Service and its 50 GB disk. Publish read-only JSON-RPC through a **new diskless Web Service** that reverse-proxies to `http://fortel2-replica:10000` and rate-limits. SettlementOS stays on the private URL.

**Repo first, then Dashboard.** Do not create the Web Service until `gateway/Dockerfile` exists on the branch that service deploys (usually `main`). Today this repo only has the replica image (`./Dockerfile` = op-geth + op-node). Pointing a Web Service at that path would boot a **second public verifier**.

### Dashboard (after `gateway/` lands)

Same GitHub repo, **second** service, same Oregon env as `fortel2-replica`:

| Field | Value |
|---|---|
| Create | **New → Web Service** (not **New → Blueprint** — current `render.yaml` still names `fortel2-replica` as `type: web` with a 20 GB disk) |
| Repo | `StephenForte/fortel2-replica` |
| Name | `fortel2-replica-rpc` (never reuse `fortel2-replica`) |
| Region | **Oregon** (private DNS fails across regions) |
| Disk | **None** |
| Dockerfile path | `./gateway/Dockerfile` (not `./Dockerfile`) |
| Env | `REPLICA_UPSTREAM=http://fortel2-replica:10000` |
| Plan | Starter or higher (Free spins down after 15 minutes) |

If the form is filled in before `gateway/` exists: leave Dockerfile Path as `./gateway/Dockerfile` and let the first deploy fail. Do not “fix” that by switching back to `./Dockerfile`.

### Rate limit / DDoS

| Layer | Role |
|---|---|
| Cloudflare (optional) | Volumetric DDoS. CNAME the custom domain to the `onrender.com` hostname, orange-cloud. Add a WAF rate-limit rule (e.g. 20 req/s per IP, burst 40). |
| Gateway `limit_req` | Per-IP HTTP limit on the diskless Web Service (JSON-RPC batches count as one HTTP request). |
| Method filter | Writes, admin/debug/txpool, oversize/chunked bodies (1 MiB). Already on the replica. |
| Render edge | Platform DDoS only — no per-RPC / per-IP limit on Standard. |

Do not put a token bucket inside `rpc-method-filter.py`.

### Smoke test (once the gateway is live)

```bash
# chain id 852
curl -s https://<gateway-host> -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# writes still rejected
curl -s https://<gateway-host> -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x"]}'
# private path unchanged
curl -s http://fortel2-replica:10000 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

Expect `result: "0x354"` on reads, `-32601 method not allowed` on `eth_sendRawTransaction`, and HTTP `429` under a burst. Lag and the sequencer sleep window are the same as the private replica (~3 minutes behind; 23:45–03:00 Pacific).

## Render

**RAM:** Render **Starter (512MB) will OOM**. Use at least **Standard (~2GB)** for op-geth + op-node (+ optional L1 router) in one container. Do not leave geth’s 1024MB default cache.

**OOM during derivation:** Logs like `decoded singular batch from channel` during L1 catch-up are normal but memory-heavy — op-node decodes batches in bursts while geth applies them. If Render kills the service with exit 137 / “Ran out of memory”, confirm the plan is **Standard or Pro** (not Starter), set the memory env vars below, or bump to **Pro (4GB)** if spikes persist.

### Blueprint vs dashboard-created services

**Prefer Blueprint-managed (greenfield only):** **New → Blueprint** → this repo is for a **new** replica, not for the live Oregon pserv. While a service stays attached to this Blueprint:

- Env vars with a literal `value:` in `render.yaml` are created/updated on each Blueprint sync.
- Keys with `sync: false` (`L1_RPC_URL`, `JWT_SECRET`) are prompted **only on first create**. Later syncs ignore them — set or rotate those secrets in the dashboard (**Environment**).
- Dashboard edits that conflict with Blueprint `value:` fields are overwritten on the next sync.

**Dashboard-created (unattached):** **New → Private Service** without going through this Blueprint is not managed by `render.yaml`. Git pushes / Manual Deploy do **not** apply Blueprint env changes — paste the tables below into **Environment**, then redeploy.

Genesis + rollup are **baked into the image** from `config/` — no secret-file upload needed.

Live `fortel2-replica` is already that Private Service. Keep deploying this image onto it (filter on `PORT`; geth/op-node stay loopback). A public URL is a **separate diskless Web Service** ([Going public](#going-public)), not a second copy of this replica.

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
| `GETH_CACHE_MB` | `128` |
| `GETH_GOMEMLIMIT` | `700MiB` |
| `OP_NODE_GOMEMLIMIT` | `768MiB` |
| `TZ` | `America/Los_Angeles` |
| `L1_RPC_SCHEDULE` | `business` |
| `L1_USE_PUBLIC_RPC` | `0` |
| `L1_RPC_PUBLIC_URL` | `https://ethereum-sepolia-rpc.publicnode.com` |
| `L1_RPC_BUSINESS_START` | `9` |
| `L1_RPC_BUSINESS_END` | `17` |
| `L1_HTTP_POLL_INTERVAL` | `24s` |
| `L1_RPC_RATE_LIMIT` | `5` |

**What they do:**

- **Memory (`GETH_*`, `OP_NODE_GOMEMLIMIT`):** keep op-geth + op-node under the 2 GB cgroup during L1 derivation bursts.
- **L1 schedule (`L1_RPC_SCHEDULE`, `TZ`, `L1_RPC_*`):** QuickNode **09:00–17:00** Pacific, publicnode overnight via in-container router (no op-node restart at cutover).
- **Credit throttle (`L1_HTTP_POLL_INTERVAL`, `L1_RPC_RATE_LIMIT`):** slow L1 polling to limit QuickNode burn.

#### Optional overrides

| Variable | When to use |
|---|---|
| `L1_RPC_FORCE` | `public` or `metered` — pin upstream and skip the schedule |
| `L1_USE_PUBLIC_RPC` | `1` — same as `L1_RPC_FORCE=public` |
| `GETH_READY_TIMEOUT_SECS` | `0` (default) — wait forever for geth IPC during slow disk recovery |

#### Manual Private Service checklist (unattached only)

1. **New → Private Service**. Runtime: **Docker**. Dockerfile path: `./Dockerfile` (repo root). Do **not** choose Web here — that would be a public replica with its own disk.
2. **Plan:** Standard (2 GB RAM) or Pro — not Starter.
3. Attach a **persistent disk** at `/data` (≥ 20 GB; live is **50 GB**).
4. Set secrets + recommended env vars from the tables above.
5. Deploy / restart after dashboard env edits.

**Web Shell tip:** the image has no `curl`. Use dashboard **Shell** with `python3`/`urllib` against `http://127.0.0.1:$PORT` (filter) or `geth attach --exec "eth.blockNumber" /data/geth.ipc`. op-node is `http://127.0.0.1:9545` (loopback only).

**Health check / long recovery:** until `entrypoint.sh` marks op-geth IPC ready (`/tmp/fortel2-el-ready`), the image `HEALTHCHECK` fails so Docker keeps `health=starting` for the 5m `start-period` (a passing probe would mark `healthy` immediately). After readiness, probes require a successful `geth attach`. If constrained disks regularly need longer than 5m to open the datadir, raise `HEALTHCHECK --start-period` so recovery is not marked `unhealthy` mid-boot. Render’s HTTP `healthCheckPath: /` hits the method filter once it is up.

**QuickNode:** Prefer a dedicated endpoint token for this replica. Render outbound IPs are CIDR ranges (not stably allowlistable on QuickNode’s per-IP whitelist) — rotate the URL if leaked. Daytime schedule uses that endpoint; overnight / `L1_RPC_FORCE=public` / `L1_USE_PUBLIC_RPC=1` use publicnode.

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
