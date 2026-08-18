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

*2026-08-16 · supersedes R-0004, amends R-0005*

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
window peaks **1,600–1,900 MB** with CPU under 70%. Revert if CPU pegs. Skip Wave 2 and
go **Pro 4 GB** if peak ≥2,000 MB or exit 137 after Wave 1.

Do not set `L1_CACHE_SIZE=0` (op-node treats 0 as ~2400). Do not tighten `GOMEMLIMIT`
while the L1 cache is still 900.

**Daily check:** Local agent **Daily replica health** at 04:00 (skill
`.cursor/skills/daily-replica-health`). Scores last-24h replica RSS against the
Wave 2 table and QuickNode credits on **L2_Render** (replica) vs **L2_mini**
(sequencer / Mac mini). Warn if either endpoint or combined credits exceed
~3M/day. Cloud automations cannot see Render MCP, so this runs in a local
Agents Window chat on this machine (Cursor + that chat must stay open
overnight). Delivery is that chat; Slack only if connected. The agent
**suggests** Wave 2 — it does not change env or deploy.

See `README.md` §"Render".
