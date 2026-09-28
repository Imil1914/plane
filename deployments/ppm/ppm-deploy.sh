#!/usr/bin/env bash
# PPM deployment operations (one entry point for the runbook).
#
#   ppm-deploy.sh <command> [args] [--env-file FILE]     (--env-file may appear anywhere, once)
#
#   config                   validate ppm.env and the Compose files (no values printed)
#   up [--no-workers]        start or update the stack, wait until healthy, run preflight; --no-workers keeps
#                            worker/beat-worker off (restore-drill copies: no e-mails/webhooks from copied data) and
#                            is remembered for the project: later up/restart/release keep them off too (a drill
#                            copy's Git server also sends nothing out and runs no migrations)
#   wait                     wait until every service is healthy / one-shots finished
#   preflight                ppm_backend_preflight --verify-storage-write (DB, Redis, broker, S3 + I/O, realtime);
#                            with the Git server also Forgejo inside the network and through the proxy (HTTPS)
#   git-bootstrap [--rotate-token]
#                            Git server (Forgejo), idempotent: service account ppm-bot (administrator; a random
#                            password that is never stored), PPM's read-only token (→ PPM_FORGEJO_TOKEN in the env
#                            file, 600; --rotate-token revokes the old one), system webhook to the PPM API; then
#                            restarts only api/worker/beat-worker when the token changed (RUNBOOK §17.3)
#   git-admin --username U --email E [--reset-password]
#                            Forgejo administrator for the owner: random one-time password (changed at the first
#                            sign-in), written only to .runtime/<project>/forgejo-admin-credentials.txt (600)
#   restart                  stop + start in dependency order (data kept), wait, preflight
#   release <name> [--allow-git-site-loss]
#                            switch PPM_RELEASE (upgrade or rollback of the application; data and schema kept). With
#                            the Git server on, a release whose proxy has no Git site (rc.1) is refused unless
#                            --allow-git-site-loss: git.<domain> would stop answering until the next release
#   status                   docker compose ps
#   stop                     stop containers (data kept)
#   logs [service...]        recent logs with secret values redacted
#   scan-logs [--self-test]  scan all logs for secrets, tokens, signed URLs, session cookies; non-zero on findings.
#                            --self-test plants every secret class into a scratch log and proves each is caught
#   claim-admin [--email E] [--password-file F]
#                            create the FIRST instance administrator (the owner types the password; RUNBOOK §6)
#   smoke <mode> [label]     API smoke inside the network — TEST STANDS ONLY (creates test accounts):
#                            bootstrap | verify | extend <label> | expect-missing-objects | measure-300 | probe |
#                            log-probe (credential-bearing URLs with planted values; then run scan-logs)
#   manage <args...>         python manage.py <args> in the API container      (pass-through: put --env-file first)
#   compose <args...>        raw docker compose with this deployment's project/env/files   (pass-through, same)
#   destroy --confirm-project NAME
#                            remove containers AND volumes — only drill/test stacks: explicit --env-file on a
#                            *.localhost domain, never the production project name, never a project whose running
#                            containers serve another domain, and only with the project name typed back
#
# Env file: --env-file, else $PPM_ENV_FILE, else <bundle>/.runtime/ppm.env; the choice is always printed.
set -euo pipefail

bundle_dir="$(cd "$(dirname "$0")" && pwd)"
PPM_SCRIPT_NAME=ppm-deploy
usage() { sed -n '2,44p' "$0"; }
fail() { echo "ppm-deploy: $*" >&2; exit 2; }

# ---- argument parsing -------------------------------------------------------------------------------------
command="" env_file_arg="" rest=()
while (($#)); do
  arg="$1"
  if [[ "$command" == compose || "$command" == manage ]]; then
    [[ "$arg" == --env-file || "$arg" == --env-file=* ]] \
      && fail "--env-file must come before '$command' (inside pass-through arguments it is ambiguous)"
    rest+=("$arg"); shift; continue
  fi
  case "$arg" in
    --env-file)
      [[ -z "$env_file_arg" ]] || fail "--env-file given twice"
      [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || fail "--env-file needs a path"
      env_file_arg="$2"; shift 2 ;;
    --env-file=*)
      [[ -z "$env_file_arg" ]] || fail "--env-file given twice"
      env_file_arg="${arg#--env-file=}"; [[ -n "$env_file_arg" ]] || fail "--env-file needs a path"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) if [[ -z "$command" ]]; then command="$arg"; else rest+=("$arg"); fi; shift ;;
  esac
done

