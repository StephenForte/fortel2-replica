# Task 7 Phase B evidence — 2026-09-09
Superseded by `docs/2026-09-10-op-reth-phase-b.md`; the from-genesis path was abandoned (D-0123).

Verification of `fortel2-replica-reth` (op-reth) from the Mini against the
staging gateway `https://fortel2-replica-reth-rpc.onrender.com`. Live
`fortel2-replica` / `fortel2-replica-rpc` were not touched.

**STATUS:** in progress. Parity is not green until catch-up + ≥20 sampled
blocks including 473031/473032.

## Service

| | |
|---|---|
| pserv | `fortel2-replica-reth` `srv-dagquc7qj5pc73fdnjsg` |
| plan | `1c-2g` (2 GB / 1 CPU) |
| disk | 10 GB at `/data` (Blueprint says 20 GB / `fortel2-replica-reth-data`; dashboard disk name is `disk`) |
| staging gateway | `fortel2-replica-reth-rpc` `srv-dagr42tbedkc73c5mp80` |
| `RETH_CROSS_BLOCK_CACHE_MB` | 256 (not moved) |
| auto-deploy | off |

## 12:47 PT redeploy (item 4 — resume)

`dep-dagrffuq1p3s738k53b0` trigger=`api`, live at 19:47:36Z, instance
`srv-dagquc7qj5pc73fdnjsg-wq5nd`.

| Boot | Genesis written? | L1 mode |
|---|---|---|
| 19:38:04Z instance `7f92g` | **yes** (`Genesis block written` hash `0xe242…e2386d`) | `mode=metered` QuickNode |
| 19:38:34Z `brvft` | no | `mode=metered` |
| 19:46:26Z `x9rh6` | no | `mode=public` publicnode |
| 19:47:27Z `wq5nd` (12:47 redeploy) | **no** | `mode=public` publicnode |
| 20:01:03Z `sjshs` (13:00 Alchemy) | **no** | `mode=metered` Alchemy |

Pin + hash-check ok on every start. 12:47 resume did not re-init.

## JWT line (19:38:43Z and once per later boot)

`Invalid JWT: Authorization header is missing or invalid` at
19:38:43Z, 19:46:32Z, 19:47:33Z, 19:59:55Z, **20:01:25Z** — **one line per
instance**, ~2–6 s after op-node starts. It does **not** repeat at the 30s
Docker HEALTHCHECK interval.

`healthcheck-reth.sh` does **not** probe the engine port. Until
`/tmp/fortel2-el-ready` exists it exits 1 with no HTTP; after that it
POSTs `eth_blockNumber` to loopback `L2_GETH_HTTP_PORT` (default 8546).
`Dockerfile.reth` HEALTHCHECK is `CMD ["/healthcheck.sh"]`. Render
`healthCheckPath: /` hits the method filter on `PORT` (10000). Engine
JWT is `--authrpc.port=8551` / `--l2.jwt-secret`, attached only after EL
HTTP is ready. The single ERROR is engine-attach (op-node's first
authrpc hit), not a stuck-sync signal.

## Public-leg stall (12:47–12:59 PT) — superseded as the initial-sync plan

Planner amendment #1 (`L1_RPC_FORCE=public`) is **superseded**. Publicnode
prunes historical receipts (L1 11546038 → 0; recent block → 111). Catch-up
cannot use that leg; tip-following still can (live replica overnight).

| Time (PT) | replica `eth_blockNumber` | hash |
|---|---|---|
| 12:51:09 | 3761 (`0xeb1`) | `0xea212d332c958ff2409947a605180bb921fb1af4b5566bdfee8fd71f8cfd99cc` |
| 12:53:18 | 3761 | same |
| 12:57:15 | 3761 | same (`curl`; ≥10 min after 12:47:51 forkchoice) |

