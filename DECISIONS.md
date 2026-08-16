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

*2026-08-16*

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

| Key | Default | Meaning |
|---|---|---|
| `PORT` | Render-injected | nginx listen port (not declared in `render.yaml`) |
| `REPLICA_UPSTREAM` | `http://fortel2-replica:10000` | upstream origin, scheme included (R-0004) |
| `RPC_RATE` | `20r/s` | `limit_req_zone` rate |
| `RPC_BURST` | `40` | `limit_req` burst |
| `RPC_REAL_IP_HEADER` | `X-Forwarded-For` | header carrying the client IP; `CF-Connecting-IP` when Cloudflare fronts it (R-0006) |
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
