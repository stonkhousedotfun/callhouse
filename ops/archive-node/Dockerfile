# ops/archive-node/Dockerfile — chain-4663 Nitro ARCHIVE node.
#
# Pinned by tag AND manifest-list digest. v3.11.4 is the latest stable Nitro (released 2026-09-16) and
# the commit (7d5ac27) that built the 2026-09-06 Archive-path snapshot this node initialises from.
# Robinhood's notices recommend the "-stripped" variant of the same release
# (digest sha256:029eee89873a3445aa7c1be939bdde468bf3a2884d2648f217de6059f8e04598); either is fine.
# Upgrading is a deliberate change: re-check docs.robinhood.com/chain/notices-and-upgrades first.
FROM offchainlabs/nitro-node:v3.11.4-7d5ac27@sha256:460918143cfdccc3aa984db8ca0c0d83b6054cec47ff10142bde4052054408ed

USER root
# Chain info + genesis from cdn.robinhood.com (URLs and checksums in chain/SHA256SUMS).
COPY chain/ /opt/archive-node/chain/
COPY nitro.json entrypoint.sh /opt/archive-node/
RUN chmod 0755 /opt/archive-node/entrypoint.sh \
 && mkdir -p /data && chown user:user /data
# The image runs as `user`. A platform volume mounted at /data may be root-owned and need a
# one-line chown on the host. The entrypoint refuses to start on an unwritable /data.
USER user

EXPOSE 8547 8548
ENTRYPOINT ["/opt/archive-node/entrypoint.sh"]