Mac sequencer (12:51 PT): `safe_l2=775009` L1 origin `11670085`; EL tip
~775155. Gateway `optimism_syncStatus` → `-32601` (allowlist). L2 block
timestamp at 3761 is `2026-08-22T23:20:10Z` (historical; catch-up).

After 12:47 public boot, logs show D-0105-class receipt failures on
publicnode with `L1_RPC_KIND=quicknode`:

- `debug_getRawReceipts does not exist/is not available`
- `got 0 receipts but expected N` on L1 11546038–11546050
- `Advancing bq origin` still ticks (L1 origin crawling, `originBehind=true`)
- Forkchoice head still `0xea212d…` (3761) at 19:47:51Z

**STALL (L2, public leg).** Rate ≈ **0 L2 blocks/min** for ≥10 min (forkchoice
12:47:51Z through 12:57:15 PT). Worker did **not** flip; planner amendment #2
moved catch-up to Alchemy.

## 13:00 PT Alchemy redeploy (amendment #2)

`dep-dagrllgu01pc73euq9rg` trigger=`api`, live 20:01:12Z, instance `…-sjshs`.

- `Starting op-node … mode=metered l1=https://eth-sepolia.g.alchemy.com/<redacted> rpckind=alchemy`
- Pin + hash-check ok; **no** `Genesis block written` (resume)
- JWT ERROR once at 20:01:25Z (engine attach; same as earlier boots)
- 13:01:38–13:02:07 PT: `Advancing bq origin` 11546038 → 11546084 (~1 L1 / 0.6 s)
- Gateway 13:02:19 PT: L2 still **3761** (bq walking already-derived L1)
- Mac 13:02: `safe_l2=775315` L1 origin `11670134`

30-min checkpoint from **13:00 PT**: derive rate, 429/stall count, ETA.
If Alchemy 429s or stalls: **report only** — QuickNode fallback is the
operator’s call.

