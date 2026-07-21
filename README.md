# ForteL2 replica

Independent **verifier node** for the [ForteL2](https://github.com/StephenForte/ForteL2) learning L2 (chain ID **852**), deriving from **Ethereum Sepolia**.

This is the package you give friends / deploy on Render. It is **not** the sequencer, batcher, proposer, or dApp — and it never needs operator private keys.

| Component | Role |
|---|---|
| op-geth | L2 execution (archive) |
| op-node | Verifier — derives L2 from L1 batches |

Pinned images: `op-node:v1.19.2`, `op-geth:v1.101702.2` (OP Labs).

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

1. **New → Private Service** (preferred) or **Web Service**.
2. Connect this repo. Runtime: **Docker**. Dockerfile path: `./Dockerfile` (repo root).
3. Attach a **persistent disk** at `/data` (≥ 20 GB).
4. Env secrets: `L1_RPC_URL` (Sepolia), optional `JWT_SECRET`, `L1_BLOCK_TIME=12`.
5. Genesis + rollup are **baked into the image** from `config/` — no secret-file upload needed for those.

Or apply `render.yaml` as a Blueprint.

**Web Service note:** the entrypoint listens on Render’s `PORT` for EL HTTP when set. Prefer **Private Service** so JSON-RPC is not public (`eth_sendRawTransaction` is an open footgun).

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
# then copy replica/config/{genesis,rollup}.json into this repo and bump a release
```

## License

Same learning / personal-use posture as ForteL2 — throwaway testnet only.
