# Diskless public RPC gateway — reverse-proxy + per-IP limit_req.
# Build context MUST be this directory (gateway/). Do not COPY from repo root.
#
# Pinned by tag, same convention as the root Dockerfile's op-geth / op-node.
# nginxinc/nginx-unprivileged already runs as USER nginx (uid 101) and
# listens on unprivileged ports. Do not switch to nginx:*-alpine (root master).

# Bridge page. Node stays in this stage. package.json and the lockfile
# are copied first so `npm ci` is cached when only sources change.
# bookworm-slim (glibc): bridge/package-lock.json pins esbuild's linux
# gnu optional packages and has no musl build, so Alpine cannot run it.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS bridge-build

WORKDIR /src
COPY bridge/package.json bridge/package-lock.json ./
RUN npm ci
COPY bridge/ ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.30.4-alpine

# Contract defaults. Render injects PORT; the rest are overridable at runtime.
# REPLICA_UPSTREAM's default is load-bearing even though every deployed gateway
# sets it explicitly: it is what a deploy falls back to if that env var is ever
# lost. It pointed at `fortel2-replica` until 2026-09-14 — a host deleted with
# the geth pserv (R-0019) — so the fallback would have failed to resolve and
# taken public read down. It now names the live EL.
# RPC_REAL_IP_HEADER defaults to CF-Connecting-IP: every Render Web Service
# terminates through Cloudflare first (platform edge, not optional orange-cloud).
# X-Forwarded-For's rightmost hop is therefore a CF PoP, not the client.
ENV PORT=10000 \
    REPLICA_UPSTREAM=http://fortel2-replica-reth:10000 \
    RPC_RATE=20r/s \
    RPC_BURST=40 \
    RPC_REAL_IP_HEADER=CF-Connecting-IP \
    RPC_MAX_BODY=1m \
    NGINX_ENVSUBST_FILTER="^(PORT|REPLICA_UPSTREAM|RPC_RATE|RPC_BURST|RPC_REAL_IP_HEADER|RPC_MAX_BODY|NGINX_LOCAL_RESOLVERS|NGINX_REPLICA_UPSTREAM)$"

# Overwrites the image's stock default.conf at start via
# /docker-entrypoint.d/20-envsubst-on-templates.sh.
# 14-*.envsh is sourced (not executed) so NGINX_LOCAL_RESOLVERS and
# NGINX_REPLICA_UPSTREAM are visible to 20-envsubst. Must sort before 20-.
COPY --chmod=755 14-resolvers-from-resolv.conf.envsh /docker-entrypoint.d/14-resolvers-from-resolv.conf.envsh
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Static live-health page for `location = /status`. Not a template: envsubst
# never touches it, so its JS `${...}` strings stay intact.
COPY status.html /usr/share/nginx/html/status.html
# Built bridge shell and hashed assets. bridge-config.json is committed
# because config/ is outside this build context.
COPY --from=bridge-build /src/dist/index.html /usr/share/nginx/html/bridge/index.html
COPY --from=bridge-build /src/dist/assets/ /usr/share/nginx/html/bridge/assets/
COPY bridge/bridge-config.json /usr/share/nginx/html/bridge-config.json

EXPOSE 10000

# Base image already drops to uid 101; repeat so the non-root contract is visible here.
USER nginx
# No VOLUME, no geth, no disk.
