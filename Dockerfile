# ForteL2 verifier — stock op-reth + op-node (chain 852 / Sepolia L1).
# Root Dockerfile for Render "Docker" runtime and friend clones.
#
# Images pinned by immutable digest (ForteL2 Task 1 / D-0109). Tag strings
# are comments only — do not float off the digest. The container's op-reth
# must report `Reth Version: 2.3.0-dev` commit 9384bc53…; entrypoint asserts
# that and fails closed otherwise. Tag op-reth/v2.3.3 ≠ the reported version.
#
# OP Labs op-node images are distroless (no /bin/sh, no apt). Do not RUN
# shell commands on that image — copy binaries into a Debian runtime instead.
# op-geth is not in this image.

FROM us-docker.pkg.dev/oplabs-tools-artifacts/images/op-reth:v2.3.3@sha256:eec35eaafb6f8b3d07c6844ff87c4f8af81fca088472b6a432435c53a36b8a4c AS reth
FROM us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.19.2@sha256:3652c0faa7582e49c31a71f86bc5170167499aed7e382e92722f34beb233ef1a AS node

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
    python3 \
    tzdata \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /config /data \
  && groupadd --gid 10001 fortel2 \
  && useradd --uid 10001 --gid fortel2 --home-dir /data --no-create-home \
    --shell /usr/sbin/nologin fortel2 \
  && chown fortel2:fortel2 /data

COPY --from=reth /usr/local/bin/op-reth /usr/local/bin/op-reth
COPY --from=node /usr/local/bin/op-node /usr/local/bin/op-node
COPY entrypoint.sh /entrypoint.sh
COPY healthcheck.sh /healthcheck.sh
COPY l1_rpc_router.py /l1_rpc_router.py
COPY rpc-method-filter.py /rpc-method-filter.py
COPY config/genesis.json /config/genesis.json
COPY config/rollup.json /config/rollup.json
RUN chmod +x /entrypoint.sh /healthcheck.sh /l1_rpc_router.py /rpc-method-filter.py \
    /usr/local/bin/op-reth /usr/local/bin/op-node

# Render Web Service sets PORT (often 10000) for the public method filter.
# op-reth HTTP stays on loopback L2_GETH_HTTP_PORT; op-node on loopback :9545.
ENV DATA_DIR=/data \
    HOME=/data \
    L2_HTTP_PORT=8545 \
    L2_GETH_HTTP_PORT=8546 \
    L2_ENGINE_PORT=8551 \
    L2_NODE_RPC_PORT=9545 \
    L1_BLOCK_TIME=12 \
    TZ=America/Los_Angeles \
    GENESIS=/config/genesis.json \
    ROLLUP=/config/rollup.json \
    PATH="/usr/local/bin:${PATH}"

VOLUME ["/data"]
EXPOSE 8545

USER fortel2
# During --start-period, failed probes (no FORTEL2_EL_READY_FILE yet / no RPC)
# keep health=starting and do not count toward --retries. healthcheck.sh must
# exit 1 while starting — exit 0 would mark healthy immediately. Raise
# start-period if constrained disks regularly need longer than 5m recovery.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5m --retries=3 \
  CMD ["/healthcheck.sh"]
ENTRYPOINT ["/entrypoint.sh"]
