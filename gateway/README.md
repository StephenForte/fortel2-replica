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
| `RPC_REAL_IP_HEADER` | `X-Forwarded-For` | header carrying the client IP; set to `CF-Connecting-IP` when Cloudflare fronts the hostname |
| `RPC_MAX_BODY` | `1m` | `client_max_body_size` — matches the filter's 1 MiB cap |

Do not rename these. The Render Web Service (`fortel2-replica-rpc`) and the
root README document the same names.

## Real-IP scheme

The container's TCP peer is Render's proxy, not the client. The limiter
key is therefore **not** bare `$remote_addr` / `$binary_remote_addr`.

1. `real_ip_header` reads `RPC_REAL_IP_HEADER`.
2. `set_real_ip_from` trusts RFC1918, loopback, link-local, and CGNAT
   (the hops that can sit between the client and this process).
3. `real_ip_recursive on` walks `X-Forwarded-For` from the **right** and
   takes the first address that is not trusted — the client as seen by
   Render. Leftmost is ignored because Render **appends** to XFF and a
   client can spoof the left side.
4. After that rewrite, `$remote_addr` is mapped to `$rpc_limit_key`.
   An empty value becomes `0.0.0.0` so `limit_req` never sees an empty
   key (empty keys disable the limiter silently).
5. If the header is absent or the peer is not in the trust list, the
   key falls back to the TCP peer. Still limited; possibly one shared
   bucket. That is fail-safe, not fail-open.

When Cloudflare is in front, XFF looks like `client, cf-edge` and the
rightmost untrusted hop is Cloudflare. Set
`RPC_REAL_IP_HEADER=CF-Connecting-IP`.

## Post-deploy verification

The true chain can only be confirmed on the live Web Service. After
`fortel2-replica-rpc` is up, do this before pointing a custom domain
or Cloudflare at it.

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
| `cf=` | raw `CF-Connecting-IP` (empty unless Cloudflare is on) |

### Working vs wrong key vs limiter off

**Working.** Two requests from two networks show two different `key=`
values. `key=` is a public client IP, not a `10/8` or `172.16/12` Render
hop. `peer=` is the Render (or Cloudflare) hop and stays the same across
clients. A single client bursting well past `RPC_BURST` gets HTTP **429**;
a second client on a different IP is unaffected.

**Limiting the wrong key (shared bucket).** Every request has the same
`key=`, and that value equals `peer=` (a Render or Cloudflare address).
Two ordinary users together trip 429s at ~20 r/s combined. Single-client
smoke tests still look fine. Typical causes: `X-Forwarded-For` missing,
or Render's peer is not in the RFC1918 trust list so `real_ip` never
rewrites. Do not "fix" this by trusting `0.0.0.0/0` (that takes the
spoofable leftmost XFF entry). Capture a log line and the peer CIDR
before changing `set_real_ip_from`.

**Limiter silently off.** `key=` is empty or `-`. A burst never 429s.
This image maps empty → `0.0.0.0`, so this should not happen. If it
does, the running config is not this template.

**Cloudflare on, header still `X-Forwarded-For`.** `key=` matches the
rightmost XFF entry (Cloudflare), `cf=` shows the real client, and
every visitor shares one bucket again. Set
`RPC_REAL_IP_HEADER=CF-Connecting-IP` and redeploy; `key=` should then
match `cf=`.

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