| Time (PT) | replica L2 | hash (prefix) | notes |
|---|---|---|---|
| 13:02:19 | 3761 | `0xea212d…` | t0; bq still walking |
| 13:10:03 | 7871 | `0xade4ea…` | +4110 in 7.7 min |
| 13:15:05 | 10938 | `0x00f658…` | +3067 in 5.0 min |
| 13:20:04 | 13986 | `0x9623dd…` | +3048 in 5.0 min |
| 13:25:04 | 16956 | `0x814f56…` | +2970 in 5.0 min; last `Inserted new L2` at 13:25:00 |
| 13:30:05 | 16956 | same | L2 flat 5 min; L1 origin still walking |
| 13:35:05 | 16956 | same | L2 flat **10 min**; L1 origin **11549390** |
| 14:08:04 | 27467 | `0x9d6229…` | inserts resumed 13:55:11 at 16957 |
| 14:38:03 | 48238 | `0x32b2e31…` | still inserting; L1 origin **11553422** |
| 15:08:03 | 60491 | `0x2cea996…` | inserting; L1 origin **11556364**; CPU dip last 10 min |
| 15:38:03 | 80329 | `0x59dc98c…` | burst back; L1 origin **11558621** |
| 16:08:06 | 98392 | `0x1e917cc…` | still inserting; L1 origin **11561625** |
| 16:38:02 | 112207 | `0xd9d03ae…` | mixed walk+burst; L1 origin **11563800** |
| 17:08:03 | 130087 | `0x0c90f38…` | still inserting; L1 origin **11566711** |
| 17:38:04 | 146653 | `0xdbd7a9a…` | last insert 17:34:27; L1 origin **11569623** |
| 18:08:05 | 163472 | `0x83ab6d2…` | inserts resumed ~17:45; L1 origin **11572006** |
| 18:38:05 | 181537 | `0x093b104…` | still inserting; L1 origin **11574845** |
| 19:08:08 | 189841 | `0xb0075de…` | empty-channel last 15 min; L1 origin **11577898** |
| 19:38:04 | 209722 | `0x1465b14…` | burst back; L1 origin **11579392** |
| 20:08:04 | 227614 | `0xb49ab20…` | still inserting; L1 origin **11582282** |
| 20:38:04 | 241332 | `0xc448f5b…` | still inserting; L1 origin **11584612** |
| 21:08:05 | 259520 | `0x883154a…` | still inserting; L1 origin **11587450** |
| 21:38:04 | 276234 | `0xbe8170d…` | L1 origin **11590389**; CPU dip last 1 min |
| 22:08:04 | 291511 | `0xf92329e…` | inserts resumed ~21:46; L1 origin **11592610** |
| 22:38:09 | 309685 | `0x015b2ac…` | still inserting; L1 origin **11595548** |
| 23:08:04 | 322445 | `0x208a87f…` | empty-channel ~22:55–23:05; L1 origin **11598144** |
| 23:38:13 | 341310 | `0x0e7cf0e…` | burst back; L1 origin **11600758** |
| 00:08:23 | 359694 | `0x370e5d1…` | still inserting; L1 origin **11603557**; Mac :9547 down |
| 00:38:08 | 373862 | `0xcccb248…` | empty-channel ~00:14–00:23; L1 origin **11605930**; Mac still down |
| 01:08:30 | 392340 | `0xa5d60cc…` | still inserting; L1 origin **11608771**; Mac still down |
| 01:38:22 | 405895 | `0xd8991b9…` | last insert 01:30:53; L1 origin **11611708**; Mac still down |
| 02:08:05 | **421225** | `0x0a12ae7…` | inserts resumed ~01:49; L1 origin **11613446**; Mac still down |
| 02:38:17 | **439657** | `0xb02e025…` | still inserting; L1 origin **11616447**; Mac still down |
| 03:08:07 | **452981** | `0xff02600…` | still inserting; L1 origin **11618911**; **Mac back** `safe_l2=794735` origin **11673276** |
| 03:38:06 | **471824** | `0x6c2579b…` | still inserting; L1 origin **11621690**; Mac `safe_l2=801590` origin **11674374** |
| 04:08:21 | **489959** | `0xa5dae65…` | still inserting; L1 origin **11624530**; Mac `safe_l2=802502` origin **11674524** |
| 04:38:05 | **503687** | `0xcc21aa4…` | still inserting; L1 origin **11626769**; Mac `safe_l2=803426` origin **11674674** |
| 05:08:04 | **521927** | `0xe5e5842…` | still inserting; L1 origin **11629684**; Mac `safe_l2=804338` origin **11674825** |
| 05:38:04 | **535451** | `0x36dc891…` | last insert 05:29:56; L1 origin **11632620**; Mac `safe_l2=805250` origin **11674975** |
| 06:08:53 | **554282** | `0x435c7af…` | burst insert; L1 origin **11634820**; then operator deploys (see below) |

**06:08 PT:** L2 **+18831 in 30 min (628/min)** through 06:07:20 on instance `…-sjshs`. t0→06:08: **+550521 in 1026 min = 537 L2/min**. HTTP 429 / `got 0 receipts`: **0** this interval. RSS **1228 MB** (interval peak **1373 MB** at 05:46; session peak still **1569 MB**). Mac `safe_l2=806180` origin **11675125**; replica origin lag **40305** L1. Remaining vs Mac safe ≈ **8 h**.

**06:07–06:09 PT operator deploys (worker did not flip).** Two dashboard updates on `fortel2-replica-reth`, both **update_failed**. Live deploy remains Alchemy `dep-dagrllgu01pc73euq9rg`.

