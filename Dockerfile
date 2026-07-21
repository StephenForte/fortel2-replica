# ForteL2 verifier — stock op-geth + op-node (chain 852 / Sepolia L1).
# Root Dockerfile for Render "Docker" runtime and friend clones.
FROM us-docker.pkg.dev/oplabs-tools-artifacts/images/op-geth:v1.101702.2 AS geth

FROM us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.19.2

USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /config

COPY --from=geth /usr/local/bin/geth /usr/local/bin/geth
COPY entrypoint.sh /entrypoint.sh
COPY config/genesis.json /config/genesis.json
COPY config/rollup.json /config/rollup.json
RUN chmod +x /entrypoint.sh

# Render Web Service sets PORT; default 8545 for local / private service.
ENV DATA_DIR=/data \
    L2_HTTP_PORT=8545 \
    L2_AUTH_PORT=8551 \
    L2_NODE_RPC_PORT=9545 \
    L1_BLOCK_TIME=12 \
    GENESIS=/config/genesis.json \
    ROLLUP=/config/rollup.json

VOLUME ["/data"]
EXPOSE 8545 9545

ENTRYPOINT ["/entrypoint.sh"]
