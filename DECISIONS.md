# Decisions — fortel2-replica

Numbered, append-only. **Never renumber.** To reverse a decision, add a new one and edit the
old entry in place to read `SUPERSEDED by R-00NN (YYYY-MM-DD)` with the reason — do not delete
it. Later work cites these IDs instead of re-deciding.

`R-` numbers are local to this repo. `D-` numbers are ForteL2's
([StephenForte/ForteL2](https://github.com/StephenForte/ForteL2)) and are referenced, never
allocated from here.

---

## R-0001 — The public read URL is a second, diskless service

*2026-08-16 · implements ForteL2 D-0031, D-0032*

The live Oregon service `fortel2-replica` stays a **Private Service** with its 50 GB `/data`
disk. Public read RPC is published by a **separate diskless Web Service**
(`fortel2-replica-rpc`) that reverse-proxies to `http://fortel2-replica:10000`.

**Why.** Render cannot flip Private ↔ Web in place and cannot reattach `/data` to a new
service. Any route that produces a *new* replica costs a full L1 resync from rollup genesis
`11323401` plus a duplicate disk.

**Consequences.** SettlementOS keeps reading `http://fortel2-replica:10000` (D-0032) and is
unaffected by anything the gateway does. Both services must live in the **same Oregon
environment** — Render private DNS does not resolve across regions. Reverting the public door
means deleting or suspending `fortel2-replica-rpc` only; the replica is never recreated "to go
private again."

See `README.md` §"Going public" and §"Revert".

## R-0002 — The gateway is nginx

*2026-08-16*

`gateway/` is an nginx image using `limit_req`. Not Caddy, not a Python proxy.

**Why.** Caddy needs a third-party plugin and an `xcaddy` build for per-IP rate limiting.
A Python limiter was rejected separately — see R-0003.

## R-0003 — No rate limiter inside `rpc-method-filter.py`

*2026-08-16*

Per-IP limiting lives on the gateway. `rpc-method-filter.py` stays allowlist-only.

**Why.** The filter runs in the replica container on a memory-tight Standard (2 GB) box
alongside op-geth and op-node, and it is **vendored from ForteL2** `scripts/rpc-method-filter.py`
— divergence makes the "apply security fixes in both repos" rule unworkable. Already stated in
`README.md`; recorded here so it survives the file's next rewrite.

## R-0004 — The gateway upstream is a literal, never `fromService`

*2026-08-16* · **SUPERSEDED by R-0008 (2026-08-16)** — the gateway is not declared in
`render.yaml` at all, so there is no `fromService` decision left to make. The analysis below is
retained because it is *why* R-0008 goes further, and because the prohibition still binds
anyone who later proposes adding the gateway back to the Blueprint.

`render.yaml` sets `REPLICA_UPSTREAM: http://fortel2-replica:10000` as a literal `value:`.
**Do not** use `fromService`.

**Why.** `fromService` resolves only within the same Blueprint. The live `fortel2-replica` was
created from the Dashboard and is **unattached** to this Blueprint, so the reference does not
resolve to the live 50 GB replica — it resolves to whichever replica that same Blueprint apply
just created. That is the R-0001 / D-0031 failure mode reached through a config idiom rather
than an error: a second empty-disk node resyncing from `11323401`, with nothing visibly broken
until someone notices two nodes billing.

The literal is correct in both worlds — greenfield (the Blueprint names the replica
`fortel2-replica`) and live (that private hostname already resolves).

**Related:** `render.yaml`'s `sizeGB: 20` is the greenfield minimum, not the live disk. Raising
it to 50 resizes nothing; it only makes a *new* apply provision an empty 50 GB volume.

## R-0005 — Gateway environment contract

*2026-08-16*

Fixed names and defaults, shared by `gateway/` and `render.yaml`. Changing one of these is a
decision, not an implementation detail — supersede this entry rather than editing in place.

**Amended 2026-08-16 by R-0008:** the values are unchanged, but they are pasted into the
Dashboard as a checklist rather than synced from `render.yaml` — the gateway is not declared
there. `README.md` §"Going public" is the authoritative copy of this table.

**Amended 2026-08-16 by R-0010:** `RPC_REAL_IP_HEADER` default is `CF-Connecting-IP`, not
`X-Forwarded-For`. Render's edge is always Cloudflare.

| Key | Default | Meaning |
|---|---|---|
| `PORT` | Render-injected | nginx listen port (not declared in `render.yaml`) |
| `REPLICA_UPSTREAM` | `http://fortel2-replica:10000` | upstream origin, scheme included (R-0004) |
| `RPC_RATE` | `20r/s` | `limit_req_zone` rate |
| `RPC_BURST` | `40` | `limit_req` burst |
| `RPC_REAL_IP_HEADER` | `CF-Connecting-IP` | header carrying the client IP; `X-Forwarded-For` only if you need the chain (R-0006 / R-0010) |
| `RPC_MAX_BODY` | `1m` | `client_max_body_size`, matched to the filter's `MAX_BODY_BYTES` (1 MiB) |

Build: Dockerfile path `./gateway/Dockerfile`, context `./gateway`, no disk, region `oregon`,
health check `/healthz`.

## R-0006 — Rate limiting keys on a resolved client IP, and fails safe

*2026-08-16*

`limit_req_zone` must **not** key on bare `$remote_addr` / `$binary_remote_addr`. The key is
resolved through `RPC_REAL_IP_HEADER`, with an explicit non-empty fallback to `$remote_addr`
when the header is absent or unparseable. `limit_req_status 429`.

**Why.** Render terminates TLS at its edge, so the gateway's peer address is Render's proxy —
keying on it puts **every client on earth in one 20 r/s bucket**, a self-DoS that looks
perfectly healthy under single-client testing. Trusting the leftmost `X-Forwarded-For` entry
unconditionally is the opposite failure: any client spoofs its own key and bypasses the limit.
The chain also changes shape by deployment — behind Cloudflare, Render's peer is Cloudflare, so
XFF reads `client, cf-ip` and the *rightmost* entry is Cloudflare, not the client.

An **empty** `limit_req_zone` key disables limiting silently — hence the mandatory fallback.
`limit_req_status` is called out because nginx defaults to **503** while `README.md`'s smoke
test promises **429**.

**Open, by design:** the true chain shape can only be confirmed against the live deployment.
`gateway/README.md` carries the post-deploy verification (what to curl, what the access log
should show, how to tell "limiting the wrong key" from "working").

## R-0007 — First version limits HTTP requests per IP only

*2026-08-16*

No method-level or cost-aware limiting. `eth_getLogs`, `eth_call`, and `eth_getProof` stay
allowlisted and unweighted, and a JSON-RPC **batch counts as one HTTP request**.

**Why.** Ship the door before the tuning. Recorded as a known gap so it is documented as a gap
rather than implied to be covered — a client can still buy expensive work per request within
the rate limit. Revisit if the public endpoint sees real traffic.

## R-0008 — The gateway is not declared in `render.yaml`; the Blueprint stays single-service

*2026-08-16 · supersedes R-0004, amends R-0005 · AMENDED by R-0013 (2026-09-08) — Blueprint may declare the new Task 7 pserv + staging gateway; the live `fortel2-replica` entry is still never re-applied, and live `fortel2-replica-rpc` stays Dashboard-only.*

`render.yaml` continues to define **exactly one** service: the private replica. The gateway
(`fortel2-replica-rpc`) is created from the Dashboard — **New → Web Service** — and is
unattached to any Blueprint, like the live replica already is. Its configuration lives as a
paste-in checklist in `README.md` §"Going public" (R-0005 table + Dockerfile path
`./gateway/Dockerfile`, context `./gateway`, no disk, region `oregon`, health check
`/healthz`, plan Starter or higher).

**Why.** A Blueprint apply cannot add a service *into* the existing Oregon environment
alongside an unattached pserv — it creates its own services. So the Blueprint path can never
produce the gateway that is actually wanted: one that reaches the **live** 50 GB replica over
private DNS. It can only produce a second replica plus a gateway, which is the R-0001 /
D-0031 outcome. Declaring the gateway in a file whose own header says "do not apply this"
is a document that contradicts itself, and the contradiction is the kind that gets resolved
at 2am by clicking the button.

Both live services are therefore Dashboard-created and unattached, and that is the intended
steady state — not a temporary condition to be cleaned up later.

**Consequences.**

- `render.yaml` keeps its single-service greenfield-reference role: it is the canonical copy
  of the **replica's** env values, which `README.md`'s tables mirror. It is not a deployment
  mechanism for anything live.
- `README.md` should not present Blueprint as the *preferred* path. It is a reference for a
  hypothetical greenfield replica; every service that actually exists is created and
  configured by hand.
- Gateway env changes are made in the Dashboard and mirrored into `README.md` §"Going
  public". Nothing syncs them — drift between the two is a documentation bug that no tool
  will catch.
- `sizeGB: 20` in `render.yaml` stays as-is, unchanged and still not the live disk (R-0004).

## R-0009 — Public sequencer reads are a third diskless service, not the replica gateway

*2026-08-16*

The explorer needs chain-852 **tip** reads (a just-settled escrow hash in seconds). The
public replica (`fortel2-replica-rpc`) derives from L1 batches and lags ~3 minutes; pointing
the browser at `https://fortel2-write.ente.ltd` is wrong (Cloudflare Access 403 without
service-token headers, and it accepts `eth_sendRawTransaction`).

**Do this:** a new diskless Web Service (`fortel2-sequencer-rpc`) that runs
`sequencer-read/start.sh` → `rpc-method-filter.py` with:

- `L2_RPC_FILTER_UPSTREAM=https://fortel2-write.ente.ltd`
- `L2_RPC_FILTER_REMOTE_UPSTREAM_HOSTS=fortel2-write.ente.ltd` (exact hostname, https/443 only)
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` copied from SettlementOS (`sync: false`)

The filter still drops `eth_sendRawTransaction`. Browsers never see the Access token.
SettlementOS **write** transports stay on `fortel2-write.ente.ltd` + Access; SettlementOS
**reads** stay on `http://fortel2-replica:10000`. Do not retarget `fortel2-replica-rpc` at
the sequencer — that would lose the L1-verified replica and put Access secrets on the
replica-lag gateway.

**Not this:** proxying the sequencer through the explorer Express app (explorer D32
declined: write-capable relay). A remote upstream is an **opt-in allowlist**; unset
`L2_RPC_FILTER_REMOTE_UPSTREAM_HOSTS` keeps the replica loopback-only.

**Rate limit.** R-0003 still forbids a limiter inside the filter. v1 ships without nginx
`limit_req` (Render platform DDoS only). If this door sees real traffic, put a copy of
`gateway/` in front the same way `fortel2-replica-rpc` sits in front of the replica — do
not add a token bucket to `rpc-method-filter.py`.

**Replica bounce.** This service can deploy from a feature branch. Merging the filter
change to `main` will rebuild `fortel2-replica` (auto-deploy on checks). That restart is
a catch-up lag event; do not merge until that bounce is acceptable.

See `README.md` §"Public sequencer reads".

## R-0010 — Gateway real-IP default is `CF-Connecting-IP`

*2026-08-16 · amends R-0005*

`RPC_REAL_IP_HEADER` defaults to `CF-Connecting-IP`, matching `gateway/Dockerfile`.
`X-Forwarded-For` is an override for when you need the chain, not the Render default.

**Why.** Every Render Web Service terminates through Cloudflare first (platform edge,
not optional orange-cloud). XFF's rightmost hop is therefore a CF PoP. The original
R-0005 default of `X-Forwarded-For` plus a private-only trust list keys every client
at that PoP into one 20 r/s bucket. `gateway/` already shipped the CF default and
trusts Cloudflare CIDRs; root docs had not caught up.

**Consequences.** `README.md` §"Going public" and this file's R-0005 table match
`gateway/README.md`. Operator orange-cloud in front of the `onrender.com` hostname
is a second CF hop — leave the default; their edge overwrites `CF-Connecting-IP`
with the same client.

## R-0011 — Gateway upstream DNS is per-request and search-qualified, confirmed live

*2026-08-17 · corrects R-0004's implicit assumption, supersedes the reverted G-2 (PR #32)*

`fortel2-replica-rpc`'s nginx uses a variable `proxy_pass` + `resolver <nameservers from
/etc/resolv.conf>` so it *can* re-query after the cached DNS TTL expires, instead of the
original literal `proxy_pass` (resolved once at config load, cached for the process lifetime).
That is not an immediate lookup on every request — nginx still caches the answer for the
response TTL (no `valid=` override). A bare host with no dot is qualified with the first token
of `/etc/resolv.conf`'s `search` line before nginx resolves it; a host that already contains a
dot is left unchanged. Both the nameserver list and the search domain are read from the
container's own `/etc/resolv.conf` at startup — never hardcoded.

**Why — two incidents, in order:**

1. **2026-08-16, ~20:00 UTC.** Literal `proxy_pass` cached `fortel2-replica`'s IP at container
   start. After a replica redeploy, the gateway kept dialing the dead address —
   `upstream timed out (110: Operation timed out)` on every request for seven minutes, until the
   gateway was manually restarted. Root cause: nginx only re-resolves a `proxy_pass` address when
   it is a variable *and* a `resolver` directive is configured.
2. **2026-08-16, 20:36–21:37 UTC.** The first fix (PR #32) added a variable `proxy_pass` +
   `resolver` sourced from `/etc/resolv.conf` `nameserver` lines — correct nginx, but nginx's
   `resolver` directive does not apply `/etc/resolv.conf`'s `search` domain list the way the OS
   resolver (`getaddrinfo`, used by the literal form) does. Every request failed immediately:
   `fortel2-replica could not be resolved (3: Host not found)`, continuously, not just after a
   redeploy — worse than incident 1. Reverted (PR #34) back to the literal-`proxy_pass` state
   (incident 1's known, lesser bug) while a real fix was built.

**Confirmed live** (PR #35, deployed `dep-da15458u01pc73fk147g`, 2026-08-17T00:13Z): the
container's actual `/etc/resolv.conf` on Render is Kubernetes-style cluster DNS —

```
resolver=169.254.20.10 10.12.0.10 search=own-d98533l7vvec738vva9g.svc.cluster.local
upstream=http://fortel2-replica.own-d98533l7vvec738vva9g.svc.cluster.local:10000
```

— and a live `eth_chainId` request through the public gateway returned `result: "0x354"`,
HTTP 200, immediately after deploy. That is initial search-qualified resolution against real
Render DNS, not a replica-address change.

**Not yet reproduced live:** incident 1's original scenario — redeploying `fortel2-replica`
alone, without touching the gateway, so the gateway must pick up a new replica address.
`tests/test_gateway_config.py` does **not** simulate a DNS-address change without restart
(Docker embedded-DNS TTLs would make a same-name container swap a false failure). Coverage
stops at configuration plus initial search-qualified resolution. Do not treat failover as
tested — confirm on the next natural replica redeploy rather than forcing one, or add a real
DNS-address-change test. Until then this is open.

**Consequences.** No `valid=` TTL override — resolution respects whatever TTL Render's cluster
DNS returns. Do not hardcode `169.254.20.10` / `10.12.0.10` / the `.svc.cluster.local` suffix
anywhere — they are read fresh from `/etc/resolv.conf` on every container start and are not
guaranteed stable across regions, plans, or Render infrastructure changes.

## R-0012 — Replica memory is Wave 1 on Standard; Wave 2 is a measured fallback

*2026-08-17*

Live `fortel2-replica` stays **Standard (2 GB)**. Catch-up OOM (exit 137) was op-node's
default `--l1.cache-size=900` (full L1 blocks + receipts) plus unbounded geth Pebble
handles, not a Python filter leak. Wave 1 (PR #39) is the live policy, already in
`entrypoint.sh` / `render.yaml` / the dashboard:

- `L1_CACHE_SIZE=128`, `L1_MAX_CONCURRENCY=2`, `L1_RPC_MAX_BATCH_SIZE=5`
- `GETH_FDLIMIT=4096`, `--cache.noprefetch`
- existing `GETH_CACHE_MB=128`, `GETH_GOMEMLIMIT=700MiB`, `OP_NODE_GOMEMLIMIT=768MiB`

**Measured 2026-08-17:** after the Wave 1 env restart, catch-up RSS sawtoothed **256–478 MB**
for 12+ hours of batch decode (Wave 0 peak was **2,125 MB**, then cgroup kill). Wave 2 is
**not** indicated.

**Wave 2** (dashboard env only — do not apply `render.yaml` as a new Blueprint, R-0008):
`GETH_CACHE_MB=64`, both `GOMEMLIMIT=512MiB`, `GOGC=50`. Use only if a later catch-up
window peaks **1,600–1,900 MB** with CPU under 70%. Revert if CPU pegs. A projected
climb toward 2 GB is not Wave 2 by itself — the daily scorer uses this peak band
only. Skip Wave 2 and go **Pro 4 GB** if peak ≥2,000 MB or exit 137 after Wave 1.

Do not set `L1_CACHE_SIZE=0` (op-node treats 0 as ~2400). Do not tighten `GOMEMLIMIT`
while the L1 cache is still 900.

**Daily check:** Cloud Agent **Daily replica health** at 04:00 Pacific (skill
`.cursor/skills/daily-replica-health`). Scores last-24h replica RSS against the
Wave 2 table and QuickNode credits on **L2_Render** (replica) vs **L2_mini**
(sequencer / Mac mini). Warn if either endpoint or combined credits exceed
~3M/day. Uses Cloud Render plus QuickNode. Verdict is the automation run
transcript. Do not run a local overnight loop. The agent **suggests** Wave 2 —
it does not change env or deploy.

See `README.md` §"Render".

## R-0013 — Task 7 Phase A: new op-reth replica on a new service/disk; live geth is frozen

*2026-09-08 · implements ForteL2 Task 7 / D-0109 / D-0110 / D-0114 / D-0122 · AMENDED by R-0014 (2026-09-10) — bootstrap is a stopped-EL snapshot, not a from-genesis metered derive*

The operated Render replica moves to **op-reth** on a **new** Private Service and a **new** disk. The live geth pserv `fortel2-replica` and its 50 GB `fortel2-replica-data` are never mutated. Public read and SOS private read stay on today's hostnames until Phase C.

**Image pin (immutable digest, Task 1 rule / D-0109).**

- `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-reth:v2.3.3@sha256:eec35eaafb6f8b3d07c6844ff87c4f8af81fca088472b6a432435c53a36b8a4c`
- `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.19.2@sha256:3652c0faa7582e49c31a71f86bc5170167499aed7e382e92722f34beb233ef1a`

The container binary must report `Reth Version: 2.3.0-dev` commit `9384bc53d8c0c77e59cac83fdaaf3b372c6d2216`. `entrypoint-reth.sh` asserts that at start and **fails closed** otherwise. Do not grep the tag string `2.3.3` (absent) or a bare `2.3`.

**Role.** Verifier only: `op-reth --full` (prune mode — without it this is an archive on a 20 GB disk), `--rollup.disable-tx-pool-gossip`, no `--proofs-history`. op-node `--l2.enginekind=reth`, `--sequencer.enabled=false`, `--p2p.disable=true`. `--l1.rpckind` from `L1_RPC_KIND` (default `quicknode`).

**Binds.** Unchanged from today's replica: op-reth HTTP loopback only (`L2_GETH_HTTP_PORT`, default 8546); op-node loopback `:9545`; the method filter is the only listener on `PORT`. Allowlist is byte-identical (`tests/test_rpc_method_filter.py`). Fresh JWT is generated in-container on `/data` — never the Mac's, never the old replica's. The new Blueprint entry does **not** declare `JWT_SECRET`.

**New Render objects (operator-applied).**

| Object | Role |
|---|---|
| pserv `fortel2-replica-reth` | Oregon, plan **standard** to start. Memory is **measured in Phase B** before any plan change. |
| disk `fortel2-replica-reth-data` | 20 GB at `/data`. D-0122 sizing: `--full` state ≈1–2 GB, no proofs store. |
| web `fortel2-replica-reth-rpc` | Diskless staging gateway. `REPLICA_UPSTREAM=http://fortel2-replica-reth:10000` (literal, not `fromService`). Used **only** for pre-repoint verification. |

Existing `fortel2-replica`, its disk, and `fortel2-replica-rpc` stay as they are until Phase C.

**Do not re-apply the live Blueprint entry.** That first `services:` block is a frozen snapshot (R-0008). A new apply creates a second empty-disk replica named `fortel2-replica`. Add objects; never rewrite that entry.

**Two Dockerfiles (why `./Dockerfile` stays geth).** Live `fortel2-replica` is Dashboard-created and auto-deploys `./Dockerfile`. Replacing that file with an op-reth image would start reth against the 50 GB geth disk on the next main deploy — the R-0008 / empty-disk class of accident, reached through an image swap rather than a new Blueprint apply. `./Dockerfile` therefore stays **byte-identical to main's op-geth v1.101702.2 image**. The Task 7 image is `Dockerfile.reth` (digest-pinned op-reth + op-node); only `fortel2-replica-reth` points at it. Phase C is a routing flip + rename-swap, not a redeploy onto the old disk.

**Initial L1.** AMENDED by R-0014: do not finish the from-genesis metered derive (D-0123). Snapshot-restore the Mac sequencer datadir, then `L1_RPC_FORCE=public` for tip-follow. The original Phase A start (`L1_RPC_FORCE=metered`) remains the recorded first-boot path; it is paused at ~68 %, not deleted.

**Memory knobs (reth equivalents of `GETH_*`).** Pinned op-reth defaults `--engine.cross-block-cache-size` to **4096 MB** — that OOMs Render Standard. Starting values:

| Old (geth / R-0012) | New (reth) | Flag |
|---|---|---|
| `GETH_CACHE_MB` | `RETH_CROSS_BLOCK_CACHE_MB=256` | `--engine.cross-block-cache-size` |
| (unbounded RPC cache) | `RETH_RPC_CACHE_MAX_BLOCKS=256` | `--rpc-cache.max-blocks` |
| `GETH_GOMEMLIMIT` / `GETH_FDLIMIT` | *removed* | op-reth is Rust; those Go/geth knobs do nothing |
| `OP_NODE_GOMEMLIMIT=768MiB` | kept | op-node is still Go |
| `L1_CACHE_SIZE=128` etc. | kept | op-node L1 receipt cache |

Phase B measures RSS/disk over ≥6 h and recommends a plan. Do not upgrade the plan on a guess. Mini archive RSS was 1.4 GB (D-0122); this verifier is `--full`, not archive.

**Artifacts.** `config/genesis.json` + `config/rollup.json` are the same 852 files (`pack-replica-artifacts.sh` output). Entrypoint hash-checks `genesis.l2.hash == 0xe242b1a3312b509e7df1496847f0bd0b115cb66676b1e973a355296c99e2386d` and refuses chain 901.

**Phase C (operator window, recorded here so Phase A does not invent a third option).** Public read = flip `fortel2-replica-rpc`'s `REPLICA_UPSTREAM` to the new private host. SOS private read (`http://fortel2-replica:10000`, D-0032) is a **rename-swap**: old service → `fortel2-replica-geth`, new → `fortel2-replica`. Rollback = reverse both (env flip + rename); no disk is touched. Suspend the old service after a clean 24 h; do not delete it (Task 9). `rail-interface.json` `readRpcUrl` does not change (same public hostname).

**Q4 / Q5 (PRD §11) stay open** until Phase B measures: whether `--full` is enough for public RPC (D-0114 prune window: diskless gateway cannot serve state older than ~latest−256), and disk/RAM of a clean 852 `--full` sync under current RPC load.

**Not this decision.** Sequencer-tip / authenticated write; `fortel2-node` / `FRIENDS.md` (Task 8); deleting the old service or disk (Task 9); ForteL2 docs (planner-owned).

## R-0014 — Bootstrap the Render reth replica from a stopped-EL snapshot of the Mac sequencer

*2026-09-10 · implements ForteL2 D-0123 resume; amends R-0013 initial-L1*

Do not re-derive ~800k L2 blocks against a metered L1 provider. Publicnode prunes old receipts; Alchemy free is ≈340 CU per L1 block; Chainstack free has no history; QuickNode is declined (D-0123). Resume Task 7 by restoring `db/` + `static_files/` + `rocksdb/` captured from the Mac's live `$DATA_DIR/l2/op-reth` **while op-reth is stopped**. `rocksdb/` is a first-class datadir store (`--datadir.rocksdb`), not a cache — restoring MDBX + static_files without it leaves the node with no RocksDB or the stale paused-derive one next to a newer MDBX.

**Capture (Mac Mini, operator-supervised, daytime — not 23:45).** `scripts/snapshot-reth-state.sh` (this repo; also the ForteL2 landing for the same helper). Refuses if the op-reth pid is alive. Packs `db/` + `static_files/` + `rocksdb/` (the last two when present). Excludes `historical-proofs/` (sequencer-only, 15+ GB), `jwt.txt`, `exex/`, `blobstore/`, `reth.toml`, `discovery-secret`, `known-peers.json`, `invalid_block_hooks/`, logs, pids, and anything under `$DATA_DIR` outside `l2/op-reth`. Asserts the archive listing is clean before writing. Output: `fortel2-852-reth-snapshot-<L2head>.tar.zst` plus a SHA-256 manifest and metadata JSON (L2 head number/hash, safe/finalized hashes, capture time, pin commit `9384bc53…`) under `$DATA_DIR/snapshots/`. GitHub release assets cap at 2 GiB — measure; if larger, split or do not publish as one asset. Nothing secret enters the tarball.

**Restore (`entrypoint-reth.sh` only).** When `RETH_SNAPSHOT_URL` is set and the datadir has no `db/`, download, verify SHA-256 against `RETH_SNAPSHOT_SHA256` (refuse on mismatch), extract `db/` + `static_files/` + `rocksdb/` only into a staging dir, then continue the existing pin assert + 852 genesis hash-check (those already ran fail-fast before the download). Never restore over an existing `db/` unless `RETH_SNAPSHOT_FORCE=1` (operator-set, one-shot — replace `db/` + `static_files/` + `rocksdb/` **only after** download/hash/listing/extract succeed, keep `jwt.txt`, **unset FORCE after that boot**). A FORCE failure leaves the paused derive in place. Live `./Dockerfile` / `entrypoint.sh` stay the geth image and never grow this path.

**Verifier profile.** The restored node still runs `--full`. The Mini dry-run (restore into `$DATA_DIR/l2/spike-op-reth`, `start-op-reth-verifier.sh`, publicnode L1) must prove reth accepts an archive-captured datadir under prune-forward, and that op-node resumes from the snapshot's **safe** head (L1 origin near capture time — not genesis `11545587`). If either fails, report; do not silently keep archive on Render.

**Independence.** History in the tarball is a copy of the sequencer's state. Independent derivation of that history was already proven by Task 3 (genesis→safe head parity). From the snapshot onward the replica derives independently from L1. Planner records the matching PRD note; this decision is the replica-repo copy.

**Render first boot after restore.** Operator sets `RETH_SNAPSHOT_URL` + `RETH_SNAPSHOT_SHA256` on `fortel2-replica-reth`, `RETH_SNAPSHOT_FORCE=1` once to clear the paused 68 % disk, `L1_RPC_FORCE=public`. Logs must show pin ok → genesis ok → download → sha256 ok → restore ok → op-node deriving near tip (pin/genesis fail-fast before the download). Then Phase B (parity, gateway, restart, sizing) resumes. Do not FORCE the live geth disk.

**Not this decision.** Mini capture window (operator); publishing the GitHub release asset (operator); Phase C; Task 8 friend nodes (they reuse this tarball + restore path); any L1 provider change beyond `L1_RPC_FORCE=public`.

## R-0015 — `RETH_ARCHIVE=1` must defeat a stale `[prune]` config in `$DATA_DIR/reth.toml`

*2026-09-10 · amends R-0014 FORCE restore; ForteL2 D-0126 (Render reth replica is full archive)*

**What happened.** Deploy of `842c28d` on `fortel2-replica-reth` (2026-09-10T20:56Z) had all six dashboard keys set, including `RETH_ARCHIVE=1`. Logs:

```
snapshot: restore ok sha256=830d78f62526551d351c65d310c38c80972bffde7ffc0eb9be2cd546cf9c8027
op-reth: archive mode — retains historical receipts/logs (--full omitted)
Starting op-reth (verifier EL, archive) loopback :8546 (...)
INFO Pruning configuration is present in the config file, but no CLI arguments are provided. Using config from file.
INFO Configuration loaded path="/data/reth.toml"
INFO Loaded storage settings settings=StorageSettings { storage_v2: true } pruning_mode="full"
INFO Pruner initialized prune_config=PruneConfig { block_interval: 5, segments: PruneModes { sender_recovery: Some(Full), transaction_lookup: None, receipts: Some(Distance(10064)), account_history: Some(Distance(10064)), storage_history: Some(Distance(10064)), bodies_history: Some(Before(0)), receipts_log_filter: ReceiptsLogPruneConfig({}) }, minimum_pruning_distance: 10064 }
```

The entrypoint omitted `--full` correctly. reth still configured a full-node pruner. Cause: earlier `--full` runs on this disk wrote prune segments into `/data/reth.toml`. reth persists the effective config there and, with no CLI prune flags, reads it back. The snapshot tarball excludes `reth.toml`; FORCE restore kept it (it only replaced `db/`, `static_files/`, `rocksdb/`). The Mac archive sequencer's `reth.toml` has `[prune]` / `[prune.segments]` with empty segments (archive); the Render file carried `receipts` / `account_history` / `storage_history` = distance 10064. The operator suspended the service before any new L2 block was committed (pruner runs every 5 blocks); restored data is believed intact. Operator will re-restore with `RETH_SNAPSHOT_FORCE=1` after this lands.

**Rule.** Archive mode = omit `--full` **and** no persisted prune segments. With `RETH_ARCHIVE=1`, the entrypoint deletes `$DATA_DIR/reth.toml` if present (unconditionally — do not hand-write a replacement; reth's TOML schema drifts between versions) and logs `op-reth: removed stale prune config from $DATA_DIR/reth.toml (RETH_ARCHIVE=1)`. reth regenerates the file on start; an empty `[prune.segments]` after an archive boot is correct (do not "fix" it). `RETH_ARCHIVE` unset or `0` does not touch the file and still passes `--full`. Invalid values still exit 1 before any datadir change. The dangerous direction is a datadir that ever booted `--full`: prune segments stay in `reth.toml` forever, and omitting `--full` does not clear them.

**FORCE restore.** `RETH_SNAPSHOT_FORCE=1` drops `$DATA_DIR/reth.toml` along with `db/`, `static_files/`, `rocksdb/` — only after download → sha256 → listing → extract succeed. `jwt.txt` stays. A FORCE failure still leaves the paused derive and the existing toml in place.

**Not this decision.** Refuse-and-exit instead of auto-remove (specified: auto-remove-with-log). Re-running the Render restore (operator). README disk-size mismatch (service disk is 10 GB; planner). Phase B.

## R-0016 — Task 7 Phase B on the snapshot-restored archive replica: header/receipt parity, staging gateway, and sync lag pass; Q5 disk/RSS still pending

*2026-09-10 · implements ForteL2 D-0123 resume / D-0127 restore; amends R-0013 Phase B; evidence in `docs/2026-09-10-op-reth-phase-b.md`*

Phase B was re-run against `fortel2-replica-reth` after the D-0127 archive restore (snapshot 811872, `RETH_ARCHIVE=1`, `L1_RPC_FORCE=public`, `L1_RPC_KIND=standard`), not against the abandoned from-genesis Alchemy derive. Staging door is `https://fortel2-replica-reth-rpc.onrender.com`. Live geth `fortel2-replica` / `fortel2-replica-rpc` were not mutated. Receipt checks use the live geth gateway as the archive baseline (D-0125: header match is not receipt match).

**Passed (this worker, 2026-09-10 22:52–23:06Z, Mac sequencer EL `http://127.0.0.1:9545` read-only).**

- **Header parity** (`scripts/verify-reth-parity.sh`): 20 consecutive safe-overlap blocks including pins `0,5,473031,473032,811872,811875`. Full match on number/hash/parentHash/stateRoot/receiptsRoot/txCount. Heads at run: candidate EL 823761, sequencer EL 823901. Exit 0.
- **Receipt parity** (same script, vs `https://fortel2-replica-rpc.onrender.com`): first-tx `eth_getTransactionReceipt` MATCH on blockHash/status/logs/logsBloom for pins plus extras 100000, 400000, 700000 (8 receipts; genesis skipped — 0 txs). Block 5 tx `0xc3425ec1…` status `0x1` (the D-0125 `--full` null). A null candidate receipt is a named FAIL, not a crash.
- **Logs:** `eth_getLogs` 473031–483030 → 3 logs on both staging and live geth; first log address `0x4200…0010`, topics[0] `0xb0444523…`, block 474217. MATCH.
- **Gateway** (`scripts/allowlist-load-test.sh`, `LOAD_N=40`): `eth_sendRawTransaction`, `admin_nodeInfo`, `debug_traceTransaction`, `personal_listAccounts` all `-32601` `method not allowed`. Allowlisted `eth_blockNumber` n=40, errors=0, error_rate=0.000, p50=144 ms, **p95=184 ms**, max=215 ms.
- **Sync lag** (`scripts/replica-sync-check.sh`, three samples ≥5 min apart, `REPLICA_MAX_SAFE_LAG=12`): staging does not expose `optimism_syncStatus` (allowlist). Lag vs live `safe_l2` was **0**, **−156** (replica EL ahead of sequencer safe), **0**. All ≤ 12. Numbers in the evidence doc.

**Pending — planner+operator (R-0016 follow-up, not this PR).** PRD Q5: `du` of `/data/db`, `/data/static_files`, `/data/rocksdb` and `df /data` at 0 h / 6 h / 24 h; RSS over the same windows; restart check. 0 h RSS is the planner-measured 289–304 MB band (not reproduced here). Do not invent disk numbers. Do not start Phase C on a guess about growth.

**Phase C preconditions (operator decides; this entry does not start Phase C).**

| Gate | Status |
|---|---|
| Header parity vs sequencer (≥20 blocks, pins including 473031/473032 and snapshot 811872/811875) | **met** |
| Receipt + logs parity vs live geth gateway (archive property) | **met** |
| Staging gateway allowlist + p95/error-rate | **met** |
| Sync lag ≤ 12 vs live safe, three samples ≥5 min apart | **met** |
| RSS + disk over ≥6 h (Q5) | **pending** |
| Restart check | **pending** |

**Not this decision.** Whether Phase C may start (operator). Q5 6 h/24 h / restart. ForteL2 D-0125 pid-name collision and ForteL2's copy of the null-receipt crash. Any Render env, plan, or disk change.

Next free R-id is **R-0017**.

