#!/usr/bin/env bash
# PPM deployment operations (one entry point for the runbook).
#
#   ppm-deploy.sh <command> [args] [--env-file FILE]     (--env-file may appear anywhere, once)
#
#   config                   validate ppm.env and the Compose files (no values printed)
#   up [--no-workers]        start or update the stack, wait until healthy, run preflight; --no-workers keeps
#                            worker/beat-worker off (restore-drill copies: no e-mails/webhooks from copied data) and
#                            is remembered for the project: later up/restart/release keep them off too (a drill
#                            copy's Git server also sends nothing out and runs no migrations). With sign-in through
#                            PPM off, PPM's OAuth2 client of the Git server is removed (ppm_oidc_client --disable)
#   wait                     wait until every service is healthy / one-shots finished
#   preflight                ppm_backend_preflight --verify-storage-write (DB, Redis, broker, S3 + I/O, realtime);
#                            with the Git server also Forgejo inside the network and through the proxy (HTTPS); with
#                            sign-in through PPM also its discovery, login source and admin token
#   git-bootstrap [--rotate-token]
#                            Git server (Forgejo), idempotent: service account ppm-bot (administrator; a random
#                            password that is never stored), PPM's read-only token (→ PPM_FORGEJO_TOKEN in the env
#                            file, 600; --rotate-token revokes the old one), system webhook to the PPM API; then
#                            restarts only api/worker/beat-worker when the token changed (RUNBOOK §17.3). With
#                            sign-in through PPM (RUNBOOK §17.14): PPM's OpenID Connect client, the login source
#                            «PPM» in Forgejo (Forgejo restarts only when it changed), its id and the admin token of
#                            ppm-bot (→ ppm.env; --rotate-token renews both tokens), then a first full sync of access
#   git-admin --username U --email E [--reset-password]
#                            Forgejo administrator for the owner: random one-time password (changed at the first
#                            sign-in), written only to .runtime/<project>/forgejo-admin-credentials.txt (600). With
#                            sign-in through PPM it is the emergency administrator: the Git server's password form is
#                            hidden until PPM_GIT_LOCAL_SIGNIN=1 + up (RUNBOOK §17.4, §17.14.6)
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
usage() { awk 'NR == 1 { next } /^#/ { print; next } { exit }' "$0"; }  # the comment block above
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

