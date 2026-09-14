# Running a ForteL2 replica node

How to clone this repo and run a read-only ForteL2 verifier on a laptop or VPS.

The only external thing you must supply is an Ethereum **Sepolia L1 RPC URL** — chain config and pinned images are already in the repo. No sequencer, batcher, or proposer keys.

This is **not** the hosted Render node. Local compose publishes raw op-reth / op-node on **loopback only** (`127.0.0.1:9545` / `127.0.0.1:9547`). There is no method filter and no allowlist. The method filter, public URLs, and L1 schedule router are the single-container Render image — see `README.md` if you meant to call those instead.

## What you need

- Docker + the Compose plugin (`docker compose`). Nothing else — no Go/Node, no Foundry.
- ~2 GB RAM. A 512 MB box will OOM (same warning as the Render note in `README.md`).
- Disk for the `reth-data` volume. Derivation starts at L1 block `11323401` and the volume grows as it catches up. `--full` is a prune mode: without it you build an archive. D-0122 sizing for `--full` state is ≈1–2 GB (no proofs store). The Render entrypoint honors `RETH_ARCHIVE=1` to omit `--full` (full archive; D-0126); local compose still always passes `--full`.
- A **Sepolia HTTPS** endpoint in `L1_RPC_URL`. `.env.example` already has `https://ethereum-sepolia-rpc.publicnode.com` for a **smoke test only**. PublicNode can return 0 receipts and stall derivation (ForteL2 D-0105). Use a receipts-capable provider (QuickNode) for anything you leave running. Compose does **not** run `L1_RPC_SCHEDULE` / the in-container router — those are Render-only. Render's new replica starts with `L1_RPC_FORCE=metered`.

## Steps

```bash
git clone https://github.com/StephenForte/fortel2-replica.git
cd fortel2-replica
```

**Verify the clone is the operator's chain** before you start. This **fails closed** — non-zero exit on mismatch, rather than printing digests for you to compare by eye.

```bash
# macOS
cd config && shasum -a 256 -c SHA256SUMS && cd ..
# Linux
# cd config && sha256sum -c SHA256SUMS && cd ..
```

Both files must print `OK`. If either does not, stop — you do not have chain 852 as the operator runs it. The expected digests are also in `README.md` §Chain identity for reference.

This catches a modified or partial clone. It cannot catch a wholly **stale** one, because `SHA256SUMS` would be stale with it; a stale clone shows up instead when your derived hashes stop matching the operator's endpoint (see *A healthy node vs a stalled one*), and after a redeploy gate you re-clone anyway.

```bash
cp .env.example .env
# optional: edit L1_RPC_URL if you have your own Sepolia endpoint
openssl rand -hex 32 > jwt.txt && chmod 600 jwt.txt
docker compose up -d
```

`docker compose up` pulls the pinned images (op-reth + op-node by digest), `op-reth init`s the datadir from `config/genesis.json` on first run (refuses chain 901), then starts op-reth `--full` + op-node `--l2.enginekind=reth`. Host ports are loopback `127.0.0.1:9545` (L2 execution RPC) and `127.0.0.1:9547` (op-node RPC). Compose only reads `L1_RPC_URL` (required), plus optional `L1_BLOCK_TIME`, `L1_HTTP_POLL_INTERVAL`, `L1_RPC_RATE_LIMIT`, `L1_CACHE_SIZE`, `L1_MAX_CONCURRENCY`, `L1_RPC_MAX_BATCH_SIZE`, `L1_RPC_KIND`, `RETH_CROSS_BLOCK_CACHE_MB`, and `RETH_RPC_CACHE_MAX_BLOCKS`. Everything else in `.env.example` is Render-only and ignored here.

The container's op-reth must report `Reth Version: 2.3.0-dev` commit `9384bc53…` (same binary lineage as the Mini pin). The single-container image asserts that at start.

**Snapshot restore** (`RETH_SNAPSHOT_URL` / `RETH_SNAPSHOT_SHA256` / `RETH_SNAPSHOT_FORCE`) is the Render `Dockerfile.reth` entrypoint path (R-0014), not this two-container compose. Local compose always `op-reth init`s an empty volume from genesis. To bootstrap a compose volume from a tarball, extract `db/` + `static_files/` + `rocksdb/` into the `reth-data` volume while the stack is down — never while op-reth is running, and never copy `jwt.txt` from the Mac.

## Confirm it works

