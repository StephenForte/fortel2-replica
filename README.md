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

## Render

**RAM:** Render **Starter (512MB) will OOM**. Use at least **Standard (~2GB)** for op-geth + op-node (+ optional L1 router) in one container. Do not leave geth’s 1024MB default cache.

**OOM during derivation:** Logs like `decoded singular batch from channel` during L1 catch-up are normal but memory-heavy — op-node decodes batches in bursts while geth applies them. If Render kills the service with exit 137 / “Ran out of memory”, confirm the plan is **Standard or Pro** (not Starter), set the memory env vars below, or bump to **Pro (4GB)** if spikes persist.

### Manual setup (Blueprint sync often skips existing services)

Render Blueprints apply cleanly to **new** services. If you already have a Private Service, env vars from `render.yaml` usually **do not** sync on redeploy — set them in the dashboard (**Environment** tab) or recreate the service from the Blueprint.

1. **New → Private Service** (preferred) or **Web Service**.
2. Connect this repo. Runtime: **Docker**. Dockerfile path: `./Dockerfile` (repo root).
3. **Plan:** Standard (2 GB RAM) or Pro — not Starter.
4. Attach a **persistent disk** mounted at `/data` (≥ 20 GB).
5. Set every env var in the table below (secrets first).
6. Genesis + rollup are **baked into the image** from `config/` — no secret-file upload needed.

#### Required secrets

| Variable | Example / notes |
|---|---|
| `L1_RPC_URL` | Render-only **QuickNode** Sepolia HTTPS URL (not the Mac mini endpoint). Required when `L1_RPC_SCHEDULE=business`. |
| `JWT_SECRET` | Optional. 64 hex chars to pin JWT across redeploys; omit to auto-generate on `/data`. |

#### Recommended env vars (match `render.yaml`)

Copy these into **Environment → Environment Variables** if Blueprint sync did not apply them:

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

Or apply `render.yaml` as a Blueprint on a **new** service.

**Private Service tip:** you cannot flip Private → Web on an existing service. Compare sync via **Shell** (`geth attach --exec "eth.blockNumber" /data/geth.ipc`) or add a temporary reverse-proxy Web service on Render’s private network. Do not leave an open public `eth_sendRawTransaction` surface up.

**Health check / long recovery:** until `entrypoint.sh` marks op-geth IPC ready (`/tmp/fortel2-el-ready`), the image `HEALTHCHECK` fails so Docker keeps `health=starting` for the 5m `start-period` (a passing probe would mark `healthy` immediately). After readiness, probes require a successful `geth attach`. If constrained disks regularly need longer than 5m to open the datadir, raise `HEALTHCHECK --start-period` so recovery is not marked `unhealthy` mid-boot.

**QuickNode:** Prefer a dedicated endpoint token for this replica. Render outbound IPs are CIDR ranges (not stably allowlistable on QuickNode’s per-IP whitelist) — keep the service Private and rotate the URL if leaked. Daytime schedule uses that endpoint; overnight / `L1_RPC_FORCE=public` / `L1_USE_PUBLIC_RPC=1` use publicnode.

If you change genesis/rollup (ForteL2 Phase 2b redeploy), **wipe `/data`** (or recreate the disk) after deploying the new image so the replica does not keep the old L1 history.

After changing env vars in the dashboard, **Manual Deploy** (or restart) the service — Render does not always pick up Blueprint-only changes on an existing Private Service.

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
