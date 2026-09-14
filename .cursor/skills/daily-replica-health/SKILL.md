---
name: daily-replica-health
description: >-
  Read-only ForteL2 replica health check: last-24h Render RSS/CPU/OOM and
  QuickNode credits on L2_Render vs L2_mini. Use when running Daily replica
  health, Wave 2 scoring, or replica memory/credit warn. The scheduled run is
  the Cloud Agent automation, not a local overnight loop.
disable-model-invocation: true
---

# Daily replica health

Run this as a **read-only** report. Do not implement Wave 2, do not change Render env vars, do not deploy, and do not print QuickNode RPC URLs or tokens.

The scheduled check is the Cursor Cloud Agent **Daily replica health** (04:00 Pacific). It uses Cloud Render (`https://mcp.render.com/mcp`) and QuickNode. Do not arm a local overnight loop or keep this chat open for the cron.

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

## Output

Short verdict in the Cloud Agent run transcript: Wave 2 call, peak RSS, L2 age, each endpoint's credits vs 3M, and any warning. No secrets.
