#!/usr/bin/env bash
# Build the PPM release images from a clean export of one Git commit (never from the working tree).
#
#   ppm-build.sh --rev <commit|tag> --release <name> [--services "api web ..."] [--page-revision <sha>]
#                [--overlay <repo-relative path>]...
#
# Images: ${PPM_IMAGE_REPO:-ppm}/<service>:<release>, labelled with the source revision; `minio` (server) and
# `tools` (mc + GnuPG for backups) come from deployments/ppm/minio/Dockerfile. The manifest in
# <runtime>/builds/<release>.json records image ids, base digests, all web flags and `pip freeze` of the API image.
# Environment:
#   PPM_IMAGE_REPO        image name prefix (default: ppm)
#   PPM_DOCKERHUB_MIRROR  registry host that mirrors Docker Hub namespaces, e.g. mirror.gcr.io
#                         (default: docker.io). Base images are pinned by digest either way.
#   PPM_BUILD_PLATFORM    optional docker --platform (default: the host architecture)
#   PPM_RUNTIME_DIR       where build exports and manifests go (default: <bundle>/.runtime, git-ignored)
#   PPM_DESIGN_V2, PPM_PROJECT_ASK_ENABLED, PPM_CANVAS_AUTOMERGE, PPM_BRAND_ENABLED, PPM_CANVAS_ENABLED,
#   PPM_ANTYFLOW_SHELL_ENABLED, PPM_SHELL_ENABLED — web build flags (RC defaults: 1, 0, 1, 1, 1, 1, 1).
# --overlay copies a file from the working tree over the export and records its SHA-256 in the manifest.
# It exists only for rehearsals before the release commit exists; a release build must not use it.
set -euo pipefail

bundle_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(git -C "$bundle_dir" rev-parse --show-toplevel)"
runtime_dir="${PPM_RUNTIME_DIR:-$bundle_dir/.runtime}"
image_repo="${PPM_IMAGE_REPO:-ppm}"
mirror="${PPM_DOCKERHUB_MIRROR:-docker.io}"

rev="" release="" page_revision="" services="minio tools proxy api web admin space live"
overlays=()
while (($#)); do
  case "$1" in
    --rev) rev="${2:?}"; shift 2 ;;
    --release) release="${2:?}"; shift 2 ;;
    --services) services="${2:?}"; shift 2 ;;
    --page-revision) page_revision="${2:?}"; shift 2 ;;
    --overlay) overlays+=("${2:?}"); shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$rev" && -n "$release" ]] || { echo "Usage: $0 --rev <commit> --release <name> [...]" >&2; exit 2; }