1. **Manual** `dep-dahamu5bedkc739rre70` (06:07:04–06:07:54, instance `…-9vb9t`): `L1_RPC_URL` = Chainstack Sepolia (`ethereum-sepolia.core.chainstack.com/<redacted>`), `rpckind=standard`. Pin + hash-check ok. **No** `Genesis block written`. op-node crash-looped: L1 genesis header **11545587** → **403** (`Archive, Debug and Trace requests are not available on your current plan`).
2. **API** `dep-dahanne1egvs73d9ureg` (06:08:45–06:09:26): instance `…-6ktnf` booted Alchemy (`rpckind=alchemy`) then failed the update. A later instance `…-xcrzh` also tried Chainstack (same 403 class). Rollback instance `…-2wsg2` started **06:09:37** with Alchemy again. At 06:11 origin walking **11634604+**; gateway still **554282** (bq scan, no new inserts yet). Staging gateway 502'd at 06:12 during cutover.

Do **not** flip to QuickNode. Chainstack on this plan cannot serve from-genesis L1 headers.

**05:38 PT:** L2 **+13524 in 30 min (451/min)**. t0→05:38: **+531690 in 996 min = 534 L2/min**. Last insert **535451** at 05:29:56 — L2 flat ~8 min at sample (CPU ~0.04; empty-channel, L1 still walking). HTTP 429 / `got 0 receipts`: **0**. RSS **1227 MB**. Mac still up (`safe_l2=805250`, origin **11674975**; replica origin lag **42355** L1). Remaining vs Mac safe ≈ **8 h**. Do **not** flip to QuickNode.

**05:08 PT:** L2 **+18240 in 30 min (608/min)**. t0→05:08: **+518166 in 966 min = 536 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1194 MB**. Mac still up (`safe_l2=804338`, origin **11674825**; replica origin lag **45141** L1). Remaining vs Mac safe ≈ **8 h**. Do **not** flip to QuickNode.

**04:38 PT:** L2 **+13728 in 30 min (458/min)**. t0→04:38: **+499926 in 936 min = 534 L2/min**. CPU dip ~04:13–04:22 then burst. HTTP 429 / `got 0 receipts`: **0**. RSS **1192 MB**. Mac still up (`safe_l2=803426`, origin **11674674**; replica origin lag **47905** L1). Remaining vs Mac safe ≈ **9 h**. Do **not** flip to QuickNode.

**04:08 PT:** L2 **+18135 in 30 min (605/min)**. t0→04:08: **+486198 in 906 min = 536 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1160 MB** (interval peak **1323 MB**; session peak still **1569 MB**). Mac still up (`safe_l2=802502`, origin **11674524**; replica origin lag **49994** L1). Remaining vs Mac safe ≈ **9 h**. Do **not** flip to QuickNode.

**03:38 PT:** L2 **+18843 in 30 min (628/min)**. t0→03:38: **+468063 in 876 min = 534 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1216 MB**. Mac still up (`safe_l2=801590`, origin **11674374**; replica origin lag **52684** L1). Remaining vs Mac safe ≈ **9 h**. Pin 473031 ~**2 min** at sample.

**03:42 PT pin parity:** replica tip **474338** then **474494** during `verify-reth-parity.sh` (no `ALLOW_MISSING_PINS`). **20/20 MATCH** including **473031** and **473032** vs Mac `:9545`. Write-reject / load-test already green. Catch-up lag still tens of thousands of L1 — not ≤2. Do **not** flip to QuickNode.

**03:08 PT:** L2 **+13324 in 30 min (444/min)**. t0→03:08: **+449220 in 846 min = 531 L2/min**. CPU dip ~02:55–03:03 then burst (inserts at 453047). HTTP 429 / `got 0 receipts`: **0**. RSS **1075 MB**. **Mac `:9545`/`:9547` reachable again** (`safe_l2=794735`, L1 origin **11673276**; replica origin lag **54365** L1). Remaining vs Mac safe ≈ **13 h**. Pin 473031 ~**45 min**. Do **not** flip to QuickNode.

