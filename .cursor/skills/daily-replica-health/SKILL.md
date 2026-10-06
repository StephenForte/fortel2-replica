---
name: daily-replica-health
description: >-
  Read-only ForteL2 replica health check: last-24h Render RSS/CPU/OOM,
  QuickNode credits on L2_Render vs L2_mini, and the public /status page.
  Use when running Daily replica health, Wave 2 scoring, or replica
  memory/credit warn. Preferred schedule is a Grok Bot routine at 04:00 Pacific.
disable-model-invocation: true
---

# Daily replica health

Run this as a **read-only** report. Do not implement Wave 2, do not change Render env vars, do not deploy, and do not print QuickNode RPC URLs or tokens.

Preferred schedule: a **Grok Bot** routine at 04:00 Pacific (Cloud Render + QuickNode plugins, laptop closed). After that routine's Test succeeds, pause the Cursor Cloud Agent of the same name so only one job runs. Do not arm a local overnight loop.

## 1. Render memory (replica)

Service: `fortel2-replica-reth` (`srv-dagquc7qj5pc73fdnjsg`) in workspace `tea-d98533l7vvec738vva90`, Standard 2 GB plan. Live EL is op-reth (`Dockerfile.reth`).

- Fetch last-24h `memory_usage`, `cpu_usage`, and `memory_limit`.
- Fetch recent deploys and scan logs for OOM / killed / exit 137.
- Note the live instance and whether L2 is still catching up.
- Score only the current instance after the latest restart. Ignore older instances in the same 24h window unless they OOM'd after the current knobs were on.

Wave 2 decision (suggest only, do not implement). Match R-0017: measured catch-up **peak** only. A projected linear climb to 2 GB is not a GO. Q5 peak was 724 MB.

- **NO-GO:** peak RSS under 1,600 MB, L2 still advancing, no kill, CPU not pegged.
- **GO Wave 2:** sustained 1,600–1,900 MB, CPU under 70%. Suggested env only: `RETH_CROSS_BLOCK_CACHE_MB` already 256 (do not raise); `OP_NODE_GOMEMLIMIT=512MiB`. Revert if CPU pegs. `GETH_*` knobs do nothing on op-reth.
- **Skip Wave 2 → Pro 4 GB:** peak ≥2,000 MB or another OOM after current knobs.

Do not reopen a geth Wave 2 (`GETH_CACHE_MB` / `GETH_GOMEMLIMIT`). The geth EL path is retired.

## 2. QuickNode usage (two endpoints)

Trailing 24h credits via usage broken down by endpoint:

- **L2_Render** (replica, id `640773`)
- **L2_mini** (sequencer / Mac mini, id `640772`)

Warn if either endpoint **or** combined credits exceed ~3,000,000 in that 24h window. Name the top methods driving spend. Replica should stay on L2_Render only — never the Mac mini URL.

## 3. Public pipeline status

Open **https://fortel2-replica-rpc.onrender.com/status** in a browser. The page is client-rendered (replica + sequencer + PublicNode L1). Wait until the header says live and the pills are not `–`. Then read **Live JSON** (pipeline-health.json shape). A raw `curl` of `/status` is HTML with `{}` and is not enough.

Report in this shape (truncate hashes `0xabcd…1234`; mempool on this page is never public):

```
Verdict: HEALTHY. Sequencer “producing”, replica “following”, batcher and proposer both “healthy”, errors list empty.
Captured: 2026-10-02 12:00 UTC (5:00 AM PT), mode sepolia, L1 11155111 / L2 852.
Heads: unsafe 1,754,558 / safe 1,754,505 / finalized 1,753,875. Observation: unsafe–safe lag 53 blocks (safe head 106 s old) against a 300 s batch cadence.
Replica: derived head …, vs sequencer safe caught up | N behind; N blocks behind tip (one batch cycle is normal).
Batcher: healthy; 2 posts in scan window; last tx 0x8d5c…d875, 133 s ago; cadence 300 s.
Proposer: healthy; 527 games; latest proxy 0x04ce…9918, age 25,039 s against a 28,800 s interval.
Aggregate: 0 empty / 15 non-empty blocks, 15 txs, 32.14 tx/min, mempool not public.
Dev sleep: awake | in window (23:45–00:15 PT).
Errors: none.
```

Overall **HEALTHY** only when all four hold: the sequencer pill is `producing`, the replica pill is `following`, batcher and proposer are both `healthy`, and `errors` is empty. A replica or sequencer that still answers RPC but has stopped advancing shows `behind` / `stalled` with **no** entry in `errors`, while batcher and proposer can stay healthy (2026-10-06: both heads froze for hours on a Sepolia fork). So never call HEALTHY from batcher, proposer and `errors` alone. Otherwise name the failing pill and the error strings. Replica lag of about one batch cadence is normal and already inside `following` (head age ≤ 900 s), so it is not a failure.

## Output

Short verdict in the Grok Bot chat (or Cloud Agent transcript until that job is paused): Wave 2 call, peak/last/avg RSS, CPU 5-min peak and 60 s max, OOM/137/restart/deploy, the `/status` block above, and each endpoint's credits vs 3M. No secrets.

## Grok Bot routine (paste)

```
Every day at 4:00 AM Pacific, run a read-only ForteL2 replica health check.

Use Cloud Render and QuickNode. Do not change env, deploy, or print RPC URLs.

1. Render: fortel2-replica-reth (srv-dagquc7qj5pc73fdnjsg), workspace tea-d98533l7vvec738vva90, Standard 2 GB. Score only the current instance after the latest restart. Report peak / last / avg RSS, memory limit, CPU 5-min avg peak, CPU 60s max, any OOM / exit 137 / restart, any new deploy.

Wave 2 suggest-only (R-0017, peak only): NO-GO under 1,600 MB; GO 1,600–1,900 MB with CPU under 70%; Pro if ≥2,000 MB or OOM. Do not raise RETH_CROSS_BLOCK_CACHE_MB.

2. QuickNode last-24h credits for L2_Render (640773) and L2_mini (640772). Warn if either or combined exceeds ~3M. Name top methods.

3. Open https://fortel2-replica-rpc.onrender.com/status in a browser. Wait until it is live (pills not "–"). Read Live JSON. Report exactly like this (truncate hashes; mempool is not public on this page):

Verdict: HEALTHY. Sequencer “producing”, replica “following”, batcher and proposer both “healthy”, errors list empty.
Captured: <UTC> (<PT>), mode sepolia, L1 11155111 / L2 852.
Heads: unsafe … / safe … / finalized …. Observation: unsafe–safe lag N blocks (safe head Ns old) against the batch cadence.
Replica: derived head …; vs sequencer safe …; N blocks behind tip (one batch cycle is normal).
Batcher: <verdict>; N posts in scan window; last tx 0xabcd…1234, Ns ago; cadence Ns.
Proposer: <verdict>; N games; latest proxy 0xabcd…1234, age Ns against a 28,800 s interval.
Aggregate: N empty / N non-empty blocks, N txs, N tx/min, mempool not public.
Dev sleep: awake | in window (23:45–00:15 PT).
Errors: none.

HEALTHY only if the sequencer pill is "producing", the replica pill is "following", batcher and proposer are healthy, and errors is empty. A "behind" replica or "stalled" sequencer is never HEALTHY even when errors is empty. Post the full verdict in this chat.
```
