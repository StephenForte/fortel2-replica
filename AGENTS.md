# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is

Docker-only OP Stack **verifier node** for the ForteL2 learning L2 (chain ID **852**), deriving from Ethereum **Sepolia**. Local compose is official `op-reth` + `op-node`. Live Render pserv `fortel2-replica` builds `./Dockerfile` (op-geth v1.101702.2, unchanged). Task 7 pserv `fortel2-replica-reth` builds `Dockerfile.reth` (digest-pinned op-reth; `entrypoint-reth.sh` asserts `Reth Version: 2.3.0-dev` commit `9384bc53…`). Supporting Python in-repo: `rpc-method-filter.py`, `l1_rpc_router.py`. Public doors: `gateway/` (nginx replica proxy) and `sequencer-read/start.sh` (filtered sequencer tip). Unit tests: `python3 -m unittest discover -s tests -v` (or `make test`). See `README.md` for the full quick start and smoke-test commands.

Task 7 (R-0017): Phase C executed. Live public read (`https://fortel2-replica-rpc.onrender.com`) and SOS private read serve `fortel2-replica-reth` (`Dockerfile.reth`). The geth pserv `fortel2-replica` and staging `fortel2-replica-reth-rpc` are **suspended** (2026-09-12, D-0129) — rollback-only, not deleted before Task 9. Render private hostnames are immutable slugs — never rename services (R-0013 rename-swap does not move traffic). Do **not** re-apply the live `fortel2-replica` Blueprint entry or point it at `Dockerfile.reth`. ForteL2 `tasks/` / `rail-interface.json` / `replica/FRIENDS.md` are planner-owned — do not edit them from this repo.

### Running locally (dev)

The startup layer installs Docker and refreshes images but does NOT start containers or create secret files. To run the stack:

1. Docker daemon: not managed by systemd here. Start it if not already running: `sudo dockerd > /tmp/dockerd.log 2>&1 &` (in a tmux session), then confirm with `sudo docker info`.
2. Create local secrets (both are gitignored):
   - `.env` with at least `L1_RPC_URL=<Sepolia HTTPS endpoint>`. The public endpoint from `.env.example` (`https://ethereum-sepolia-rpc.publicnode.com`) works for smoke tests; for sustained sync use a dedicated provider.
   - `openssl rand -hex 32 > jwt.txt && chmod 600 jwt.txt`
3. `sudo docker compose up -d` (compose maps EL to host `9545`, op-node to host `9547`).

### Verifying it works (hello world)

```bash
curl -s http://127.0.0.1:9545 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'   # → {"result":"0x354"}  (852)
curl -s http://127.0.0.1:9547 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"optimism_syncStatus","params":[]}' | jq '{current_l1:.result.current_l1.number, head_l1:.result.head_l1.number, safe_l2:.result.safe_l2.number}'
```

`cast`/`jq` are optional; `jq` is preinstalled, `cast` (Foundry) is not — use `curl` as above.

### Non-obvious gotchas

