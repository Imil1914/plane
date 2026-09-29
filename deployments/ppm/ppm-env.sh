#!/usr/bin/env bash
# PPM deployment env file: generate secrets (init), validate (check), read/change non-secret keys (get/set).
#
#   ppm-env.sh init  --domain <host> --output <file> [--tls internal|<acme-e-mail>] [--bind 127.0.0.1|0.0.0.0]
#                    [--https-port 443] [--http-port 80] [--project NAME] [--release rc.1] [--image-repo ppm]
#                    [--minio-image <image>] [--mirror docker.io] [--hsts 31536000]
#                    [--git-domain <host>] [--git-ssh-port 2222] [--forgejo-image <image@sha256:…>]
#                    [--reuse-secret-key-from <env file>] [--force]
#   ppm-env.sh check <file>
#   ppm-env.sh get   <file> <KEY>          (non-secret keys only)
#   ppm-env.sh set   <file> <KEY> <VALUE>  (non-secret keys only)
#   ppm-env.sh add-git <file> [--git-domain <host>] [--git-ssh-port 2222] [--forgejo-image <image@sha256:…>]
#                    add the Git server keys (Forgejo) that an existing env (e.g. of RC.1) lacks; every existing line
#                    stays byte-identical, keys already present (also PPM_GIT_SERVER_ENABLED=0) are never changed
#   ppm-env.sh add-sso <file>
#                    add the keys of sign-in through PPM (single sign-on to the Git server, G2.2) that an env of RC.2
#                    lacks, the same way (nothing else changes); needs the Git server keys first (add-git)
#   ppm-env.sh rotate-sso-key <file> [--finish]
#                    new signing key of the sign-in; the old one stays published as PPM_OIDC_PREVIOUS_PRIVATE_KEY until
#                    --finish drops it (RUNBOOK §13, §17.14.8)
#   ppm-env.sh rotate-sso-secret <file>
#                    new client secret of the sign-in (then up and git-bootstrap)
#   ppm-env.sh set-secret <file> KEY   value on stdin — KEY is PPM_FORGEJO_TOKEN or PPM_FORGEJO_ADMIN_TOKEN (written by
#                    ppm-deploy.sh git-bootstrap), PPM_ALERT_TELEGRAM_BOT_TOKEN or PPM_ALERT_SMTP_PASSWORD (RUNBOOK §14)
#
# Secure by default: `init` without --tls/--bind creates the PRIVATE setup phase (Caddy's internal CA, ports bound
# to 127.0.0.1) — the instance administrator is claimed before anything is reachable (RUNBOOK §5–7); the public
# phase is switched on with `set PPM_TLS <e-mail>` + `set PPM_BIND_ADDRESS 0.0.0.0`.
# Secret values are never printed. The env file and the backup passphrase file are created with mode 600.
# `--reuse-secret-key-from` keeps SECRET_KEY (and FORGEJO_SECRET_KEY) of an existing deployment (restore/disaster
# recovery: Plane encrypts instance settings, Forgejo 2FA secrets with them). Project: `ppm` (production) by default;
# for a *.localhost domain (drills, tests) `ppm-drill` — a *.localhost env may never use the production project name.
# Git server (Forgejo, RUNBOOK §17): on by default in new files (git.<domain>, SSH 2222 — a drill copy on the
# production server needs another --git-ssh-port); an env without the keys (RC.1) keeps it off until `add-git`.
# Sign-in through PPM (RUNBOOK §17.14): on by default in new files with the Git server; an env without its keys
# (RC.2) keeps the Git server's own sign-in (G2.1) until `add-sso`. The signing key is generated straight into the
# env (RSA 3072, the PEM in base64 on one line): no key file is written anywhere else, no value is printed.
# Monitoring and alerts (ppm-monitor.sh, RUNBOOK §14): thresholds default in the script when a key is absent; the
# Telegram/SMTP alert channels are optional (empty = not configured) — no migration command needed for either.
set -euo pipefail

SECRET_KEYS=(SECRET_KEY LIVE_SERVER_SECRET_KEY POSTGRES_PASSWORD RABBITMQ_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY
  PPM_GITHUB_APP_CLIENT_SECRET PPM_GITHUB_APP_PRIVATE_KEY PPM_GITHUB_WEBHOOK_SECRET
  FORGEJO_DB_PASSWORD FORGEJO_SECRET_KEY FORGEJO_INTERNAL_TOKEN FORGEJO_JWT_SECRET FORGEJO_LFS_JWT_SECRET
  PPM_FORGEJO_WEBHOOK_SECRET PPM_FORGEJO_TOKEN PPM_ALERT_TELEGRAM_BOT_TOKEN PPM_ALERT_SMTP_PASSWORD
  PPM_OIDC_PRIVATE_KEY PPM_OIDC_PREVIOUS_PRIVATE_KEY PPM_OIDC_CLIENT_SECRET PPM_FORGEJO_ADMIN_TOKEN)
REQUIRED_KEYS=(PPM_PROJECT PPM_IMAGE_REPO PPM_RELEASE PPM_MINIO_IMAGE PPM_DOMAIN PPM_HTTP_PORT PPM_HTTPS_PORT
  PPM_PUBLIC_URL PPM_BIND_ADDRESS PPM_TLS PPM_BACKUP_PASSPHRASE_FILE SECRET_KEY LIVE_SERVER_SECRET_KEY
  POSTGRES_PASSWORD RABBITMQ_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY)
GENERATED_SECRETS=(SECRET_KEY LIVE_SERVER_SECRET_KEY POSTGRES_PASSWORD RABBITMQ_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY)
# Git server (Forgejo): settings, generated secrets (hex, except the two JWT secrets: base64url of exactly 32 bytes
# without '=', the only form Forgejo accepts — any other value it silently regenerates at every start) and the
# read-only API token written later by `ppm-deploy.sh git-bootstrap`.
GIT_SETTINGS=(PPM_GIT_SERVER_ENABLED PPM_GIT_DOMAIN PPM_GIT_PUBLIC_URL PPM_GIT_SSH_ENABLED PPM_GIT_SSH_PORT
  PPM_GIT_MAX_BODY_SIZE PPM_FORGEJO_IMAGE)