# HEALTHY_SERVICES / ONESHOT_SERVICES: set by ppm_init_context (ppm-lib.sh) — shared with ppm-monitor.sh.
SECRET_KEYS=(SECRET_KEY LIVE_SERVER_SECRET_KEY POSTGRES_PASSWORD RABBITMQ_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY
  PPM_GITHUB_APP_CLIENT_SECRET PPM_GITHUB_APP_PRIVATE_KEY PPM_GITHUB_WEBHOOK_SECRET
  FORGEJO_DB_PASSWORD FORGEJO_SECRET_KEY FORGEJO_INTERNAL_TOKEN FORGEJO_JWT_SECRET FORGEJO_LFS_JWT_SECRET
  PPM_FORGEJO_WEBHOOK_SECRET PPM_FORGEJO_TOKEN PPM_ALERT_TELEGRAM_BOT_TOKEN PPM_ALERT_SMTP_PASSWORD
  PPM_OIDC_PRIVATE_KEY PPM_OIDC_PREVIOUS_PRIVATE_KEY PPM_OIDC_CLIENT_SECRET PPM_FORGEJO_ADMIN_TOKEN)

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
# With sign-in through PPM (the API has PPM_GIT_SSO_ENABLED=1) also: git_sso_discovery — the internal discovery
# Forgejo reads names the PUBLIC issuer (PPM address + /auth/oidc) and internal token endpoint; git_sso_hidden — the
# proxy answers 404 to it from outside; git_sso_source — Forgejo's login source «PPM» is there, active, with the id of
# ppm.env and the settings git-bootstrap gives it (checked here, in bash); git_admin_token — the admin token signs in
# as ppm-bot, an administrator, and reaches the admin API. "missing (run git-bootstrap)" is not a failure.
git_preflight() {
  local site=1 source_state=""
  dc exec -T proxy test -f /etc/caddy/git-server-1.caddy >/dev/null 2>&1 || site=0
  ((sso_enabled)) && source_state="$(sso_source_state)"
  dc exec -T -e "PPM_GIT_SITE=$site" -e "PPM_GIT_SSO_SOURCE=$source_state" api python - <<'PY'
import json, os, ssl, sys, urllib.error, urllib.request

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

if os.environ.get("PPM_GIT_SSO_ENABLED") == "1":  # sign-in through PPM (docker-compose.git-sso.yml)
    issuer = os.environ.get("WEB_URL", "").rstrip("/") + "/auth/oidc"
    internal = os.environ.get("PPM_OIDC_INTERNAL_URL", "http://api:8000").rstrip("/") + "/auth/oidc"
    try:
        status, body = get(internal + "/internal/.well-known/openid-configuration")
        document = json.loads(body)
        if document.get("issuer") != issuer:
            checks["git_sso_discovery"] = "fail (its issuer is not the public address of PPM + /auth/oidc)"
        elif not str(document.get("authorization_endpoint", "")).startswith(issuer + "/"):
            checks["git_sso_discovery"] = "fail (its authorization endpoint is not the public one)"
        elif not str(document.get("token_endpoint", "")).startswith(internal + "/"):
            checks["git_sso_discovery"] = "fail (its token endpoint is not the internal one)"
        else:
            checks["git_sso_discovery"] = "ok"
    except urllib.error.HTTPError as error:
        checks["git_sso_discovery"] = (f"fail (HTTP {error.code}: the API does not serve sign-in through PPM — "
                                       "manage ppm_oidc_client --status)")
    except Exception as error:  # noqa: BLE001
        checks["git_sso_discovery"] = f"fail ({error.__class__.__name__})"
    try:
        get(os.environ.get("WEB_URL", "").rstrip("/") + "/auth/oidc/internal/.well-known/openid-configuration")
        checks["git_sso_hidden"] = "fail (the proxy lets the internal discovery out)"
    except urllib.error.HTTPError as error:
        checks["git_sso_hidden"] = "ok" if error.code == 404 else f"fail (HTTP {error.code} instead of 404)"
    except Exception as error:  # noqa: BLE001
        checks["git_sso_hidden"] = f"fail ({error.__class__.__name__})"
    checks["git_sso_source"] = os.environ.get("PPM_GIT_SSO_SOURCE") or "fail (not checked)"
    admin = os.environ.get("PPM_FORGEJO_ADMIN_TOKEN", "")
    if not admin:
        checks["git_admin_token"] = "missing (run git-bootstrap)"
    else:
        base = os.environ.get("PPM_FORGEJO_URL", "").rstrip("/") + "/api/v1"
        try:
            status, body = get(base + "/user", {"Authorization": f"token {admin}"})
            me = json.loads(body)
            if me.get("login") != "ppm-bot":
                checks["git_admin_token"] = "fail (not ppm-bot)"
            elif not me.get("is_admin"):
                checks["git_admin_token"] = "fail (ppm-bot is not an administrator of the Git server)"
            else:
                get(base + "/admin/users?limit=1", {"Authorization": f"token {admin}"})
                checks["git_admin_token"] = "ok"
        except urllib.error.HTTPError as error:
            checks["git_admin_token"] = f"fail (HTTP {error.code}: run git-bootstrap --rotate-token)"
        except Exception as error:  # noqa: BLE001
            checks["git_admin_token"] = f"fail ({error.__class__.__name__})"
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
  # R26: sign-in through PPM off (switched off, or never set up) — PPM keeps no OAuth2 client for the Git server.
  ((sso_enabled)) || sso_disable_client
  cmd_preflight
  echo "ppm-deploy: $project is up at $(env_get PPM_PUBLIC_URL) (release $(env_get PPM_RELEASE), $([[ "$(env_get PPM_BIND_ADDRESS)" == 127.0.0.1 ]] && echo "PRIVATE: ports on 127.0.0.1 only" || echo "public"))."
  if ((git_enabled)); then
    echo "ppm-deploy: Git server at $(env_get PPM_GIT_PUBLIC_URL)$([[ "$(env_get PPM_GIT_SSH_ENABLED)" == 1 ]] && echo ", git over SSH on port $(env_get PPM_GIT_SSH_PORT)")$( ((sso_enabled)) && echo ", sign-in through PPM")."
    if [[ -z "$(env_get PPM_FORGEJO_TOKEN)" ]]; then
      echo "ppm-deploy: next for the Git server: ./ppm-deploy.sh --env-file $env_file git-bootstrap (RUNBOOK §17.3)"
    elif ((sso_enabled)) && [[ -z "$(env_get PPM_FORGEJO_ADMIN_TOKEN)" || -z "$(env_get PPM_FORGEJO_SSO_SOURCE_ID)" ]]; then
      echo "ppm-deploy: next for sign-in through PPM: ./ppm-deploy.sh --env-file $env_file git-bootstrap (RUNBOOK §17.14.2)"
    fi
    if ((sso_enabled)) && [[ "$(env_get PPM_GIT_LOCAL_SIGNIN)" == 1 ]]; then
      note "ВНИМАНИЕ: на Git-сервере включена форма входа по паролю (PPM_GIT_LOCAL_SIGNIN=1, аварийный вход). Когда закончите: ./ppm-env.sh set $env_file PPM_GIT_LOCAL_SIGNIN 0 и up (RUNBOOK §17.14.6)"
    fi
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
  # Sign-in through PPM: the one-time id of an anonymous sign-in, in the path (the proxy masks it as REDACTED).
  'oidc-continue-path|/auth/oidc/continue/[A-Za-z0-9_-]{16,}'
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
    echo 'GET /auth/oidc/continue/Q2xpZW50LXRva2VuLTAxMjM0NTY3ODkwYWJj/ 302'
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
    echo '"uri":"/auth/oidc/continue/REDACTED/","status":302'
    echo '"uri":"/auth/oidc/authorize/?REDACTED","status":302'
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
  trap git_on_exit EXIT
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

# One git-bootstrap or git-admin at a time per project: both issue and revoke ppm-bot's tokens (git-bootstrap's last
# step revokes every token it does not know) and git-bootstrap changes the login source «PPM». A lock whose process is
# gone (a killed run) is taken over. Released by the EXIT trap together with the temporary token.
git_lock_held=0
git_lock() {
  local lock="$state_dir/git-bootstrap.lock" pid
  if ! mkdir "$lock" 2>/dev/null; then
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      die "another git-bootstrap or git-admin of project $project is running (pid $pid): wait until it ends, then try again; nothing was changed"
    fi
    rm -rf -- "$lock"
    mkdir "$lock" 2>/dev/null || die "could not take the lock $lock (another run started just now?): try again; nothing was changed"
    note "the lock of an interrupted git-bootstrap/git-admin (pid ${pid:-unknown}) was taken over"
  fi
  echo "$$" >"$lock/pid"
  git_lock_held=1
  trap git_on_exit EXIT
}
git_on_exit() {
  git_boot_end
  if ((git_lock_held)); then rm -rf -- "$state_dir/git-bootstrap.lock"; git_lock_held=0; fi
}

cmd_git_bootstrap() {
  git_require
  "$bundle_dir/ppm-env.sh" check "$env_file" >/dev/null || die "env file is invalid: ppm-env.sh check $env_file"
  forgejo_require_running
  git_lock
  local out token admin_token args=() services=(api worker beat-worker) restarted="" saved=() source_id_changed=0
  local restart_services=0
  ((rotate_token)) && args+=(--rotate-token)
  ((no_workers)) && services=(api)
  # 0. Sign-in through PPM (RUNBOOK §17.14): PPM's OpenID Connect client, then Forgejo's login source «PPM» (Forgejo
  #    restarts only when it changed) and its id in the env file. Switched off: PPM's client is removed (R26).
  wait_healthy api
  sso_require_running_api
  if ((sso_enabled)); then
    args+=(--admin-token)
    sso_ensure_client
    sso_ensure_source
    # Also when an earlier run changed the source and was interrupted before this restart (the marker says so).
    if ((sso_source_changed)) || sso_restart_is_pending; then
      note "restarting the Git server: it reads its login sources only when it starts"
      dc restart forgejo >/dev/null \
        || die "the login source PPM is changed, but the Git server did not restart (see: ppm-deploy.sh logs forgejo); it keeps the previous settings until it does — ./ppm-deploy.sh --env-file $env_file compose restart forgejo, or run git-bootstrap again"
      wait_healthy forgejo
      rm -f -- "$SSO_RESTART_MARK"
    fi
    if [[ "$(env_get PPM_FORGEJO_SSO_SOURCE_ID)" != "$sso_source_id" ]]; then
      "$bundle_dir/ppm-env.sh" set "$env_file" PPM_FORGEJO_SSO_SOURCE_ID "$sso_source_id" >/dev/null \
        || die "could not write PPM_FORGEJO_SSO_SOURCE_ID to $env_file; run git-bootstrap again"
      source_id_changed=1
    fi
  else
    sso_disable_client
  fi
  git_boot_begin
  # 1. Webhook, and a new read-only token (and admin token) when needed (the tool revokes nothing yet).
  out="$(printf '%s\n%s\n%s\n%s\n' "$git_boot_token" "$(env_get PPM_FORGEJO_TOKEN)" "$(env_get PPM_FORGEJO_WEBHOOK_SECRET)" \
    "$( ((sso_enabled)) && env_get PPM_FORGEJO_ADMIN_TOKEN)" | dc run --rm -T forgejo-bootstrap prepare ${args[@]+"${args[@]}"})" \
    || die "git-bootstrap stopped (reason above): $env_file was not changed and PPM's current tokens still work"
  token="$(printf '%s\n' "$out" | sed -n 's/^token=//p')"
  admin_token="$(printf '%s\n' "$out" | sed -n 's/^admin_token=//p')"
  out=""
  # 2. New tokens are saved first (600) and put to work (only the services that read PPM_FORGEJO_*), and only then
  #    are the old ones revoked: at no moment does PPM hold a revoked token.
  if [[ -n "$token" ]]; then
    printf '%s\n' "$token" | "$bundle_dir/ppm-env.sh" set-secret "$env_file" PPM_FORGEJO_TOKEN >/dev/null \
      || die "Forgejo issued a new token but it could not be written to $env_file; the previous token still works — run git-bootstrap again"
    token=""
    saved+=("read-only token (PPM_FORGEJO_TOKEN)")
  fi
  if [[ -n "$admin_token" ]]; then
    printf '%s\n' "$admin_token" | "$bundle_dir/ppm-env.sh" set-secret "$env_file" PPM_FORGEJO_ADMIN_TOKEN >/dev/null \
      || die "Forgejo issued a new admin token but it could not be written to $env_file; the previous tokens still work — run git-bootstrap again"
    admin_token=""
    saved+=("admin token (PPM_FORGEJO_ADMIN_TOKEN)")
  fi
  if ((${#saved[@]})); then
    note "new ${saved[0]}$( ((${#saved[@]} > 1)) && echo " and ${saved[1]}") saved in $env_file (mode 600): save the new copy of the file in the password manager"
  fi
  ((${#saved[@]} || source_id_changed)) && restart_services=1
  if ((!restart_services)) && ! services_match_env "${services[@]}"; then
    note "${services[*]} run with other tokens or login source id than $env_file (an earlier run was interrupted, or the file changed without up): restarting them before anything is revoked"
    restart_services=1
  fi
  if ((restart_services)); then
    { dc up -d --no-deps "${services[@]}" && (cmd_wait) && git_preflight; } \
      || die "$env_file is updated, but ${services[*]} did not come up healthy with it (above); the previous tokens are still valid — fix it and run git-bootstrap again"
    restarted="${services[*]}"
  fi
  # 3. Every other token of ppm-bot (previous PPM tokens, the temporary one — and the admin token when sign-in through
  #    PPM is off) is revoked; its password ends unknown.
  printf '%s\n%s\n%s\n' "$git_boot_token" "$(env_get PPM_FORGEJO_TOKEN)" "$( ((sso_enabled)) && env_get PPM_FORGEJO_ADMIN_TOKEN)" \
    | dc run --rm -T forgejo-bootstrap finish \
    || die "PPM works with the tokens in $env_file, but revoking the other tokens of ppm-bot failed (reason above) — run git-bootstrap again"
  git_boot_token=""
  if ((!sso_enabled)) && [[ -n "$(env_get PPM_FORGEJO_ADMIN_TOKEN)" ]]; then
    if printf '\n' | "$bundle_dir/ppm-env.sh" set-secret "$env_file" PPM_FORGEJO_ADMIN_TOKEN >/dev/null; then
      note "sign-in through PPM is off: its admin token was revoked in the Git server and removed from $env_file"
    else
      note "WARNING: the admin token was revoked in the Git server, but could not be removed from $env_file"
    fi
  fi
  if [[ -n "$restarted" ]]; then
    echo "ppm-deploy: Git server ready at $(env_get PPM_GIT_PUBLIC_URL); $restarted restarted with the new settings, the previous tokens revoked."
  else
    echo "ppm-deploy: Git server ready at $(env_get PPM_GIT_PUBLIC_URL); tokens unchanged, PPM's services not restarted."
  fi
  # 4. Sign-in through PPM: the first full synchronization of accounts, organizations and teams (then every 10 min).
  ((sso_enabled)) && sso_first_sync
  return 0
}

# ---- Sign-in through PPM (single sign-on to the Git server, G2.2, RUNBOOK §17.14) ---------------------------------
#
# PPM is the OpenID Connect provider of one client, Forgejo, which signs people in through its login source named
# exactly «PPM» (the name is in the button «Войти через PPM», in Forgejo's callback URL and in the redirect URI PPM
# registers). The client secret never appears on a command line: Forgejo's CLI takes it only as an argument (visible
# to the host in /proc while it runs), so the CLI creates and changes the source WITHOUT it, and the secret is written
# into the source's configuration in Forgejo's database from psql's stdin (sso_source_write_secret).

SSO_DISCOVERY_URL=http://api:8000/auth/oidc/internal/.well-known/openid-configuration
# `--scopes` takes a comma-separated list; Forgejo stores it as four scopes (a space-separated string would be ONE).
SSO_SCOPES=openid,profile,email,groups
# A change of the login source reaches Forgejo's web process only with its restart. The marker holds the start time of
# the Forgejo container when the change was made: while that container has not restarted since, a restart is owed —
# also after a git-bootstrap that was interrupted in between (preflight reports it; the next git-bootstrap restarts).
SSO_RESTART_MARK="$state_dir/forgejo-restart-pending"

# Forgejo's CLI in its container (uid 1000, its app.ini). No secret passes through here.
#   version                       `forgejo --version`
#   list                          `forgejo admin auth list` (parsed on the host: sso_source_listed)
#   discovery <url>               the HTTP status Forgejo gets for PPM's discovery (000: unreachable)
#   add <client_id> <url> <scopes> creates the source (OpenID Connect, discovery, scopes, local 2FA skipped)
#   update <id> <flag>...         changes only the given flags
# shellcheck disable=SC2016  # expanded inside the container
FORGEJO_SSO_SCRIPT='set -euo pipefail
action="$1"; shift
case "$action" in
  version) forgejo --version ;;
  list) forgejo admin auth list ;;
  discovery) curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$1" 2>/dev/null || true ;;
  add) forgejo admin auth add-oauth --name PPM --provider openidConnect --key "$1" --auto-discover-url "$2" \
         --skip-local-2fa --scopes "$3" ;;
  update) id="$1"; shift; forgejo admin auth update-oauth --id "$id" "$@" ;;
  *) echo "unknown action $action" >&2; exit 2 ;;
esac'

# The running API must have been started from this env file as it is now (sign-in on or off, the same client
# secret): otherwise PPM and the Git server would end up with different secrets. The secret goes to the check on
# stdin and is compared inside the container; nothing is printed.
sso_require_running_api() {
  local rc=0
  # shellcheck disable=SC2016  # expanded inside the container
  printf '%s\n' "$(env_get PPM_OIDC_CLIENT_SECRET)" | dc exec -T api sh -c '
IFS= read -r secret || true
[ "${PPM_GIT_SSO_ENABLED:-0}" = "$1" ] || exit 3
[ "$1" != 1 ] || [ "$secret" = "${PPM_OIDC_CLIENT_SECRET:-}" ] || exit 4' sso-check "$sso_enabled" || rc=$?
  case "$rc" in
    0) ;;
    3) die "$env_file switches sign-in through PPM $( ((sso_enabled)) && echo on || echo off), but the running API was started with it $( ((sso_enabled)) && echo off || echo on): run ./ppm-deploy.sh --env-file $env_file up first, then git-bootstrap; nothing was changed" ;;
    4) die "the running API has another PPM_OIDC_CLIENT_SECRET than $env_file (changed without up?): run ./ppm-deploy.sh --env-file $env_file up first, then git-bootstrap; nothing was changed" ;;
    *) die "could not check the running API (exit $rc): is the stack up? ./ppm-deploy.sh --env-file $env_file up; nothing was changed" ;;
  esac
}

