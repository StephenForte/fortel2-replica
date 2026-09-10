# Task 7 Phase B evidence — 2026-09-10

Verification of the snapshot-restored **archive** replica `fortel2-replica-reth`
through staging gateway `https://fortel2-replica-reth-rpc.onrender.com`.
Compared to Mac sequencer EL `http://127.0.0.1:9545` (headers, lag) and the
live geth public gateway `https://fortel2-replica-rpc.onrender.com` (receipts,
logs). Live geth service/env were not touched. Nothing was started, stopped, or
restarted on this Mac. Receipt checks live in `scripts/verify-reth-parity.sh`
(same process as header parity; `CHECK_RECEIPTS=1`).

**STATUS:** worker-side Phase B **pass**. Q5 disk/RSS over ≥6 h and the restart
check are **pending — planner+operator (R-0016 follow-up)**. Phase C is an
operator decision (see R-0016).

The from-genesis Alchemy attempt is history; see
`docs/2026-09-09-op-reth-phase-b.md` (superseded; D-0123).

## Planner-measured, not reproduced

Planner window 2026-09-10 22:30–22:50Z. Quoted here because this worker did not
re-read Render logs, dashboard env, or Web Shell `du`/`df`:

- Render pserv `fortel2-replica-reth` (`srv-dagquc7qj5pc73fdnjsg`): op-reth
  archive from snapshot 811872, deploy of main `06dfc41`, at tip. reth logged
  `pruning_mode="archive"` and Pruner segments all `None`. Dashboard keys:
  `RETH_ARCHIVE=1`, `RETH_SNAPSHOT_URL`/`SHA256`, `L1_RPC_FORCE=public`,
  `L1_RPC_KIND=standard`. `FORCE` removed.
- Staging gateway `fortel2-replica-reth-rpc`:
  `https://fortel2-replica-reth-rpc.onrender.com` (web, diskless, `/healthz`,
  43-method allowlist, `REPLICA_UPSTREAM=http://fortel2-replica-reth:10000`
  per R-0013). Live public gateway
  `https://fortel2-replica-rpc.onrender.com` still fronts the geth replica.
- Tips at 22:47Z: staging 823455, live geth gateway 823455, Mac sequencer EL
  823508 (≈53 blocks ≈ batch-submission lag).
- Archive property through staging: `eth_getTransactionReceipt` for the first
  tx of blocks 5, 400000, 810952 → status `0x1` (block 5 was null under `--full`
  in D-0125); `eth_getTransactionByHash` ok; `eth_getLogs` 400000–400050 → 0
  logs, no error.
- Render metrics 22:30–22:40Z: memory 289–304 MB (limit 2 GiB), CPU ≈0.7 %.
  Archive datadir on the Mac ≈1.2 GB at ~823k blocks. Render disk 10 GB.
- Catch-up on PublicNode after restore: 811875 → 822825 in ≈31 min.

This worker **did** reproduce: staging and live geth tips matching each other
while the sequencer EL sits ahead; block 5 receipt status `0x1` on staging;
`eth_getLogs` 400000–400050 → 0 logs, no error (during the log hunt).

## Rebase

Branch `feat/op-reth-replica-phase-b` (one commit `9addb1f`) rebased onto
`main` `3640d7d`. Conflict in `DECISIONS.md`: kept main's R-0014 (snapshot)
and R-0015 (archive prune toml); dropped the branch draft
"R-0014 — Publicnode is tip-follow only; from-genesis catch-up is metered
Alchemy". Scripts and `docs/2026-09-09-op-reth-phase-b.md` carried forward.
One supersession line added at the top of that old doc; body unchanged.

## Header + receipt parity

```
CANDIDATE_RPC=https://fortel2-replica-reth-rpc.onrender.com \
LIVE_RPC=http://127.0.0.1:9545 \
BLOCKS_CSV=0,5,473031,473032,811872,811875 \
RECEIPT_LIVE_RPC=https://fortel2-replica-rpc.onrender.com \
RECEIPT_EXTRA_CSV=100000,400000,700000 \
LOGS_FROM=473031 LOGS_TO=483030 \
bash scripts/verify-reth-parity.sh
```

Run 2026-09-10T22:58:09Z. Exit 0.

```
heads candidate_el=823761 live_el=823901
samples=20 heights=[0, 5, 58840, 117680, 176520, 235360, 294200, 353040, 411880, 470721, 473031, 473032, 529561, 588401, 647241, 706081, 764921, 811872, 811875, 823761]
  block 0 … txCount=0 MATCH
  block 5 hash=0xd9fd2a33…e209e9 … txCount=1 MATCH
  … 18 more MATCH (including 473031, 473032, 811872, 811875, overlap head 823761) …
full-match: staging gateway = live sequencer (20 blocks)
receipt live=https://fortel2-replica-rpc.onrender.com heights=[0, 5, 473031, 473032, 811872, 811875, 100000, 400000, 700000] logs=473031-483030
  receipt block 0 SKIP (no txs)
  receipt block 5 tx=0xc3425ec1…299f4f blockHash=0xd9fd2a33…e209e9 status=0x1 logs=0 MATCH
  receipt block 473031 tx=0x6458f341…8be374 … status=0x1 logs=0 MATCH
  receipt block 473032 tx=0xc6f75634…22cd95 … status=0x1 logs=0 MATCH
  receipt block 811872 tx=0xc79da634…36257b … status=0x1 logs=0 MATCH
  receipt block 811875 tx=0x1a83dfec…0f65d2 … status=0x1 logs=0 MATCH
  receipt block 100000 tx=0x3f62400e…76c513 … status=0x1 logs=0 MATCH
  receipt block 400000 tx=0x9c1a3a4f…17512c … status=0x1 logs=0 MATCH
  receipt block 700000 tx=0x7dbbfd8b…d9b6b8 … status=0x1 logs=0 MATCH
  logs 473031-483030 count=3 first address=0x4200000000000000000000000000000000000010 topics0=0xb0444523268717a02698be47d0803aa7468c00acbed2f8bd93a0459cde61dd89 block=474217 MATCH
receipt-match: 8 receipts + eth_getLogs 473031-483030
verify-reth-parity: PASS (20 blocks)
```

