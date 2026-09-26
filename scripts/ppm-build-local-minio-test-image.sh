#!/usr/bin/env bash
set -euo pipefail

# Reproducible AF1.2 fallback when the official container registries are
# unavailable. Downloads only official GitHub release assets, checks SHA-256,
# and builds a disposable local arm64 image; no binaries enter the repository.

minio_tag=RELEASE.2025-09-07T16-13-09Z
mc_tag=RELEASE.2025-08-13T08-35-41Z
image=ppm-af12-minio:${minio_tag}
temporary_dir="$(mktemp -d)"
trap 'rm -rf -- "$temporary_dir"' EXIT

script_dir="$(cd "$(dirname "$0")" && pwd)"

verify_download() {
  local repository="$1"
  local tag="$2"
  local asset="$3"
  local target="$4"
  local pinned_sha256="$5"
  local expected actual checksum

  curl --fail --location --silent --show-error --retry 3 \
    "https://github.com/minio/${repository}/releases/download/${tag}/${asset}" \
    --output "${temporary_dir}/${target}"
  checksum="$(curl --fail --location --silent --show-error --retry 3 \
    "https://github.com/minio/${repository}/releases/download/${tag}/${asset}.sha256sum")"
  expected="${checksum%% *}"
  if ! [[ "$expected" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'Invalid official SHA-256 for %s\n' "$asset" >&2
    exit 1
  fi
  if [[ "$expected" != "$pinned_sha256" ]]; then
    printf 'Published SHA-256 changed for %s; review the release before rebuilding.\n' "$asset" >&2
    exit 1
  fi
  actual="$(shasum -a 256 "${temporary_dir}/${target}")"
  actual="${actual%% *}"
  if [[ "$actual" != "$expected" ]]; then
    printf 'SHA-256 mismatch for %s\n' "$asset" >&2
    exit 1
  fi
  printf 'Verified %s (%s)\n' "$asset" "$actual"
}

verify_download minio "$minio_tag" "minio.linux-arm64.${minio_tag}" minio \
  5c83cd2cf151717ba0243f73e1c7802ff36e272b67144bdd7f1f7d684fd6f03d
verify_download mc "$mc_tag" "mc.linux-arm64.${mc_tag}" mc \
  14c8c9616cfce4636add161304353244e8de383b2e2752c0e9dad01d4c27c12c

docker build --platform linux/arm64 \
  --file "${script_dir}/ppm-minio-release.Dockerfile" \
  --tag "$image" "$temporary_dir"

printf 'Local test image ready: %s\n' "$image"
printf 'Run: PPM_E2E_MINIO_IMAGE=%s bash scripts/ppm-canvas-browser-gate.sh chrome\n' "$image"