# The services that read PPM_FORGEJO_* must run with what the env file holds now: git-bootstrap writes new tokens and
# the login source id into the file first and they reach the services only with their restart — a run interrupted in
# between, or a file edited without up, leaves the services behind (and the next run would revoke a token they still
# use). The values go to each check on stdin and are compared inside the container; nothing is printed.
# shellcheck disable=SC2016  # expanded inside the container
SERVICE_ENV_CHECK_SCRIPT='for key in "$@"; do IFS= read -r want || want=""; [ "$want" = "$(printenv "$key" || true)" ] || exit 5; done'
services_match_env() { # service...
  local service key keys=(PPM_FORGEJO_TOKEN)
  ((sso_enabled)) && keys+=(PPM_FORGEJO_ADMIN_TOKEN PPM_FORGEJO_SSO_SOURCE_ID)
  for service in "$@"; do
    for key in "${keys[@]}"; do printf '%s\n' "$(env_get "$key")"; done \
      | dc exec -T "$service" sh -c "$SERVICE_ENV_CHECK_SCRIPT" env-check "${keys[@]}" >/dev/null 2>&1 || return 1
  done
}

forgejo_started_at() { docker inspect -f '{{.State.StartedAt}}' "$(dc ps -q forgejo 2>/dev/null | head -n1)" 2>/dev/null || true; }
sso_restart_pending_mark() { forgejo_started_at >"$SSO_RESTART_MARK"; }  # before every change of the source
sso_restart_is_pending() { # true while the Forgejo container has not restarted since the source changed
  [[ -s "$SSO_RESTART_MARK" ]] || return 1
  [[ "$(cat "$SSO_RESTART_MARK")" == "$(forgejo_started_at)" ]] && return 0
  rm -f -- "$SSO_RESTART_MARK"  # restarted since by other means (compose restart, up, a reboot)
  return 1
}

