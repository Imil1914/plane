#!/usr/bin/env bash
# PPM deployment operations (one entry point for the runbook).
#
#   ppm-deploy.sh <command> [args] [--env-file FILE]     (--env-file may appear anywhere, once)
#
#   config                   validate ppm.env and the Compose files (no values printed)
#   up [--no-workers]        start or update the stack, wait until healthy, run preflight; --no-workers keeps
#                            worker/beat-worker off (restore-drill copies: no e-mails/webhooks from copied data) and
#                            is remembered for the project: later up/restart/release keep them off too
#   wait                     wait until every service is healthy / one-shots finished
#   preflight                ppm_backend_preflight --verify-storage-write (DB, Redis, broker, S3 + I/O, realtime)
#   restart                  stop + start in dependency order (data kept), wait, preflight
#   release <name>           switch PPM_RELEASE (upgrade or rollback of the application; data and schema kept)
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
usage() { sed -n '2,31p' "$0"; }
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

KNOWN_SERVICES=" plane-db plane-redis plane-mq plane-minio minio-init proxy migrator api worker beat-worker live web admin space "
no_args() { ((${#rest[@]} == 0)) || fail "'$command' takes no arguments (got: ${rest[*]})"; }
confirm_project="" claim_email="" claim_password_file="" scan_self_test=0 no_workers=0
case "$command" in
  config|wait|preflight|restart|status|stop) no_args ;;
  up)
    if ((${#rest[@]} == 1)) && [[ "${rest[0]}" == --no-workers ]]; then no_workers=1; else no_args; fi ;;
  release)
    ((${#rest[@]} == 1)) || fail "release needs exactly one release name"
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
# A restore-drill copy stays without background jobs across up/restart/release (marker written by up --no-workers).
[[ -f "$state_dir/no-workers" ]] && no_workers=1

HEALTHY_SERVICES=(plane-db plane-redis plane-mq plane-minio proxy api worker beat-worker live web admin space)
ONESHOT_SERVICES=(minio-init migrator)
SECRET_KEYS=(SECRET_KEY LIVE_SERVER_SECRET_KEY POSTGRES_PASSWORD RABBITMQ_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY
  PPM_GITHUB_APP_CLIENT_SECRET PPM_GITHUB_APP_PRIVATE_KEY PPM_GITHUB_WEBHOOK_SECRET)

check_images() {
  local repo release image missing=0
  repo="$(env_get PPM_IMAGE_REPO)"; release="${1:-$(env_get PPM_RELEASE)}"
  for image in "$repo/api:$release" "$repo/web:$release" "$repo/admin:$release" "$repo/space:$release" \
    "$repo/live:$release" "$repo/proxy:$release" "$repo/tools:$release" "$(env_get PPM_MINIO_IMAGE)"; do
    docker image inspect "$image" >/dev/null 2>&1 || { echo "missing image: $image" >&2; missing=1; }
  done
  ((missing == 0)) || die "build the release first: ppm-build.sh --rev <commit> --release $release"
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
}

cmd_up() {
  "$bundle_dir/ppm-env.sh" check "$env_file" >/dev/null || die "env file is invalid: ppm-env.sh check $env_file"
  check_images
  dc_up
  cmd_wait
  cmd_preflight
  echo "ppm-deploy: $project is up at $(env_get PPM_PUBLIC_URL) (release $(env_get PPM_RELEASE), $([[ "$(env_get PPM_BIND_ADDRESS)" == 127.0.0.1 ]] && echo "PRIVATE: ports on 127.0.0.1 only" || echo "public"))."
}

cmd_release() {
  local target="$1" current
  current="$(env_get PPM_RELEASE)"
  check_images "$target"
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
  rm -f "$tmp"
  # Test-only values the smoke recorded (test password, session/CSRF cookies it received, log-probe tokens).
  if [[ -s "$PPM_SMOKE_DIR/sensitive-values.txt" ]]; then
    count="$(grep -c -F -f "$PPM_SMOKE_DIR/sensitive-values.txt" "$out" || true)"
    printf '  %-34s %s\n' "smoke:recorded-test-values" "$count"; ((count == 0)) || findings=1
  fi
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
  } >"$planted"
  {
    echo 'GET /uploads/x?X-Amz-Credential=REDACTED&X-Amz-Signature=REDACTED&X-Amz-Expires=300'
    echo 'GET /auth/github/callback/?code=REDACTED&state=REDACTED'
    echo 'GET /accounts/reset-password?uidb64=REDACTED&token=REDACTED'
    echo 'POST /auth/reset-password/REDACTED'
    echo '"headers":{"User-Agent":["curl/8"]}'
    echo 'transport: amqp://plane:**@plane-mq:5672/plane'
    echo 'GET /api/workspaces/w/projects/p/issues/?state=0f9e8d7c-1111-2222-3333-444455556666'
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

case "$command" in
  config) cmd_config ;;
  up) cmd_up ;;
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