KNOWN_SERVICES=" plane-db plane-redis plane-mq plane-minio minio-init proxy migrator api worker beat-worker live web admin space forgejo forgejo-db-init "
no_args() { ((${#rest[@]} == 0)) || fail "'$command' takes no arguments (got: ${rest[*]})"; }
confirm_project="" claim_email="" claim_password_file="" scan_self_test=0 no_workers=0 allow_git_site_loss=0
rotate_token=0 git_admin_username="" git_admin_email="" git_admin_reset=0
case "$command" in
  config|wait|preflight|restart|status|stop) no_args ;;
  up)
    if ((${#rest[@]} == 1)) && [[ "${rest[0]}" == --no-workers ]]; then no_workers=1; else no_args; fi ;;
  release)
    if ((${#rest[@]} == 2)) && [[ "${rest[1]}" == --allow-git-site-loss ]]; then allow_git_site_loss=1; rest=("${rest[0]}"); fi
    ((${#rest[@]} == 1)) || fail "release needs exactly one release name (and optionally --allow-git-site-loss)"
    [[ "${rest[0]}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "release name must be a Docker tag" ;;
  logs)
    for arg in ${rest[@]+"${rest[@]}"}; do
      [[ "$KNOWN_SERVICES" == *" $arg "* ]] || fail "logs: unknown service or option '$arg'"
    done ;;
  scan-logs)
    if ((${#rest[@]} == 1)) && [[ "${rest[0]}" == --self-test ]]; then scan_self_test=1; else no_args; fi ;;
  smoke)
    ((${#rest[@]} >= 1)) || fail "smoke needs a mode"
    case "${rest[0]}" in
      bootstrap|verify|expect-missing-objects|measure-300|probe|log-probe) ((${#rest[@]} == 1)) || fail "smoke ${rest[0]} takes no more arguments" ;;
      extend) ((${#rest[@]} == 2)) && [[ "${rest[1]}" =~ ^[A-Za-z0-9_-]{1,40}$ ]] || fail "smoke extend needs one label [A-Za-z0-9_-]" ;;
      *) fail "unknown smoke mode '${rest[0]}'" ;;
    esac ;;
  claim-admin)
    set -- ${rest[@]+"${rest[@]}"}
    while (($#)); do
      case "$1" in
        --email) [[ $# -ge 2 ]] || fail "--email needs a value"; claim_email="$2"; shift 2 ;;
        --password-file) [[ $# -ge 2 ]] || fail "--password-file needs a path"; claim_password_file="$2"; shift 2 ;;
        *) fail "claim-admin: unknown option '$1'" ;;
      esac
    done ;;
  destroy)
    set -- ${rest[@]+"${rest[@]}"}
    while (($#)); do
      case "$1" in
        --confirm-project) [[ $# -ge 2 ]] || fail "--confirm-project needs the project name"; confirm_project="$2"; shift 2 ;;
        *) fail "destroy: unknown option '$1' (did you mean --confirm-project NAME?)" ;;
      esac
    done ;;
  git-bootstrap)
    for arg in ${rest[@]+"${rest[@]}"}; do
      [[ "$arg" == --rotate-token ]] || fail "git-bootstrap: unknown option '$arg' (only --rotate-token)"
      rotate_token=1
    done ;;
  git-admin)
    set -- ${rest[@]+"${rest[@]}"}
    while (($#)); do
      case "$1" in
        --username) [[ $# -ge 2 ]] || fail "--username needs a value"; git_admin_username="$2"; shift 2 ;;
        --email) [[ $# -ge 2 ]] || fail "--email needs a value"; git_admin_email="$2"; shift 2 ;;
        --reset-password) git_admin_reset=1; shift ;;
        *) fail "git-admin: unknown option '$1'" ;;
      esac
    done
    [[ -n "$git_admin_username" && -n "$git_admin_email" ]] || fail "git-admin needs --username <name> and --email <e-mail>"
    [[ "$git_admin_username" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$ ]] \
      || fail "git-admin: '$git_admin_username' is not a valid Forgejo user name (letters, digits, . _ -; up to 39)"
    [[ "$(printf '%s' "$git_admin_username" | tr '[:upper:]' '[:lower:]')" != ppm-bot ]] \
      || fail "git-admin: ppm-bot is reserved for the PPM service account"
    [[ "$git_admin_email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] \
      || fail "git-admin: '$git_admin_email' is not an e-mail address" ;;
  compose|manage) ;;
  "") usage; exit 2 ;;
  *) fail "unknown command '$command' (see --help)" ;;
esac

# shellcheck source=ppm-lib.sh
source "$bundle_dir/ppm-lib.sh"
ppm_resolve_env_file "$env_file_arg"
[[ "$command" == destroy && "$env_file_source" != "--env-file" ]] \
  && fail "destroy never uses a default env file: pass --env-file explicitly"
ppm_init_context
# A restore-drill copy stays without background jobs across up/restart/release (marker written by up --no-workers);
# its Git server stays isolated (ppm_git_drill_exports: no egress, no migrations).
[[ -f "$state_dir/no-workers" ]] && no_workers=1
((no_workers)) && ppm_git_drill_exports

HEALTHY_SERVICES=(plane-db plane-redis plane-mq plane-minio proxy api worker beat-worker live web admin space)
ONESHOT_SERVICES=(minio-init migrator)
if ((git_enabled)); then HEALTHY_SERVICES+=(forgejo); ONESHOT_SERVICES+=(forgejo-db-init); fi
SECRET_KEYS=(SECRET_KEY LIVE_SERVER_SECRET_KEY POSTGRES_PASSWORD RABBITMQ_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY
  PPM_GITHUB_APP_CLIENT_SECRET PPM_GITHUB_APP_PRIVATE_KEY PPM_GITHUB_WEBHOOK_SECRET
  FORGEJO_DB_PASSWORD FORGEJO_SECRET_KEY FORGEJO_INTERNAL_TOKEN FORGEJO_JWT_SECRET FORGEJO_LFS_JWT_SECRET
  PPM_FORGEJO_WEBHOOK_SECRET PPM_FORGEJO_TOKEN)

check_images() {
  local repo release image missing=0
  repo="$(env_get PPM_IMAGE_REPO)"; release="${1:-$(env_get PPM_RELEASE)}"
  for image in "$repo/api:$release" "$repo/web:$release" "$repo/admin:$release" "$repo/space:$release" \
    "$repo/live:$release" "$repo/proxy:$release" "$repo/tools:$release" "$(env_get PPM_MINIO_IMAGE)"; do
    docker image inspect "$image" >/dev/null 2>&1 || { echo "missing image: $image" >&2; missing=1; }
  done
  ((missing == 0)) || die "build the release first: ppm-build.sh --rev <commit> --release $release"
  # The Git server image is not built: it is pulled by its pinned digest (the same on codeberg.org and on the mirror
  # data.forgejo.org — change the host in PPM_FORGEJO_IMAGE if one of them is unreachable).
  if ((git_enabled)); then
    image="$(env_get PPM_FORGEJO_IMAGE)"
    docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image" >/dev/null \
      || die "cannot pull the Git server image $image (network, or switch PPM_FORGEJO_IMAGE to data.forgejo.org/forgejo/forgejo with the same digest)"
  fi
}

cmd_config() {
  "$bundle_dir/ppm-env.sh" check "$env_file"
  dc config --quiet
  echo "ppm-deploy: Compose configuration is valid for project $project."
}

cmd_wait() {
  local deadline=$((SECONDS + ${PPM_WAIT_TIMEOUT:-900})) service id state pending
  while :; do
    pending=()
    for service in "${ONESHOT_SERVICES[@]}"; do
      id="$(dc ps -a -q "$service" 2>/dev/null | head -n1)"
      [[ -n "$id" ]] || { pending+=("$service:absent"); continue; }
      state="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$id")"
      case "$state" in
        "exited 0") ;;
        exited*) die "$service failed ($state); see: ppm-deploy.sh logs $service" ;;
        *) pending+=("$service:$state") ;;
      esac
    done
    for service in "${HEALTHY_SERVICES[@]}"; do
      ((no_workers)) && [[ "$service" == worker || "$service" == beat-worker ]] && continue
      id="$(dc ps -q "$service" 2>/dev/null | head -n1)"
      [[ -n "$id" ]] || { pending+=("$service:absent"); continue; }
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")"
      [[ "$state" == "healthy" ]] || pending+=("$service:$state")
    done
    ((${#pending[@]} == 0)) && { echo "ppm-deploy: all services healthy."; return 0; }
    ((SECONDS > deadline)) && die "timeout waiting for: ${pending[*]}"
    sleep 5
  done
}

dc_up() {
  if ((no_workers)); then
    : >"$state_dir/no-workers"
    dc up -d --remove-orphans --scale worker=0 --scale beat-worker=0
    note "worker and beat-worker are OFF for this project (restore-drill copy): no background jobs, e-mails or webhooks"
  else
    dc up -d --remove-orphans
  fi
}

cmd_preflight() {
  dc exec -T api python manage.py ppm_backend_preflight --verify-storage-write
  if ((git_enabled)); then git_preflight; fi
}

# Git server, seen from the API container: Forgejo's health endpoint at the in-network address PPM uses
# (PPM_FORGEJO_URL) and at the public HTTPS address through the proxy (Caddy site, certificate, network alias), and
# whether PPM's read-only token signs in as ppm-bot. No value is printed. A proxy image without the Git site (a
# release before RC.2, switched to with --allow-git-site-loss) is reported, not failed: that loss was accepted.
git_preflight() {
  local site=1
  dc exec -T proxy test -f /etc/caddy/git-server-1.caddy >/dev/null 2>&1 || site=0
  dc exec -T -e "PPM_GIT_SITE=$site" api python - <<'PY'
import json, os, ssl, sys, urllib.request

checks = {}
context = ssl.create_default_context()
if os.environ.get("AWS_CA_BUNDLE"):  # private phase / drills: Caddy's internal CA (docker-compose.internal-tls.yml)
    context.load_verify_locations(os.environ["AWS_CA_BUNDLE"])

def get(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=10, context=context) as response:
        return response.status, response.read()

for name, base in (("git_internal", os.environ.get("PPM_FORGEJO_URL", "")),
                   ("git_public", os.environ.get("PPM_FORGEJO_PUBLIC_URL", ""))):
    if name == "git_public" and os.environ.get("PPM_GIT_SITE") == "0":
        checks[name] = "absent: this release's proxy has no Git site (HTTPS to the Git server is off, SSH works)"
        continue
    try:
        status, body = get(base.rstrip("/") + "/api/healthz")
        checks[name] = "ok" if status == 200 and json.loads(body).get("status") == "pass" else "fail"
    except Exception as error:  # noqa: BLE001 - reported as a check result
        checks[name] = f"fail ({error.__class__.__name__})"
token = os.environ.get("PPM_FORGEJO_TOKEN", "")
if not token:
    checks["git_token"] = "missing (run git-bootstrap)"
else:
    try:
        status, body = get(os.environ["PPM_FORGEJO_URL"].rstrip("/") + "/api/v1/user",
                           {"Authorization": f"token {token}"})
        checks["git_token"] = "ok" if json.loads(body).get("login") == "ppm-bot" else "fail (not ppm-bot)"
    except Exception as error:  # noqa: BLE001
        checks["git_token"] = f"fail ({error.__class__.__name__})"
failed = any(value.startswith("fail") for value in checks.values())
print(json.dumps({"checks": checks, "status": "fail" if failed else "ok"}, sort_keys=True))
sys.exit(1 if failed else 0)
PY
}

cmd_up() {
  "$bundle_dir/ppm-env.sh" check "$env_file" >/dev/null || die "env file is invalid: ppm-env.sh check $env_file"
  check_images
  dc_up
  cmd_wait
  cmd_preflight
  echo "ppm-deploy: $project is up at $(env_get PPM_PUBLIC_URL) (release $(env_get PPM_RELEASE), $([[ "$(env_get PPM_BIND_ADDRESS)" == 127.0.0.1 ]] && echo "PRIVATE: ports on 127.0.0.1 only" || echo "public"))."
  if ((git_enabled)); then
    echo "ppm-deploy: Git server at $(env_get PPM_GIT_PUBLIC_URL)$([[ "$(env_get PPM_GIT_SSH_ENABLED)" == 1 ]] && echo ", git over SSH on port $(env_get PPM_GIT_SSH_PORT)")."
    [[ -n "$(env_get PPM_FORGEJO_TOKEN)" ]] \
      || echo "ppm-deploy: next for the Git server: ./ppm-deploy.sh --env-file $env_file git-bootstrap (RUNBOOK §17.3)"
  fi
}

# Does the proxy image carry the Git server site? (proxy images before RC.2 do not.)
proxy_has_git_site() { # image
  docker run --rm --network none --entrypoint sh "$1" -c 'test -f /etc/caddy/git-server-1.caddy' >/dev/null 2>&1
}

cmd_release() {
  local target="$1" current
  current="$(env_get PPM_RELEASE)"
  check_images "$target"
  if ((git_enabled)) && ! proxy_has_git_site "$(env_get PPM_IMAGE_REPO)/proxy:$target"; then
    if ((allow_git_site_loss)); then
      note "ВНИМАНИЕ: в прокси релиза $target нет сайта Git-сервера — $(env_get PPM_GIT_PUBLIC_URL) не будет открываться (веб-интерфейс Forgejo и git по HTTPS), пока не вернётесь на релиз с ним; git по SSH и данные Forgejo не затронуты (принято --allow-git-site-loss)"
    else
      die "отказ: в прокси релиза $target нет сайта Git-сервера. После переключения $(env_get PPM_GIT_PUBLIC_URL) перестанет открываться — веб-интерфейс Forgejo и git по HTTPS (git по SSH и данные Forgejo останутся). Если это осознанный откат, повторите: release $target --allow-git-site-loss; сайт вернётся с релизом, где он есть (RUNBOOK §12). Ничего не изменено."
    fi
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $project $current -> $target" >>"$state_dir/releases.log"
  "$bundle_dir/ppm-env.sh" set "$env_file" PPM_RELEASE "$target" >/dev/null
  echo "ppm-deploy: switching $project from $current to $target (no data or schema is removed)."
  cmd_up
}

redact_stream() {
  # Replace every configured secret value with <redacted:KEY> (literal match). awk reads the env file itself,
  # so the values never appear on a command line; presigned-URL signatures are masked as well.
  awk -v keys="${SECRET_KEYS[*]}" '
    BEGIN { n = split(keys, list, " "); for (i = 1; i <= n; i++) wanted[list[i]] = 1 }
    FNR == NR {
      p = index($0, "=")
      if (p > 1) { k = substr($0, 1, p - 1); v = substr($0, p + 1)
        if ((k in wanted) && length(v) >= 8) { count++; value[count] = v; name[count] = k } }
      next
    }
    {
      line = $0
      for (i = 1; i <= count; i++) {
        out = ""
        while ((j = index(line, value[i])) > 0) {
          out = out substr(line, 1, j - 1) "<redacted:" name[i] ">"; line = substr(line, j + length(value[i]))
        }
        line = out line
      }
      gsub(/X-Amz-Signature=[0-9a-f]+/, "X-Amz-Signature=<redacted>", line)
      print line
    }' "$env_file" -
}

smoke_run() { # [docker compose run options...] -- smoke args...
  local opts=() ca="$PPM_SMOKE_DIR/internal-ca.crt"
  while (($#)) && [[ "$1" != "--" ]]; do opts+=("$1"); shift; done
  shift
  if [[ -z "$(dc ps -q worker 2>/dev/null)" ]]; then
    opts+=(-e PPM_SMOKE_NO_WORKERS=1)  # restore-drill copy without background jobs: no reindex check
  fi
  if [[ "$(env_get PPM_TLS)" == "internal" ]]; then
    # Caddy keeps its CA private (0600, root) in its volume; the smoke gets a copy of the public root certificate.
    dc exec -T proxy cat /data/caddy/pki/authorities/local/root.crt >"$ca"
    opts+=(-e PPM_SMOKE_CA_BUNDLE=/state/internal-ca.crt)
  fi
  dc run --rm ${opts[@]+"${opts[@]}"} smoke "$@"
}

cmd_smoke() {
  if [[ "$1" != "bootstrap" ]]; then smoke_run -T -- "$@"; return; fi
  smoke_run -T -- bootstrap-account
  local email
  email="$(sed -n 's/^  "email": "\([^"]*\)",*$/\1/p' "$PPM_SMOKE_DIR/smoke-state.json" | head -n1)"
  [[ -n "$email" ]] || die "smoke state has no test account"
  dc exec -T api python manage.py ppm_global_admin grant --email "$email" \
    --reason "RC smoke test account on a test instance" --bootstrap
  smoke_run -T -- bootstrap-data
}

cmd_claim_admin() {
  local opts=() args=()
  [[ -n "$claim_email" ]] && args+=(--email "$claim_email")
  if [[ -n "$claim_password_file" ]]; then
    [[ -f "$claim_password_file" ]] || die "password file $claim_password_file does not exist"
    opts+=(-T -v "$(abs_path "$claim_password_file"):/run/ppm-admin-password:ro")
    args+=(--password-file /run/ppm-admin-password)
  elif [[ ! -t 0 ]]; then
    die "claim-admin asks for the password interactively: run it in a terminal (the owner types it)"
  fi
  dc run --rm ${opts[@]+"${opts[@]}"} --entrypoint python smoke /smoke/claim_admin.py ${args[@]+"${args[@]}"}
}

cmd_destroy() {
  # Who owns the project decides, not only the env file at hand: production data is never deleted by this script.
  local domain served_by served; domain="$(env_get PPM_DOMAIN)"
  ppm_valid_project_name "$project" \
    || die "refusing: PPM_PROJECT of this env file is not a valid Compose project name; nothing deleted"
  ! ppm_is_production_project "$project" \
    || die "refusing: this env file names the production project — destroy never removes it"
  [[ "$domain" == *.localhost ]] \
    || die "refusing: this env file serves $domain — destroy only removes drill/test stacks on *.localhost"
  served_by="$(ppm_project_domains "$project" | tr '\n' ' ')"
  for served in $served_by; do
    [[ "$served" == "$domain" ]] \
      || die "refusing: containers of this project serve $served, not $domain — it is not the stack of this env file"
  done
  if [[ -z "$confirm_project" ]]; then
    [[ -t 0 ]] || die "destroy needs --confirm-project <project name of this env file> (typed back)"
    read -r -p "Delete ALL data (containers and volumes) of the drill project '$project' ($domain)? Type its name: " confirm_project
  fi
  [[ "$confirm_project" == "$project" ]] \
    || die "the typed name does not match the project of this env file (ppm-env.sh get <env> PPM_PROJECT); nothing deleted"
  dc --profile tools down -v --remove-orphans
  rm -f -- "$state_dir/no-workers"
  echo "ppm-deploy: project $project removed (containers and volumes)."
}

cmd_logs() {
  dc logs --no-color --tail="${PPM_LOG_TAIL:-300}" "$@" | redact_stream
}

collect_logs() { # $1 = output file; all services incl. finished one-shots + application log files
  local out="$1" service id
  : >"$out"; chmod 600 "$out"
  dc logs --no-color --timestamps >>"$out" 2>&1 || true
  for service in api worker beat-worker; do
    id="$(dc ps -q "$service" 2>/dev/null | head -n1)"
    [[ -n "$id" ]] || continue
    docker exec "$id" sh -c 'for f in /code/plane/logs/*.log*; do [ -f "$f" ] && { echo "== file $f"; cat "$f"; }; done' \
      2>/dev/null | sed "s/^/$service-file | /" >>"$out" || true
  done
}

# Patterns match real values only: masked forms (Celery amqp://user:**@, Caddy …=REDACTED) do not count.
SCAN_PATTERNS=(
  'presigned-signature|X-Amz-Signature=[0-9a-f]{16,}'
  'presigned-credential|X-Amz-Credential=[A-Za-z0-9]+(%2F|/)[0-9]{8}'
  's3v2-signature|AWSAccessKeyId=[A-Za-z0-9]'
  'plane-api-token|plane_api_[0-9a-f]{16,}'
  'x-api-key-header|[Xx]-[Aa]pi-[Kk]ey"?[]:= ["]+[A-Za-z0-9_-]{12,}'
  'authorization-header|[Aa]uthorization"?[]:= ["]+(Bearer|Basic|[Tt]oken) +[A-Za-z0-9._~+/=-]{8,}'
  'set-cookie-header|[Ss]et-[Cc]ookie"?[]:= ["]+[A-Za-z0-9_-]+=[^;" ]{8,}'
  'private-key|-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'github-token|(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})'
  'openai-style-key|sk-[A-Za-z0-9]{20,}'
  'jwt|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  'session-cookie|session-id=[a-z0-9]{16,}'
  'csrf-cookie|csrftoken=[A-Za-z0-9]{16,}'
  'token-query-param|[?&](token|uidb64|access_token|refresh_token|api_key|password|secret)=[^&"#[:space:]]{6,}'
  'oauth-callback-param|callback/?[^"[:space:]]*[?&](code|state)=[^&"#[:space:]]{6,}'
  'reset-password-path|/reset-password/[A-Za-z0-9_-]{2,}/[A-Za-z0-9_-]{8,}'
  'password-json|"password" *: *"[^"]+"'
  'amqp-url-with-password|amqp://[^:[:space:]]+:[^@*[:space:]][^@[:space:]]*@'
  'postgres-url-with-password|postgres(ql)?://[^:[:space:]]+:[^@*[:space:]][^@[:space:]]*@'
  # git over HTTPS with credentials in the URL (git clone https://user:token@git.<domain>/…), any webhook URL alike.
  'http-url-with-credentials|https?://[^/:@[:space:]"]+:[^@*/[:space:]"][^@/[:space:]"]*@'
  # Forgejo 15 names its session cookie `session` (16 hex); PPM's is session-id (above).
  'forgejo-session-cookie|(^|[^A-Za-z0-9_-])session=[0-9a-f]{16}'
)

scan_file() { # $1 = log file; prints counts, returns 1 when anything sensitive is found
  local out="$1" key value count findings=0 entry name regex scrubbed
  local tmp; tmp="$(mktemp "$state_dir/.scan.XXXXXX")"; chmod 600 "$tmp"
  for key in "${SECRET_KEYS[@]}"; do
    value="$(env_get "$key")"; ((${#value} >= 8)) || continue
    printf '%s\n' "$value" >"$tmp"
    count="$(grep -c -F -f "$tmp" "$out" || true)"
    printf '  %-34s %s\n' "secret:$key" "$count"; ((count == 0)) || findings=1
  done
  # Test-only values the smoke recorded (test password, session/CSRF cookies it received, log-probe tokens).
  if [[ -s "$PPM_SMOKE_DIR/sensitive-values.txt" ]]; then
    count="$(grep -c -F -f "$PPM_SMOKE_DIR/sensitive-values.txt" "$out" || true)"
    printf '  %-34s %s\n' "smoke:recorded-test-values" "$count"; ((count == 0)) || findings=1
  fi
  # The one-time password of the Forgejo administrator (git-admin), while its file exists.
  if [[ -s "$state_dir/forgejo-admin-credentials.txt" ]]; then
    sed -n 's/^password=//p' "$state_dir/forgejo-admin-credentials.txt" >"$tmp"
    if [[ -s "$tmp" ]]; then
      count="$(grep -c -F -f "$tmp" "$out" || true)"
      printf '  %-34s %s\n' "git:admin-one-time-password" "$count"; ((count == 0)) || findings=1
    fi
  fi
  rm -f "$tmp"
  scrubbed="$(mktemp "$state_dir/.scan.XXXXXX")"; chmod 600 "$scrubbed"
  sed -E 's/=REDACTED//g; s#/REDACTED##g' "$out" >"$scrubbed"
  for entry in "${SCAN_PATTERNS[@]}"; do
    name="${entry%%|*}"; regex="${entry#*|}"
    count="$(grep -c -E -- "$regex" "$scrubbed" || true)"
    printf '  %-34s %s\n' "pattern:$name" "$count"; ((count == 0)) || findings=1
  done
  rm -f "$scrubbed"
  return "$findings"
}

cmd_scan_self_test() {
  # Plant one real-looking value of every class (plus the real env secrets) and require each to be caught;
  # then require zero findings on the redacted forms Caddy/Celery produce. Nothing is printed but counts.
  local planted redacted key value missed=0 name regex entry
  planted="$(mktemp "$state_dir/.selftest.XXXXXX")"; redacted="$(mktemp "$state_dir/.selftest.XXXXXX")"
  chmod 600 "$planted" "$redacted"
  {
    for key in "${SECRET_KEYS[@]}"; do value="$(env_get "$key")"; ((${#value} >= 8)) && echo "leak $key=$value"; done
    # The Forgejo administrator's one-time password, while its file exists (git-admin).
    if [[ -s "$state_dir/forgejo-admin-credentials.txt" ]]; then
      sed -n 's/^password=/leak forgejo admin password /p' "$state_dir/forgejo-admin-credentials.txt"
    fi
    echo 'GET /uploads/x?X-Amz-Credential=ppmabc123%2F20260926%2Fus-east-1%2Fs3&X-Amz-Signature=0123456789abcdef0123'
    echo 'GET /old?AWSAccessKeyId=AKIAEXAMPLE&Signature=x'
    echo '"headers":{"X-Api-Key":["plane_api_0123456789abcdef0123456789abcdef"]}'
    echo '"headers":{"Authorization":["Bearer abcdefghijklmnopqrstuvwx"]}'
    echo '"resp_headers":{"Set-Cookie":["session-id=abcdefghijklmnopqrstuvwx; Path=/; Secure"]}'
    echo '-----BEGIN RSA PRIVATE KEY-----'
    echo 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    echo 'key sk-abcdefghijklmnopqrstuvwxyz0123'
    echo 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrst'
    echo 'Cookie: session-id=0123456789abcdefghij; csrftoken=ABCDEFGHIJKLMNOPQRSTUV'
    echo 'GET /accounts/reset-password?uidb64=MTIzNDU2&token=c0ffee-0123456789abcdef'
    echo 'GET /auth/github/callback/?code=abcdef0123456789&state=0123456789abcdef'
    echo 'POST /auth/reset-password/MTIzNDU2/c0ffee-0123456789abcdef/'
    echo '{"password": "Plain-Text-Password"}'
    echo 'broker amqp://plane:realpassword@plane-mq:5672/plane'
    echo 'db postgresql://plane:realpassword@plane-db:5432/plane'
    echo 'git push https://developer:0123456789abcdef0123456789abcdef01234567@git.example.test/team/app.git'
    echo 'Cookie: session=0123456789abcdef; lang=ru-RU'
  } >"$planted"
  {
    echo 'GET /uploads/x?X-Amz-Credential=REDACTED&X-Amz-Signature=REDACTED&X-Amz-Expires=300'
    echo 'GET /auth/github/callback/?code=REDACTED&state=REDACTED'
    echo 'GET /accounts/reset-password?uidb64=REDACTED&token=REDACTED'
    echo 'POST /auth/reset-password/REDACTED'
    echo '"headers":{"User-Agent":["curl/8"]}'
    echo 'transport: amqp://plane:**@plane-mq:5672/plane'
    echo 'GET /api/workspaces/w/projects/p/issues/?state=0f9e8d7c-1111-2222-3333-444455556666'
    echo '"uri":"/team/app.git/info/refs?REDACTED","host":"git.example.test:8443"'
    echo 'clone ssh://git@git.example.test:2222/team/app.git or https://git.example.test:8443/team/app.git'
    echo 'webhook http://api:8000/api/ppm/v1/git/forgejo/webhook/ delivered: 404'
  } >"$redacted"
  echo "ppm-deploy: self-test — planted values (every row must be > 0):"
  local report; report="$(scan_file "$planted" || true)"
  printf '%s\n' "$report"
  while read -r name count; do
    [[ -n "$name" ]] || continue
    [[ "$name" == smoke:* ]] && continue
    ((count > 0)) || { echo "ppm-deploy: self-test MISSED $name" >&2; missed=1; }
  done < <(printf '%s\n' "$report" | awk '{print $1, $2}')
  echo "ppm-deploy: self-test — redacted forms (every row must be 0):"
  if scan_file "$redacted"; then echo "  no false positives"; else echo "ppm-deploy: self-test flagged a redacted form" >&2; missed=1; fi
  rm -f "$planted" "$redacted"
  ((missed == 0)) || die "scan-logs self-test FAILED"
  echo "ppm-deploy: scan-logs self-test passed (${#SECRET_KEYS[@]} secret keys + ${#SCAN_PATTERNS[@]} patterns)."
}

cmd_scan_logs() {
  local out="$state_dir/scan-logs.txt"
  collect_logs "$out"
  echo "ppm-deploy: scanning $(wc -l <"$out" | tr -d ' ') log lines of project $project (values are never printed)"
  local result=0
  scan_file "$out" || result=1
  if [[ "${PPM_KEEP_SCAN:-0}" != 1 ]]; then rm -f "$out"; fi
  if ((result)); then echo "ppm-deploy: scan-logs FOUND sensitive values (counts above)"; return 1; fi
  echo "ppm-deploy: scan-logs clean."
}

# ---- Git server (Forgejo) -----------------------------------------------------------------------------------
#
# No password or token ever appears on a command line — neither on the host nor inside a container (every process's
# arguments are visible in /proc to the host). Secrets travel only through pipes (stdin/stdout) and the env file.

git_require() {
  ((git_enabled)) || die "the Git server is off in $env_file (PPM_GIT_SERVER_ENABLED is not 1; an RC.1 env: ppm-env.sh add-git $env_file, then up)"
}

# Fails at once (instead of waiting for health) when the Forgejo container does not exist.
forgejo_require_running() {
  [[ -n "$(dc ps -q forgejo 2>/dev/null | head -n1)" ]] \
    || die "Forgejo is not running in project $project: start the stack first — ./ppm-deploy.sh --env-file $env_file up"
  wait_healthy forgejo
}

# A bash script run inside the Forgejo container (uid 1000, its CLI and app.ini): only the script's own stdout
# comes back; what the Forgejo CLI prints stays inside the script or goes to stderr.
forgejo_script() { # script args...
  local script="$1"; shift
  dc exec -T forgejo bash -c "$script" forgejo-script "$@"
}

# The temporary credential of ppm-bot for the API steps: a token with the scopes write:admin and read:user from
# Forgejo's CLI (the account is created first when missing, with Forgejo's own random password that the script
# drops). Prints the token only. forgejo/git_bootstrap.py revokes it before it exits (or `cleanup` after a failure).
# shellcheck disable=SC2016  # expanded inside the container
FORGEJO_BOOT_SCRIPT='set -euo pipefail
email="$1" name="$2"
if ! out="$(forgejo admin user create --username ppm-bot --email "$email" --admin --random-password \
    --random-password-length 40 --must-change-password=false --fullname "PPM service account" 2>&1)"; then
  case "$out" in
    *"user already exists"*) ;;
    *) printf "%s\n" "$out" | grep -v "generated random password" >&2; exit 1 ;;
  esac
fi
out=""
forgejo admin user generate-access-token --username ppm-bot --token-name "$name" --scopes "write:admin,read:user" --raw'

# The owner's administrator: Forgejo generates the password itself (--random-password), the script prints it.
# shellcheck disable=SC2016  # expanded inside the container
FORGEJO_ADMIN_SCRIPT='set -euo pipefail
user="$1" email="$2"
if out="$(forgejo admin user create --username "$user" --email "$email" --admin --random-password \
    --random-password-length 20 --must-change-password=true 2>&1)"; then
  pw="$(printf "%s\n" "$out" | sed -n "s/^generated random password is '"'"'\(.*\)'"'"'\$/\1/p")"
  [ -n "$pw" ] || { echo "the Forgejo CLI did not report the generated password" >&2; exit 1; }
  printf "%s\n" "$pw"; exit 0
fi
case "$out" in
  *"user already exists"*) exit 3 ;;
  *) printf "%s\n" "$out" | grep -v "generated random password" >&2; exit 1 ;;
esac'

git_boot_token="" # the temporary token while a Git server command runs (revoked by the EXIT trap on failure)
git_boot_begin() {
  local out
  out="$(forgejo_script "$FORGEJO_BOOT_SCRIPT" "ppm-bot@noreply.$(env_get PPM_GIT_DOMAIN)" \
    "ppm-bootstrap-$(date -u +%Y%m%dT%H%M%SZ)-$$")" || die "could not prepare the service account ppm-bot or its temporary token (see: ppm-deploy.sh logs forgejo); nothing was changed"
  git_boot_token="$(printf '%s\n' "$out" | grep -E '^[0-9a-f]{40}$' | tail -n1)"
  out=""
  [[ -n "$git_boot_token" ]] || die "Forgejo returned no temporary token for ppm-bot; nothing was changed"
  trap git_boot_end EXIT
}
git_boot_end() { # revokes the temporary token if a step failed before the tool could revoke it
  [[ -n "$git_boot_token" ]] || return 0
  if printf '%s\n' "$git_boot_token" | dc run --rm -T forgejo-bootstrap cleanup >/dev/null; then
    note "temporary token of ppm-bot revoked after the failure"
  else
    note "WARNING: the temporary token of ppm-bot could not be revoked — run git-bootstrap again (it revokes every token but PPM's)"
  fi
  git_boot_token=""
}

cmd_git_bootstrap() {
  git_require
  "$bundle_dir/ppm-env.sh" check "$env_file" >/dev/null || die "env file is invalid: ppm-env.sh check $env_file"
  forgejo_require_running
  local out token args=() services=(api worker beat-worker) restarted=""
  ((rotate_token)) && args+=(--rotate-token)
  ((no_workers)) && services=(api)
  git_boot_begin
  # 1. Webhook, and a new read-only token when needed (the tool revokes nothing yet).
  out="$(printf '%s\n%s\n%s\n' "$git_boot_token" "$(env_get PPM_FORGEJO_TOKEN)" "$(env_get PPM_FORGEJO_WEBHOOK_SECRET)" \
    | dc run --rm -T forgejo-bootstrap prepare ${args[@]+"${args[@]}"})" \
    || die "git-bootstrap stopped (reason above): $env_file was not changed and PPM's current token still works"
  token="$(printf '%s\n' "$out" | sed -n 's/^token=//p')"
  out=""
  # 2. A new token is saved first (600) and put to work (only the services that read PPM_FORGEJO_*), and only
  #    then are the old ones revoked: at no moment does PPM hold a revoked token.
  if [[ -n "$token" ]]; then
    printf '%s\n' "$token" | "$bundle_dir/ppm-env.sh" set-secret "$env_file" PPM_FORGEJO_TOKEN >/dev/null \
      || die "Forgejo issued a new token but it could not be written to $env_file; the previous token still works — run git-bootstrap again"
    token=""
    note "new read-only token saved in $env_file (PPM_FORGEJO_TOKEN, mode 600): save the new copy of the file in the password manager"
    { dc up -d --no-deps "${services[@]}" && (cmd_wait) && git_preflight; } \
      || die "the new token is saved in $env_file, but ${services[*]} did not come up healthy with it (above); the previous tokens are still valid — fix it and run git-bootstrap again"
    restarted="${services[*]}"
  fi
  # 3. Every other token of ppm-bot (previous PPM tokens, the temporary one) is revoked; its password ends unknown.
  printf '%s\n%s\n' "$git_boot_token" "$(env_get PPM_FORGEJO_TOKEN)" | dc run --rm -T forgejo-bootstrap finish \
    || die "PPM works with the token in $env_file, but revoking the other tokens of ppm-bot failed (reason above) — run git-bootstrap again"
  git_boot_token=""
  if [[ -n "$restarted" ]]; then
    echo "ppm-deploy: Git server ready at $(env_get PPM_GIT_PUBLIC_URL); $restarted restarted with the new read-only token, the previous tokens revoked."
  else
    echo "ppm-deploy: Git server ready at $(env_get PPM_GIT_PUBLIC_URL); PPM_FORGEJO_TOKEN unchanged, nothing restarted."
  fi
}

cmd_git_admin() {
  git_require
  forgejo_require_running
  local creds="$state_dir/forgejo-admin-credentials.txt" password="" rc=0 action out
  if ((git_admin_reset)); then
    action="password reset"
    git_boot_begin
    out="$(printf '%s\n' "$git_boot_token" | dc run --rm -T forgejo-bootstrap reset-password "$git_admin_username")" || rc=$?
    password="$(printf '%s\n' "$out" | sed -n 's/^password=//p')"
    out=""
    # The tool revokes the temporary token after the reset; a failure there still leaves a valid new password.
    [[ -n "$password" ]] || die "could not reset the password of the Forgejo user $git_admin_username (reason above)"
    ((rc == 0)) && git_boot_token=""
  else
    action="created"
    password="$(forgejo_script "$FORGEJO_ADMIN_SCRIPT" "$git_admin_username" "$git_admin_email")" || rc=$?
    ((rc == 3)) && die "Forgejo user $git_admin_username already exists: a new one-time password — git-admin --username $git_admin_username --email $git_admin_email --reset-password"
    ((rc == 0)) && [[ -n "$password" ]] || die "could not create the Forgejo administrator $git_admin_username (see above)"
  fi
  (
    umask 077
    {
      echo "# Git server of PPM (Forgejo): administrator $action $(date -u +%Y-%m-%dT%H:%M:%SZ) by ppm-deploy.sh git-admin."
      echo "# ONE-TIME password: Forgejo asks for a new one at the first sign-in. Afterwards delete this file."
      echo "url=$(env_get PPM_GIT_PUBLIC_URL)/"
      echo "username=$git_admin_username"
      echo "email=$git_admin_email"
      echo "password=$password"
    } >"$creds.tmp"
  )
  chmod 600 "$creds.tmp" && mv -f "$creds.tmp" "$creds"
  password=""
  echo "ppm-deploy: Forgejo administrator $git_admin_username $action; the one-time password is in $creds (mode 600, not printed)."
  echo "ppm-deploy: sign in at $(env_get PPM_GIT_PUBLIC_URL)/ (from outside only after RUNBOOK §7), set your own password, then delete the file (RUNBOOK §17.4)."
  ((rc == 0)) || die "the password was set, but revoking the temporary token of ppm-bot failed (reason above) — run git-bootstrap"
}

case "$command" in
  config) cmd_config ;;
  up) cmd_up ;;
  git-bootstrap) cmd_git_bootstrap ;;
  git-admin) cmd_git_admin ;;
  wait) cmd_wait ;;
  preflight) cmd_preflight ;;
  smoke) cmd_smoke "${rest[@]}" ;;
  claim-admin) cmd_claim_admin ;;
  manage) dc exec -T api python manage.py ${rest[@]+"${rest[@]}"} ;;
  # Not `docker compose restart`: it bounces every container at once, so the one-shot minio-init races MinIO.
  # stop + up honours depends_on (healthy / completed) and re-runs the one-shots in order; data is kept.
  restart) dc stop; dc_up; cmd_wait; cmd_preflight ;;
  release) cmd_release "${rest[0]}" ;;
  status) dc ps -a ;;
  logs) cmd_logs ${rest[@]+"${rest[@]}"} ;;
  scan-logs) if ((scan_self_test)); then cmd_scan_self_test; else cmd_scan_logs; fi ;;
  stop) dc stop ;;
  destroy) cmd_destroy ;;
  compose) dc ${rest[@]+"${rest[@]}"} ;;
esac