[[ "$release" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "Release must be a Docker tag (A-Z a-z 0-9 . _ -)." >&2; exit 2; }

revision="$(git -C "$repo_root" rev-parse --verify "${rev}^{commit}")"
page_revision="${page_revision:-$revision}"
build_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Base images pinned by multi-arch index digest (same digest on Docker Hub and its mirrors).
node_image="$mirror/library/node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402"
nginx_image="$mirror/library/nginx:1.31-alpine@sha256:1ed1b0e1d7652937d6cbdaf4018c7b6fc009a7dd6c3047351e2eddda745de43f"
python_image="$mirror/library/python:3.12.10-alpine@sha256:4bbf5ef9ce4b273299d394de268ad6018e10a9375d7efc7c2ce9501a6eb6b86c"
caddy_image="$mirror/library/caddy:2.11.3-alpine@sha256:86deaf5e3d3408a6ccec08fbb79989783dd26e206ae10bcf78a801dc8c9ab794"
alpine_image="$mirror/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
dockerfile_frontend="$mirror/docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e"

mkdir -p "$runtime_dir/build" "$runtime_dir/builds"
# One export directory per run: concurrent builds never share (or delete) each other's build context.
export_dir="$(mktemp -d "$runtime_dir/build/${revision:0:12}.XXXXXX")"
trap 'rm -rf -- "$export_dir"' EXIT
git -C "$repo_root" archive --format=tar "$revision" | tar -x -C "$export_dir"
echo "Exported $revision to $export_dir"

overlay_json=""
for path in ${overlays[@]+"${overlays[@]}"}; do
  [[ "$path" != /* && "$path" != *..* ]] || { echo "Overlay path must be repository-relative: $path" >&2; exit 2; }
  [[ -f "$repo_root/$path" ]] || { echo "Overlay file is missing: $path" >&2; exit 2; }
  mkdir -p "$export_dir/$(dirname "$path")"
  cp -p "$repo_root/$path" "$export_dir/$path"
  sum="$(shasum -a 256 "$export_dir/$path" | awk '{print $1}')"
  overlay_json+="${overlay_json:+,}{\"path\":\"$path\",\"sha256\":\"$sum\"}"
  echo "Overlay: $path ($sum)"
done

platform_args=()
[[ -n "${PPM_BUILD_PLATFORM:-}" ]] && platform_args=(--platform "$PPM_BUILD_PLATFORM")
label_args=(
  --label "org.opencontainers.image.revision=$revision"
  --label "org.opencontainers.image.version=$release"
  --label "org.opencontainers.image.created=$build_date"
  --label "org.opencontainers.image.licenses=AGPL-3.0-only"
  --label "org.opencontainers.image.source=https://github.com/Imil1914/plane"
  --label "ppm.release=$release"
)

build() {
  local service="$1" context="$2" dockerfile="$3"; shift 3
  local tag="$image_repo/$service:$release" started=$SECONDS attempt=1
  local attempts="${PPM_BUILD_ATTEMPTS:-4}"
  echo "==> Building $tag"
  # Package mirrors and registries fail transiently; BuildKit keeps finished layers, so a retry resumes.
  until docker build ${platform_args[@]+"${platform_args[@]}"} --progress=plain "${label_args[@]}" \
    --build-arg "BUILDKIT_SYNTAX=$dockerfile_frontend" "$@" \
    -f "$dockerfile" -t "$tag" "$context"; do
    if ((attempt >= attempts)); then echo "==> FAILED $tag after $attempt attempts" >&2; return 1; fi
    attempt=$((attempt + 1)); echo "==> Retrying $tag (attempt $attempt/$attempts) in 20s"; sleep 20
  done
  echo "==> Built $tag in $((SECONDS - started))s"
}

for service in $services; do
  case "$service" in
    minio) build minio "$export_dir/deployments/ppm/minio" "$export_dir/deployments/ppm/minio/Dockerfile" \
             --target minio --build-arg "ALPINE_IMAGE=$alpine_image" ;;
    tools) build tools "$export_dir/deployments/ppm/minio" "$export_dir/deployments/ppm/minio/Dockerfile" \
             --target tools --build-arg "ALPINE_IMAGE=$alpine_image"
           docker run --rm --entrypoint sh "$image_repo/tools:$release" -c 'mc --version >/dev/null && gpg --version | head -n1'
           ;;
    proxy) build proxy "$export_dir/deployments/ppm/proxy" "$export_dir/deployments/ppm/proxy/Dockerfile" \
             --build-arg "CADDY_IMAGE=$caddy_image"
           docker run --rm -e PPM_DOMAIN=ppm.example.test -e PPM_TLS=internal --entrypoint caddy \
             "$image_repo/proxy:$release" validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
           # With the Git server site (git-server-1.caddy) as docker-compose.git.yml runs it.
           docker run --rm -e PPM_DOMAIN=ppm.example.test -e PPM_TLS=internal -e PPM_GIT_SERVER_ENABLED=1 \
             -e PPM_GIT_DOMAIN=git.ppm.example.test --entrypoint caddy \
             "$image_repo/proxy:$release" validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
           echo "Caddyfile validated (with and without the Git server site)." ;;
    api) build api "$export_dir/apps/api" "$export_dir/apps/api/Dockerfile.api" \
           --build-arg "PYTHON_IMAGE=$python_image" ;;
    web) build web "$export_dir" "$export_dir/apps/web/Dockerfile.web" \
           --build-arg "NODE_IMAGE=$node_image" --build-arg "NGINX_IMAGE=$nginx_image" \
           --build-arg "VITE_PPM_SOURCE_REVISION=$page_revision" \
           --build-arg "VITE_PPM_RELEASE=$release" \
           --build-arg "VITE_PPM_BUILD_DATE=$build_date" \
           --build-arg "PPM_DESIGN_V2=${PPM_DESIGN_V2:-1}" \
           --build-arg "PPM_PROJECT_ASK_ENABLED=${PPM_PROJECT_ASK_ENABLED:-0}" \
           --build-arg "PPM_CANVAS_AUTOMERGE=${PPM_CANVAS_AUTOMERGE:-1}" \
           --build-arg "PPM_BRAND_ENABLED=${PPM_BRAND_ENABLED:-1}" \
           --build-arg "PPM_CANVAS_ENABLED=${PPM_CANVAS_ENABLED:-1}" \
           --build-arg "PPM_ANTYFLOW_SHELL_ENABLED=${PPM_ANTYFLOW_SHELL_ENABLED:-1}" \
           --build-arg "PPM_SHELL_ENABLED=${PPM_SHELL_ENABLED:-1}" ;;
    admin) build admin "$export_dir" "$export_dir/apps/admin/Dockerfile.admin" \
             --build-arg "NODE_IMAGE=$node_image" --build-arg "NGINX_IMAGE=$nginx_image" \
             --build-arg "PPM_BRAND_ENABLED=${PPM_BRAND_ENABLED:-1}" \
             --build-arg "PPM_SHELL_ENABLED=${PPM_SHELL_ENABLED:-1}" ;;
    space) build space "$export_dir" "$export_dir/apps/space/Dockerfile.space" \
             --build-arg "NODE_IMAGE=$node_image" \
             --build-arg "PPM_BRAND_ENABLED=${PPM_BRAND_ENABLED:-1}" \
             --build-arg "PPM_SHELL_ENABLED=${PPM_SHELL_ENABLED:-1}" ;;
    live) build live "$export_dir" "$export_dir/apps/live/Dockerfile.live" \
            --build-arg "NODE_IMAGE=$node_image" ;;
    *) echo "Unknown service: $service" >&2; exit 2 ;;
  esac
done

# Python dependencies as installed (transitive ones included): reproducibility record next to the manifest.
freeze_json=""
if [[ " $services " == *" api "* ]]; then
  freeze="$runtime_dir/builds/$release.pip-freeze.txt"
  docker run --rm --entrypoint pip "$image_repo/api:$release" freeze --all >"$freeze"
  freeze_json="\"pip_freeze\": {\"file\": \"$(basename "$freeze")\", \"packages\": $(grep -c '==' "$freeze"), \"sha256\": \"$(shasum -a 256 "$freeze" | awk '{print $1}')\"},"
  echo "pip freeze: $freeze"
fi

images_json=""
for service in $services; do
  id="$(docker image inspect --format '{{.Id}}' "$image_repo/$service:$release")"
  arch="$(docker image inspect --format '{{.Architecture}}' "$image_repo/$service:$release")"
  images_json+="${images_json:+,}\"$service\":{\"image\":\"$image_repo/$service:$release\",\"id\":\"$id\",\"architecture\":\"$arch\"}"
done

manifest="$runtime_dir/builds/$release.json"
cat >"$manifest" <<JSON
{
  "schema": "ppm-build-manifest/1",
  "release": "$release",
  "source_revision": "$revision",
  "page_revision": "$page_revision",
  "build_date": "$build_date",
  "overlays": [${overlay_json}],
  "web_flags": {"PPM_DESIGN_V2": "${PPM_DESIGN_V2:-1}", "PPM_PROJECT_ASK_ENABLED": "${PPM_PROJECT_ASK_ENABLED:-0}",
                "PPM_CANVAS_AUTOMERGE": "${PPM_CANVAS_AUTOMERGE:-1}", "PPM_BRAND_ENABLED": "${PPM_BRAND_ENABLED:-1}",
                "PPM_CANVAS_ENABLED": "${PPM_CANVAS_ENABLED:-1}", "PPM_ANTYFLOW_SHELL_ENABLED": "${PPM_ANTYFLOW_SHELL_ENABLED:-1}",
                "PPM_SHELL_ENABLED": "${PPM_SHELL_ENABLED:-1}"},
  ${freeze_json}
  "base_images": {"node": "$node_image", "nginx": "$nginx_image", "python": "$python_image", "caddy": "$caddy_image", "alpine": "$alpine_image"},
  "images": {${images_json}}
}
JSON
echo "Build manifest: $manifest"
