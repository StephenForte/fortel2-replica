# Running a ForteL2 replica node

How to clone this repo and run a read-only ForteL2 verifier on a laptop or VPS.

The only external thing you must supply is an Ethereum **Sepolia L1 RPC URL** — chain config and pinned images are already in the repo. No sequencer, batcher, or proposer keys.

This is **not** the hosted Render node. Local compose publishes raw op-geth / op-node. The method filter, public URLs, and L1 schedule router are the single-container Render image — see `README.md` if you meant to call those instead.

## What you need

- Docker + the Compose plugin (`docker compose`). Nothing else — no Go/Node, no Foundry.
- ~2 GB RAM. A 512 MB box will OOM (same warning as the Render note in `README.md`).
- Disk for the `geth-data` volume. Derivation starts at L1 block `11323401` and the volume grows as it catches up.
- A **Sepolia HTTPS** endpoint in `L1_RPC_URL`. `.env.example` already has `https://ethereum-sepolia-rpc.publicnode.com` for a smoke test. Use a dedicated provider for anything you leave running. Compose does **not** run `L1_RPC_SCHEDULE` / the in-container router — those are Render-only.

## Steps

```bash
git clone https://github.com/StephenForte/fortel2-replica.git
cd fortel2-replica
cp .env.example .env
# optional: edit L1_RPC_URL if you have your own Sepolia endpoint
openssl rand -hex 32 > jwt.txt && chmod 600 jwt.txt
docker compose up -d
```

`docker compose up` pulls the pinned images, `geth init`s the datadir from `config/genesis.json` on first run, then starts op-geth + op-node. Host ports are `9545` (L2 execution RPC) and `9547` (op-node RPC). Compose only reads `L1_RPC_URL` (required), plus optional `L1_BLOCK_TIME`, `L1_HTTP_POLL_INTERVAL`, `L1_RPC_RATE_LIMIT`, `L1_CACHE_SIZE`, `L1_MAX_CONCURRENCY`, `L1_RPC_MAX_BATCH_SIZE`, `GETH_CACHE_MB`, and `GETH_FDLIMIT`. Everything else in `.env.example` is Render-only and ignored here.

## Confirm it works

```bash
curl -s http://127.0.0.1:9545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'      # → {"result":"0x354"} = 852

curl -s http://127.0.0.1:9547 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"optimism_syncStatus","params":[]}' | jq \
  '{current_l1:.result.current_l1.number, head_l1:.result.head_l1.number, safe_l2:.result.safe_l2.number}'
```

`jq` is optional. Foundry `cast` is optional too — if you have it, the same checks are `cast chain-id` / `cast block-number` on `:9545` and `cast rpc optimism_syncStatus` on `:9547`.

## What to expect

- **Give it time.** op-node replays Sepolia from the rollup genesis L1 block forward. `current_l1` climbs right away; `safe_l2` / `unsafe_l2` stay `0` until derivation reaches the L1 blocks where batches were posted. That lag is normal.
- **Read-only chain, raw local RPC.** There are no sequencer keys. Local `:9545` is stock op-geth (including `debug` / `txpool`), not the Render allowlist — `eth_sendRawTransaction` is not rejected here, but this node does not sequence (`--sequencer.enabled=false`).
- **No secrets to share.** `L1_RPC_URL` is the only sensitive value if it has a token. `.env` and `jwt.txt` are gitignored. Make your own; do not reuse someone else's.
- **Stop/reset:** `docker compose down` to stop; `docker compose down -v` to wipe the chain datadir (needed if `config/genesis.json` or `config/rollup.json` changes after a ForteL2 redeploy — see `README.md`).

## Before you share this repo

`config/` must match the current ForteL2 deployment. If ForteL2 has been redeployed on Sepolia since you last pushed, refresh `config/genesis.json` and `config/rollup.json` before someone else clones, or their node will derive against stale L1 history.