GIT_HEX_SECRETS=(FORGEJO_DB_PASSWORD FORGEJO_SECRET_KEY FORGEJO_INTERNAL_TOKEN PPM_FORGEJO_WEBHOOK_SECRET)
GIT_JWT_SECRETS=(FORGEJO_JWT_SECRET FORGEJO_LFS_JWT_SECRET)
GIT_KEYS=("${GIT_SETTINGS[@]}" "${GIT_HEX_SECRETS[@]}" "${GIT_JWT_SECRETS[@]}" PPM_FORGEJO_TOKEN)
# Sign-in through PPM (G2.2): PPM is the OpenID Connect provider of the Git server. Settings, the two generated secrets
# (signing key, client secret), the previous signing key (only during a rotation) and what git-bootstrap writes (the
# admin token of ppm-bot, the id of Forgejo's login source «PPM»).
SSO_SETTINGS=(PPM_GIT_SSO_ENABLED PPM_GIT_LOCAL_SIGNIN PPM_OIDC_CLIENT_ID)
SSO_GENERATED_SECRETS=(PPM_OIDC_PRIVATE_KEY PPM_OIDC_CLIENT_SECRET)
SSO_KEYS=("${SSO_SETTINGS[@]}" PPM_OIDC_PRIVATE_KEY PPM_OIDC_PREVIOUS_PRIVATE_KEY PPM_OIDC_CLIENT_SECRET
  PPM_FORGEJO_ADMIN_TOKEN PPM_FORGEJO_SSO_SOURCE_ID)
# Monitoring and alerts (ppm-monitor.sh, RUNBOOK §14). Thresholds are plain settings with script-side defaults
# (an env lacking them, e.g. RC.2, behaves exactly as if it had the default — no migration needed); the two alert
# channels (Telegram, SMTP) are optional integrations like the GitHub App keys: empty means "not configured".
MONITOR_THRESHOLD_KEYS=(PPM_MONITOR_DISK_WARN_PERCENT PPM_MONITOR_DISK_WARN_GB PPM_MONITOR_DISK_CRIT_PERCENT
  PPM_MONITOR_DISK_CRIT_GB PPM_MONITOR_BACKUP_MAX_AGE_HOURS PPM_MONITOR_CERT_WARN_DAYS PPM_MONITOR_REMIND_HOURS
  PPM_MONITOR_HTTP_TIMEOUT)
MONITOR_TELEGRAM_KEYS=(PPM_ALERT_TELEGRAM_BOT_TOKEN PPM_ALERT_TELEGRAM_CHAT_ID)
MONITOR_SMTP_KEYS=(PPM_ALERT_SMTP_HOST PPM_ALERT_SMTP_PORT PPM_ALERT_SMTP_SECURITY PPM_ALERT_SMTP_USER
  PPM_ALERT_SMTP_PASSWORD PPM_ALERT_SMTP_FROM PPM_ALERT_SMTP_TO)

PPM_SCRIPT_NAME=ppm-env
bundle_dir="$(cd "$(dirname "$0")" && pwd)"
# Shared rules (production project name, project-name format, Forgejo image). Sourced first: the helpers below
# override the library's same-named ones (env_get here takes the file as its first argument).
# shellcheck source=ppm-lib.sh
source "$bundle_dir/ppm-lib.sh"

die() { echo "ppm-env: $*" >&2; exit 1; }
is_secret() { local k; for k in "${SECRET_KEYS[@]}"; do [[ "$k" == "$1" ]] && return 0; done; return 1; }
rand_hex() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
# base64url of 32 random bytes, no '=' (43 characters): Forgejo's JWT_SECRET / LFS_JWT_SECRET format.
rand_b64url32() { { openssl rand 32 2>/dev/null || head -c 32 /dev/urandom; } | base64 | tr -d '\n=' | tr '+/' '-_'; }
env_get() { awk -v k="$2" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$1"; }
env_has() { grep -q "^$2=" "$1"; }
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
valid_host() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; }

public_url() { # domain https_port
  if [[ "$2" == "443" ]]; then echo "https://$1"; else echo "https://$1:$2"; fi
}

