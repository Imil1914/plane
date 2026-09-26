# Local, disposable AF1.2 test image built from checksum-verified official
# MinIO and mc release binaries. This is not a production image.
FROM mirror.gcr.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

COPY --chmod=0755 minio /usr/local/bin/minio
COPY --chmod=0755 mc /usr/local/bin/mc

ENTRYPOINT ["/usr/local/bin/minio"]
