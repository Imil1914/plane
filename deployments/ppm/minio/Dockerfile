# PPM object storage image: official MinIO server and mc client release binaries, verified by pinned SHA-256.
#
# Why a local build: the community MinIO images are no longer pullable anonymously (Docker Hub `minio/minio`
# is stale and quay.io/minio/* answers 401 without credentials, checked 2026-09-26), while the official
# GitHub release binaries are still published with .sha256sum files. The build fails closed on any checksum
# mismatch.
#
# Targets:
#   minio  — the object storage server (also carries `mc` for minio-init);
#   tools  — operator tools for ppm-backup.sh / ppm-restore.sh: mc + GnuPG (AES256 symmetric encryption with a
#            passphrase file) + tar/gzip. Runs as the invoking host user (compose `user:`), never as a server.
ARG ALPINE_IMAGE=alpine:3.20
FROM ${ALPINE_IMAGE} AS minio

ARG TARGETARCH
ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z

RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) minio_sha256=7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f; \
             mc_sha256=01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891 ;; \
      arm64) minio_sha256=5c83cd2cf151717ba0243f73e1c7802ff36e272b67144bdd7f1f7d684fd6f03d; \
             mc_sha256=14c8c9616cfce4636add161304353244e8de383b2e2752c0e9dad01d4c27c12c ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    wget -q -O /usr/local/bin/minio \
      "https://github.com/minio/minio/releases/download/${MINIO_RELEASE}/minio.linux-${TARGETARCH}.${MINIO_RELEASE}"; \
    echo "${minio_sha256}  /usr/local/bin/minio" | sha256sum -c -; \
    wget -q -O /usr/local/bin/mc \
      "https://github.com/minio/mc/releases/download/${MC_RELEASE}/mc.linux-${TARGETARCH}.${MC_RELEASE}"; \
    echo "${mc_sha256}  /usr/local/bin/mc" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/minio /usr/local/bin/mc; \
    mkdir -p /export

EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/export"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:9000/minio/health/live || exit 1


FROM minio AS tools

RUN apk add --no-cache gnupg

ENTRYPOINT []
CMD ["sh"]
HEALTHCHECK NONE
