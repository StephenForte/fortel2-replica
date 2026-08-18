---
name: daily-replica-health
description: >-
  Read-only ForteL2 replica health check: last-24h Render RSS/CPU/OOM and
  QuickNode credits on L2_Render vs L2_mini. Use when running Daily replica
  health, the 04:00 local loop, Wave 2 scoring, or replica memory/credit warn.
disable-model-invocation: true
disabled-environments:
  - cloud
---

# Daily replica health

Run this as a **read-only** report. Do not implement Wave 2, do not change Render env vars, do not deploy, and do not print QuickNode RPC URLs or tokens.

This check must run in a **local** agent (this machine). Cloud automations cannot see the Render plugin. Use Render and QuickNode from the local catalog.

## 1. Render memory (replica)

Service: `fortel2-replica` (`srv-d9fsgi3rjlhs73ceh6tg`) in workspace `tea-d98533l7vvec738vva90`, Standard 2 GB plan.

- Fetch last-24h `memory_usage`, `cpu_usage`, and `memory_limit`.
- Fetch recent deploys and scan logs for OOM / killed / exit 137.
- Note the live instance and whether L2 is still catching up (`Imported new potential chain segment age=`).
- Score only the current instance after the latest restart. Ignore older instances in the same 24h window unless they OOM'd after Wave 1 knobs were on.

Wave 2 decision (suggest only, do not implement). Match R-0012: measured catch-up **peak** only. A projected linear climb to 2 GB is not a GO.

- **NO-GO:** peak RSS under 1,600 MB, L2 still advancing, no kill, CPU not pegged.
- **GO Wave 2:** sustained 1,600–1,900 MB, CPU under 70%. Suggested env only: `GETH_CACHE_MB=64`, `GETH_GOMEMLIMIT=512MiB`, `OP_NODE_GOMEMLIMIT=512MiB`, `GOGC=50`. Revert if CPU pegs.
- **Skip Wave 2 → Pro 4 GB:** peak ≥2,000 MB or another OOM after Wave 1.

Wave 1 is already live (`L1_CACHE_SIZE=128`, `GETH_FDLIMIT=4096`, noprefetch, `GOMEMLIMIT` 700/768). Do not reopen Wave 2 unless today's catch-up peak is 1,600–1,900 MB.

## 2. QuickNode usage (two endpoints)

Trailing 24h credits via usage broken down by endpoint:

- **L2_Render** (replica, id `640773`)
- **L2_mini** (sequencer / Mac mini, id `640772`)

Warn if either endpoint **or** combined credits exceed ~3,000,000 in that 24h window. Name the top methods driving spend. Replica should stay on L2_Render only — never the Mac mini URL.

## Output

Short verdict in chat, plus a canvas: Wave 2 call, peak RSS, L2 age, each endpoint's credits vs 3M, and any warning. No secrets. Slack is optional and only if that integration is connected in this local session.
