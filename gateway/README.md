# Public RPC gateway

Diskless nginx reverse proxy for the ForteL2 replica's public read URL.
No geth, no op-node, no volume. Per-IP HTTP rate limiting lives here;
the replica method filter stays limiter-free.

Build context is this directory:

```bash
docker build -f gateway/Dockerfile -t fortel2-gw:test gateway/
docker run --rm fortel2-gw:test nginx -t
```

Listen port is `$PORT` (Render injects it; default `10000` locally).
Upstream is `$REPLICA_UPSTREAM` (default `http://fortel2-replica:10000`).

`GET /healthz` is answered locally (200, `ok\n`) and is not rate-limited.
`GET /` still proxies through to the filter's `{"ok":true,...}` body.

## Env (contract)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `10000` (Render injects) | nginx listen port |
| `REPLICA_UPSTREAM` | `http://fortel2-replica:10000` | upstream origin, scheme included |
| `RPC_RATE` | `20r/s` | `limit_req_zone` rate |
| `RPC_BURST` | `40` | `limit_req` burst (`nodelay`) |
| `RPC_REAL_IP_HEADER` | `CF-Connecting-IP` | header carrying the client IP. Render Web Services always terminate through Cloudflare first, so this is the default — not an optional override. Set to `X-Forwarded-For` only if you need the chain; CF CIDRs are already trusted so the walk skips PoPs |
| `RPC_MAX_BODY` | `1m` | `client_max_body_size` — matches the filter's 1 MiB cap |

Do not rename these. The default for `RPC_REAL_IP_HEADER` is
`CF-Connecting-IP` because Render's edge is always Cloudflare; older
root docs that treat that header as an optional override are stale.

## Real-IP scheme

The container's TCP peer is Render's proxy, not the client. The limiter
key is therefore **not** bare `$remote_addr` / `$binary_remote_addr`.

1. `real_ip_header` reads `RPC_REAL_IP_HEADER` (default `CF-Connecting-IP`).
2. `set_real_ip_from` trusts RFC1918, loopback, link-local, CGNAT, **and
   Cloudflare's published CIDRs**. Render's edge is always Cloudflare
   (platform DDoS, not the optional operator orange-cloud). Without those
   CIDRs, an `X-Forwarded-For` walk stops on the CF PoP and every client
   at that PoP shares one 20 r/s bucket.
3. `real_ip_recursive on` walks `X-Forwarded-For` from the **right** and
   takes the first address that is not trusted. Leftmost is ignored
   because Render **appends** to XFF and a client can spoof the left side.
4. After that rewrite, `$remote_addr` is mapped to `$rpc_limit_key`.
   An empty value becomes `0.0.0.0` so `limit_req` never sees an empty
   key (empty keys disable the limiter silently).
5. If the header is absent or the peer is not in the trust list, the
   key falls back to the TCP peer. Still limited; possibly one shared
   bucket. That is fail-safe, not fail-open.

Operator orange-cloud in front of the `onrender.com` hostname is a
**second** Cloudflare hop. Leave `RPC_REAL_IP_HEADER=CF-Connecting-IP`
(their edge overwrites it with the same client). Do not treat
"Cloudflare is off" as the Render default — it never is.

## Post-deploy verification

The true chain can only be confirmed on the live Web Service. After
`fortel2-replica-rpc` is up, do this before pointing a custom domain
at it. Platform Cloudflare is already in the path.

### 1. Local health (no replica, no limiter)

```bash
curl -sS -D- https://<gateway-host>/healthz
# HTTP/2 200
# body: ok
```

A 502 here means the gateway process is down, not the replica.

### 2. Proxy through to the filter

```bash
curl -sS https://<gateway-host>/
# {"ok":true,"upstream":"http://127.0.0.1:8546","allowed":...}
```

```bash
curl -sS https://<gateway-host> -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# result: "0x354"
```

### 3. Read the access log (Render → Logs)

Each proxied request logs:

```
<resolved> key=<limit-key> peer=<tcp-peer> POST / 200 xff="..." cf="..."
```

| Field | What it is |
|---|---|
| first column / `key=` | the rate-limit bucket (post-`real_ip`, never empty) |
| `peer=` | the TCP hop nginx actually accepted (`$realip_remote_addr`) |
| `xff=` | raw `X-Forwarded-For` |
| `cf=` | raw `CF-Connecting-IP` (always set on a Render Web Service) |

### Working vs wrong key vs limiter off

**Working.** Two requests from two networks show two different `key=`
values. `key=` matches `cf=` (a public client IP), not a `10/8` Render
hop and **not** a Cloudflare PoP (`104.16.0.0/13`, `172.64.0.0/13`,
`162.158.0.0/15`, …). `peer=` is the Render proxy and stays the same
across clients. A single client bursting well past `RPC_BURST` gets
HTTP **429**; a second client on a different IP is unaffected.

**Limiting the wrong key (shared bucket).** Every request has the same
`key=`, and that value equals `peer=` (a Render address). Two ordinary
users together trip 429s at ~20 r/s combined. Single-client smoke tests
still look fine. Typical cause: the real-IP header is missing and the
peer is not in the trust list. Do not "fix" this by trusting `0.0.0.0/0`
(that takes the spoofable leftmost XFF entry).

**Limiting the Cloudflare PoP (the easy miss).** `key=` is a public IP
that does **not** match `cf=`, and matches the rightmost `xff=` entry
(a CF edge such as `104.22.x.x`). Many clients at one PoP share a
bucket; two users on different ISPs in the same city can trip 429s
together. This is the default-`X-Forwarded-For` + private-only trust
list failure. This image defaults to `CF-Connecting-IP` and trusts CF
CIDRs so an XFF override still walks past the PoP. If you still see
this, the running config is stale or CF republished ranges.

**Limiter silently off.** `key=` is empty or `-`. A burst never 429s.
This image maps empty → `0.0.0.0`, so this should not happen. If it
does, the running config is not this template.

### 4. Burst (expect 429)

```bash
# well past RPC_BURST=40; some responses must be HTTP 429
for i in $(seq 1 80); do
  curl -sS -o /dev/null -w '%{http_code}\n' https://<gateway-host> \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' &
done
wait
```

## Local run (dummy upstream)

```bash
# terminal 1 — stand-in for the replica filter
python3 -m http.server 18080
# terminal 2
docker run --rm -p 10000:10000 \
  -e REPLICA_UPSTREAM=http://host.docker.internal:18080 \
  fortel2-gw:test
curl -sS http://127.0.0.1:10000/healthz   # ok
```

On Linux, add `--add-host=host.docker.internal:host-gateway` if the
upstream is on the host.
