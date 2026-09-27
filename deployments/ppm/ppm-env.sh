#!/usr/bin/env bash
# PPM deployment env file: generate secrets (init), validate (check), read/change non-secret keys (get/set).
#
#   ppm-env.sh init  --domain <host> --output <file> [--tls internal|<acme-e-mail>] [--bind 127.0.0.1|0.0.0.0]
#                    [--https-port 443] [--http-port 80] [--project NAME] [--release rc.1] [--image-repo ppm]
#                    [--minio-image <image>] [--mirror docker.io] [--hsts 31536000]
#                    [--reuse-secret-key-from <env file>] [--force]
#   ppm-env.sh check <file>
#   ppm-env.sh get   <file> <KEY>          (non-secret keys only)
#   ppm-env.sh set   <file> <KEY> <VALUE>  (non-secret keys only)
#
# Secure by default: `init` without --tls/--bind creates the PRIVATE setup phase (Caddy's internal CA, ports bound
# to 127.0.0.1) — the instance administrator is claimed before anything is reachable (RUNBOOK §5–7); the public
# phase is switched on with `set PPM_TLS <e-mail>` + `set PPM_BIND_ADDRESS 0.0.0.0`.
# Secret values are never printed. The env file and the backup passphrase file are created with mode 600.
# `--reuse-secret-key-from` keeps SECRET_KEY of an existing deployment (restore/disaster recovery: Plane encrypts
# instance settings with it). Project: `ppm` (production) by default; for a *.localhost domain (drills, tests)
# `ppm-drill` — a *.localhost env may never use the production project name.
set -euo pipefail

SECRET_KEYS=(SECRET_KEY LIVE_SERVER_SECRET_KEY POSTGRES_PASSWORD RABBITMQ_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY
  PPM_GITHUB_APP_CLIENT_SECRET PPM_GITHUB_APP_PRIVATE_KEY PPM_GITHUB_WEBHOOK_SECRET)
REQUIRED_KEYS=(PPM_PROJECT PPM_IMAGE_REPO PPM_RELEASE PPM_MINIO_IMAGE PPM_DOMAIN PPM_HTTP_PORT PPM_HTTPS_PORT
  PPM_PUBLIC_URL PPM_BIND_ADDRESS PPM_TLS PPM_BACKUP_PASSPHRASE_FILE SECRET_KEY LIVE_SERVER_SECRET_KEY
  POSTGRES_PASSWORD RABBITMQ_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY)
GENERATED_SECRETS=(SECRET_KEY LIVE_SERVER_SECRET_KEY POSTGRES_PASSWORD RABBITMQ_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY)

PPM_SCRIPT_NAME=ppm-env
bundle_dir="$(cd "$(dirname "$0")" && pwd)"
# Shared rules (production project name, project-name format). Sourced first: the helpers below override the
# library's same-named ones (env_get here takes the file as its first argument).
# shellcheck source=ppm-lib.sh
source "$bundle_dir/ppm-lib.sh"