# git-bootstrap writes the client secret into the login source in Forgejo's database: a format verified on Forgejo
# 15.x. Another version is refused before anything of the sign-in changes.
sso_require_forgejo_15() {
  local version
  version="$(forgejo_script "$FORGEJO_SSO_SCRIPT" version 2>/dev/null | head -n 1)" || version=""
  [[ "$version" =~ version\ 15\.[0-9]+ ]] \
    || die "the Git server runs «${version:-an unknown version}», and git-bootstrap keeps sign-in through PPM only on Forgejo 15.x (it writes the client secret of the login source into Forgejo's database, a format verified on 15.x): go back to a 15.x digest (RUNBOOK §17.9) or have this version checked first; nothing was changed"
}

# PPM's OAuth2 client of the Git server, brought in line with the env (idempotent; prints no secret).
sso_ensure_client() {
  local out rc=0
  out="$(dc exec -T api python manage.py ppm_oidc_client --ensure 2>&1)" || rc=$?
  [[ -z "$out" ]] || printf '%s\n' "$out" | sed 's/^/git-bootstrap: PPM: /' >&2
  ((rc == 0)) \
    || die "PPM could not set up its OpenID Connect client for the Git server (reason above; ./ppm-deploy.sh --env-file $env_file manage ppm_oidc_client --status shows what is missing); nothing in the Git server was changed"
}