**02:38 PT:** L2 **+18432 in 30 min (614/min)**. t0→02:38: **+435896 in 816 min = 534 L2/min**. Inserts still firing at sample (439807 at 02:38:25). HTTP 429 / `got 0 receipts`: **0**. RSS **1154 MB**. Mac still unreachable (sixth tick). Remaining vs last Mac snapshot 794467 ≈ **10 h**. Pin 473031 ~**55 min**. Do **not** flip to QuickNode.

**02:08 PT:** L2 **+15330 in 30 min (511/min)**. t0→02:08: **+417464 in 786 min = 531 L2/min**. Empty-channel until ~01:49, then burst. HTTP 429: **0**. RSS **1194 MB**. Mac still unreachable (fifth tick). Remaining vs last Mac snapshot 794467 ≈ **12 h**. Pin 473031 ~**1.5 h**. Do **not** flip to QuickNode.

**01:38 PT:** L2 **+13555 in 30 min (452/min)**. t0→01:38: **+402134 in 756 min = 532 L2/min**. Last insert **405895** at 01:30:53 — L2 flat ~7.5 min at sample (CPU ~0.04; empty-channel, not a 10-min stall). HTTP 429 / `got 0 receipts`: **0**. RSS **1126 MB**. Mac still unreachable (fourth tick). Remaining vs last Mac snapshot 794467 ≈ **14 h**. Pin 473031 ~**2 h**. Do **not** flip to QuickNode.

**01:08 PT:** L2 **+18478 in 30 min (616/min)**. t0→01:08: **+388579 in 726 min = 535 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1085 MB**. Mac `:9545`/`:9547` still unreachable (third tick). Remaining vs last Mac snapshot 794467 ≈ **11 h**. Pin 473031 ~**2 h**. Do **not** flip to QuickNode.

**00:38 PT:** L2 **+14168 in 30 min (472/min)**. t0→00:38: **+370101 in 696 min = 532 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1200 MB**. Mac `:9545`/`:9547` still unreachable (second tick). Remaining vs last Mac snapshot 794467 ≈ **15 h**. Pin 473031 ~**3 h**. Do **not** flip to QuickNode.

**00:08 PT (Sep 10):** L2 **+18384 in 30 min (613/min)**. t0→00:08: **+355933 in 666 min = 534 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1418 MB** (session peak still **1569 MB**). CPU 0.10–0.30. Mac `127.0.0.1:9547` **unreachable** this tick (last sample 23:38: `safe_l2=794467`). Remaining vs that snapshot ~435k L2 / 613/min ≈ **12 h**. Pin 473031 ~**3 h**. Do **not** flip to QuickNode.

**23:38 PT:** L2 **+18865 in 30 min (629/min)**. t0→23:38: **+337549 in 636 min = 531 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1473 MB** (session peak still **1569 MB**; this interval saw 1548 MB). CPU 0.09–0.30. Mac `safe_l2=794467`. Remaining ~453k L2 / 629/min ≈ **12 h**. Pin 473031 ~3.5 h at this burst. Do **not** flip to QuickNode.

**23:08 PT:** L2 **+12760 in 30 min (425/min)**. t0→23:08: **+318684 in 606 min = 526 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1070 MB** (session peak still **1569 MB**). Mac `safe_l2=793561`. Remaining ~471k L2 / 425/min ≈ **18 h** (or ~13 h at 606/min bursts). Do **not** flip to QuickNode.

**22:38 PT:** L2 **+18174 in 30 min (606/min)**. t0→22:38: **+305924 in 576 min = 531 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1090 MB** (session peak still **1569 MB**). CPU 0.08–0.14. Mac `safe_l2=792625`. Remaining ~483k L2 / 606/min ≈ **13 h**. Do **not** flip to QuickNode.

**22:08 PT:** L2 **+15277 in 30 min (509/min)**. t0→22:08: **+287750 in 546 min = 527 L2/min**. Empty-channel until ~21:46, then burst. HTTP 429 / `got 0 receipts`: **0**. RSS **1048 MB** (session peak still **1569 MB**). Mac `safe_l2=791719`. Remaining ~500k L2 / 509/min ≈ **16 h**. Do **not** flip to QuickNode.