die() { echo "ppm-env: $*" >&2; exit 1; }
is_secret() { local k; for k in "${SECRET_KEYS[@]}"; do [[ "$k" == "$1" ]] && return 0; done; return 1; }
rand_hex() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
env_get() { awk -v k="$2" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$1"; }
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

public_url() { # domain https_port
  if [[ "$2" == "443" ]]; then echo "https://$1"; else echo "https://$1:$2"; fi
}

# Passphrase file path from the env: relative values are relative to the env file's directory.
passphrase_path() { # env_file
  local value; value="$(env_get "$1" PPM_BACKUP_PASSPHRASE_FILE)"
  [[ -z "$value" || "$value" == /* ]] && { echo "$value"; return; }
  echo "$(cd "$(dirname "$1")" && pwd)/$value"
}

cmd_init() {
  local domain="" tls=internal output="" https_port=443 http_port=80 bind=127.0.0.1 project="" release=rc.1
  local image_repo=ppm minio_image="" mirror=docker.io hsts=31536000 reuse_from="" force=0
  while (($#)); do
    case "$1" in
      --domain) domain="${2:?}"; shift 2 ;;
      --tls) tls="${2:?}"; shift 2 ;;
      --output) output="${2:?}"; shift 2 ;;
      --https-port) https_port="${2:?}"; shift 2 ;;
      --http-port) http_port="${2:?}"; shift 2 ;;
      --bind) bind="${2:?}"; shift 2 ;;
      --project) project="${2:?}"; shift 2 ;;
      --release) release="${2:?}"; shift 2 ;;
      --image-repo) image_repo="${2:?}"; shift 2 ;;
      --minio-image) minio_image="${2:?}"; shift 2 ;;
      --mirror) mirror="${2:?}"; shift 2 ;;
      --hsts) hsts="${2:?}"; shift 2 ;;
      --reuse-secret-key-from) reuse_from="${2:?}"; shift 2 ;;
      --force) force=1; shift ;;
      *) die "unknown argument for init: $1" ;;
    esac
  done
  [[ -n "$domain" && -n "$output" ]] || die "init needs --domain and --output"
  # Drill/test deployments (*.localhost) never share the production project name: Compose would treat them as the
  # production project (same containers and volumes).
  if [[ -z "$project" ]]; then
    if [[ "$domain" == *.localhost ]]; then project=ppm-drill; else project="$PPM_PRODUCTION_PROJECT"; fi
  fi
  [[ -e "$output" && "$force" != 1 ]] && die "$output already exists; use check, or --force to replace it explicitly"
  minio_image="${minio_image:-$image_repo/minio:$release}"
  local secret_key; secret_key="$(rand_hex 48)"
  if [[ -n "$reuse_from" ]]; then
    secret_key="$(env_get "$reuse_from" SECRET_KEY)"
    [[ -n "$secret_key" ]] || die "SECRET_KEY not found in $reuse_from"
  fi
  mkdir -p "$(dirname "$output")"
  local base passphrase_name passphrase_file
  base="$(basename "$output")"; passphrase_name="${base%.env}.backup-passphrase"
  passphrase_file="$(cd "$(dirname "$output")" && pwd)/$passphrase_name"
  # An existing passphrase is NEVER replaced (old backups need it); init reuses it even with --force.
  local created_passphrase=0
  local tmp; tmp="$(mktemp "$(dirname "$output")/.ppm-env.XXXXXX")"
  chmod 600 "$tmp"
  {
    echo "# PPM deployment env — generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by ppm-env.sh. Contains secrets: never commit/share."
    echo "PPM_PROJECT=$project"
    echo "PPM_IMAGE_REPO=$image_repo"
    echo "PPM_RELEASE=$release"
    echo "PPM_MINIO_IMAGE=$minio_image"
    echo "PPM_DOCKERHUB_MIRROR=$mirror"
    echo "PPM_DOMAIN=$domain"
    echo "PPM_HTTP_PORT=$http_port"
    echo "PPM_HTTPS_PORT=$https_port"
    echo "PPM_PUBLIC_URL=$(public_url "$domain" "$https_port")"
    echo "PPM_BIND_ADDRESS=$bind"
    echo "PPM_TLS=$tls"
    echo "PPM_ACME_CA=https://acme-v02.api.letsencrypt.org/directory"
    echo "PPM_HSTS_MAX_AGE=$hsts"
    echo "PPM_ENABLE_SIGNUP=0"
    echo "PPM_GUNICORN_WORKERS=2"
    echo "PPM_WORKER_CONCURRENCY=2"
    echo "PPM_FILE_SIZE_LIMIT=5242880"
    echo "PPM_PROXY_MAX_BODY_SIZE=16MB"
    echo "PPM_S3_CONNECT_TIMEOUT=5"
    echo "PPM_S3_READ_TIMEOUT=10"
    echo "PPM_S3_MAX_ATTEMPTS=2"
    echo "PPM_GIT_WRITE_ENABLED=0"
    echo "PPM_CANVAS_AUTOMERGE=1"
    echo "PPM_BACKUP_PASSPHRASE_FILE=$passphrase_name"
    echo "PPM_BACKUP_KEEP=7"
    echo "SECRET_KEY=$secret_key"
    echo "LIVE_SERVER_SECRET_KEY=$(rand_hex 48)"
    echo "POSTGRES_PASSWORD=$(rand_hex 32)"
    echo "RABBITMQ_PASSWORD=$(rand_hex 32)"
    echo "MINIO_ACCESS_KEY=ppm$(rand_hex 10)"
    echo "MINIO_SECRET_KEY=$(rand_hex 32)"
    echo "PPM_GITHUB_APP_ID="
    echo "PPM_GITHUB_APP_SLUG="
    echo "PPM_GITHUB_APP_CLIENT_ID="
    echo "PPM_GITHUB_CALLBACK_URL="
    echo "PPM_GITHUB_APP_CLIENT_SECRET="
    echo "PPM_GITHUB_APP_PRIVATE_KEY="
    echo "PPM_GITHUB_WEBHOOK_SECRET="
  } >"$tmp"
  if [[ ! -e "$passphrase_file" ]]; then
    (umask 077 && rand_hex 48 >"$passphrase_file.tmp") && chmod 600 "$passphrase_file.tmp" && mv -f "$passphrase_file.tmp" "$passphrase_file"
    created_passphrase=1
  else
    echo "Kept the existing backup passphrase file $passphrase_file (backups made with it stay restorable)."
  fi
  mv -f "$tmp" "$output"
  chmod 600 "$output"
  if ! (cmd_check "$output" >/dev/null); then
    cmd_check "$output" || true
    rm -f "$output"
    ((created_passphrase)) && rm -f "$passphrase_file"
    die "no files were kept (fix the arguments and run init again)"
  fi
  echo "Created $output and $passphrase_file (mode 600); generated secrets: ${GENERATED_SECRETS[*]}$([[ -n "$reuse_from" ]] && echo " (SECRET_KEY reused)"). Values were not printed."
  echo "Store BOTH files in a password manager: without the passphrase file no backup can be restored."
  cmd_check "$output"
}

cmd_check() {
  local file="${1:?check needs a file}" errors=() key value domain tls https_port bind expected passfile project
  [[ -f "$file" ]] || die "$file does not exist"
  for key in "${REQUIRED_KEYS[@]}"; do
    [[ -n "$(env_get "$file" "$key")" ]] || errors+=("$key is missing or empty")
  done
  for key in "${GENERATED_SECRETS[@]}"; do
    value="$(env_get "$file" "$key")"
    [[ -z "$value" ]] && continue
    if [[ "$value" =~ ^(generated-by-ppm-env|change-this-key-on-deployment|secret-key|access-key|plane|password|changeme)$ ]]; then
      errors+=("$key still holds a placeholder")
    elif ((${#value} < 20)); then
      errors+=("$key is shorter than 20 characters")
    elif [[ ! "$value" =~ ^[A-Za-z0-9]+$ ]]; then
      errors+=("$key must be alphanumeric (it is embedded in connection URLs)")
    fi
  done
  domain="$(env_get "$file" PPM_DOMAIN)"; tls="$(env_get "$file" PPM_TLS)"; https_port="$(env_get "$file" PPM_HTTPS_PORT)"
  project="$(env_get "$file" PPM_PROJECT)"
  ppm_valid_project_name "$project" \
    || errors+=("PPM_PROJECT must be a Compose project name (a-z 0-9 _ -; no capitals, spaces or tabs)")
  if [[ "$domain" == *.localhost ]] && ppm_is_production_project "$project"; then
    errors+=("PPM_PROJECT names the production project ($PPM_PRODUCTION_PROJECT); a *.localhost (drill/test) deployment needs its own (e.g. ppm-drill)")
  fi
  bind="$(env_get "$file" PPM_BIND_ADDRESS)"
  [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
    || errors+=("PPM_DOMAIN must be a bare host name (no scheme, port or path)")
  for key in PPM_HTTP_PORT PPM_HTTPS_PORT; do
    [[ "$(env_get "$file" "$key")" =~ ^[0-9]{2,5}$ ]] || errors+=("$key must be a port number")
  done
  [[ "$bind" =~ ^(127\.0\.0\.1|0\.0\.0\.0)$ ]] || errors+=("PPM_BIND_ADDRESS must be 127.0.0.1 (private) or 0.0.0.0 (public)")
  if [[ "$tls" == "internal" ]]; then
    # Caddy's internal CA is never exposed publicly: *.localhost rehearsals, or the private setup phase on loopback.
    [[ "$domain" == *.localhost || "$bind" == "127.0.0.1" ]] \
      || errors+=("PPM_TLS=internal is only allowed for *.localhost or with PPM_BIND_ADDRESS=127.0.0.1 (private setup phase)")
  elif [[ ! "$tls" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
    errors+=("PPM_TLS must be the ACME contact e-mail (or internal for the private phase / *.localhost)")
  elif [[ "$domain" == *.localhost ]]; then
    errors+=("ACME cannot issue certificates for *.localhost; use PPM_TLS=internal")
  elif [[ "$bind" == "127.0.0.1" ]]; then
    errors+=("ACME needs ports 80/443 reachable from the Internet: set PPM_BIND_ADDRESS=0.0.0.0 together with PPM_TLS=<e-mail>")
  fi
  if [[ "$(env_get "$file" PPM_ACME_CA)" == *staging* ]]; then
    # The API reaches object storage through the public URL and trusts only public CAs (and Caddy's internal CA in
    # the private phase): with a staging certificate every storage call — and preflight — fails.
    errors+=("PPM_ACME_CA points to a staging CA: the server does not trust it (preflight object_storage fails); use the production directory")
  fi
  expected="$(public_url "$domain" "$https_port")"
  [[ "$(env_get "$file" PPM_PUBLIC_URL)" == "$expected" ]] || errors+=("PPM_PUBLIC_URL must be exactly $expected")
  [[ "$(env_get "$file" PPM_RELEASE)" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || errors+=("PPM_RELEASE must be a Docker tag")
  if [[ "$(file_mode "$file")" != "600" && "$(file_mode "$file")" != "400" ]]; then
    errors+=("$file must not be readable by other users (chmod 600)")
  fi
  passfile="$(passphrase_path "$file")"
  if [[ -n "$passfile" ]]; then
    if [[ ! -f "$passfile" ]]; then
      errors+=("backup passphrase file $passfile is missing (restore it from the password manager)")
    else
      [[ "$(file_mode "$passfile")" == "600" || "$(file_mode "$passfile")" == "400" ]] || errors+=("$passfile must be mode 600")
      (( $(tr -d '\n' <"$passfile" | wc -c) >= 32 )) || errors+=("$passfile holds fewer than 32 characters")
    fi
  fi
  if ((${#errors[@]})); then
    printf 'ppm-env: %s is invalid:\n' "$file" >&2
    printf '  - %s\n' "${errors[@]}" >&2
    return 1
  fi
  echo "ppm-env: $file is valid (domain $domain, $([[ "$bind" == 127.0.0.1 ]] && echo private || echo public) phase, release $(env_get "$file" PPM_RELEASE)); secret values were not printed."
}

cmd_get() {
  local file="${1:?}" key="${2:?}"
  is_secret "$key" && die "refusing to print secret $key"
  env_get "$file" "$key"
}

cmd_set() {
  local file="${1:?}" key="${2:?}" value="${3?}"
  is_secret "$key" && die "refusing to change secret $key with set; edit the file or re-run init"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "invalid key $key"
  local tmp; tmp="$(mktemp "$(dirname "$file")/.ppm-env.XXXXXX")"
  chmod 600 "$tmp"
  awk -v k="$key" -v v="$value" 'BEGIN { done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' "$file" >"$tmp"
  mv -f "$tmp" "$file"
  chmod 600 "$file"
  echo "ppm-env: $key updated in $file"
}

case "${1:-}" in
  init) shift; cmd_init "$@" ;;
  check) shift; cmd_check "$@" || exit 1 ;;
  get) shift; cmd_get "$@" ;;
  set) shift; cmd_set "$@" ;;
  *) sed -n '2,18p' "$0"; exit 2 ;;
esac