# R26: sign-in through PPM off — PPM's OAuth2 client of the Git server goes with its codes and tokens. A release
# without the command (before G2.2) has nothing to remove; any other failure is only reported: the sign-in endpoints
# answer 404 anyway while PPM_GIT_SSO_ENABLED is not 1.
sso_disable_client() {
  local out rc=0
  out="$(dc exec -T api python manage.py ppm_oidc_client --disable 2>&1)" || rc=$?
  if ((rc == 0)); then
    [[ -z "$out" ]] || note "sign-in through PPM is off: $(printf '%s\n' "$out" | tail -n 1)"
  elif [[ "$out" != *"Unknown command"* ]]; then
    note "WARNING: sign-in through PPM is off, but its OAuth2 client could not be removed (manage ppm_oidc_client --disable failed; the endpoints stay closed anyway) — run git-bootstrap later"
  fi
}

# "<id> <type> <active>" of the login source named exactly PPM, from `forgejo admin auth list` (a header line, then
# ID, Name, Type, Enabled separated by tabs); nothing when there is none.
sso_source_listed() {
  local out
  out="$(forgejo_script "$FORGEJO_SSO_SCRIPT" list)" || return 1
  printf '%s\n' "$out" | tr -d '\r' | awk -F '\t+' 'NR > 1 && $2 == "PPM" { print $1, $3, $4; exit }'
}