# Passphrase file path from the env: relative values are relative to the env file's directory.
passphrase_path() { # env_file
  local value; value="$(env_get "$1" PPM_BACKUP_PASSPHRASE_FILE)"
  [[ -z "$value" || "$value" == /* ]] && { echo "$value"; return; }
  echo "$(cd "$(dirname "$1")" && pwd)/$value"
}

# Signing key of the sign-in through PPM: a new RSA 3072 private key, its PEM in base64 on one line — the form of
# PPM_OIDC_PRIVATE_KEY. It only ever exists in this pipe and in the caller's variable (never in a file or argv).
rsa_key_b64() {
  { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 2>/dev/null || openssl genrsa 3072 2>/dev/null; } \
    | base64 | tr -d '\n'
}
# Bits of the RSA modulus of such a value ("" when it is not base64 of an unencrypted RSA private key in PEM). Only
# the public half is ever written out (-pubout), and only into this pipe; -passin pass: fails an encrypted key at once
# instead of asking for its passphrase.
rsa_b64_bits() { # value
  local text
  [[ "$1" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 0
  text="$(printf '%s' "$1" | base64 -d 2>/dev/null | openssl pkey -passin pass: -pubout 2>/dev/null \
    | openssl pkey -pubin -noout -text 2>/dev/null)" || true
  [[ "$text" == *Modulus* ]] || return 0
  sed -n 's/.*Public-Key: (\([0-9]*\) bit).*/\1/p' <<<"$text" | head -n1
}

# A new signing key; fails unless it really is an RSA key of 3072 bits (no openssl, or one without genpkey/genrsa).
# Callers: key="$(new_signing_key)" || die "$KEYGEN_FAILED"
new_signing_key() {
  local value; value="$(rsa_key_b64)" || true
  [[ "$(rsa_b64_bits "$value")" == 3072 ]] || return 1
  printf '%s' "$value"
}
KEYGEN_FAILED="openssl could not generate the RSA 3072 signing key (is openssl installed?); nothing was written"

# The keys of sign-in through PPM, one KEY=value line each: switched on, the Git server's password form off, the two
# generated values given by the caller; what git-bootstrap writes later — empty.
sso_lines() { # signing_key client_secret
  echo "PPM_GIT_SSO_ENABLED=1"
  echo "PPM_GIT_LOCAL_SIGNIN=0"
  echo "PPM_OIDC_CLIENT_ID=forgejo"
  echo "PPM_OIDC_PRIVATE_KEY=$1"
  echo "PPM_OIDC_PREVIOUS_PRIVATE_KEY="
  echo "PPM_OIDC_CLIENT_SECRET=$2"
  echo "PPM_FORGEJO_ADMIN_TOKEN="
  echo "PPM_FORGEJO_SSO_SOURCE_ID="
}
SSO_BLOCK_COMMENT="# ---- Sign-in through PPM (single sign-on to the Git server), RUNBOOK §17.14. PPM_FORGEJO_ADMIN_TOKEN and PPM_FORGEJO_SSO_SOURCE_ID are written by ppm-deploy.sh git-bootstrap."

# The Git server keys, one KEY=value line each (secrets freshly generated; the token empty).
git_lines() { # git_domain https_port ssh_port forgejo_image [forgejo_secret_key]
  echo "PPM_GIT_SERVER_ENABLED=1"
  echo "PPM_GIT_DOMAIN=$1"
  echo "PPM_GIT_PUBLIC_URL=$(public_url "$1" "$2")"
  echo "PPM_GIT_SSH_ENABLED=1"
  echo "PPM_GIT_SSH_PORT=$3"
  echo "PPM_GIT_MAX_BODY_SIZE=1GB"
  echo "PPM_FORGEJO_IMAGE=$4"
  echo "FORGEJO_DB_PASSWORD=$(rand_hex 32)"
  echo "FORGEJO_SECRET_KEY=${5:-$(rand_hex 32)}"
  echo "FORGEJO_INTERNAL_TOKEN=$(rand_hex 32)"
  echo "FORGEJO_JWT_SECRET=$(rand_b64url32)"
  echo "FORGEJO_LFS_JWT_SECRET=$(rand_b64url32)"
  echo "PPM_FORGEJO_WEBHOOK_SECRET=$(rand_hex 32)"
  echo "PPM_FORGEJO_TOKEN="
}

cmd_init() {
  local domain="" tls=internal output="" https_port=443 http_port=80 bind=127.0.0.1 project="" release=rc.1
  local image_repo=ppm minio_image="" mirror=docker.io hsts=31536000 reuse_from="" force=0 git_domain=""
  local forgejo_image="$PPM_FORGEJO_IMAGE_DEFAULT" git_ssh_port=2222
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
      --git-domain) git_domain="${2:?}"; shift 2 ;;
      --git-ssh-port) git_ssh_port="${2:?}"; shift 2 ;;
      --forgejo-image) forgejo_image="${2:?}"; shift 2 ;;
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
  git_domain="${git_domain:-git.$domain}"
  local secret_key forgejo_secret_key=""; secret_key="$(rand_hex 48)"
  if [[ -n "$reuse_from" ]]; then
    secret_key="$(env_get "$reuse_from" SECRET_KEY)"
    [[ -n "$secret_key" ]] || die "SECRET_KEY not found in $reuse_from"
    # Forgejo encrypts 2FA secrets with it: a recovered Git server needs the old value too (when the old env had one).
    forgejo_secret_key="$(env_get "$reuse_from" FORGEJO_SECRET_KEY)"
  fi
  # Sign-in through PPM comes with the Git server: its signing key is generated before anything is written.
  local signing_key; signing_key="$(new_signing_key)" || die "$KEYGEN_FAILED"
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
    echo "# ---- Monitoring and alerts (ppm-monitor.sh), RUNBOOK §14. Thresholds have these defaults even if removed."
    echo "PPM_MONITOR_DISK_WARN_PERCENT=15"
    echo "PPM_MONITOR_DISK_WARN_GB=10"
    echo "PPM_MONITOR_DISK_CRIT_PERCENT=5"
    echo "PPM_MONITOR_DISK_CRIT_GB=3"
    echo "PPM_MONITOR_BACKUP_MAX_AGE_HOURS=26"
    echo "PPM_MONITOR_CERT_WARN_DAYS=14"
    echo "PPM_MONITOR_REMIND_HOURS=6"
    echo "PPM_MONITOR_HTTP_TIMEOUT=5"
    echo "# Optional Telegram bot alert channel; empty = not configured (RUNBOOK §14.2)"
    echo "PPM_ALERT_TELEGRAM_BOT_TOKEN="
    echo "PPM_ALERT_TELEGRAM_CHAT_ID="
    echo "# Optional e-mail alert channel via SMTP; empty = not configured (RUNBOOK §14.3). PPM_ALERT_SMTP_TO accepts"
    echo "# one address or several separated by commas."
    echo "PPM_ALERT_SMTP_HOST="
    echo "PPM_ALERT_SMTP_PORT=587"
    echo "PPM_ALERT_SMTP_SECURITY=starttls"
    echo "PPM_ALERT_SMTP_USER="
    echo "PPM_ALERT_SMTP_PASSWORD="
    echo "PPM_ALERT_SMTP_FROM="
    echo "PPM_ALERT_SMTP_TO="
    echo "# ---- Git server (Forgejo), RUNBOOK §17. PPM_FORGEJO_TOKEN is written by ppm-deploy.sh git-bootstrap."
    git_lines "$git_domain" "$https_port" "$git_ssh_port" "$forgejo_image" "$forgejo_secret_key"
    echo "$SSO_BLOCK_COMMENT"
    sso_lines "$signing_key" "$(rand_hex 24)"
  } >"$tmp"
  signing_key=""
  if [[ ! -e "$passphrase_file" ]]; then
    (umask 077 && rand_hex 48 >"$passphrase_file.tmp") && chmod 600 "$passphrase_file.tmp" && mv -f "$passphrase_file.tmp" "$passphrase_file"
    created_passphrase=1
  else
    echo "Kept the existing backup passphrase file $passphrase_file (backups made with it stay restorable)."
  fi
  mv -f "$tmp" "$output"
  chmod 600 "$output"
  if ! (cmd_check "$output" >/dev/null 2>&1); then
    cmd_check "$output" || true
    rm -f "$output"
    ((created_passphrase)) && rm -f "$passphrase_file"
    die "no files were kept (fix the arguments and run init again)"
  fi
  echo "Created $output and $passphrase_file (mode 600); generated secrets: ${GENERATED_SECRETS[*]} ${GIT_HEX_SECRETS[*]} ${GIT_JWT_SECRETS[*]} ${SSO_GENERATED_SECRETS[*]}$([[ -n "$reuse_from" ]] && echo " (SECRET_KEY$([[ -n "$forgejo_secret_key" ]] && echo ", FORGEJO_SECRET_KEY") reused)"). Values were not printed."
  echo "Store BOTH files in a password manager: without the passphrase file no backup can be restored."
  cmd_check "$output"
}