Extra receipt heights 100000 / 400000 / 700000 are in 100000–800000. The
`eth_getLogs` range is the cutover window; live geth returned >0 logs (3).
First-tx receipts in that CSV are L1 attributes (`to=0x4200…0015`) so log
count is 0; the archive property is that the receipt is **not null**.

## Gateway (staging)

```
LOAD_N=40 REPLICA_L2_RPC_URL=https://fortel2-replica-reth-rpc.onrender.com \
bash scripts/allowlist-load-test.sh
```

Run 2026-09-10T22:59:12Z. Exit 0.

```
allowlist load-test url=https://fortel2-replica-reth-rpc.onrender.com n=40
  refuse eth_sendRawTransaction http=200 code=-32601 msg='method not allowed: eth_sendRawTransaction' 174ms OK
  refuse admin_nodeInfo http=200 code=-32601 msg='method not allowed: admin_nodeInfo' 138ms OK
  refuse debug_traceTransaction http=200 code=-32601 msg='method not allowed: debug_traceTransaction' 148ms OK
  refuse personal_listAccounts http=200 code=-32601 msg='method not allowed: personal_listAccounts' 155ms OK
eth_blockNumber n=40 errors=0 error_rate=0.000 p50=144ms p95=184ms max=215ms
allowlist-load-test: PASS
```

Allowlist contents were not changed. `optimism_syncStatus` stays refused
(`-32601 method not allowed: optimism_syncStatus` in the lag script).

## Sync lag (three samples ≥5 min apart)

```
REPLICA_L2_RPC_URL=https://fortel2-replica-reth-rpc.onrender.com \
LIVE_L2_RPC_URL=http://127.0.0.1:9545 \
bash scripts/replica-sync-check.sh
```

`REPLICA_MAX_SAFE_LAG=12`. Staging has no `optimism_syncStatus`; the script
uses live op-node `:9547` `safe_l2` when reachable. Negative lag means the
replica EL tip is ahead of the sequencer's reported safe (sequencer unsafe is
still slightly ahead of the replica).

| # | sampled_at (UTC) | replica EL | live EL | live safe_l2 | lag vs safe/tip | EL lag | result |
|---|---|---|---|---|---|---|---|
| 1 | 2026-09-10T22:52:30Z | 823605 | 823731 | 823605 | **0** | 126 | OK |
| 2 | 2026-09-10T22:59:11Z | 823917 | 823932 | 823761 | **−156** | 15 | OK |
| 3 | 2026-09-10T23:06:29Z | 824073 | 824151 | 824073 | **0** | 78 | OK |

Sample 1 replica hash `0xa43521dc…e5b8b9`, age_s=253.
Sample 2 replica hash `0xf7cb61b6…0849d1`, age_s=30.
Sample 3 replica hash `0xe97739d1…8b0db0`, age_s=156.

## PRD Q5 (disk / RSS)

Do not invent numbers. 0 h RSS is planner-measured. Disk cells and later
windows need Web Shell + Render metrics (planner+operator follow-up).

| | 0 h | 6 h | 24 h |
|---|---|---|---|
| `/data/db` (`du`) | pending — planner+operator (R-0016 follow-up) | pending — planner+operator (R-0016 follow-up) | pending — planner+operator (R-0016 follow-up) |
| `/data/static_files` (`du`) | pending — planner+operator (R-0016 follow-up) | pending — planner+operator (R-0016 follow-up) | pending — planner+operator (R-0016 follow-up) |
| `/data/rocksdb` (`du`) | pending — planner+operator (R-0016 follow-up) | pending — planner+operator (R-0016 follow-up) | pending — planner+operator (R-0016 follow-up) |
| `df /data` | pending — planner+operator (R-0016 follow-up) | pending — planner+operator (R-0016 follow-up) | pending — planner+operator (R-0016 follow-up) |
| RSS | 289–304 MB (planner-measured 22:30–22:40Z, not reproduced) | pending — planner+operator (R-0016 follow-up) | pending — planner+operator (R-0016 follow-up) |
| restart-check | pending — planner+operator (R-0016 follow-up) | — | — |

Planner also recorded Mac archive datadir ≈1.2 GB at ~823k blocks (not a
Render `du`). Render disk 10 GB.

## Unittest (this Mac, vs `main` `3640d7d` + this branch)

```
python3 -m unittest discover -s tests
```

104 run, 3 fail, 6 skipped. The 3 failures are `test_snapshot_reth_state`
refusing because the live `op-reth` pid is alive (environmental; green in CI):

- `test_appledouble_sibling_is_not_packed`
- `test_packs_db_and_static_files_excludes_secrets`
- `test_stale_pidfile_does_not_block`

No other movement vs the 3640d7d baseline.

```
bash -n scripts/verify-reth-parity.sh scripts/allowlist-load-test.sh scripts/replica-sync-check.sh
```

OK.

## Merge note

Merging this PR redeploys `fortel2-replica-reth-rpc` (Blueprint web,
autoDeploy on commit). Harmless: `gateway/` is untouched. Do not re-apply the
live `fortel2-replica` Blueprint entry.