# The source's configuration as Forgejo stored it (JSON in login_source.cfg of its database), one key=value line per
# setting git-bootstrap keeps; the client secret only as its SHA-256 (compared, never shown).
sso_source_config() { # id
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  dc exec -T plane-db psql -X -U plane -d forgejo -tA -v ON_ERROR_STOP=1 -c "
select k || '=' || coalesce(v, '') from login_source s, lateral (values
  ('provider', s.cfg::jsonb ->> 'Provider'),
  ('client_id', s.cfg::jsonb ->> 'ClientID'),
  ('secret_sha256', encode(sha256(convert_to(coalesce(s.cfg::jsonb ->> 'ClientSecret', ''), 'UTF8')), 'hex')),
  ('discovery', s.cfg::jsonb ->> 'OpenIDConnectAutoDiscoveryURL'),
  ('scopes', (s.cfg::jsonb -> 'Scopes')::text),
  ('skip_local_2fa', coalesce(s.cfg::jsonb ->> 'SkipLocalTwoFA', 'false')),
  ('group_claim_name', s.cfg::jsonb ->> 'GroupClaimName'),
  ('admin_group', s.cfg::jsonb ->> 'AdminGroup'),
  ('restricted_group', s.cfg::jsonb ->> 'RestrictedGroup'),
  ('group_team_map', s.cfg::jsonb ->> 'GroupTeamMap'),
  ('group_team_map_removal', coalesce(s.cfg::jsonb ->> 'GroupTeamMapRemoval', 'false')),
  ('required_claim_name', s.cfg::jsonb ->> 'RequiredClaimName'),
  ('allow_username_change', coalesce(s.cfg::jsonb ->> 'AllowUsernameChange', 'false'))
) as f(k, v) where s.id = $1" | tr -d '\r'
}

# What differs from the settings git-bootstrap gives the source: sets `sso_drift` (names) and `sso_update_flags`
# (the update-oauth flags that fix them); the client secret and «skip local 2FA» (which update-oauth cannot change)
# set `sso_write_secret`.
sso_source_compare() { # id
  local config want_sha
  sso_drift=() sso_update_flags=() sso_write_secret=0
  config="$(sso_source_config "$1")" || return 1
  want_sha="$(printf '%s' "$(env_get PPM_OIDC_CLIENT_SECRET)" | sha256_file - | awk '{ print $1 }')"
  sso_setting() { printf '%s\n' "$config" | sed -n "s/^$1=//p" | head -n 1; }
  [[ "$(sso_setting provider)" == openidConnect ]] || { sso_drift+=(provider); sso_update_flags+=(--provider openidConnect); }
  [[ "$(sso_setting client_id)" == "$(env_get PPM_OIDC_CLIENT_ID)" ]] \
    || { sso_drift+=(client_id); sso_update_flags+=(--key "$(env_get PPM_OIDC_CLIENT_ID)"); }
  [[ "$(sso_setting discovery)" == "$SSO_DISCOVERY_URL" ]] \
    || { sso_drift+=(discovery); sso_update_flags+=(--auto-discover-url "$SSO_DISCOVERY_URL"); }
  [[ "$(sso_setting scopes)" == '["openid", "profile", "email", "groups"]' ]] \
    || { sso_drift+=(scopes); sso_update_flags+=(--scopes "$SSO_SCOPES"); }
  # PPM keeps administrators, teams and names itself (R10, R12, R14): no group mapping, no required claim, no renames.
  [[ -z "$(sso_setting group_claim_name)" ]] || { sso_drift+=(group_claim_name); sso_update_flags+=(--group-claim-name ""); }
  [[ -z "$(sso_setting admin_group)" ]] || { sso_drift+=(admin_group); sso_update_flags+=(--admin-group ""); }
  [[ -z "$(sso_setting restricted_group)" ]] || { sso_drift+=(restricted_group); sso_update_flags+=(--restricted-group ""); }
  [[ -z "$(sso_setting group_team_map)" ]] || { sso_drift+=(group_team_map); sso_update_flags+=(--group-team-map ""); }
  [[ "$(sso_setting group_team_map_removal)" == false ]] \
    || { sso_drift+=(group_team_map_removal); sso_update_flags+=(--group-team-map-removal=false); }
  [[ -z "$(sso_setting required_claim_name)" ]] \
    || { sso_drift+=(required_claim); sso_update_flags+=(--required-claim-name "" --required-claim-value ""); }
  [[ "$(sso_setting allow_username_change)" == false ]] \
    || { sso_drift+=(allow_username_change); sso_update_flags+=(--allow-username-change=false); }
  [[ "$(sso_setting secret_sha256)" == "$want_sha" ]] || { sso_drift+=(client_secret); sso_write_secret=1; }
  [[ "$(sso_setting skip_local_2fa)" == true ]] || { sso_drift+=(skip_local_2fa); sso_write_secret=1; }
  config="" want_sha=""
}