**21:38 PT:** L2 **+16714 in 30 min (557/min)**. t0→21:38: **+272473 in 516 min = 528 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1130 MB** (session peak still **1569 MB**). CPU 0.09–0.16 then ~0.04 at 21:37. Mac `safe_l2=790801`. Remaining ~515k L2 / 557/min ≈ **15 h**. Do **not** flip to QuickNode.

**21:08 PT:** L2 **+18188 in 30 min (606/min)**. t0→21:08: **+255759 in 486 min = 526 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1121 MB** (session peak still **1569 MB**). CPU 0.08–0.12. Mac `safe_l2=789853`. Remaining ~530k L2 / 606/min ≈ **15 h**. Do **not** flip to QuickNode.

**20:38 PT:** L2 **+13718 in 30 min (457/min)**. t0→20:38: **+237571 in 456 min = 521 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **955 MB** after a new peak **1569 MB** at 20:10 (sawtooth recovered; 77% of 2 GB). CPU 0.13–0.39. Mac `safe_l2=788947`. Remaining ~548k L2 / 457/min ≈ **20 h**. Stay on Standard. Do **not** flip to QuickNode.

**20:08 PT:** L2 **+17892 in 30 min (596/min)**. t0→20:08: **+223853 in 426 min = 525 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **1477 MB**, new session peak **1493 MB** at 19:57 (was 1278; still 73% of 2 GB). CPU 0.08 then **0.23–0.33**. Mac `safe_l2=788179`. Remaining ~561k L2 / 596/min ≈ **16 h**. Do **not** flip to QuickNode. Stay on Standard.

**19:38 PT:** L2 **+19881 in 30 min (663/min)**. t0→19:38: **+205961 in 396 min = 520 L2/min**. Inserts resumed ~19:12 (CPU 0.04→0.14). HTTP 429 / `got 0 receipts`: **0**. RSS **998 MB** (session peak still **1278 MB**). Mac `safe_l2=787255`. Remaining ~578k L2 / 663/min ≈ **15 h**. Do **not** flip to QuickNode.

**19:08 PT (6 h checkpoint):** L2 **+8304 in 30 min (277/min)** — CPU ~0.04 from 18:53 (empty-channel). t0→19:08: **+186080 in 366 min = 508 L2/min**. L1 origin 11574845 → **11577898**. HTTP 429 / `got 0 receipts`: **0**. RSS **1011 MB**. Mac `safe_l2=786319`. Remaining ~596k L2 / 508/min ≈ **20 h**. Do **not** flip to QuickNode.

**18:38 PT:** L2 **+18065 in 30 min (602/min)**. t0→18:38: **+177776 in 336 min = 529 L2/min**. HTTP 429 / `got 0 receipts`: **0**. RSS **962 MB** (session peak still **1278 MB**). CPU 0.08–0.14. Mac `safe_l2=785371`. Remaining ~604k L2 / 602/min ≈ **17 h**. Do **not** flip to QuickNode. 6 h memory window completes ~19:00.

**18:08 PT:** L2 **+16819 in 30 min (561/min)**. t0→18:08: **+159711 in 306 min = 522 L2/min**. Empty-channel until ~17:45 (CPU ~0.04), then burst. HTTP 429 / `got 0 receipts`: **0**. RSS **1047 MB** (session peak still **1278 MB**). Mac `safe_l2=784465`. Remaining ~621k L2 / 561/min ≈ **18 h**. Do **not** flip to QuickNode.

