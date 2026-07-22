# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is

Docker-only OP Stack **verifier node** for the ForteL2 learning L2 (chain ID **852**), deriving from Ethereum **Sepolia**. There is no application source code, test suite, or linter — the "app" is two prebuilt OP Labs containers (`op-geth` execution client + `op-node` verifier) run via `docker-compose.yml`. See `README.md` for the full quick start and smoke-test commands.

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
- **Changing `config/genesis.json` or `config/rollup.json`** (after a ForteL2 Sepolia redeploy) requires wiping the datadir: `sudo docker compose down -v` then `up -d`, otherwise geth keeps the old chain.
- The single-container `Dockerfile`/`entrypoint.sh` (Render deploy) exposes EL on `8545` and op-node on `9545`; the local `docker-compose.yml` instead publishes host ports `9545`/`9547`. Don't confuse the two port schemes.