# Writes the client secret (and «skip local 2FA», which update-oauth ignores) into the source's configuration: the
# secret reaches psql as a psql variable on stdin, never on a command line, and this session logs no statement
# (the guards of forgejo/db-init.sql). Fails closed: only the row of this id named PPM, of type OAuth2 (6) and with a
# ClientSecret field in its JSON is changed, and anything else than exactly that one row is a failure. Prints nothing.
sso_source_write_secret() { # id
  local out
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  out="$({
    printf '%s\n' "SET log_statement = 'none';" "SET log_min_error_statement = 'panic';" \
      "SET log_min_duration_statement = -1;" "SET log_min_duration_sample = -1;" "SET log_transaction_sample_rate = 0;"
    printf '\\set sso_secret %s\n' "$(env_get PPM_OIDC_CLIENT_SECRET)"
    printf '%s\n' "UPDATE login_source SET cfg = jsonb_set(jsonb_set(cfg::jsonb, '{ClientSecret}', to_jsonb(:'sso_secret'::text)), '{SkipLocalTwoFA}', 'true'::jsonb)::text WHERE id = $1 AND name = 'PPM' AND type = 6 AND cfg::jsonb ? 'ClientSecret' RETURNING id;"
  } | dc exec -T plane-db psql -X -q -tA -v ON_ERROR_STOP=1 -U plane -d forgejo 2>&1)" || { out=""; return 1; }
  [[ "$(printf '%s\n' "$out" | tr -d '\r' | sed '/^$/d')" == "$1" ]]
}

# Forgejo's login source «PPM» as sign-in through PPM needs it: created when missing, brought in line when it drifted.
# Sets sso_source_id and sso_source_changed (the Git server must restart to use a change).
sso_require_numeric_id() { # id — it goes into SQL and into update-oauth --id
  [[ "$1" =~ ^[0-9]+$ ]] \
    || die "unexpected answer of forgejo admin auth list for the login source PPM (id «$1»): git-bootstrap stops before touching Forgejo's database"
}