# Git server keys (Forgejo). Sets git_state (for the summary) and appends to the caller's `errors`/`notes`.
check_git() { # file
  local file="$1" enabled domain git_domain tls bind https_port http_port ssh ssh_port size image key value token
  if ! env_has "$file" PPM_GIT_SERVER_ENABLED; then
    git_state="off"
    notes+=("Git server keys are missing (env of RC.1): the Git server stays off. Add them (nothing else changes): ppm-env.sh add-git $file")
    return 0
  fi
  enabled="$(env_get "$file" PPM_GIT_SERVER_ENABLED)"
  case "$enabled" in
    0) git_state="off"; return 0 ;;
    1) ;;
    *) errors+=("PPM_GIT_SERVER_ENABLED must be 1 (Git server on) or 0 (off)"); return 0 ;;
  esac
  for key in "${GIT_KEYS[@]}"; do
    [[ "$key" == PPM_FORGEJO_TOKEN || "$key" == PPM_GIT_MAX_BODY_SIZE ]] && continue
    env_has "$file" "$key" || errors+=("$key is missing (Git server on): ppm-env.sh add-git $file adds it")
  done
  domain="$(env_get "$file" PPM_DOMAIN)"; git_domain="$(env_get "$file" PPM_GIT_DOMAIN)"
  tls="$(env_get "$file" PPM_TLS)"; bind="$(env_get "$file" PPM_BIND_ADDRESS)"
  https_port="$(env_get "$file" PPM_HTTPS_PORT)"; http_port="$(env_get "$file" PPM_HTTP_PORT)"
  if ! valid_host "$git_domain"; then
    errors+=("PPM_GIT_DOMAIN must be a bare host name (e.g. git.$domain)")
  elif [[ "$git_domain" == "$domain" ]]; then
    errors+=("PPM_GIT_DOMAIN must differ from PPM_DOMAIN: the Git server needs its own origin (git.$domain)")
  elif [[ "$domain" == *.localhost && "$git_domain" != *.localhost ]]; then
    errors+=("PPM_GIT_DOMAIN must be *.localhost like PPM_DOMAIN (drill/test deployment)")
  elif [[ "$domain" != *.localhost && "$git_domain" == *.localhost ]]; then
    errors+=("PPM_GIT_DOMAIN is *.localhost next to a real PPM_DOMAIN: use git.$domain (with its DNS record)")
  fi
  [[ "$(env_get "$file" PPM_GIT_PUBLIC_URL)" == "$(public_url "$git_domain" "$https_port")" ]] \
    || errors+=("PPM_GIT_PUBLIC_URL must be exactly $(public_url "$git_domain" "$https_port")")
  ssh="$(env_get "$file" PPM_GIT_SSH_ENABLED)"; ssh_port="$(env_get "$file" PPM_GIT_SSH_PORT)"
  [[ "$ssh" =~ ^[01]$ ]] || errors+=("PPM_GIT_SSH_ENABLED must be 1 (git over SSH) or 0 (HTTPS only)")
  if [[ "$ssh" == 1 ]]; then
    if [[ ! "$ssh_port" =~ ^[0-9]{2,5}$ ]] || ((10#$ssh_port > 65535)); then
      errors+=("PPM_GIT_SSH_PORT must be a port number")
    elif [[ "$ssh_port" == "$https_port" || "$ssh_port" == "$http_port" ]]; then
      errors+=("PPM_GIT_SSH_PORT must differ from PPM_HTTP_PORT/PPM_HTTPS_PORT (the proxy listens there)")
    fi
  fi
  value="$(env_get "$file" PPM_GIT_DISABLE_MIGRATIONS)"
  [[ -z "$value" || "$value" =~ ^(true|false)$ ]] \
    || errors+=("PPM_GIT_DISABLE_MIGRATIONS must be true (no repository migrations) or false")
  size="$(env_get "$file" PPM_GIT_MAX_BODY_SIZE)"
  [[ -z "$size" || "$size" =~ ^[1-9][0-9]*([KMGT]i?B|B)?$ ]] \
    || errors+=("PPM_GIT_MAX_BODY_SIZE must be a size such as 1GB or 500MB")
  image="$(env_get "$file" PPM_FORGEJO_IMAGE)"
  [[ "$image" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] \
    || errors+=("PPM_FORGEJO_IMAGE must be pinned by digest (<image>@sha256:<64 hex>, e.g. $PPM_FORGEJO_IMAGE_DEFAULT)")
  for key in "${GIT_HEX_SECRETS[@]}"; do
    value="$(env_get "$file" "$key")"
    [[ -z "$value" ]] && { env_has "$file" "$key" && errors+=("$key is empty"); continue; }
    if ((${#value} < 20)); then errors+=("$key is shorter than 20 characters")
    elif [[ ! "$value" =~ ^[A-Za-z0-9]+$ ]]; then errors+=("$key must be alphanumeric (ppm-env.sh generates hex)"); fi
  done
  for key in "${GIT_JWT_SECRETS[@]}"; do
    value="$(env_get "$file" "$key")"
    [[ "$value" =~ ^[A-Za-z0-9_-]{43}$ ]] \
      || errors+=("$key must be base64url of 32 bytes without '=' (43 characters); Forgejo replaces any other value at every start")
  done
  token="$(env_get "$file" PPM_FORGEJO_TOKEN)"
  if [[ -z "$token" ]]; then
    notes+=("PPM_FORGEJO_TOKEN is empty: after \`up\`, run ppm-deploy.sh git-bootstrap (service account, read-only token, webhook)")
  elif [[ ! "$token" =~ ^[0-9a-f]{40}$ ]]; then
    errors+=("PPM_FORGEJO_TOKEN is not a Forgejo token (40 hex characters): run ppm-deploy.sh git-bootstrap --rotate-token")
  fi
  if [[ "$tls" == "internal" && "$git_domain" != *.localhost && "$bind" != "127.0.0.1" ]]; then
    errors+=("PPM_TLS=internal is only allowed for a *.localhost PPM_GIT_DOMAIN or with PPM_BIND_ADDRESS=127.0.0.1")
  fi
  git_state="$git_domain on ($([[ "$ssh" == 1 ]] && echo "SSH port $ssh_port" || echo "HTTPS only"))"
}

# Sign-in through PPM (single sign-on to the Git server, G2.2). Needs the Git server on (git_state from check_git),
# extends git_state for the summary and appends to the caller's `errors`/`notes`. An env without the keys (RC.2) keeps
# the Git server's own sign-in — a note, not an error; with PPM_GIT_SSO_ENABLED=0 the other keys are not checked.
check_sso() { # file
  local file="$1" enabled key value bits current previous local_signin empty=()
  if ! env_has "$file" PPM_GIT_SSO_ENABLED; then
    [[ "$git_state" == off ]] \
      || notes+=("the keys of sign-in through PPM are missing (env of RC.2): the Git server keeps its own sign-in. Add them (nothing else changes): ppm-env.sh add-sso $file")
    return 0
  fi
  enabled="$(env_get "$file" PPM_GIT_SSO_ENABLED)"
  case "$enabled" in
    0) [[ "$git_state" == off ]] || git_state+=", own sign-in (single sign-on off)"; return 0 ;;
    1) ;;
    *) errors+=("PPM_GIT_SSO_ENABLED must be 1 (sign-in through PPM) or 0 (the Git server's own sign-in, G2.1)"); return 0 ;;
  esac
  if [[ "$git_state" == off ]]; then
    errors+=("PPM_GIT_SSO_ENABLED=1 needs the Git server (PPM_GIT_SERVER_ENABLED=1): with the Git server off, set PPM_GIT_SSO_ENABLED 0 as well")
    return 0
  fi
  for key in "${SSO_KEYS[@]}"; do
    env_has "$file" "$key" || errors+=("$key is missing (sign-in through PPM on): ppm-env.sh add-sso $file adds it")
  done
  local_signin="$(env_get "$file" PPM_GIT_LOCAL_SIGNIN)"
  [[ "$local_signin" =~ ^[01]$ ]] \
    || errors+=("PPM_GIT_LOCAL_SIGNIN must be 0 (sign-in through PPM only) or 1 (the Git server's password form too: emergency sign-in)")
  [[ "$(env_get "$file" PPM_OIDC_CLIENT_ID)" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] \
    || errors+=("PPM_OIDC_CLIENT_ID must be letters, digits and . _ - (forgejo by default)")
  # PPM's provider accepts only a random secret of at least 32 hex digits (its fast hash relies on that); hex also
  # keeps it unambiguous in HTTP Basic authentication, where Forgejo sends it URL-encoded.
  [[ "$(env_get "$file" PPM_OIDC_CLIENT_SECRET)" =~ ^[0-9a-fA-F]{32,255}$ ]] \
    || errors+=("PPM_OIDC_CLIENT_SECRET must be 32 to 255 hex digits (ppm-env.sh rotate-sso-secret generates 48)")
  current="$(env_get "$file" PPM_OIDC_PRIVATE_KEY)"; bits="$(rsa_b64_bits "$current")"
  if [[ -z "$bits" ]]; then
    errors+=("PPM_OIDC_PRIVATE_KEY is not an unencrypted RSA private key in PEM, base64 on one line (ppm-env.sh rotate-sso-key generates one)")
  elif ((bits < 2048)); then
    errors+=("PPM_OIDC_PRIVATE_KEY is an RSA key of $bits bits; at least 2048 are needed (ppm-env.sh rotate-sso-key generates 3072)")
  fi
  previous="$(env_get "$file" PPM_OIDC_PREVIOUS_PRIVATE_KEY)"
  if [[ -n "$previous" ]]; then
    bits="$(rsa_b64_bits "$previous")"
    if [[ -z "$bits" ]] || ((bits < 2048)); then
      errors+=("PPM_OIDC_PREVIOUS_PRIVATE_KEY is not an RSA private key of at least 2048 bits in PEM, base64 on one line (empty outside a rotation)")
    elif [[ "$previous" == "$current" ]]; then
      errors+=("PPM_OIDC_PREVIOUS_PRIVATE_KEY equals PPM_OIDC_PRIVATE_KEY: a rotation needs a new key — ppm-env.sh rotate-sso-key $file --finish, then rotate-sso-key $file")
    else
      notes+=("a signing-key rotation is under way (PPM_OIDC_PREVIOUS_PRIVATE_KEY is set): 5 minutes after the up that brought the new key, finish it — ppm-env.sh rotate-sso-key $file --finish, then up")
    fi
  fi
  value="$(env_get "$file" PPM_FORGEJO_ADMIN_TOKEN)"
  if [[ -z "$value" ]]; then empty+=(PPM_FORGEJO_ADMIN_TOKEN)
  elif [[ ! "$value" =~ ^[0-9a-f]{40}$ ]]; then
    errors+=("PPM_FORGEJO_ADMIN_TOKEN is not a Forgejo token (40 hex characters): run ppm-deploy.sh git-bootstrap --rotate-token")
  fi
  value="$(env_get "$file" PPM_FORGEJO_SSO_SOURCE_ID)"
  if [[ -z "$value" ]]; then empty+=(PPM_FORGEJO_SSO_SOURCE_ID)
  elif [[ ! "$value" =~ ^[1-9][0-9]{0,9}$ ]]; then
    errors+=("PPM_FORGEJO_SSO_SOURCE_ID must be the id of the login source «PPM» in the Git server (a positive whole number; git-bootstrap writes it)")
  fi
  if ((${#empty[@]} == 2)); then
    notes+=("sign-in through PPM is not set up in the Git server yet (PPM_FORGEJO_ADMIN_TOKEN and PPM_FORGEJO_SSO_SOURCE_ID are empty): after \`up\`, run ppm-deploy.sh git-bootstrap")
  elif ((${#empty[@]} == 1)); then
    notes+=("sign-in through PPM is not fully set up (${empty[0]} is empty): run ppm-deploy.sh git-bootstrap")
  fi
  if [[ "$local_signin" == 1 ]]; then
    git_state+=", sign-in through PPM + the password form (emergency)"
    notes+=("the Git server's password form is ON (PPM_GIT_LOCAL_SIGNIN=1, emergency sign-in, RUNBOOK §17.14.6): when done — ppm-env.sh set $file PPM_GIT_LOCAL_SIGNIN 0, then up")
  else
    git_state+=", sign-in through PPM"
  fi
}

# Monitoring keys (ppm-monitor.sh, RUNBOOK §14). Thresholds fall back to script defaults when absent — an env
# without them (e.g. RC.2) needs no migration. The two alert channels are validated only once their first key is
# non-empty; empty stays "not configured" (O-4), never an error, same as the optional GitHub App keys above.
check_monitor() { # file
  local file="$1" key value token chat_id host port security user pass from to addr
  for key in "${MONITOR_THRESHOLD_KEYS[@]}"; do
    value="$(env_get "$file" "$key")"
    [[ -z "$value" ]] && continue
    if [[ "$key" == *_PERCENT ]]; then
      [[ "$value" =~ ^(0|[1-9][0-9]?|100)$ ]] || errors+=("$key must be a whole percentage from 0 to 100")
    else
      [[ "$value" =~ ^[1-9][0-9]*$ ]] || errors+=("$key must be a positive whole number")
    fi
  done
  token="$(env_get "$file" PPM_ALERT_TELEGRAM_BOT_TOKEN)"; chat_id="$(env_get "$file" PPM_ALERT_TELEGRAM_CHAT_ID)"
  if [[ -n "$token" || -n "$chat_id" ]]; then
    if [[ -z "$token" || -z "$chat_id" ]]; then
      errors+=("PPM_ALERT_TELEGRAM_BOT_TOKEN and PPM_ALERT_TELEGRAM_CHAT_ID must be set together, or both left empty (channel off)")
    else
      [[ "$token" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{20,}$ ]] \
        || errors+=("PPM_ALERT_TELEGRAM_BOT_TOKEN is not a bot token from @BotFather (digits:letters)")
      [[ "$chat_id" =~ ^-?[0-9]{1,15}$ ]] \
        || errors+=("PPM_ALERT_TELEGRAM_CHAT_ID must be numeric (a personal chat id, or negative for a group)")
    fi
  fi
  host="$(env_get "$file" PPM_ALERT_SMTP_HOST)"
  if [[ -n "$host" ]]; then
    valid_host "$host" || errors+=("PPM_ALERT_SMTP_HOST must be a bare host name")
    port="$(env_get "$file" PPM_ALERT_SMTP_PORT)"
    [[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) \
      || errors+=("PPM_ALERT_SMTP_PORT must be a port number")
    security="$(env_get "$file" PPM_ALERT_SMTP_SECURITY)"
    [[ "$security" =~ ^(starttls|tls|none)$ ]] || errors+=("PPM_ALERT_SMTP_SECURITY must be starttls, tls or none")
    user="$(env_get "$file" PPM_ALERT_SMTP_USER)"; pass="$(env_get "$file" PPM_ALERT_SMTP_PASSWORD)"
    [[ ( -z "$user" && -z "$pass" ) || ( -n "$user" && -n "$pass" ) ]] \
      || errors+=("PPM_ALERT_SMTP_USER and PPM_ALERT_SMTP_PASSWORD must be set together, or both left empty (no SMTP authentication)")
    from="$(env_get "$file" PPM_ALERT_SMTP_FROM)"
    [[ "$from" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || errors+=("PPM_ALERT_SMTP_FROM must be an e-mail address")
    to="$(env_get "$file" PPM_ALERT_SMTP_TO)"
    if [[ -z "$to" ]]; then
      errors+=("PPM_ALERT_SMTP_TO is empty (at least one recipient address; several separated by commas)")
    else
      for addr in ${to//,/ }; do
        [[ "$addr" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || errors+=("PPM_ALERT_SMTP_TO has an invalid address: $addr")
      done
    fi
  fi
}

cmd_check() {
  local file="${1:?check needs a file}" errors=() notes=() key value domain tls https_port bind expected passfile project
  local git_state="off"
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
  valid_host "$domain" || errors+=("PPM_DOMAIN must be a bare host name (no scheme, port or path)")
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
  check_git "$file"
  check_sso "$file"
  check_monitor "$file"
  if ((${#errors[@]})); then
    printf 'ppm-env: %s is invalid:\n' "$file" >&2
    printf '  - %s\n' "${errors[@]}" >&2
    return 1
  fi
  # Notes go to stderr: visible even where the summary is discarded (ppm-deploy.sh up).
  ((${#notes[@]} == 0)) || printf 'ppm-env: note: %s\n' "${notes[@]}" >&2
  echo "ppm-env: $file is valid (domain $domain, $([[ "$bind" == 127.0.0.1 ]] && echo private || echo public) phase, release $(env_get "$file" PPM_RELEASE); Git server $git_state); secret values were not printed."
}

# Append the Git server keys an existing env lacks; never touches an existing line (the old content stays a
# byte-identical prefix of the new file) and never changes a key that is present, even an empty or 0 one.
cmd_add_git() {
  local file="" git_domain="" forgejo_image="$PPM_FORGEJO_IMAGE_DEFAULT" git_ssh_port=2222 domain https_port line key
  local added=() kept=()
  local generated=() tmp
  while (($#)); do
    case "$1" in
      --git-domain) git_domain="${2:?--git-domain needs a host name}"; shift 2 ;;
      --git-ssh-port) git_ssh_port="${2:?--git-ssh-port needs a port}"; shift 2 ;;
      --forgejo-image) forgejo_image="${2:?--forgejo-image needs an image}"; shift 2 ;;
      -*) die "unknown argument for add-git: $1" ;;
      *) [[ -z "$file" ]] || die "add-git takes one env file"; file="$1"; shift ;;
    esac
  done
  [[ -n "$file" ]] || die "add-git needs the env file"
  [[ -f "$file" ]] || die "$file does not exist (create a new one with init)"
  domain="$(env_get "$file" PPM_DOMAIN)"; https_port="$(env_get "$file" PPM_HTTPS_PORT)"
  [[ -n "$domain" && -n "$https_port" ]] || die "$file has no PPM_DOMAIN/PPM_HTTPS_PORT: not a PPM env file"
  git_domain="${git_domain:-git.$domain}"
  tmp="$(mktemp "$(dirname "$file")/.ppm-env.XXXXXX")"
  chmod 600 "$tmp"
  cat "$file" >"$tmp"
  [[ -z "$(tail -c 1 "$file")" ]] || echo >>"$tmp"  # the old last line gets its newline; its bytes stay the same
  echo "# ---- Git server (Forgejo), added $(date -u +%Y-%m-%dT%H:%M:%SZ) by ppm-env.sh add-git (RUNBOOK §17)" >>"$tmp"
  while IFS= read -r line; do
    key="${line%%=*}"
    if env_has "$file" "$key"; then kept+=("$key"); continue; fi
    echo "$line" >>"$tmp"; added+=("$key")
    is_secret "$key" && [[ "$key" != PPM_FORGEJO_TOKEN ]] && generated+=("$key")
  done < <(git_lines "$git_domain" "$https_port" "$git_ssh_port" "$forgejo_image")
  if ((${#added[@]} == 0)); then
    rm -f "$tmp"
    echo "ppm-env: $file already has every Git server key; nothing to add (the file was not changed)."
  else
    mv -f "$tmp" "$file"
    chmod 600 "$file"
    echo "ppm-env: added ${#added[@]} Git server keys to $file: ${added[*]}; generated secrets: ${generated[*]:-none} (values were not printed)."
    ((${#kept[@]} == 0)) || echo "ppm-env: kept as they were: ${kept[*]}"
    echo "ppm-env: save the new copy of $file in the password manager."
  fi
  if [[ "$(env_get "$file" PPM_GIT_SERVER_ENABLED)" == 0 ]]; then
    echo "ppm-env: PPM_GIT_SERVER_ENABLED=0 was kept: the Git server stays off (switch on: ppm-env.sh set $file PPM_GIT_SERVER_ENABLED 1)."
  fi
  cmd_check "$file"
}

# Append the keys of sign-in through PPM an existing env lacks (env of RC.2): the same rules as add-git — the old
# content stays a byte-identical prefix, a key that is present is never changed (also PPM_GIT_SSO_ENABLED=0). Only
# where the Git server is on: sign-in through PPM exists only for it.
cmd_add_sso() {
  local file="" line key added=() kept=() generated=() tmp signing_key
  while (($#)); do
    case "$1" in
      -*) die "unknown argument for add-sso: $1" ;;
      *) [[ -z "$file" ]] || die "add-sso takes one env file"; file="$1"; shift ;;
    esac
  done
  [[ -n "$file" ]] || die "add-sso needs the env file"
  [[ -f "$file" ]] || die "$file does not exist (create a new one with init)"
  [[ -n "$(env_get "$file" PPM_DOMAIN)" ]] || die "$file has no PPM_DOMAIN: not a PPM env file"
  env_has "$file" PPM_GIT_SERVER_ENABLED \
    || die "$file has no Git server keys (env of RC.1), and sign-in through PPM is the Git server's sign-in: first ppm-env.sh add-git $file (RUNBOOK §17.2), then add-sso; the file was not changed"
  [[ "$(env_get "$file" PPM_GIT_SERVER_ENABLED)" == 1 ]] \
    || die "the Git server is off in $file (PPM_GIT_SERVER_ENABLED is not 1), and sign-in through PPM is its sign-in: switch it on first — ppm-env.sh set $file PPM_GIT_SERVER_ENABLED 1 — then add-sso; the file was not changed"
  signing_key="$(new_signing_key)" || die "$KEYGEN_FAILED"
  tmp="$(mktemp "$(dirname "$file")/.ppm-env.XXXXXX")"
  chmod 600 "$tmp"
  cat "$file" >"$tmp"
  [[ -z "$(tail -c 1 "$file")" ]] || echo >>"$tmp"  # the old last line gets its newline; its bytes stay the same
  echo "$SSO_BLOCK_COMMENT Added $(date -u +%Y-%m-%dT%H:%M:%SZ) by ppm-env.sh add-sso." >>"$tmp"
  while IFS= read -r line; do
    key="${line%%=*}"
    if env_has "$file" "$key"; then kept+=("$key"); continue; fi
    echo "$line" >>"$tmp"; added+=("$key")
    case "$key" in PPM_OIDC_PRIVATE_KEY | PPM_OIDC_CLIENT_SECRET) generated+=("$key") ;; esac
  done < <(sso_lines "$signing_key" "$(rand_hex 24)")
  signing_key=""
  if ((${#added[@]} == 0)); then
    rm -f "$tmp"
    echo "ppm-env: $file already has every key of sign-in through PPM; nothing to add (the file was not changed)."
  else
    mv -f "$tmp" "$file"
    chmod 600 "$file"
    echo "ppm-env: added ${#added[@]} keys of sign-in through PPM to $file: ${added[*]}; generated: ${generated[*]:-none} (values were not printed)."
    ((${#kept[@]} == 0)) || echo "ppm-env: kept as they were: ${kept[*]}"
    echo "ppm-env: save the new copy of $file in the password manager."
  fi
  if [[ "$(env_get "$file" PPM_GIT_SSO_ENABLED)" == 0 ]]; then
    echo "ppm-env: PPM_GIT_SSO_ENABLED=0 was kept: the Git server keeps its own sign-in (switch on: ppm-env.sh set $file PPM_GIT_SSO_ENABLED 1, then up and git-bootstrap)."
  else
    echo "ppm-env: next: ./ppm-deploy.sh --env-file $file up, then ./ppm-deploy.sh --env-file $file git-bootstrap (RUNBOOK §17.14.2)."
  fi
  cmd_check "$file"
}

# Replace the lines of one or two keys (appended when missing); the values come through awk's environment
# (PPM_ENV_VALUE_1, PPM_ENV_VALUE_2 — e.g. `PPM_ENV_VALUE_1="$v" write_values …`), never its arguments. Every other
# line stays as it is; the file stays mode 600.
write_values() { # file key1 [key2]
  local file="$1" tmp
  tmp="$(mktemp "$(dirname "$file")/.ppm-env.XXXXXX")"
  chmod 600 "$tmp"
  awk -v k1="$2" -v k2="${3:-}" 'BEGIN { v1 = ENVIRON["PPM_ENV_VALUE_1"]; v2 = ENVIRON["PPM_ENV_VALUE_2"] }
    index($0, k1 "=") == 1 { print k1 "=" v1; d1 = 1; next }
    k2 != "" && index($0, k2 "=") == 1 { print k2 "=" v2; d2 = 1; next }
    { print }
    END { if (!d1) print k1 "=" v1; if (k2 != "" && !d2) print k2 "=" v2 }' "$file" >"$tmp"
  mv -f "$tmp" "$file"
  chmod 600 "$file"
}

sso_rotation_file() { # command args... — sets `file` (and `finish` for --finish) of the caller
  local command="$1"; shift
  while (($#)); do
    case "$1" in
      --finish) [[ "$command" == rotate-sso-key ]] || die "unknown argument for $command: $1"; finish=1; shift ;;
      -*) die "unknown argument for $command: $1" ;;
      *) [[ -z "$file" ]] || die "$command takes one env file"; file="$1"; shift ;;
    esac
  done
  [[ -n "$file" ]] || die "$command needs the env file"
  [[ -f "$file" ]] || die "$file does not exist"
  if ! { env_has "$file" PPM_OIDC_PRIVATE_KEY && env_has "$file" PPM_OIDC_CLIENT_SECRET; }; then
    die "$file has no keys of sign-in through PPM: ppm-env.sh add-sso $file adds them"
  fi
}

# Signing key rotation (R7): the new key signs from the next `up`; the previous one stays in the JWKS until the ID
# tokens it signed have expired (5 minutes), then --finish drops it. Forgejo does not check the signature, so sign-in
# never breaks during a rotation.
cmd_rotate_sso_key() {
  local file="" finish=0 current previous new
  sso_rotation_file rotate-sso-key "$@"
  previous="$(env_get "$file" PPM_OIDC_PREVIOUS_PRIVATE_KEY)"
  if ((finish)); then
    if [[ -z "$previous" ]]; then
      echo "ppm-env: no signing-key rotation is under way in $file (PPM_OIDC_PREVIOUS_PRIVATE_KEY is empty); nothing to finish (the file was not changed)."
    else
      PPM_ENV_VALUE_1="" write_values "$file" PPM_OIDC_PREVIOUS_PRIVATE_KEY
      echo "ppm-env: the previous signing key was removed from $file; next: ./ppm-deploy.sh --env-file $file up (the JWKS then publishes only the current key). Save the new copy of $file in the password manager."
    fi
  else
    [[ -z "$previous" ]] \
      || die "a signing-key rotation is already under way in $file: finish it first — ppm-env.sh rotate-sso-key $file --finish (5 minutes after the up that brought the current key), then up; the file was not changed"
    new="$(new_signing_key)" || die "$KEYGEN_FAILED"
    current="$(env_get "$file" PPM_OIDC_PRIVATE_KEY)"
    if [[ -n "$(rsa_b64_bits "$current")" ]]; then
      PPM_ENV_VALUE_1="$new" PPM_ENV_VALUE_2="$current" write_values "$file" PPM_OIDC_PRIVATE_KEY PPM_OIDC_PREVIOUS_PRIVATE_KEY
      echo "ppm-env: new signing key (RSA 3072) in PPM_OIDC_PRIVATE_KEY of $file; the previous one moved to PPM_OIDC_PREVIOUS_PRIVATE_KEY and stays published in the JWKS (values were not printed)."
      echo "ppm-env: next: ./ppm-deploy.sh --env-file $file up; 5 minutes later: ppm-env.sh rotate-sso-key $file --finish and up again (RUNBOOK §17.14.8). Save the new copy of $file in the password manager."
    else
      # The old value was no key at all (sign-in could not have worked): nothing to keep published.
      PPM_ENV_VALUE_1="$new" write_values "$file" PPM_OIDC_PRIVATE_KEY
      echo "ppm-env: new signing key (RSA 3072) in PPM_OIDC_PRIVATE_KEY of $file; the old value was not a usable key and was dropped (values were not printed). Next: ./ppm-deploy.sh --env-file $file up; nothing to --finish."
    fi
    new="" current=""
  fi
  cmd_check "$file"
}

# Client secret rotation: the new value reaches PPM's database (a hash) and Forgejo's login source «PPM» with the next
# `up` + git-bootstrap; until git-bootstrap, the old secret keeps working (PPM checks the one in its database).
cmd_rotate_sso_secret() {
  local file="" finish=0
  sso_rotation_file rotate-sso-secret "$@"
  PPM_ENV_VALUE_1="$(rand_hex 24)" write_values "$file" PPM_OIDC_CLIENT_SECRET
  echo "ppm-env: new client secret (48 hex) in PPM_OIDC_CLIENT_SECRET of $file (value not printed)."
  echo "ppm-env: next: ./ppm-deploy.sh --env-file $file up, then ./ppm-deploy.sh --env-file $file git-bootstrap — it hands the new secret to PPM and to the Git server, which restarts once (RUNBOOK §17.14.8). Save the new copy of $file in the password manager."
  cmd_check "$file"
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

# Secrets a script (or the operator) writes without ever typing them on a command line: the value comes on stdin
# and reaches awk through its environment. PPM_FORGEJO_TOKEN and PPM_FORGEJO_ADMIN_TOKEN (git-bootstrap; the admin
# token is cleared with an empty line when sign-in through PPM is switched off), the Telegram bot token and the SMTP
# password (RUNBOOK §14, from the owner's terminal) — every other secret: edit the file, RUNBOOK §13.
cmd_set_secret() {
  local file="${1:?set-secret needs the env file}" key="${2:?set-secret needs the key}" value="" tmp
  case "$key" in
    PPM_FORGEJO_TOKEN | PPM_FORGEJO_ADMIN_TOKEN | PPM_ALERT_TELEGRAM_BOT_TOKEN | PPM_ALERT_SMTP_PASSWORD) ;;
    *) die "set-secret only writes PPM_FORGEJO_TOKEN, PPM_FORGEJO_ADMIN_TOKEN, PPM_ALERT_TELEGRAM_BOT_TOKEN or PPM_ALERT_SMTP_PASSWORD (other secrets: edit the file, RUNBOOK §13)" ;;
  esac
  [[ -f "$file" ]] || die "$file does not exist"
  IFS= read -r value || true
  case "$key" in
    PPM_FORGEJO_TOKEN)
      [[ "$value" =~ ^[0-9a-f]{40}$ ]] || die "set-secret: stdin holds no Forgejo token (40 hex characters); $file was not changed" ;;
    PPM_FORGEJO_ADMIN_TOKEN)
      [[ -z "$value" || "$value" =~ ^[0-9a-f]{40}$ ]] \
        || die "set-secret: stdin holds no Forgejo token (40 hex characters; an empty line clears it); $file was not changed" ;;
    PPM_ALERT_TELEGRAM_BOT_TOKEN)
      [[ "$value" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{20,}$ ]] \
        || die "set-secret: stdin holds no Telegram bot token (digits:letters, from @BotFather); $file was not changed" ;;
    PPM_ALERT_SMTP_PASSWORD)
      [[ -n "$value" ]] || die "set-secret: stdin was empty; $file was not changed" ;;
  esac
  tmp="$(mktemp "$(dirname "$file")/.ppm-env.XXXXXX")"
  chmod 600 "$tmp"
  PPM_ENV_SECRET_VALUE="$value" awk -v k="$key" 'BEGIN { v = ENVIRON["PPM_ENV_SECRET_VALUE"]; done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' "$file" >"$tmp"
  mv -f "$tmp" "$file"
  chmod 600 "$file"
  echo "ppm-env: $key updated in $file (value not printed)"
}

case "${1:-}" in
  init) shift; cmd_init "$@" ;;
  check) shift; cmd_check "$@" || exit 1 ;;
  get) shift; cmd_get "$@" ;;
  set) shift; cmd_set "$@" ;;
  add-git) shift; cmd_add_git "$@" || exit 1 ;;
  add-sso) shift; cmd_add_sso "$@" || exit 1 ;;
  rotate-sso-key) shift; cmd_rotate_sso_key "$@" || exit 1 ;;
  rotate-sso-secret) shift; cmd_rotate_sso_secret "$@" || exit 1 ;;
  set-secret) shift; cmd_set_secret "$@" ;;
  # The usage: the comment block at the top of this file (up to the first line that is not a comment).
  *) awk 'NR == 1 { next } /^#/ { print; next } { exit }' "$0"; exit 2 ;;
esac
