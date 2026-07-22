# ForteL2 replica

Independent **verifier node** for the [ForteL2](https://github.com/StephenForte/ForteL2) learning L2 (chain ID **852**), deriving from **Ethereum Sepolia**.

This is the package you give friends / deploy on Render. It is **not** the sequencer, batcher, proposer, or dApp — and it never needs operator private keys.

| Component | Role |
|---|---|
| op-geth | L2 execution (full sync, not archive) |
| op-node | Verifier — derives L2 from L1 batches |

Pinned images: `op-node:v1.19.2`, `op-geth:v1.101702.2` (OP Labs).

**Status (Phase 3):** Operator-verified on Render against a fresh Phase 2b cutover — matching L2 block hashes with the Mac sequencer. Genesis/rollup in `config/` must stay in lockstep with ForteL2 after any Sepolia redeploy.

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

**RAM:** Render **Starter (512MB) will OOM**. Use at least **Standard (~2GB)** for op-geth + op-node in one container. Set `GETH_CACHE_MB=256` (default in entrypoint); do not leave geth’s 1024MB default.

1. **New → Private Service** (preferred) or **Web Service**.
2. Connect this repo. Runtime: **Docker**. Dockerfile path: `./Dockerfile` (repo root).
3. Attach a **persistent disk** at `/data` (≥ 20–50 GB).
4. Env secrets: `L1_RPC_URL` (Sepolia), optional `JWT_SECRET`, `L1_BLOCK_TIME=12`, optional `GETH_CACHE_MB=256`.
5. Genesis + rollup are **baked into the image** from `config/` — no secret-file upload needed for those.

**Private Service tip:** you cannot flip Private → Web on an existing service. Compare sync via **Shell** (`geth attach --exec "eth.blockNumber" /data/geth.ipc`) or add a temporary reverse-proxy Web service on Render’s private network. Do not leave an open public `eth_sendRawTransaction` surface up.

If you change genesis/rollup (ForteL2 Phase 2b redeploy), **wipe `/data`** (or recreate the disk) after deploying the new image so the replica does not keep the old L1 history.

Or apply `render.yaml` as a Blueprint.

## Sync model

Derives from Sepolia L1 only — **no connection to the Mac mini sequencer** is required for safe/finalized heads. Unsafe tip may lag until batches land on L1.

## What not to share / commit

- No sequencer keys, harvest wallet, or `.env.sepolia`
- Do not commit real QuickNode URLs with tokens (use Render secrets / local `.env`)

## Operator (ForteL2 monorepo)

Chain config is published here from [ForteL2](https://github.com/StephenForte/ForteL2) after a Sepolia redeploy:

```bash
# in ForteL2
FORTEL2_ENV=.env.sepolia ./scripts/pack-replica-artifacts.sh
# then copy replica/config/{genesis,rollup}.json into this repo and push
# wipe Mac data-sepolia AND Render /data before restarting both
```

## License

Same learning / personal-use posture as ForteL2 — throwaway testnet only.
