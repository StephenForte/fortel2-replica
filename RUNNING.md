# Running a ForteL2 replica node

How to hand this project to a friend and have them run their own ForteL2 verifier node.

The only external thing they must supply is an Ethereum **Sepolia L1 RPC URL** — everything else (chain config, pinned images) is already in the repo.

## What they need installed

- Docker + the Compose plugin (`docker compose`). Nothing else — no Go/Node, no Foundry. `op-geth` and `op-node` run as pinned prebuilt images from `docker-compose.yml`.
- A machine with enough RAM. This stack wants ~2 GB; a 512 MB box will OOM (same warning as the Render note in `README.md`).
- A **Sepolia HTTPS RPC endpoint** for `L1_RPC_URL`. The public one in `.env.example` (`https://ethereum-sepolia-rpc.publicnode.com`) works for a smoke test; a dedicated provider (e.g. QuickNode) is better for sustained sync.

## Steps they run

```bash
git clone https://github.com/StephenForte/fortel2-replica.git
cd fortel2-replica
cp .env.example .env
# edit .env → set L1_RPC_URL to a Sepolia HTTPS endpoint
openssl rand -hex 32 > jwt.txt && chmod 600 jwt.txt
docker compose up -d
```

That's it. `docker compose up` auto-pulls the images, `geth init`s the datadir from `config/genesis.json` on first run, then starts op-geth + op-node. Ports published on the host are `9545` (L2 execution RPC) and `9547` (op-node RPC), per `docker-compose.yml`.

## How they confirm it works

```bash
curl -s http://127.0.0.1:9545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'      # → {"result":"0x354"} = 852

curl -s http://127.0.0.1:9547 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"optimism_syncStatus","params":[]}' | jq \
  '{current_l1:.result.current_l1.number, head_l1:.result.head_l1.number, safe_l2:.result.safe_l2.number}'
```

If they have Foundry, the `cast` equivalents are in `README.md`; `jq`/`cast` are optional.

## Things to tell them

- **Give it a few minutes.** op-node replays Sepolia from the rollup genesis L1 block forward, so `current_l1` climbs right away but `safe_l2`/`unsafe_l2` stay `0` until derivation reaches the L1 blocks where batches were posted. That lag is normal, not a bug.
- **No secrets or keys needed.** This is a read-only verifier — there are no sequencer/batcher/proposer keys, and `L1_RPC_URL` is the only sensitive value. `.env` and `jwt.txt` are gitignored, so they won't get committed.
- **Don't reuse your `.env`/`jwt.txt`.** Each person makes their own (especially the RPC URL if it has a token).
- **Stop/reset:** `docker compose down` to stop; `docker compose down -v` to also wipe the chain datadir (needed if `config/genesis.json` or `config/rollup.json` ever changes after a ForteL2 redeploy — see `README.md`).
- **Always-on deploy:** to run it as a service instead of on a laptop, point them at the **Render** section / `render.yaml` in `README.md`.

## Before you share

The config in `config/` must match the current ForteL2 deployment. If ForteL2 has been redeployed on Sepolia since you last pushed, refresh `config/genesis.json` and `config/rollup.json` before sharing, or your friend's node will derive against stale L1 history.