sso_ensure_source() {
  local code listed id type active
  sso_source_changed=0 sso_source_id=""
  sso_require_forgejo_15
  # add-oauth reads the discovery right away (and fails without it); Forgejo reads it at every start.
  code="$(forgejo_script "$FORGEJO_SSO_SCRIPT" discovery "$SSO_DISCOVERY_URL")" || code=000
  [[ "$code" == 200 ]] \
    || die "the Git server cannot read PPM's discovery at $SSO_DISCOVERY_URL (HTTP $code): see ./ppm-deploy.sh --env-file $env_file manage ppm_oidc_client --status and logs api; nothing in the Git server was changed"
  listed="$(sso_source_listed)" || die "could not list the login sources of the Git server (forgejo admin auth list; see logs forgejo)"
  if [[ -z "$listed" ]]; then
    sso_restart_pending_mark
    forgejo_script "$FORGEJO_SSO_SCRIPT" add "$(env_get PPM_OIDC_CLIENT_ID)" "$SSO_DISCOVERY_URL" "$SSO_SCOPES" >/dev/null \
      || die "the Git server did not create the login source PPM (forgejo admin auth add-oauth; reason above)"
    listed="$(sso_source_listed)" || true
    [[ -n "$listed" ]] || die "the login source PPM was created but the Git server does not list it (see logs forgejo)"
    read -r id type active <<<"$listed"
    sso_require_numeric_id "$id"
    sso_source_changed=1
    sso_source_write_secret "$id" \
      || die "the login source PPM (id $id) was created, but its client secret could not be written — run git-bootstrap again"
    # Read back what Forgejo stored: the source must now be exactly what git-bootstrap keeps.
    if ! sso_source_compare "$id" || ((${#sso_drift[@]})); then
      die "the login source PPM (id $id) was created, but Forgejo stored other settings (${sso_drift[*]:-unreadable}) — run git-bootstrap again"
    fi
    note "login source PPM created in the Git server (id $id): OpenID Connect, discovery $SSO_DISCOVERY_URL, scopes openid profile email groups, local 2FA skipped"
  else
    read -r id type active <<<"$listed"
    sso_require_numeric_id "$id"
    [[ "$type" == OAuth2 ]] \
      || die "the Git server has a login source named PPM of another type ($type): rename or delete it (Панель управления → Идентификация и доступ → Аутентификация), then run git-bootstrap again"
    [[ "$active" == true ]] \
      || die "the login source PPM (id $id) is switched off in the Git server: switch it on (Панель управления → Идентификация и доступ → Аутентификация → PPM → «Источник аутентификации активирован» → «Обновить источник аутентификации») or switch sign-in through PPM off in $env_file (PPM_GIT_SSO_ENABLED 0 and up), then run git-bootstrap again"
    sso_source_compare "$id" || die "could not read the settings of the login source PPM (id $id) in the Git server's database"
    ((${#sso_update_flags[@]} == 0 && !sso_write_secret)) || sso_restart_pending_mark
    if ((${#sso_update_flags[@]})); then
      forgejo_script "$FORGEJO_SSO_SCRIPT" update "$id" "${sso_update_flags[@]}" >/dev/null \
        || die "the Git server did not update the login source PPM (forgejo admin auth update-oauth; reason above)"
    fi
    if ((sso_write_secret)); then
      sso_source_write_secret "$id" || die "could not write the client secret of the login source PPM (id $id) — run git-bootstrap again"
    fi
    if ((${#sso_drift[@]})); then
      note "login source PPM (id $id) brought in line with $env_file: ${sso_drift[*]}"
      sso_source_changed=1
    else
      note "login source PPM (id $id) already in line with $env_file"
    fi
  fi
  sso_source_id="$id"
}

# For preflight: the login source «PPM» against ppm.env — ok / missing (run git-bootstrap) / fail (why).
sso_source_state() {
  local want listed id type active
  want="$(env_get PPM_FORGEJO_SSO_SOURCE_ID)"
  [[ -n "$want" ]] || { echo "missing (run git-bootstrap)"; return 0; }
  listed="$(sso_source_listed 2>/dev/null)" || { echo "fail (the Git server did not list its login sources)"; return 0; }
  [[ -n "$listed" ]] || { echo "fail (the Git server has no login source PPM: run git-bootstrap)"; return 0; }
  read -r id type active <<<"$listed"
  if [[ ! "$id" =~ ^[0-9]+$ ]]; then echo "fail (unexpected answer of forgejo admin auth list)"
  elif [[ "$id" != "$want" ]]; then echo "fail (login source PPM has id $id, ppm.env says $want: run git-bootstrap)"
  elif [[ "$type" != OAuth2 ]]; then echo "fail (the login source PPM is not OpenID Connect)"
  elif [[ "$active" != true ]]; then echo "fail (the login source PPM is switched off in the Git server)"
  elif sso_restart_is_pending; then echo "fail (a change of the login source PPM waits for a restart of the Git server: run git-bootstrap)"
  elif ! sso_source_compare "$id" 2>/dev/null; then echo "fail (its settings could not be read)"
  elif ((${#sso_drift[@]})); then echo "fail (differs from ppm.env: ${sso_drift[*]} — run git-bootstrap)"
  else echo ok; fi
}

# The first full synchronization of code access (accounts, organizations, teams, repositories), right away and in
# the API container, so the operator sees its result; afterwards beat runs it every 10 minutes. A problem is reported,
# not fatal: sign-in through PPM is set up either way and the next run repeats the work.
SSO_SYNC_PY='import json
from plane.ppm_git import tasks
from plane.ppm_git.models import PpmForgejoSyncRun
run_id = tasks.reconcile_forgejo_access()
run = PpmForgejoSyncRun.objects.filter(pk=run_id).first() if run_id else None
if run is None:
    print("status=skipped")
else:
    print("status=" + run.status)
    print("seconds=%d" % max(0, (run.finished_at - run.started_at).total_seconds()))
    print("counts=" + json.dumps(run.counts or {}, ensure_ascii=False, sort_keys=True))
    for problem in (run.problems or [])[:5]:
        print("problem=" + " ".join(str(problem.get("message", "")).split()))
    print("problems=%d" % len(run.problems or []))'
sso_first_sync() {
  local out rc=0 status
  note "first full synchronization of code access (accounts, organizations, teams) — may take a minute"
  out="$(dc exec -T api python manage.py shell -v 0 -c "$SSO_SYNC_PY" 2>&1)" || rc=$?
  status="$(printf '%s\n' "$out" | sed -n 's/^status=//p' | tail -n 1)"
  case "$rc:$status" in
    0:ok)
      echo "ppm-deploy: code access synchronized in $(printf '%s\n' "$out" | sed -n 's/^seconds=//p')s ($(printf '%s\n' "$out" | sed -n 's/^counts=//p')); from now on every 10 minutes and after every change in PPM." ;;
    0:partial | 0:error)
      note "WARNING: the first synchronization of code access ended «$status» with $(printf '%s\n' "$out" | sed -n 's/^problems=//p') problem(s):"
      printf '%s\n' "$out" | sed -n 's/^problem=/  - /p' >&2
      note "sign-in through PPM is set up; details and «Синхронизировать сейчас» — PPM admin center → «Git-сервер» (RUNBOOK §17.14.9)" ;;
    0:skipped)
      note "the synchronization did not start now (another one is running, or the API does not see sign-in through PPM as set up); it runs every 10 minutes by itself — state: PPM admin center → «Git-сервер»" ;;
    *)
      printf '%s\n' "$out" | tail -n 5 >&2
      note "WARNING: the first synchronization of code access could not run (above); sign-in through PPM is set up, and the synchronization repeats every 10 minutes — see logs api" ;;
  esac
}

cmd_git_admin() {
  git_require
  forgejo_require_running
  git_lock
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
  if ((sso_enabled)); then
    # With sign-in through PPM the Git server's password form is hidden: this account is the emergency administrator.
    if [[ "$(env_get PPM_GIT_LOCAL_SIGNIN)" == 1 ]]; then
      echo "ppm-deploy: the Git server's password form is on (PPM_GIT_LOCAL_SIGNIN=1): sign in with this password now; afterwards hide it again — ./ppm-env.sh set $env_file PPM_GIT_LOCAL_SIGNIN 0, then up (RUNBOOK §17.14.6)."
    else
      echo "ppm-deploy: sign-in through PPM is on, so the Git server shows no password form: to sign in with this password, open it for a while — ./ppm-env.sh set $env_file PPM_GIT_LOCAL_SIGNIN 1, then ./ppm-deploy.sh --env-file $env_file up; afterwards PPM_GIT_LOCAL_SIGNIN 0 and up again (RUNBOOK §17.4, §17.14.6)."
    fi
  fi
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