**17:38 PT:** L2 **+16566 in 30 min (552/min)**. t0→17:38: **+142892 in 276 min = 518 L2/min**. Last insert **146653** at 17:34:27 — L2 flat ~3.5 min at sample while L1 origin still walking (empty-channel, not a 10-min stall). HTTP 429 / `got 0 receipts`: **0**. RSS **936 MB** (session peak still **1278 MB**). CPU 0.09–0.15 then ~0.05 after 17:36. Mac `safe_l2=783535`. Remaining ~637k L2 / 552/min ≈ **19 h**. Do **not** flip to QuickNode.

**17:08 PT:** L2 **+17880 in 30 min (596/min)**. t0→17:08: **+126326 in 246 min = 513 L2/min**. L1 origin 11563800 → **11566711**. HTTP 429 / `got 0 receipts`: **0**. RSS **991 MB** (session peak still **1278 MB**). CPU 0.08–0.13. Mac `safe_l2=782749`. Remaining ~653k L2 / 596/min ≈ **18 h**. Do **not** flip to QuickNode.

**16:38 PT:** L2 **+13815 in 30 min (461/min)**. t0→16:38: **+108446 in 216 min = 502 L2/min**. L1 origin 11561625 → **11563800**. HTTP 429 / `got 0 receipts`: **0**. RSS **934 MB**, new session peak **1278 MB** at 16:21 (sawtooth; CPU spike 0.30 at 16:29). Mac `safe_l2=781819`. Remaining ~670k L2 / 461/min ≈ **24 h**. Do **not** flip to QuickNode.

**16:08 PT:** L2 **+18063 in 30 min (602/min)**. t0→16:08: **+94631 in 186 min = 509 L2/min**. L1 origin 11558621 → **11561625**. HTTP 429 / `got 0 receipts`: **0**. RSS **945 MB**, new session peak **1042 MB** at 16:07. CPU 0.08–0.14. Mac `safe_l2=780889`. Remaining ~682k L2 / 602/min ≈ **19 h**. Do **not** flip to QuickNode.

**15:38 PT:** L2 **+19838 in 30 min (661/min)**. t0→15:38: **+76568 in 156 min = 491 L2/min**. L1 origin 11556364 → **11558621**. HTTP 429 / `got 0 receipts`: **0**. RSS **944 MB**, new session peak **961 MB** at 15:35. CPU 0.08–0.20. Mac `safe_l2=779977`. Remaining ~700k L2 / 661/min ≈ **18 h**. Do **not** flip to QuickNode.

**15:08 PT:** L2 **+12253 in 30 min (408/min)** — slower than last interval (CPU ~0.04 from 14:59, another empty-channel stretch). t0→15:08: **+56730 in 126 min = 450 L2/min**. L1 origin 11553422 → **11556364**. HTTP 429: **0**. RSS **718 MB**, new session peak **810 MB** at 14:56. Mac `safe_l2=779059`. Remaining ~718k L2 / 408/min ≈ **29 h** (or ~18 h if 692/min bursts return). Do **not** flip to QuickNode.

**14:38 PT:** L2 **+20771 in 30 min (692/min)**. t0→14:38: **+44477 in 96 min = 463 L2/min**. L1 origin 11551453 → **11553422**. HTTP 429 / `got 0 receipts`: **0**. RSS **676 MB**, new session peak **762 MB** at 14:37 (was 728). CPU 0.08–0.19. Mac `safe_l2=778273`. Remaining ~730k L2 / 692/min ≈ **18 h**. Do **not** flip to QuickNode.

**14:08 PT (first 30-min sample):** L2 **resumed**. Empty-channel walk was 13:25:00–13:55:11 (30 min), then **+10511 L2 in 13 min** (**808 L2/min** burst). 13:35→14:08: **+10511 / 33 min = 319/min** (includes remaining L1 walk). t0→14:08: **+23706 in 66 min = 359 L2/min**. L1 origin **11551453** (`originBehind=false`). HTTP 429 / `got 0 receipts`: **0**. RSS **591 MB** (session peak still **728 MB** at 13:17; burst sawtooth to 678 MB). CPU 0.04 during walk, **0.13–0.18** while inserting. Mac `safe_l2=777349` L1 origin `11670459`. Remaining ~750k L2 / 808/min ≈ **15 h** during bursts, or ~**35 h** at blended 359/min. Do **not** flip to QuickNode.

