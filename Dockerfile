# ForteL2 verifier — stock op-geth + op-node (chain 852 / Sepolia L1).
# Root Dockerfile for Render "Docker" runtime and friend clones.
#
# OP Labs op-node images are distroless (no /bin/sh, no apt). Do not RUN
# shell commands on that image — copy binaries into a Debian runtime instead.

FROM us-docker.pkg.dev/oplabs-tools-artifacts/images/op-geth:v1.101702.2 AS geth
FROM us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.19.2 AS node

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /config /data

COPY --from=geth /usr/local/bin/geth /usr/local/bin/geth
COPY --from=node /usr/local/bin/op-node /usr/local/bin/op-node
COPY entrypoint.sh /entrypoint.sh
COPY config/genesis.json /config/genesis.json
COPY config/rollup.json /config/rollup.json
RUN chmod +x /entrypoint.sh /usr/local/bin/geth /usr/local/bin/op-node

# Render Web Service sets PORT; default 8545 for local / private service.
ENV DATA_DIR=/data \
    L2_HTTP_PORT=8545 \
    L2_AUTH_PORT=8551 \
    L2_NODE_RPC_PORT=9545 \
    L1_BLOCK_TIME=12 \
    GENESIS=/config/genesis.json \
    ROLLUP=/config/rollup.json \
    PATH="/usr/local/bin:${PATH}"

VOLUME ["/data"]
EXPOSE 8545 9545

ENTRYPOINT ["/entrypoint.sh"]