```bash
curl -s http://127.0.0.1:9545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'      # → {"result":"0x354"} = 852

curl -s http://127.0.0.1:9547 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"optimism_syncStatus","params":[]}' | jq \
  '{current_l1:.result.current_l1.number, head_l1:.result.head_l1.number, safe_l2:.result.safe_l2.number, unsafe_l2:.result.unsafe_l2.number}'
```

`jq` is optional. Foundry `cast` is optional too — if you have it, the same checks are `cast chain-id` / `cast block-number` on `:9545` and `cast rpc optimism_syncStatus` on `:9547`.

## A healthy node vs a stalled one

`docker compose ps` showing `Up` is not enough. A stalled node answers `eth_chainId` the same way a working one does.

**Catching up (normal, not stalled).** `docker compose logs -f op-node` repeats `Advancing bq origin` as `current_l1` climbs toward `head_l1`. `safe_l2` / `unsafe_l2` stay `0` until derivation reaches the L1 blocks where the sequencer posted batches. That lag is expected and can last a long time from genesis.

**Healthy after catch-up.** `unsafe_l2` (and then `safe_l2`) leave `0` and keep climbing. Local `eth_blockNumber` on `:9545` advances. Compare it to the operator's public replica:

```bash
curl -s https://fortel2-replica-rpc.onrender.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

While you are still deriving, your tip is behind. Once caught up, it should track that public head — both sit ~3 minutes behind the sequencer, and both pause new L2 progress during the sequencer sleep window (**23:45–03:00** `America/Los_Angeles`). Hash-equal blocks at the same number mean you are on the same chain.

**Stalled.** `current_l1` is not climbing, or `current_l1` has reached `head_l1` but `safe_l2` stays `0` for hours after that, or your L2 head is frozen while the public endpoint keeps moving. Typical causes: PublicNode returning 0 receipts (D-0105), or genesis/rollup that do not match `README.md` §Chain identity.

## Reach the RPC from another machine (opt-in)

The default `ports:` publish is loopback. A process on this machine can use `http://127.0.0.1:9545`; nothing else on the network can. That is the intended default on a laptop and on a VPS.

Compose does **not** run the method filter. Opening the ports is unauthenticated L2 JSON-RPC (`eth` / `net` / `web3` on op-reth, plus op-node RPC) with no allowlist.

To listen on all interfaces, edit the two `ports:` lines in `docker-compose.yml` and drop the `127.0.0.1:` prefix, then recreate the containers (`docker compose up -d`):

    ports:
      - "9545:8545"      # all interfaces — unauthenticated L2 RPC on every NIC
    ports:
      - "9547:9545"

Do **not** change `--http.addr`, `--ws.addr`, `--rpc.addr`, or `--authrpc.addr` inside the `command:` lists. Those are the in-container bind. They must stay `0.0.0.0` so op-node can reach op-reth at `http://op-reth:8551` on the compose network. Setting them to `127.0.0.1` makes the node look "up" and still unreachable from op-node.

If you publish past loopback, put a firewall or reverse proxy in front. Do not assume Docker's publish is a security boundary.

## What to expect

- **Give it time.** op-node replays Sepolia from the rollup genesis L1 block forward. `current_l1` climbs right away; `safe_l2` / `unsafe_l2` stay `0` until derivation reaches the L1 blocks where batches were posted. That lag is normal.
- **Read-only chain, raw local RPC.** There are no sequencer keys. Local `:9545` is stock op-reth (HTTP `eth,net,web3` in the Render image; compose is similarly read-oriented), not the Render allowlist — `eth_sendRawTransaction` is not rejected here, but this node does not sequence (`--sequencer.enabled=false`).
- **No secrets to share.** `L1_RPC_URL` is the only sensitive value if it has a token. `.env` and `jwt.txt` are gitignored. Make your own; do not reuse someone else's. Never print L1 URLs or JWTs.
- **Stop/reset:** `docker compose down` to stop; `docker compose down -v` to wipe the chain datadir (needed if `config/genesis.json` or `config/rollup.json` changes after a ForteL2 redeploy — see `README.md`). Mid-chain rewind is wipe + re-derive — never `debug_setHead`.

## Before you share this repo

`config/` must match the current ForteL2 deployment. If ForteL2 has been redeployed on Sepolia since you last pushed, refresh `config/genesis.json` and `config/rollup.json` before someone else clones, or their node will derive against stale L1 history.
