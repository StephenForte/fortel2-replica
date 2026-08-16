# Diskless public RPC gateway — reverse-proxy + per-IP limit_req.
# Build context MUST be this directory (gateway/). Do not COPY from repo root.
#
# Pinned by tag, same convention as the root Dockerfile's op-geth / op-node.
# nginxinc/nginx-unprivileged already runs as USER nginx (uid 101) and
# listens on unprivileged ports. Do not switch to nginx:*-alpine (root master).

FROM nginxinc/nginx-unprivileged:1.30.4-alpine

# Contract defaults. Render injects PORT; the rest are overridable at runtime.
ENV PORT=10000 \
    REPLICA_UPSTREAM=http://fortel2-replica:10000 \
    RPC_RATE=20r/s \
    RPC_BURST=40 \
    RPC_REAL_IP_HEADER=X-Forwarded-For \
    RPC_MAX_BODY=1m \
    NGINX_ENVSUBST_FILTER="^(PORT|REPLICA_UPSTREAM|RPC_RATE|RPC_BURST|RPC_REAL_IP_HEADER|RPC_MAX_BODY)$"

# Overwrites the image's stock default.conf at start via
# /docker-entrypoint.d/20-envsubst-on-templates.sh.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 10000

# Base image already drops to uid 101; repeat so the non-root contract is visible here.
USER nginx
# No VOLUME, no geth, no disk.