### 30-min Alchemy checkpoint (13:00 → 13:30/13:35 PT)

| | |
|---|---|
| L2 | 3761 → **16956** (+13195 in 28 min); then **0** from 13:25–13:35 |
| Overall rate | **400 L2/min** t0→13:35 (33 min) |
| Last 10 min L2 | **0** — report threshold met |
| L1 | origin **11548969** at 13:31 → **11549390** at 13:35:43, `originBehind=false`, ~1 L1 / 0.6 s |
| HTTP 429 / `got 0 receipts` | **0** since Alchemy boot |
| RSS | peak **728 MB** (13:17); **534 MB** at 13:36. CPU 0.08–0.20 then **~0.04** during L1-only walk |
| Mac | `safe_l2=776251` L1 origin `11670284` (13:35) |
| ETA | L1 remaining ~120.9k / ~90 L1/min ≈ **22 h** of empty-channel walk; ~759k L2 remaining if 594/min resumes |

**Report (L2 rate ≈ 0 for 10 min):** last L2 insert was block **16956** at 13:25:00. Gateway still 16956 / `0x814f56…` at 13:35:05. Derivation is **not** hung: L1 origin keeps advancing (11548969 → 11549390 in ~4.7 min). Empty-channel scan, **not** a 429 stall. Do **not** flip to QuickNode.

Alchemy RSS 13:02–13:10: 134 → 316 → 457 → 359–442 MB (sawtooth). CPU ~0.08–0.14. Cache 256 unchanged. Unattended samples now **30 min**.

## Memory (6 h checkpoint, 13:01–19:08 PT)

Alchemy instance `…-sjshs` on Standard **2 GB** (`1c-2g`), `RETH_CROSS_BLOCK_CACHE_MB=256`:

| | |
|---|---|
| 1-min RSS peak | **1569 MB** at 20:10 PT (77% of 2 GB) |
| Typical sawtooth | 900–1500 MB; recovered to 955 MB at 20:38 |
| Now (20:38) | **955 MB** |
| CPU | 0.04 empty-channel / 0.08–0.39 insert (spike 0.39 at 20:32) |
| Disk used | **not in Render metrics** (10 GB disk attached; Blueprint says 20 GB) |

**Recommendation:** stay on Standard 2 GB. Do not raise the plan. Leave `RETH_CROSS_BLOCK_CACHE_MB=256`. RSS peaked at 1569 MB then dropped to 955 MB — still sawtooth, not a leak. Headroom ~479 MB at peak. Disk size is still unmeasured.

First metered instance climbed 130 → 652 MB in ~7 min (CPU ~0.1).
Public instance after 12:47: 124 MB → **231 MB** by 12:59 PT.

## Allowlist (staging gateway)

`scripts/allowlist-load-test.sh` n=20: write/admin/debug all `-32601`;
`eth_blockNumber` p95 **195 ms**, error rate **0**.

Overlap parity vs Mac `:9545` (hashes-only): early overlap MATCH through 2507
with `ALLOW_MISSING_PINS=1`. **03:42 PT** (pins derived): 20 samples including
**473031/473032** and replica tip **474494** — **PASS** (`verify-reth-parity.sh`,
no missing-pin waiver). Fields: number/hash/parentHash/stateRoot/receiptsRoot/txCount.

## Not yet

- Catch-up lag ≤ 2 L1 (3 samples) — Alchemy catch-up in progress (L2 554282 at 06:08; Mac `safe_l2=806180`, origin lag 40305 L1). 06:07–06:09 operator Chainstack/API updates **failed**; rolled back to Alchemy live deploy. Worker did not flip.
- 60-min public-leg observation after catch-up (tip-follow only)