- **Docker storage driver**: This VM's kernel needs `fuse-overlayfs` (configured in `/etc/docker/daemon.json`). With Docker 29+ you must also set `features.containerd-snapshotter: false` in that file or fuse-overlayfs is ignored. iptables is switched to `iptables-legacy`.
- **Derivation is slow to advance L2**: op-node replays L1 from the rollup genesis L1 block (~11323401) forward at roughly one L1 block/sec. `current_l1` climbs immediately, but `safe_l2`/`unsafe_l2` stay `0` until derivation reaches the L1 blocks where the sequencer actually posted batches. A flat `safe_l2=0` shortly after startup is normal, not a failure — the proof of correctness is `current_l1` steadily advancing toward `head_l1`.
- **No L1_RPC_URL → op-node/entrypoint hard-exits.** Compose reads it from `.env`.
- **Render env vars:** Blueprint-managed services sync `value:` keys from `render.yaml` on Blueprint sync; `sync: false` secrets (`L1_RPC_URL`, `JWT_SECRET`) are prompted only on first create and must be set/rotated in the dashboard afterward. Dashboard-created (unattached) services ignore `render.yaml` — paste the README checklist, then redeploy.
- **Render memory (R-0012 geth rollback / R-0013 live reth):** Starter (512MB) OOMs. Live reth stays Standard (Q5: RSS peak 724 MB, R-0017). Geth pserv stays Wave 1 on Standard until suspended 2026-09-12. Reth pserv uses `RETH_CROSS_BLOCK_CACHE_MB=256` (pinned op-reth default is 4096 MB — OOM), `RETH_RPC_CACHE_MAX_BLOCKS=256`, `OP_NODE_GOMEMLIMIT=768MiB`, `L1_CACHE_SIZE=128`, `L1_MAX_CONCURRENCY=2`, `L1_RPC_MAX_BATCH_SIZE=5`. `GETH_*` knobs do nothing on op-reth (Rust). Never `L1_CACHE_SIZE=0`. Tip-follow `L1_RPC_FORCE=public` (D-0105 / R-0014). Daily Cloud Agent **Daily replica health** (04:00 Pacific, skill `.cursor/skills/daily-replica-health`) still scores the geth rollback replica until it is suspended; it does not change env. It uses Cloud Render plus QuickNode — do not run a local overnight loop.
- **L1 credit knobs:** `L1_HTTP_POLL_INTERVAL` (default `24s`) and `L1_RPC_RATE_LIMIT` (default `5`) are passed to op-node. `L1_RPC_SCHEDULE=business` starts `/l1_rpc_router.py` (needs `python3` + `tzdata`) and points op-node at `http://127.0.0.1:18545`, which forwards to QuickNode **09:00–17:00** in `TZ` (default `America/Los_Angeles`) and publicnode otherwise. Overrides: `L1_RPC_FORCE=public|metered` or `L1_USE_PUBLIC_RPC=1`. Use a Render-only QuickNode URL in `L1_RPC_URL` (**L2_Render**, not the Mac mini **L2_mini** sequencer endpoint). Warn at ~3M credits/day per endpoint or combined.
- **Changing `config/genesis.json` or `config/rollup.json`** (after a ForteL2 Sepolia redeploy) requires wiping the datadir: `sudo docker compose down -v` then `up -d`, otherwise op-reth keeps the old chain. Entrypoint hash-checks the 852 genesis hash and refuses 901.
- The Task 7 single-container `Dockerfile.reth` / `entrypoint-reth.sh` publishes the **method filter** on `PORT`/`L2_HTTP_PORT` (often `10000` on the Private Service); op-reth HTTP is loopback `:8546` and op-node RPC is loopback `:9545` (never public). Live `./Dockerfile` / `entrypoint.sh` stay the geth image. Local `docker-compose.yml` still publishes host ports `9545`/`9547` to raw op-reth/op-node (`docker compose --profile render build replica-reth` builds the Render image). Don't confuse the two port schemes.
- Live public read is reth via `fortel2-replica-rpc` → `http://fortel2-replica-reth:10000` (R-0017). The geth Private Service `fortel2-replica` (`http://fortel2-replica:10000`, 50 GB disk, `./Dockerfile`) is rollback-only until Task 9. Hostnames are immutable slugs — never rename services. Do not convert either pserv to Web or re-apply the live `render.yaml` entry (would create a second pserv with an empty disk). Task 7 added `fortel2-replica-reth` + `fortel2-replica-reth-rpc` (R-0013); live `fortel2-replica-rpc` stays Dashboard-created (R-0008). Public replica: `https://fortel2-replica-rpc.onrender.com` (`./gateway/Dockerfile`). Public sequencer tip: `https://fortel2-sequencer-rpc.onrender.com` (`sequencer-read/start.sh`, R-0009). Do not point a Web Service at the root `./Dockerfile`.
