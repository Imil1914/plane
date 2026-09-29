#!/usr/bin/env bash
# Negative (and a few positive) checks of the operator scripts' argument handling and refusals.
# Creates only throw-away env files in a temporary directory; starts no containers and touches no Compose project:
# the only real Docker call is `docker compose config` (validates files); every check that would reach Docker runs
# with a FAKE `docker` first in PATH, which records each call and simulates existing projects. Exit 1 on any failure.
#
#   deployments/ppm/tests/cli-checks.sh
# shellcheck disable=SC2015  # `check && pass || fail`: pass never fails
set -uo pipefail

bundle_dir="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ppm-cli-checks.XXXXXX")"; tmp="$(cd "$tmp" && pwd)"  # normalised (TMPDIR may end in /)
trap 'rm -rf -- "$tmp"' EXIT
unset PPM_ENV_FILE
export PPM_RUNTIME_DIR="$tmp/runtime"  # state dirs of the throw-away projects stay in the temp dir
passed=0 failed=0

pass() { passed=$((passed + 1)); printf '  ok    %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf '  FAIL  %s\n' "$1"; }
run() { "$@" </dev/null 2>&1; }  # never a TTY: interactive prompts must refuse, not wait

expect_fail() { # name, expected text, command...
  local name="$1" want="$2" out rc; shift 2
  out="$(run "$@")" && rc=0 || rc=$?
  if ((rc != 0)) && [[ "$out" == *"$want"* ]]; then pass "$name"; else fail "$name — rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"; fi
}
expect_ok() { # name, expected text, command...
  local name="$1" want="$2" out rc; shift 2
  out="$(run "$@")" && rc=0 || rc=$?
  if ((rc == 0)) && [[ "$out" == *"$want"* ]]; then pass "$name"; else fail "$name — rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"; fi
}
file_sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# Fake docker: records every call in $FAKE_DOCKER_LOG, runs nothing. $FAKE_DOCKER_STATE lists projects that "exist":
# "<project> <containers> <volumes> <domain their containers serve>" per line. For the backup/restore and Git server
# flows it answers like the real services would, driven by FAKE_* variables (see below), records the stdin of the
# Forgejo API tool per subcommand in $FAKE_DOCKER_LOG.stdin.<subcommand>, and replaces the GnuPG steps: "encrypting"
# packs the working directory into a tar.gz, "decrypting" unpacks such a file (prepared tar archives in the tests).
fakebin="$tmp/fakebin" fakelog="$tmp/fake-docker.log" fakestate="$tmp/fake-docker.state"
mkdir -p "$fakebin"; : >"$fakelog"; : >"$fakestate"
cat >"$fakebin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_DOCKER_LOG"
all=" $* "
state_line() { [[ -f "${FAKE_DOCKER_STATE:-}" ]] && awk -v p="$1" '$1 == p' "$FAKE_DOCKER_STATE"; return 0; }
label_project() {
  local arg
  for arg in "$@"; do [[ "$arg" == label=com.docker.compose.project=* ]] && echo "${arg#label=com.docker.compose.project=}"; done
  return 0
}
has() { [[ "$all" == *" $1 "* ]]; }      # an exact argument
contains() { [[ "$all" == *"$1"* ]]; }   # a piece of any argument
mount_of() { # container path → host path of the -v mapping to it
  local prev="" arg
  for arg in "$@"; do
    if [[ "$prev" == -v ]]; then case "$arg" in *:"$MOUNT"|*:"$MOUNT":ro) echo "${arg%%:*}"; return;; esac; fi
    prev="$arg"
  done
}
last="${*: -1}"
case "$1" in
  ps)
    p="$(label_project "$@")"; read -r _ n _ _ <<<"$(state_line "$p")"
    for ((i = 1; i <= ${n:-0}; i++)); do echo "fake-$p-$i"; done ;;
  volume)
    if [[ "$2" == inspect ]]; then [[ "${FAKE_FORGEJO_VOLUME:-0}" == 1 ]]; exit; fi
    p="$(label_project "$@")"; read -r _ _ n _ <<<"$(state_line "$p")"
    for ((i = 1; i <= ${n:-0}; i++)); do echo "${p}_volume$i"; done ;;
  inspect)
    case "$3" in
      *ExitCode*) echo "exited 0" ;;
      *Health*) echo "healthy" ;;
      *State.Running*) echo "${FAKE_FORGEJO_RUNNING:-true}" ;;
      # Changes with every (fake) restart of the container: $FAKE_SSO_DIR/restarts counts them.
      *StartedAt*) echo "started-$(cat "${FAKE_SSO_DIR:-/nonexistent}/restarts" 2>/dev/null || echo 0)" ;;
      *Config.Env*)
        for id in "${@:4}"; do
          p="${id#fake-}"; p="${p%-*}"; read -r _ _ _ d <<<"$(state_line "$p")"
          [[ -n "$d" ]] && echo "PPM_DOMAIN=$d"
        done ;;
    esac ;;
  run) # raw docker run: the Git site probe of a proxy image, the Forgejo data volume of a switched-off Git server
    if contains "git-server-1.caddy"; then [[ -n "${FAKE_NO_GIT_SITE:-}" ]] && contains "$FAKE_NO_GIT_SITE" && exit 1; exit 0; fi
    [[ -n "${FAKE_RUN_FAIL:-}" ]] && exit 1
    if contains "exec tar -cf -"; then printf 'FAKE-FORGEJO-DATA'; exit 0; fi
    if contains "count()"; then echo "${FAKE_REPOS:-0} 0 0 0"; exit 0; fi ;;
  compose)
    if has ps; then [[ -n "${FAKE_NO_CONTAINERS:-}" ]] || echo "fake-service"; exit 0; fi
    # ---- sign-in through PPM (G2.2): the API's checks and commands, Forgejo's login source «PPM» in $FAKE_SSO_DIR
    # (files: source = the `auth list` row, cfg = the key=value lines of ppm-deploy.sh's config query).
    sso_sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | awk '{ print $1 }'; }
    sso_put() { # key value — in the fake source configuration
      local file="$FAKE_SSO_DIR/cfg"
      awk -v k="$1" -v v="$2" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$file" >"$file.new" && mv -f "$file.new" "$file"
    }
    if contains "sso-check"; then cat >"$FAKE_DOCKER_LOG.stdin.sso-check"; [[ -n "${FAKE_API_SSO_MISMATCH:-}" ]] && exit 3; exit 0; fi
    if contains "env-check"; then cat >"$FAKE_DOCKER_LOG.stdin.env-check"; [[ -n "${FAKE_API_STALE:-}" ]] && exit 5; exit 0; fi
    # The compose command itself is one whole argument (a text argument such as a preflight state may contain the word).
    is_arg() { local a; for a in "${@:2}"; do [[ "$a" == "$1" ]] && return 0; done; return 1; }
    if is_arg up "$@" && is_arg --no-deps "$@" && [[ -n "${FAKE_UP_FAIL:-}" ]]; then exit 1; fi
    if is_arg restart "$@"; then
      [[ -n "${FAKE_RESTART_FAIL:-}" ]] && exit 1
      if [[ -n "${FAKE_SSO_DIR:-}" ]]; then
        n="$(cat "$FAKE_SSO_DIR/restarts" 2>/dev/null || echo 0)"; echo $((n + 1)) >"$FAKE_SSO_DIR/restarts"
      fi
      exit 0
    fi
    if contains "ppm_oidc_client --ensure"; then
      [[ -n "${FAKE_ENSURE_FAIL:-}" ]] && { echo "CommandError: Единый вход не настроен: проверьте PPM_OIDC_PRIVATE_KEY." >&2; exit 1; }
      echo "Клиент OIDC «forgejo» уже соответствует окружению."; exit 0
    fi
    if contains "ppm_oidc_client --disable"; then
      [[ -n "${FAKE_DISABLE_UNKNOWN:-}" ]] && { echo "Unknown command: 'ppm_oidc_client'" >&2; exit 1; }
      echo "Клиент OIDC «forgejo» не найден — отключать нечего."; exit 0
    fi
    if contains "manage.py shell"; then
      echo "status=${FAKE_SYNC_STATUS:-ok}"; echo "seconds=2"; echo 'counts={"accounts_created": 0}'
      if [[ "${FAKE_SYNC_STATUS:-ok}" == ok ]]; then echo "problems=0"
      else echo "problem=Доступ к robot/app настраивается вручную: он вне организации пространства"; echo "problems=1"; fi
      exit 0
    fi
    if contains "add-oauth"; then # FORGEJO_SSO_SCRIPT: its action follows the script name forgejo-script
      rest=(); seen=0
      for arg in "$@"; do ((seen)) && rest+=("$arg"); [[ "$arg" == forgejo-script ]] && seen=1; done
      case "${rest[0]}" in
        list) printf 'ID\tName\tType\tEnabled\n'; [[ -f "$FAKE_SSO_DIR/source" ]] && cat "$FAKE_SSO_DIR/source" ;;
        version) printf '%s\n' "${FAKE_FORGEJO_VERSION:-forgejo version 15.0.9+gitea-1.22.0 (release name 15.0.9) built with GNU Make 4.4.1, go1.26.8 : bindata, timetzdata, sqlite, sqlite_unlock_notify}" ;;
        discovery) printf '%s' "${FAKE_SSO_DISCOVERY:-200}" ;;
        add)
          [[ -f "$FAKE_SSO_DIR/source" ]] && { echo "login source already exists [name: PPM]" >&2; exit 1; }
          printf '7\tPPM\tOAuth2\ttrue\n' >"$FAKE_SSO_DIR/source"
          scopes='["'"${rest[3]}"'"]'; [[ "${rest[3]}" == openid,profile,email,groups ]] && scopes='["openid", "profile", "email", "groups"]'
          printf '%s\n' provider=openidConnect "client_id=${rest[1]}" "secret_sha256=$(printf '' | sso_sha)" \
            "discovery=${rest[2]}" "scopes=$scopes" skip_local_2fa=true group_claim_name= admin_group= restricted_group= \
            group_team_map= group_team_map_removal=false required_claim_name= allow_username_change=false >"$FAKE_SSO_DIR/cfg" ;;
        update)
          set -- "${rest[@]:2}"
          while (($#)); do
            case "$1" in
              --key) sso_put client_id "$2"; shift 2 ;;
              --auto-discover-url) sso_put discovery "$2"; shift 2 ;;
              --scopes) sso_put scopes '["openid", "profile", "email", "groups"]'; shift 2 ;;
              --provider) sso_put provider "$2"; shift 2 ;;
              --admin-group) sso_put admin_group "$2"; shift 2 ;;
              --group-claim-name) sso_put group_claim_name "$2"; shift 2 ;;
              *) shift ;;
            esac
          done ;;
      esac
      exit 0
    fi
    if contains "login_source" && contains " -c "; then cat "$FAKE_SSO_DIR/cfg"; exit 0; fi
    if contains "psql -X -q -tA"; then # the client secret of the source, on stdin
      cat >"$FAKE_DOCKER_LOG.stdin.psql-sso"
      sso_put secret_sha256 "$(sed -n 's/^\\set sso_secret //p' "$FAKE_DOCKER_LOG.stdin.psql-sso" | tr -d '\n' | sso_sha)"
      sso_put skip_local_2fa true
      cut -f1 "$FAKE_SSO_DIR/source"; exit 0
    fi
    if contains "forgejo-script"; then
      if contains "generate-access-token"; then [[ -n "${FAKE_BOOT_FAIL:-}" ]] && exit 1; echo "$FAKE_BOOT_TOKEN"; exit 0; fi
      if contains "--random-password-length 20"; then echo "$FAKE_ADMIN_PASSWORD"; exit 0; fi
      exit 0
    fi
    if contains " forgejo-bootstrap "; then
      sub="$(printf '%s\n' "$@" | awk 'seen { print; exit } $0 == "forgejo-bootstrap" { seen = 1 }')"
      cat >"$FAKE_DOCKER_LOG.stdin.$sub"
      [[ ",${FAKE_TOOL_FAIL:-}," == *",$sub,"* ]] && { echo "git-bootstrap: FAILED: fake failure of $sub" >&2; exit 1; }
      case "$sub" in
        prepare)
          if [[ -z "${FAKE_PREPARE_KEEP:-}" ]]; then
            echo "token=$FAKE_NEW_TOKEN"
            ! contains "--admin-token" || echo "admin_token=$FAKE_NEW_ADMIN_TOKEN"
          fi ;;
        reset-password) echo "password=$FAKE_RESET_PASSWORD" ;;
      esac
      exit 0
    fi
    if contains "pg_dump"; then [[ -n "${FAKE_FAIL_FORGEJO_DUMP:-}" ]] && has forgejo && exit 1; printf 'FAKE-DUMP'; exit 0; fi
    if contains "pg_restore --list"; then cat >/dev/null; echo "1; 0 0 TABLE fake t plane"; exit 0; fi
    if contains "pg_restore --data-only"; then cat >/dev/null; printf 'COPY public.fake_t (id) FROM stdin;\n1\n\\.\n'; exit 0; fi
    if contains "pg_restore"; then cat >/dev/null; exit 0; fi
    if contains "show server_version"; then echo "15.7"; exit 0; fi
    if contains "datname = 'forgejo'"; then echo "${FAKE_FORGEJO_DB:-0}"; exit 0; fi
    if contains "from pg_tables"; then echo 0; exit 0; fi
    if contains "from repository"; then echo "${FAKE_REPOS:-0}"; exit 0; fi
    # The row-count query of a restore (on stdin): every table it names has the one row of the fake dump.
    if contains "psql"; then grep -oE "'public\.(\"[a-z_]+\"|[a-z_][a-z0-9_]*)'" | tr -d "'" | sed 's/$/=1/'; exit 0; fi
    if contains ":/backup:ro" && contains ":/out"; then # "encryption": tar.gz of the working directory
      work="$(MOUNT=/backup mount_of "$@")"; out="$(MOUNT=/out mount_of "$@")"
      tar -czf "$out/$last.tar.gz.gpg" -C "$work" . && exit 0; exit 1
    fi
    if contains ":/in:ro" && contains ":/work"; then # "decryption": unpack the prepared tar.gz
      in="$(MOUNT=/in mount_of "$@")"; work="$(MOUNT=/work mount_of "$@")"
      tar -xzf "$in/$last" -C "$work" && exit 0; exit 1
    fi
    if contains "exec tar -cf -"; then printf 'FAKE-FORGEJO-DATA'; exit 0; fi
    if contains "count()"; then echo "${FAKE_REPOS:-0} 0 0 0"; exit 0; fi
    if contains "find /var/lib/gitea -mindepth 1"; then echo 0; exit 0; fi
    if contains "tar -xf -"; then cat >/dev/null; exit 0; fi
    if contains "shuf -n"; then echo "${FAKE_REPOS:-0} 0 0"; exit 0; fi
    if contains "test -f /etc/caddy/git-server-1.caddy"; then [[ -n "${FAKE_NO_GIT_SITE:-}" ]] && exit 1; exit 0; fi
    if contains " python - "; then cat >/dev/null; exit 0; fi ;;
esac
exit 0
FAKE
chmod +x "$fakebin/docker"
fake() { env PATH="$fakebin:$PATH" FAKE_DOCKER_LOG="$fakelog" FAKE_DOCKER_STATE="$fakestate" PPM_WAIT_TIMEOUT=5 "$@"; }
fake_calls() { grep -c -- "$1" "$fakelog" || true; }

deploy="$bundle_dir/ppm-deploy.sh" backup="$bundle_dir/ppm-backup.sh" restore="$bundle_dir/ppm-restore.sh"
envtool="$bundle_dir/ppm-env.sh"
prod="$tmp/prod.env" drill="$tmp/drill.env"
run "$envtool" init --domain ppm.example.test --output "$prod" --project ppm-cli-prod --release cli >/dev/null
run "$envtool" init --domain drill.localhost --output "$drill" --project ppm-cli-drill --release cli \
  --https-port 28443 --http-port 28080 >/dev/null

echo "ppm-env.sh"
expect_ok "init defaults to the private phase (internal TLS, 127.0.0.1)" "private phase" "$envtool" check "$prod"
expect_fail "ACME without public ports is rejected" "ACME needs ports 80/443" \
  "$envtool" init --domain ppm.example.test --tls admin@example.test --output "$tmp/acme.env"
if [[ ! -e "$tmp/acme.env" && ! -e "$tmp/acme.backup-passphrase" ]]; then pass "a failed init leaves no files behind"
else fail "a failed init left files behind"; fi
expect_fail "internal TLS for a public phase is rejected" "PPM_TLS=internal is only allowed" \
  "$envtool" init --domain ppm.example.test --bind 0.0.0.0 --output "$tmp/pub.env"
expect_fail "init refuses to replace an env file" "already exists" \
  "$envtool" init --domain ppm.example.test --output "$prod"
before="$(file_sum "$tmp/prod.backup-passphrase")"
run "$envtool" init --domain ppm.example.test --output "$prod" --project ppm-cli-prod --release cli --force >/dev/null
if [[ "$(file_sum "$tmp/prod.backup-passphrase")" == "$before" ]]; then pass "init --force keeps the existing backup passphrase"
else fail "init --force replaced the backup passphrase"; fi
expect_fail "secrets cannot be printed" "refusing to print secret" "$envtool" get "$prod" SECRET_KEY
expect_fail "secrets cannot be set" "refusing to change secret" "$envtool" set "$prod" POSTGRES_PASSWORD x
cp -p "$drill" "$tmp/loose.env"; chmod 644 "$tmp/loose.env"
expect_fail "a world-readable env file is invalid" "must not be readable by other users" "$envtool" check "$tmp/loose.env"
chmod 644 "$tmp/drill.backup-passphrase"
expect_fail "a world-readable passphrase file is invalid" "must be mode 600" "$envtool" check "$drill"
chmod 600 "$tmp/drill.backup-passphrase"

run "$envtool" init --domain other-drill.localhost --output "$tmp/defaultname.env" --release cli >/dev/null
if [[ "$("$envtool" get "$tmp/defaultname.env" PPM_PROJECT)" == ppm-drill ]]; then
  pass "init on *.localhost defaults to project ppm-drill, never the production name"
else fail "init on *.localhost chose project '$("$envtool" get "$tmp/defaultname.env" PPM_PROJECT)'"; fi
if [[ "$("$envtool" get "$prod" PPM_PROJECT)" == ppm-cli-prod ]]; then pass "--project is honoured"; else fail "--project ignored"; fi
cp -p "$drill" "$tmp/prodname.env"; cp -p "$tmp/drill.backup-passphrase" "$tmp/prodname.backup-passphrase"
run "$envtool" set "$tmp/prodname.env" PPM_BACKUP_PASSPHRASE_FILE prodname.backup-passphrase >/dev/null
run "$envtool" set "$tmp/prodname.env" PPM_PROJECT ppm >/dev/null
expect_fail "check refuses the production project name on a *.localhost env" "names the production project" \
  "$envtool" check "$tmp/prodname.env"
expect_fail "init refuses --project ppm for a *.localhost domain (no files kept)" "names the production project" \
  "$envtool" init --domain x.localhost --project ppm --output "$tmp/x.env"
[[ ! -e "$tmp/x.env" ]] && pass "  ... and leaves no env file" || fail "  ... left $tmp/x.env"
pub="$tmp/pub.env"; cp -p "$prod" "$pub"; cp -p "$tmp/prod.backup-passphrase" "$tmp/pub.backup-passphrase"
run "$envtool" set "$pub" PPM_BACKUP_PASSPHRASE_FILE pub.backup-passphrase >/dev/null
run "$envtool" set "$pub" PPM_TLS admin@example.test >/dev/null
expect_fail "switching to ACME alone (ports still private) is rejected" "ACME needs ports 80/443" "$envtool" check "$pub"
run "$envtool" set "$pub" PPM_BIND_ADDRESS 0.0.0.0 >/dev/null
expect_ok "ACME + 0.0.0.0 is the valid public phase" "public phase" "$envtool" check "$pub"
run "$envtool" set "$pub" PPM_ACME_CA https://acme-staging-v02.api.letsencrypt.org/directory >/dev/null
expect_fail "a staging ACME CA is rejected (preflight could not pass)" "staging CA" "$envtool" check "$pub"
run "$envtool" set "$pub" PPM_ACME_CA https://acme-v02.api.letsencrypt.org/directory >/dev/null
ports="$("$deploy" --env-file "$pub" compose config --format json 2>/dev/null | python3 -c '
import json, sys
config = json.load(sys.stdin)
proxy = sorted({port.get("host_ip", "") for port in config["services"]["proxy"].get("ports", [])})
internal = any("caddy-data" in str(volume) for volume in config["services"]["api"].get("volumes", []))
print(",".join(proxy), "internal-ca" if internal else "public-ca")')"
if [[ "$ports" == "0.0.0.0 public-ca" ]]; then pass "public phase publishes on 0.0.0.0 without the internal-CA overlay"
else fail "public phase config: got '$ports'"; fi
ports="$("$deploy" --env-file "$prod" compose config --format json 2>/dev/null | python3 -c '
import json, sys
config = json.load(sys.stdin)
print(",".join(sorted({port.get("host_ip", "") for port in config["services"]["proxy"].get("ports", [])})))')"
if [[ "$ports" == "127.0.0.1" ]]; then pass "private phase publishes only on 127.0.0.1"; else fail "private phase ports: got '$ports'"; fi

echo "ppm-env.sh — Git server (Forgejo) keys (R17)"
# Test-only readers/writers of raw values (secrets included): used for format checks, never printed.
rawget() { awk -v k="$2" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$1"; }
rawput() { # file key value — like `set`, but also for secrets (to build broken files)
  local t; t="$(mktemp "$tmp/.put.XXXXXX")"
  awk -v k="$2" -v v="$3" 'index($0, k "=") == 1 { print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' \
    "$1" >"$t" && mv -f "$t" "$1" && chmod 600 "$1"
}
GIT_SECRETS=(FORGEJO_DB_PASSWORD FORGEJO_SECRET_KEY FORGEJO_INTERNAL_TOKEN FORGEJO_JWT_SECRET FORGEJO_LFS_JWT_SECRET
  PPM_FORGEJO_WEBHOOK_SECRET)
GIT_KEYS=(PPM_GIT_SERVER_ENABLED PPM_GIT_DOMAIN PPM_GIT_PUBLIC_URL PPM_GIT_SSH_ENABLED PPM_GIT_SSH_PORT
  PPM_GIT_MAX_BODY_SIZE PPM_FORGEJO_IMAGE "${GIT_SECRETS[@]}" PPM_FORGEJO_TOKEN)
genv="$tmp/git.env"
initout="$(run "$envtool" init --domain gitcli.example.test --https-port 8443 --output "$genv" --project ppm-cli-git --release cli)"
if [[ "$(rawget "$genv" PPM_GIT_SERVER_ENABLED)" == 1 && "$(rawget "$genv" PPM_GIT_DOMAIN)" == git.gitcli.example.test \
      && "$(rawget "$genv" PPM_GIT_PUBLIC_URL)" == https://git.gitcli.example.test:8443 \
      && "$(rawget "$genv" PPM_GIT_SSH_ENABLED)" == 1 && "$(rawget "$genv" PPM_GIT_SSH_PORT)" == 2222 \
      && "$(rawget "$genv" PPM_GIT_MAX_BODY_SIZE)" == 1GB ]]; then
  pass "init adds the Git server: git.<domain>, public URL with the HTTPS port, SSH 2222, 1GB bodies"
else fail "init Git keys: $(grep -E '^PPM_GIT_' "$genv" | tr '\n' ' ')"; fi
[[ "$(rawget "$genv" PPM_FORGEJO_IMAGE)" =~ ^codeberg\.org/forgejo/forgejo:15-rootless@sha256:[0-9a-f]{64}$ ]] \
  && pass "init pins Forgejo 15 rootless by digest" || fail "PPM_FORGEJO_IMAGE: $(rawget "$genv" PPM_FORGEJO_IMAGE)"
bad=""
for key in FORGEJO_DB_PASSWORD FORGEJO_SECRET_KEY FORGEJO_INTERNAL_TOKEN PPM_FORGEJO_WEBHOOK_SECRET; do
  [[ "$(rawget "$genv" "$key")" =~ ^[0-9a-f]{64}$ ]] || bad+=" $key"
done
for key in FORGEJO_JWT_SECRET FORGEJO_LFS_JWT_SECRET; do
  value="$(rawget "$genv" "$key")"
  # Forgejo decodes these with base64.RawURLEncoding and regenerates them unless they are exactly 32 bytes.
  [[ "$value" =~ ^[A-Za-z0-9_-]{43}$ ]] && python3 -c 'import base64, sys; sys.exit(len(base64.urlsafe_b64decode(sys.argv[1] + "=")) != 32)' "$value" \
    || bad+=" $key"
done
[[ -z "$bad" && -z "$(rawget "$genv" PPM_FORGEJO_TOKEN)" ]] \
  && pass "  ... secrets: hex for passwords/keys, base64url of 32 bytes without '=' for the JWT secrets; token empty" \
  || fail "  ... malformed:$bad"
values="$(for key in "${GIT_SECRETS[@]}"; do rawget "$genv" "$key"; done | sort -u | wc -l | tr -d ' ')"
[[ "$values" == "${#GIT_SECRETS[@]}" ]] && pass "  ... every Git secret is distinct" || fail "  ... repeated secret values"
printed=0; for key in "${GIT_SECRETS[@]}"; do [[ "$initout" == *"$(rawget "$genv" "$key")"* ]] && printed=1; done
((printed == 0)) && pass "  ... init prints no Git secret" || fail "  ... init printed a Git secret"
for key in "${GIT_SECRETS[@]}" PPM_FORGEJO_TOKEN; do
  expect_fail "get refuses $key" "refusing to print secret" "$envtool" get "$genv" "$key"
done
expect_fail "set refuses FORGEJO_SECRET_KEY" "refusing to change secret" "$envtool" set "$genv" FORGEJO_SECRET_KEY x
expect_ok "check: a new env with the Git server is valid" "Git server git.gitcli.example.test on" "$envtool" check "$genv"
expect_ok "  ... and reminds to run git-bootstrap while PPM_FORGEJO_TOKEN is empty" "git-bootstrap" "$envtool" check "$genv"

rc1="$tmp/rc1.env"; cp -p "$genv" "$rc1"; cp -p "$tmp/git.backup-passphrase" "$tmp/rc1.backup-passphrase"
rawput "$rc1" PPM_BACKUP_PASSPHRASE_FILE rc1.backup-passphrase
grep -v -E '^(PPM_GIT_|PPM_FORGEJO_|PPM_OIDC_|FORGEJO_|# ---- Git server|# ---- Sign-in through PPM)' "$rc1" >"$rc1.tmp" \
  && mv -f "$rc1.tmp" "$rc1" && chmod 600 "$rc1"
expect_ok "check: an RC.1 env without Git keys stays valid (Git server off)" "Git server off" "$envtool" check "$rc1"
expect_ok "  ... and explains how to add the keys" "ppm-env.sh add-git $rc1" "$envtool" check "$rc1"
rc1_size="$(wc -c <"$rc1" | tr -d ' ')"; rc1_sum="$(file_sum "$rc1")"; cp -p "$rc1" "$tmp/rc1.orig"
out="$(run "$envtool" add-git "$rc1")" && rc=0 || rc=$?
if ((rc == 0)) && [[ "$(head -c "$rc1_size" "$rc1" | file_sum /dev/stdin)" == "$rc1_sum" ]]; then
  pass "add-git keeps every existing byte of the RC.1 file (only appends)"
else fail "add-git changed the existing content (rc=$rc): $(tail -n 2 <<<"$out" | tr '\n' ' ')"; fi
missing=""; for key in "${GIT_KEYS[@]}"; do grep -q "^$key=" "$rc1" || missing+=" $key"; done
[[ -z "$missing" ]] && pass "  ... adds every Git key" || fail "  ... missing after add-git:$missing"
[[ "$(rawget "$rc1" PPM_GIT_DOMAIN)" == git.gitcli.example.test && "$(rawget "$rc1" PPM_GIT_PUBLIC_URL)" == https://git.gitcli.example.test:8443 ]] \
  && pass "  ... derives git.<PPM_DOMAIN> and the public URL from the file" || fail "  ... wrong derived Git domain/URL"
printed=0; for key in "${GIT_SECRETS[@]}"; do [[ "$out" == *"$(rawget "$rc1" "$key")"* ]] && printed=1; done
((printed == 0)) && [[ "$out" == *"FORGEJO_JWT_SECRET"* ]] && pass "  ... names the generated secrets, prints no value" \
  || fail "  ... add-git output: $(tail -n 3 <<<"$out" | tr '\n' ' ')"
[[ "$(file_mode "$rc1")" == 600 ]] && pass "  ... file stays mode 600" || fail "  ... mode $(file_mode "$rc1")"
expect_ok "  ... the result is valid with the Git server on" "Git server git.gitcli.example.test on" "$envtool" check "$rc1"
before="$(file_sum "$rc1")"
expect_ok "add-git again adds nothing" "nothing to add" "$envtool" add-git "$rc1"
[[ "$(file_sum "$rc1")" == "$before" ]] && pass "  ... and leaves the file byte-identical" || fail "  ... the file changed"
off="$tmp/off.env"; cp -p "$tmp/rc1.orig" "$off"; cp -p "$tmp/rc1.backup-passphrase" "$tmp/off.backup-passphrase"
rawput "$off" PPM_BACKUP_PASSPHRASE_FILE off.backup-passphrase; rawput "$off" PPM_GIT_SERVER_ENABLED 0
expect_ok "an env with PPM_GIT_SERVER_ENABLED=0 is valid without the other Git keys" "Git server off" "$envtool" check "$off"
expect_ok "add-git keeps PPM_GIT_SERVER_ENABLED=0 and says how to switch on" "PPM_GIT_SERVER_ENABLED 1" "$envtool" add-git "$off"
[[ "$(rawget "$off" PPM_GIT_SERVER_ENABLED)" == 0 && -n "$(rawget "$off" FORGEJO_SECRET_KEY)" ]] \
  && pass "  ... the value 0 is kept, the missing keys are added" || fail "  ... PPM_GIT_SERVER_ENABLED=$(rawget "$off" PPM_GIT_SERVER_ENABLED)"
out="$(run "$envtool" add-git "$tmp/none.env")" && rc=0 || rc=$?
((rc != 0)) && [[ ! -e "$tmp/none.env" ]] && pass "add-git refuses a missing file (creates nothing)" || fail "add-git on a missing file: rc=$rc"
dgit="$tmp/dgit.env"; cp -p "$drill" "$dgit"; cp -p "$tmp/drill.backup-passphrase" "$tmp/dgit.backup-passphrase"
rawput "$dgit" PPM_BACKUP_PASSPHRASE_FILE dgit.backup-passphrase
[[ "$(rawget "$dgit" PPM_GIT_DOMAIN)" == git.drill.localhost && "$(rawget "$dgit" PPM_GIT_PUBLIC_URL)" == https://git.drill.localhost:28443 ]] \
  && pass "a *.localhost drill env gets git.<drill domain> with its HTTPS port" || fail "drill Git domain: $(rawget "$dgit" PPM_GIT_DOMAIN)"
run "$envtool" init --domain sshport.localhost --https-port 29443 --http-port 29080 --git-ssh-port 29222 \
  --output "$tmp/sshport.env" --project ppm-cli-sshport --release cli >/dev/null
[[ "$(rawget "$tmp/sshport.env" PPM_GIT_SSH_PORT)" == 29222 ]] \
  && pass "init --git-ssh-port: a drill copy next to production keeps off the production SSH port" \
  || fail "init --git-ssh-port: $(rawget "$tmp/sshport.env" PPM_GIT_SSH_PORT)"
cp -p "$tmp/rc1.orig" "$tmp/custom.env"; cp -p "$tmp/rc1.backup-passphrase" "$tmp/custom.backup-passphrase"
rawput "$tmp/custom.env" PPM_BACKUP_PASSPHRASE_FILE custom.backup-passphrase
run "$envtool" add-git "$tmp/custom.env" --git-domain code.gitcli.example.test --git-ssh-port 2022 >/dev/null
[[ "$(rawget "$tmp/custom.env" PPM_GIT_PUBLIC_URL)" == https://code.gitcli.example.test:8443 && "$(rawget "$tmp/custom.env" PPM_GIT_SSH_PORT)" == 2022 ]] \
  && pass "add-git --git-domain/--git-ssh-port choose another host name and SSH port" \
  || fail "add-git --git-domain: $(rawget "$tmp/custom.env" PPM_GIT_PUBLIC_URL) $(rawget "$tmp/custom.env" PPM_GIT_SSH_PORT)"

broken() { # name, expected text, key, value — check must refuse a copy of the valid Git env with key=value
  local b="$tmp/broken.env"; cp -p "$genv" "$b"; cp -p "$tmp/git.backup-passphrase" "$tmp/broken.backup-passphrase"
  rawput "$b" PPM_BACKUP_PASSPHRASE_FILE broken.backup-passphrase; rawput "$b" "$3" "$4"
  expect_fail "$1" "$2" "$envtool" check "$b"
}
broken "check refuses a padded/short JWT secret (Forgejo would regenerate it)" "FORGEJO_JWT_SECRET must be" \
  FORGEJO_JWT_SECRET "$(rawget "$genv" FORGEJO_JWT_SECRET)="
broken "check refuses a short LFS JWT secret" "FORGEJO_LFS_JWT_SECRET must be" FORGEJO_LFS_JWT_SECRET abc
broken "check refuses a short Forgejo DB password" "FORGEJO_DB_PASSWORD is shorter" FORGEJO_DB_PASSWORD abc123
broken "check refuses a placeholder webhook secret" "PPM_FORGEJO_WEBHOOK_SECRET" PPM_FORGEJO_WEBHOOK_SECRET generated-by-ppm-env
broken "check refuses a Git public URL that does not match the Git domain" "PPM_GIT_PUBLIC_URL must be exactly" \
  PPM_GIT_PUBLIC_URL https://git.gitcli.example.test
broken "check refuses the PPM host as the Git host" "must differ from PPM_DOMAIN" PPM_GIT_DOMAIN gitcli.example.test
broken "check refuses an SSH port equal to the HTTPS port" "PPM_GIT_SSH_PORT" PPM_GIT_SSH_PORT 8443
broken "check refuses a Forgejo image not pinned by digest" "pinned by digest" PPM_FORGEJO_IMAGE codeberg.org/forgejo/forgejo:15-rootless
broken "check refuses PPM_GIT_SERVER_ENABLED other than 0/1" "PPM_GIT_SERVER_ENABLED must be" PPM_GIT_SERVER_ENABLED yes
broken "check refuses a malformed PPM_FORGEJO_TOKEN" "PPM_FORGEJO_TOKEN" PPM_FORGEJO_TOKEN not-a-token
broken "check refuses a malformed PPM_GIT_MAX_BODY_SIZE" "PPM_GIT_MAX_BODY_SIZE" PPM_GIT_MAX_BODY_SIZE lots
broken "check refuses a *.localhost Git host next to a real PPM domain" "PPM_GIT_DOMAIN" PPM_GIT_DOMAIN git.x.localhost
pubgit="$tmp/pubgit.env"; cp -p "$genv" "$pubgit"; cp -p "$tmp/git.backup-passphrase" "$tmp/pubgit.backup-passphrase"
rawput "$pubgit" PPM_BACKUP_PASSPHRASE_FILE pubgit.backup-passphrase
rawput "$pubgit" PPM_TLS admin@example.test; rawput "$pubgit" PPM_BIND_ADDRESS 0.0.0.0
expect_ok "the public phase (ACME, 0.0.0.0) is valid with the Git server" "public phase" "$envtool" check "$pubgit"

tokfile="$tmp/tok.env"; cp -p "$genv" "$tokfile"; cp -p "$tmp/git.backup-passphrase" "$tmp/tok.backup-passphrase"
rawput "$tokfile" PPM_BACKUP_PASSPHRASE_FILE tok.backup-passphrase
tok="$(openssl rand -hex 20)"
out="$(printf '%s\n' "$tok" | "$envtool" set-secret "$tokfile" PPM_FORGEJO_TOKEN 2>&1)" && rc=0 || rc=$?
((rc == 0)) && [[ "$(rawget "$tokfile" PPM_FORGEJO_TOKEN)" == "$tok" && "$out" != *"$tok"* && "$(file_mode "$tokfile")" == 600 ]] \
  && pass "set-secret writes PPM_FORGEJO_TOKEN from stdin (never printed, file stays 600)" || fail "set-secret: rc=$rc"
before="$(file_sum "$tokfile")"
out="$(printf 'nope\n' | "$envtool" set-secret "$tokfile" PPM_FORGEJO_TOKEN 2>&1)" && rc=0 || rc=$?
((rc != 0)) && [[ "$(file_sum "$tokfile")" == "$before" ]] && pass "  ... refuses a value that is not a token (file unchanged)" \
  || fail "  ... accepted a malformed token"
out="$(printf '%s\n' "$tok" | "$envtool" set-secret "$tokfile" SECRET_KEY 2>&1)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"only writes PPM_FORGEJO_TOKEN"* ]] && pass "  ... writes no other secret" || fail "  ... set-secret SECRET_KEY: rc=$rc"

echo "ppm-env.sh — sign-in through PPM (single sign-on, G2.2 R23)"
SSO_KEYS=(PPM_GIT_SSO_ENABLED PPM_GIT_LOCAL_SIGNIN PPM_OIDC_CLIENT_ID PPM_OIDC_PRIVATE_KEY PPM_OIDC_PREVIOUS_PRIVATE_KEY
  PPM_OIDC_CLIENT_SECRET PPM_FORGEJO_ADMIN_TOKEN PPM_FORGEJO_SSO_SOURCE_ID)
key_bits() { # base64 of a PEM private key → bits of its RSA modulus ("" for anything else); the key is never printed
  local text
  text="$(printf '%s' "$1" | base64 -d 2>/dev/null | openssl pkey -passin pass: -pubout 2>/dev/null \
    | openssl pkey -pubin -noout -text 2>/dev/null)" || true
  [[ "$text" == *Modulus* ]] && sed -n 's/.*Public-Key: (\([0-9]*\) bit).*/\1/p' <<<"$text" | head -n1
}
pem_head() { printf '%s' "$1" | base64 -d 2>/dev/null | head -n1; }
new_key() { openssl genpkey -algorithm "$1" -pkeyopt "$2" 2>/dev/null | base64 | tr -d '\n'; }
if [[ "$(rawget "$genv" PPM_GIT_SSO_ENABLED)" == 1 && "$(rawget "$genv" PPM_GIT_LOCAL_SIGNIN)" == 0 \
      && "$(rawget "$genv" PPM_OIDC_CLIENT_ID)" == forgejo && -z "$(rawget "$genv" PPM_FORGEJO_ADMIN_TOKEN)" \
      && -z "$(rawget "$genv" PPM_FORGEJO_SSO_SOURCE_ID)" && -z "$(rawget "$genv" PPM_OIDC_PREVIOUS_PRIVATE_KEY)" ]] \
    && grep -q '^PPM_OIDC_PREVIOUS_PRIVATE_KEY=$' "$genv"; then
  pass "init switches sign-in through PPM on: SSO 1, password form 0, client forgejo; admin token and source id empty"
else fail "init SSO keys: $(grep -E '^(PPM_GIT_SSO|PPM_GIT_LOCAL|PPM_OIDC_CLIENT_ID|PPM_FORGEJO_SSO)' "$genv" | tr '\n' ' ')"; fi
key="$(rawget "$genv" PPM_OIDC_PRIVATE_KEY)" secret="$(rawget "$genv" PPM_OIDC_CLIENT_SECRET)"
[[ "$key" =~ ^[A-Za-z0-9+/]+={0,2}$ && "$(key_bits "$key")" == 3072 && "$(pem_head "$key")" == "-----BEGIN "*"PRIVATE KEY-----" \
   && "$secret" =~ ^[0-9a-f]{48}$ ]] \
  && pass "  ... signing key: RSA 3072, the PEM in base64 on one line; client secret: 48 hex" \
  || fail "  ... key bits '$(key_bits "$key")', secret length ${#secret}"
[[ "$initout" != *"$key"* && "$initout" != *"$secret"* && "$initout" == *PPM_OIDC_PRIVATE_KEY* && "$initout" == *PPM_OIDC_CLIENT_SECRET* ]] \
  && pass "  ... init names both generated values and prints neither" || fail "  ... init output about the SSO secrets"
[[ -z "$(find "$tmp" -maxdepth 1 \( -name '*.pem' -o -name '*.key' -o -name '.ppm-env.*' \))" ]] \
  && pass "  ... no key file or leftover next to the env (the key goes straight into it)" \
  || fail "  ... stray files: $(find "$tmp" -maxdepth 1 \( -name '*.pem' -o -name '*.key' -o -name '.ppm-env.*' \) | tr '\n' ' ')"
for key in PPM_OIDC_PRIVATE_KEY PPM_OIDC_PREVIOUS_PRIVATE_KEY PPM_OIDC_CLIENT_SECRET PPM_FORGEJO_ADMIN_TOKEN; do
  expect_fail "get refuses $key" "refusing to print secret" "$envtool" get "$genv" "$key"
done
expect_fail "set refuses PPM_OIDC_CLIENT_SECRET" "refusing to change secret" "$envtool" set "$genv" PPM_OIDC_CLIENT_SECRET x
expect_ok "check: sign-in through PPM is named in the summary" "sign-in through PPM" "$envtool" check "$genv"
expect_ok "  ... and git-bootstrap is due while the admin token and source id are empty" \
  "PPM_FORGEJO_SSO_SOURCE_ID are empty" "$envtool" check "$genv"

rc2="$tmp/rc2.env"; cp -p "$genv" "$rc2"; cp -p "$tmp/git.backup-passphrase" "$tmp/rc2.backup-passphrase"
rawput "$rc2" PPM_BACKUP_PASSPHRASE_FILE rc2.backup-passphrase
grep -v -E '^(PPM_GIT_SSO_ENABLED|PPM_GIT_LOCAL_SIGNIN|PPM_OIDC_|PPM_FORGEJO_ADMIN_TOKEN|PPM_FORGEJO_SSO_SOURCE_ID|# ---- Sign-in through PPM)' \
  "$rc2" >"$rc2.tmp" && mv -f "$rc2.tmp" "$rc2" && chmod 600 "$rc2"
expect_ok "check: an RC.2 env (Git server, no sign-in keys) stays valid" "Git server git.gitcli.example.test on" "$envtool" check "$rc2"
expect_ok "  ... and explains how to add sign-in through PPM" "ppm-env.sh add-sso $rc2" "$envtool" check "$rc2"
rc2_size="$(wc -c <"$rc2" | tr -d ' ')"; rc2_sum="$(file_sum "$rc2")"; cp -p "$rc2" "$tmp/rc2.orig"
out="$(run "$envtool" add-sso "$rc2")" && rc=0 || rc=$?
if ((rc == 0)) && [[ "$(head -c "$rc2_size" "$rc2" | file_sum /dev/stdin)" == "$rc2_sum" ]]; then
  pass "add-sso keeps every existing byte of the RC.2 file (only appends)"
else fail "add-sso changed the existing content (rc=$rc): $(tail -n 2 <<<"$out" | tr '\n' ' ')"; fi
missing=""; for key in "${SSO_KEYS[@]}"; do grep -q "^$key=" "$rc2" || missing+=" $key"; done
[[ -z "$missing" && "$(rawget "$rc2" PPM_GIT_SSO_ENABLED)" == 1 && "$(rawget "$rc2" PPM_GIT_LOCAL_SIGNIN)" == 0 ]] \
  && pass "  ... adds every sign-in key, switched on, password form off" || fail "  ... missing after add-sso:$missing"
key="$(rawget "$rc2" PPM_OIDC_PRIVATE_KEY)" secret="$(rawget "$rc2" PPM_OIDC_CLIENT_SECRET)"
[[ "$(key_bits "$key")" == 3072 && "$secret" =~ ^[0-9a-f]{48}$ && "$key" != "$(rawget "$genv" PPM_OIDC_PRIVATE_KEY)" ]] \
  && pass "  ... generates its own RSA 3072 signing key and 48-hex client secret" || fail "  ... generated key/secret malformed"
[[ "$out" != *"$key"* && "$out" != *"$secret"* && "$out" == *"PPM_OIDC_PRIVATE_KEY"* && "$out" == *"git-bootstrap"* ]] \
  && pass "  ... names the generated values (not printed) and the next steps (up, git-bootstrap)" \
  || fail "  ... add-sso output: $(tail -n 3 <<<"$out" | tr '\n' ' ')"
[[ "$(file_mode "$rc2")" == 600 ]] && pass "  ... file stays mode 600" || fail "  ... mode $(file_mode "$rc2")"
expect_ok "  ... the result is valid with sign-in through PPM" "sign-in through PPM" "$envtool" check "$rc2"
before="$(file_sum "$rc2")"
expect_ok "add-sso again adds nothing" "nothing to add" "$envtool" add-sso "$rc2"
[[ "$(file_sum "$rc2")" == "$before" ]] && pass "  ... and leaves the file byte-identical" || fail "  ... the file changed"
nogit="$tmp/nogit.env"; cp -p "$tmp/rc1.orig" "$nogit"; cp -p "$tmp/rc1.backup-passphrase" "$tmp/nogit.backup-passphrase"
rawput "$nogit" PPM_BACKUP_PASSPHRASE_FILE nogit.backup-passphrase; before="$(file_sum "$nogit")"
expect_fail "add-sso refuses an env without the Git server keys (RC.1): add-git first" "ppm-env.sh add-git $nogit" \
  "$envtool" add-sso "$nogit"
[[ "$(file_sum "$nogit")" == "$before" ]] && pass "  ... and does not touch it" || fail "  ... the RC.1 file changed"
gitoff="$tmp/gitoff.env"; cp -p "$tmp/rc2.orig" "$gitoff"; cp -p "$tmp/rc2.backup-passphrase" "$tmp/gitoff.backup-passphrase"
rawput "$gitoff" PPM_BACKUP_PASSPHRASE_FILE gitoff.backup-passphrase; rawput "$gitoff" PPM_GIT_SERVER_ENABLED 0
before="$(file_sum "$gitoff")"
expect_fail "add-sso refuses while the Git server is off (PPM_GIT_SERVER_ENABLED=0)" "PPM_GIT_SERVER_ENABLED 1" \
  "$envtool" add-sso "$gitoff"
[[ "$(file_sum "$gitoff")" == "$before" ]] && pass "  ... and does not touch it" || fail "  ... the file changed"
kept="$tmp/kept.env"; cp -p "$tmp/rc2.orig" "$kept"; cp -p "$tmp/rc2.backup-passphrase" "$tmp/kept.backup-passphrase"
rawput "$kept" PPM_BACKUP_PASSPHRASE_FILE kept.backup-passphrase; rawput "$kept" PPM_GIT_SSO_ENABLED 0
expect_ok "add-sso keeps PPM_GIT_SSO_ENABLED=0 and says how to switch on" "PPM_GIT_SSO_ENABLED 1" "$envtool" add-sso "$kept"
[[ "$(rawget "$kept" PPM_GIT_SSO_ENABLED)" == 0 && -n "$(rawget "$kept" PPM_OIDC_CLIENT_SECRET)" ]] \
  && pass "  ... the value 0 is kept, the missing keys are added" || fail "  ... PPM_GIT_SSO_ENABLED=$(rawget "$kept" PPM_GIT_SSO_ENABLED)"
expect_ok "  ... an env with sign-in through PPM off is valid" "single sign-on off" "$envtool" check "$kept"
out="$(run "$envtool" add-sso "$tmp/none.env")" && rc=0 || rc=$?
((rc != 0)) && [[ ! -e "$tmp/none.env" ]] && pass "add-sso refuses a missing file (creates nothing)" || fail "add-sso on a missing file: rc=$rc"

broken "check refuses PPM_GIT_SSO_ENABLED other than 0/1" "PPM_GIT_SSO_ENABLED must be" PPM_GIT_SSO_ENABLED yes
broken "check refuses PPM_GIT_LOCAL_SIGNIN other than 0/1" "PPM_GIT_LOCAL_SIGNIN must be" PPM_GIT_LOCAL_SIGNIN on
broken "check refuses sign-in through PPM without the Git server" "needs the Git server" PPM_GIT_SERVER_ENABLED 0
broken "check refuses a signing key that is not base64 of a PEM private key" "PPM_OIDC_PRIVATE_KEY" \
  PPM_OIDC_PRIVATE_KEY not-a-key
broken "check refuses an RSA signing key under 2048 bits" "PPM_OIDC_PRIVATE_KEY" \
  PPM_OIDC_PRIVATE_KEY "$(new_key RSA rsa_keygen_bits:1024)"
broken "check refuses an EC signing key (RS256 needs RSA)" "PPM_OIDC_PRIVATE_KEY" \
  PPM_OIDC_PRIVATE_KEY "$(new_key EC ec_paramgen_curve:P-256)"
broken "check refuses a previous signing key equal to the current one" "PPM_OIDC_PREVIOUS_PRIVATE_KEY" \
  PPM_OIDC_PREVIOUS_PRIVATE_KEY "$(rawget "$genv" PPM_OIDC_PRIVATE_KEY)"
broken "check refuses a short client secret" "PPM_OIDC_CLIENT_SECRET" PPM_OIDC_CLIENT_SECRET abc123
broken "check refuses a client secret with special characters" "PPM_OIDC_CLIENT_SECRET" \
  PPM_OIDC_CLIENT_SECRET "$(openssl rand -hex 24)+/="
broken "check refuses a client secret that is not hex (PPM's provider needs at least 32 hex digits)" "hex digits" \
  PPM_OIDC_CLIENT_SECRET "$(openssl rand -hex 16)ghijklmnopqrstuv"
broken "check refuses a client id with spaces" "PPM_OIDC_CLIENT_ID" PPM_OIDC_CLIENT_ID "bad id"
broken "check refuses a malformed admin token" "PPM_FORGEJO_ADMIN_TOKEN" PPM_FORGEJO_ADMIN_TOKEN not-a-token
broken "check refuses a non-numeric login source id" "PPM_FORGEJO_SSO_SOURCE_ID" PPM_FORGEJO_SSO_SOURCE_ID abc
broken "check refuses login source id 0" "PPM_FORGEJO_SSO_SOURCE_ID" PPM_FORGEJO_SSO_SOURCE_ID 0
nosecret="$tmp/nosecret.env"; cp -p "$genv" "$nosecret"; cp -p "$tmp/git.backup-passphrase" "$tmp/nosecret.backup-passphrase"
rawput "$nosecret" PPM_BACKUP_PASSPHRASE_FILE nosecret.backup-passphrase
grep -v '^PPM_OIDC_CLIENT_SECRET=' "$nosecret" >"$nosecret.tmp" && mv -f "$nosecret.tmp" "$nosecret" && chmod 600 "$nosecret"
expect_fail "check refuses sign-in through PPM with a key missing" "PPM_OIDC_CLIENT_SECRET is missing" "$envtool" check "$nosecret"
emerg="$tmp/emerg.env"; cp -p "$genv" "$emerg"; cp -p "$tmp/git.backup-passphrase" "$tmp/emerg.backup-passphrase"
rawput "$emerg" PPM_BACKUP_PASSPHRASE_FILE emerg.backup-passphrase; rawput "$emerg" PPM_GIT_LOCAL_SIGNIN 1
expect_ok "the emergency password form (PPM_GIT_LOCAL_SIGNIN=1) is valid, with a reminder to switch it off" \
  "PPM_GIT_LOCAL_SIGNIN 0" "$envtool" check "$emerg"

atok="$(openssl rand -hex 20)"
out="$(printf '%s\n' "$atok" | "$envtool" set-secret "$tokfile" PPM_FORGEJO_ADMIN_TOKEN 2>&1)" && rc=0 || rc=$?
((rc == 0)) && [[ "$(rawget "$tokfile" PPM_FORGEJO_ADMIN_TOKEN)" == "$atok" && "$out" != *"$atok"* && "$(file_mode "$tokfile")" == 600 ]] \
  && pass "set-secret writes PPM_FORGEJO_ADMIN_TOKEN from stdin (never printed, file stays 600)" || fail "set-secret admin: rc=$rc"
before="$(file_sum "$tokfile")"
out="$(printf 'nope\n' | "$envtool" set-secret "$tokfile" PPM_FORGEJO_ADMIN_TOKEN 2>&1)" && rc=0 || rc=$?
((rc != 0)) && [[ "$(file_sum "$tokfile")" == "$before" ]] && pass "  ... refuses a value that is not a token (file unchanged)" \
  || fail "  ... accepted a malformed admin token"
out="$(printf '\n' | "$envtool" set-secret "$tokfile" PPM_FORGEJO_ADMIN_TOKEN 2>&1)" && rc=0 || rc=$?
((rc == 0)) && grep -q '^PPM_FORGEJO_ADMIN_TOKEN=$' "$tokfile" \
  && pass "  ... an empty value clears it (git-bootstrap after sign-in through PPM is switched off)" || fail "  ... clearing: rc=$rc"

rot="$tmp/rot.env"; cp -p "$genv" "$rot"; cp -p "$tmp/git.backup-passphrase" "$tmp/rot.backup-passphrase"
rawput "$rot" PPM_BACKUP_PASSPHRASE_FILE rot.backup-passphrase
others() { grep -v -E '^PPM_OIDC_(PRIVATE_KEY|PREVIOUS_PRIVATE_KEY|CLIENT_SECRET)=' "$1" | file_sum /dev/stdin; }
old_key="$(rawget "$rot" PPM_OIDC_PRIVATE_KEY)" old_secret="$(rawget "$rot" PPM_OIDC_CLIENT_SECRET)" rest="$(others "$rot")"
out="$(run "$envtool" rotate-sso-key "$rot")" && rc=0 || rc=$?
key="$(rawget "$rot" PPM_OIDC_PRIVATE_KEY)"
((rc == 0)) && [[ "$(rawget "$rot" PPM_OIDC_PREVIOUS_PRIVATE_KEY)" == "$old_key" && "$key" != "$old_key" \
   && "$(key_bits "$key")" == 3072 && "$out" != *"$key"* && "$out" != *"$old_key"* && "$out" == *"--finish"* ]] \
  && pass "rotate-sso-key: a new RSA 3072 key, the old one kept as the previous key (JWKS), nothing printed" \
  || fail "rotate-sso-key: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
[[ "$(others "$rot")" == "$rest" && "$(file_mode "$rot")" == 600 ]] && pass "  ... every other line is unchanged, mode 600" \
  || fail "  ... other lines changed"
before="$(file_sum "$rot")"
expect_fail "  ... a second rotation before --finish is refused" "--finish" "$envtool" rotate-sso-key "$rot"
[[ "$(file_sum "$rot")" == "$before" ]] && pass "  ... (file unchanged)" || fail "  ... the refused rotation changed the file"
out="$(run "$envtool" rotate-sso-key "$rot" --finish)" && rc=0 || rc=$?
((rc == 0)) && grep -q '^PPM_OIDC_PREVIOUS_PRIVATE_KEY=$' "$rot" && [[ "$(rawget "$rot" PPM_OIDC_PRIVATE_KEY)" == "$key" ]] \
  && pass "rotate-sso-key --finish drops the previous key and keeps the new one" || fail "rotate --finish: rc=$rc"
out="$(run "$envtool" rotate-sso-secret "$rot")" && rc=0 || rc=$?
secret="$(rawget "$rot" PPM_OIDC_CLIENT_SECRET)"
((rc == 0)) && [[ "$secret" =~ ^[0-9a-f]{48}$ && "$secret" != "$old_secret" && "$out" != *"$secret"* && "$out" == *"git-bootstrap"* \
   && "$(others "$rot")" == "$rest" ]] \
  && pass "rotate-sso-secret: a new 48-hex client secret, nothing printed, the next steps named (up, git-bootstrap)" \
  || fail "rotate-sso-secret: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
expect_ok "  ... the rotated env is valid" "sign-in through PPM" "$envtool" check "$rot"
expect_fail "rotate-sso-key refuses an env without sign-in keys" "ppm-env.sh add-sso" "$envtool" rotate-sso-key "$tmp/rc2.orig"
expect_fail "rotate-sso-secret refuses an env without sign-in keys" "ppm-env.sh add-sso" "$envtool" rotate-sso-secret "$tmp/rc2.orig"

echo "Compose — Git server services (docker compose config only)"
compose_json() { "$deploy" --env-file "$1" compose --profile tools config --format json 2>/dev/null; }  # tools: forgejo-tools
gitcfg="$(compose_json "$genv" | python3 -c '
import json, sys
c = json.load(sys.stdin); s = c["services"]
f = s.get("forgejo", {}); env = f.get("environment", {})
ports = sorted((p.get("host_ip", ""), str(p.get("published", "")), p.get("target")) for p in f.get("ports", []))
want = {"FORGEJO__security__INSTALL_LOCK": "true", "FORGEJO__service__DISABLE_REGISTRATION": "true",
        "FORGEJO__service__REQUIRE_SIGNIN_VIEW": "true", "FORGEJO__server__OFFLINE_MODE": "true",
        "FORGEJO__service__DEFAULT_ALLOW_CREATE_ORGANIZATION": "false", "FORGEJO__service__DEFAULT_ORG_VISIBILITY": "private",
        "FORGEJO__service__ENABLE_NOTIFY_MAIL": "false", "FORGEJO__repository__DEFAULT_PRIVATE": "private",
        "FORGEJO__repository__ENABLE_PUSH_CREATE_USER": "true", "FORGEJO__repository__ENABLE_PUSH_CREATE_ORG": "true",
        "FORGEJO__repository__DEFAULT_PUSH_CREATE_PRIVATE": "true", "FORGEJO__webhook__ALLOWED_HOST_LIST": "api",
        "FORGEJO__mailer__ENABLED": "false", "FORGEJO__cron_0X2E_update_checker__ENABLED": "false",
        "FORGEJO__actions__ENABLED": "false", "FORGEJO__packages__ENABLED": "false", "FORGEJO__federation__ENABLED": "false",
        "FORGEJO__session__COOKIE_SECURE": "true", "FORGEJO__oauth2__ENABLED": "false", "FORGEJO__mirror__ENABLED": "false",
        "FORGEJO__server__SSH_LISTEN_PORT": "2222", "FORGEJO__server__SSH_PORT": "2222", "FORGEJO__server__START_SSH_SERVER": "true",
        "FORGEJO__server__DISABLE_SSH": "false", "FORGEJO__server__LFS_START_SERVER": "true",
        "FORGEJO__server__ROOT_URL": "https://git.gitcli.example.test:8443/", "FORGEJO__server__DOMAIN": "git.gitcli.example.test",
        "FORGEJO__database__HOST": "plane-db:5432", "FORGEJO__database__NAME": "forgejo", "FORGEJO__database__USER": "forgejo",
        "FORGEJO__security__DISABLE_QUERY_AUTH_TOKEN": "true", "FORGEJO__log__LOGGER_ROUTER_MODE": "",
        "FORGEJO__proxy__PROXY_ENABLED": "false", "FORGEJO__repository__DISABLE_MIGRATIONS": "false"}
wrong = sorted(k for k, v in want.items() if env.get(k) != v)
secrets_set = all(env.get(k) for k in ("FORGEJO__database__PASSWD", "FORGEJO__security__SECRET_KEY",
    "FORGEJO__security__INTERNAL_TOKEN", "FORGEJO__oauth2__JWT_SECRET", "FORGEJO__server__LFS_JWT_SECRET"))
app = all(s[n]["environment"].get("PPM_FORGEJO_URL") == "http://forgejo:3000"
          and s[n]["environment"].get("PPM_FORGEJO_PUBLIC_URL") == "https://git.gitcli.example.test:8443"
          and s[n]["environment"].get("PPM_FORGEJO_WEBHOOK_SECRET") and "PPM_FORGEJO_TOKEN" in s[n]["environment"]
          for n in ("api", "worker", "beat-worker"))
proxy = s["proxy"]; aliases = proxy["networks"]["default"].get("aliases", [])
print("image-pinned" if "@sha256:" in f.get("image", "") else "image-unpinned")
print("ports", ports)
print("env-wrong", wrong)
print("secrets-set", secrets_set)
print("app-env", app, "migrator-clean", not any(k.startswith("PPM_FORGEJO") for k in s["migrator"]["environment"]))
print("proxy", proxy["environment"].get("PPM_GIT_SERVER_ENABLED"), sorted(aliases))
print("db-init", f.get("depends_on", {}).get("forgejo-db-init", {}).get("condition"), s.get("forgejo-db-init", {}).get("image", "").split("@")[0].rsplit("/", 1)[-1])
print("tmpfs", f.get("tmpfs"), "caps", f.get("cap_drop"), f.get("security_opt"))
print("tools", s.get("forgejo-tools", {}).get("network_mode"), sorted(s.get("forgejo-tools", {}).get("profiles", [])))
')"
[[ "$gitcfg" == *"image-pinned"* ]] && pass "Forgejo runs the digest-pinned image" || fail "Forgejo image: $gitcfg"
[[ "$gitcfg" == *"ports [('127.0.0.1', '2222', 2222)]"* ]] \
  && pass "  ... publishes only SSH, on PPM_BIND_ADDRESS (127.0.0.1); port 3000 nowhere" || fail "  ... ports: $(grep ports <<<"$gitcfg")"
[[ "$gitcfg" == *"env-wrong []"* ]] && pass "  ... FORGEJO__ settings as required (R14; closed, offline, private, webhooks only to api)" \
  || fail "  ... settings differ: $(grep env-wrong <<<"$gitcfg")"
[[ "$gitcfg" == *"secrets-set True"* ]] && pass "  ... DB password, SECRET_KEY, INTERNAL_TOKEN and both JWT secrets come from the env" \
  || fail "  ... a Forgejo secret is not passed"
[[ "$gitcfg" == *"app-env True migrator-clean True"* ]] \
  && pass "  ... api/worker/beat-worker get PPM_FORGEJO_URL (in-network), public URL, webhook secret, token; migrator none" \
  || fail "  ... PPM_FORGEJO_*: $(grep app-env <<<"$gitcfg")"
[[ "$gitcfg" == *"proxy 1 ['git.gitcli.example.test', 'gitcli.example.test']"* ]] \
  && pass "  ... the proxy serves the Git site and carries the Git host as a network alias" || fail "  ... proxy: $(grep proxy <<<"$gitcfg")"
[[ "$gitcfg" == *"db-init service_completed_successfully postgres:15.7-alpine"* ]] \
  && pass "  ... Forgejo starts only after forgejo-db-init (same pinned PostgreSQL image)" || fail "  ... $(grep db-init <<<"$gitcfg")"
[[ "$gitcfg" == *"tmpfs ['/etc/forgejo:uid=1000,gid=1000,mode=0700'] caps ['ALL'] ['no-new-privileges:true']"* ]] \
  && pass "  ... app.ini in a tmpfs (no secret in the data volume); no capabilities, no-new-privileges" \
  || fail "  ... $(grep tmpfs <<<"$gitcfg")"
[[ "$gitcfg" == *"tools none ['tools']"* ]] && pass "  ... forgejo-tools (backup/restore) has no network and runs only on demand" \
  || fail "  ... $(grep tools <<<"$gitcfg")"
nossh="$tmp/nossh.env"; cp -p "$genv" "$nossh"; cp -p "$tmp/git.backup-passphrase" "$tmp/nossh.backup-passphrase"
rawput "$nossh" PPM_BACKUP_PASSPHRASE_FILE nossh.backup-passphrase; rawput "$nossh" PPM_GIT_SSH_ENABLED 0
cfg="$(compose_json "$nossh" | python3 -c '
import json, sys
f = json.load(sys.stdin)["services"]["forgejo"]
print(len(f.get("ports", [])), f["environment"]["FORGEJO__server__DISABLE_SSH"], f["environment"]["FORGEJO__server__START_SSH_SERVER"])')"
[[ "$cfg" == "0 true false" ]] && pass "PPM_GIT_SSH_ENABLED=0: no SSH server, no published port" || fail "SSH off: $cfg"
cfg="$(compose_json "$pubgit" | python3 -c '
import json, sys
f = json.load(sys.stdin)["services"]["forgejo"]
print(sorted(p.get("host_ip", "") for p in f.get("ports", [])))')"
[[ "$cfg" == "['0.0.0.0']" ]] && pass "the public phase publishes SSH on 0.0.0.0 (like the proxy)" || fail "public SSH: $cfg"
cp -p "$tmp/rc1.orig" "$tmp/rc1b.env"; cp -p "$tmp/rc1.backup-passphrase" "$tmp/rc1b.backup-passphrase"
rawput "$tmp/rc1b.env" PPM_BACKUP_PASSPHRASE_FILE rc1b.backup-passphrase
cfg="$(compose_json "$tmp/rc1b.env" | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
print(sorted(n for n in s if "forgejo" in n), any(k.startswith("PPM_FORGEJO") for k in s["api"]["environment"]),
      "PPM_GIT_SERVER_ENABLED" in s["proxy"]["environment"])')"
[[ "$cfg" == "[] False False" ]] && pass "an RC.1 env (no Git keys): no Forgejo service, no PPM_FORGEJO_* in the API, no Git site" \
  || fail "RC.1 env compose: $cfg"
mkdir -p "$PPM_RUNTIME_DIR/ppm-cli-git"; : >"$PPM_RUNTIME_DIR/ppm-cli-git/no-workers"
cfg="$(compose_json "$genv" | python3 -c '
import json, sys
e = json.load(sys.stdin)["services"]["forgejo"]["environment"]
print(e["FORGEJO__proxy__PROXY_ENABLED"], e["FORGEJO__proxy__PROXY_URL"], e["FORGEJO__repository__DISABLE_MIGRATIONS"],
      e["FORGEJO__cron_0X2E_sync_external_users__ENABLED"])')"
rm -f "$PPM_RUNTIME_DIR/ppm-cli-git/no-workers"
[[ "$cfg" == "true http://127.0.0.1:9/ true false" ]] \
  && pass "a restore-drill copy: Forgejo egress to a closed local port, migrations and external sync off" || fail "drill copy Forgejo: $cfg"

echo "Compose — sign-in through PPM (docker-compose.git-sso.yml, R24)"
sso_cfg() { # env file → one line per fact, for the sign-in overlay
  compose_json "$1" | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]; f = s["forgejo"]["environment"]
keys = ("FORGEJO__oauth2_client__ENABLE_AUTO_REGISTRATION", "FORGEJO__oauth2_client__ACCOUNT_LINKING",
        "FORGEJO__oauth2_client__USERNAME", "FORGEJO__oauth2_client__UPDATE_AVATAR", "FORGEJO__service__ENABLE_INTERNAL_SIGNIN")
print("forgejo", ",".join(f.get(k, "-") for k in keys), f.get("FORGEJO__oauth2__ENABLED"),
      "basic:" + f.get("FORGEJO__service__ENABLE_BASIC_AUTHENTICATION", "default"))
app = ("PPM_GIT_SSO_ENABLED", "PPM_OIDC_CLIENT_ID", "PPM_OIDC_INTERNAL_URL")
secret = ("PPM_OIDC_CLIENT_SECRET", "PPM_OIDC_PRIVATE_KEY")
later = ("PPM_OIDC_PREVIOUS_PRIVATE_KEY", "PPM_FORGEJO_ADMIN_TOKEN", "PPM_FORGEJO_SSO_SOURCE_ID")
for n in ("api", "worker", "beat-worker"):
    e = s[n]["environment"]
    print(n, ",".join(str(e.get(k, "-")) for k in app), all(e.get(k) for k in secret), all(k in e for k in later))
leak = sorted(n for n in s if n not in ("api", "worker", "beat-worker")
              and any(k.startswith("PPM_OIDC") or k in ("PPM_GIT_SSO_ENABLED", "PPM_FORGEJO_ADMIN_TOKEN")
                      for k in (s[n].get("environment") or {})))
print("elsewhere", leak)'
}
cfg="$(sso_cfg "$genv")"
[[ "$cfg" == *"forgejo false,disabled,nickname,false,0 false basic:default"* ]] \
  && pass "sign-in on: Forgejo creates and links no account itself, name from nickname, no avatars; password form off; [oauth2] and Basic auth unchanged" \
  || fail "sign-in on, Forgejo: $(grep '^forgejo' <<<"$cfg")"
[[ "$(grep -c '^\(api\|worker\|beat-worker\) 1,forgejo,http://api:8000 True True$' <<<"$cfg")" == 3 ]] \
  && pass "  ... api/worker/beat-worker get the switch, client, internal URL, key, secret, admin token and source id" \
  || fail "  ... app env: $(grep -E '^(api|worker|beat-worker) ' <<<"$cfg" | tr '\n' ';')"
[[ "$cfg" == *"elsewhere []"* ]] && pass "  ... no other service (migrator, live, web, tools) gets any of them" \
  || fail "  ... also in: $(grep elsewhere <<<"$cfg")"
[[ "$(sso_cfg "$emerg")" == *"forgejo false,disabled,nickname,false,1 "* ]] \
  && pass "PPM_GIT_LOCAL_SIGNIN=1: the password form is back (ENABLE_INTERNAL_SIGNIN=1), sign-in through PPM stays" \
  || fail "emergency sign-in: $(sso_cfg "$emerg" | grep '^forgejo')"
ssooff="$tmp/ssooff.env"; cp -p "$genv" "$ssooff"; cp -p "$tmp/git.backup-passphrase" "$tmp/ssooff.backup-passphrase"
rawput "$ssooff" PPM_BACKUP_PASSPHRASE_FILE ssooff.backup-passphrase; rawput "$ssooff" PPM_GIT_SSO_ENABLED 0
for pair in "ssooff:$ssooff" "rc2:$tmp/rc2.orig"; do
  cfg="$(sso_cfg "${pair#*:}")"
  [[ "$cfg" == *"forgejo -,-,-,-,- false basic:default"* && "$(grep -c '^\(api\|worker\|beat-worker\) -,-,- False False$' <<<"$cfg")" == 3 ]] \
    && pass "sign-in off (${pair%%:*}): Forgejo as in G2.1 (its password form), the API gets none of the sign-in keys" \
    || fail "sign-in off (${pair%%:*}): $(tr '\n' ';' <<<"$cfg")"
done

echo "Git server — proxy site, database init, bootstrap tool"
git_site="$bundle_dir/proxy/git-server-1.caddy"
# shellcheck disable=SC2016  # Caddy placeholders, matched literally
if grep -q 'import ppm_log_redaction' "$git_site" && ! grep -q 'X-Frame-Options "' "$git_site" \
    && grep -q 'max_size {$PPM_GIT_MAX_BODY_SIZE:1GB}' "$git_site" && grep -q 'reverse_proxy forgejo:3000' "$git_site" \
    && grep -q '^import /etc/caddy/git-server-{$PPM_GIT_SERVER_ENABLED:0}.caddy$' "$bundle_dir/proxy/Caddyfile" \
    && ! grep -qv '^#' "$bundle_dir/proxy/git-server-0.caddy"; then
  pass "Git site: same log redaction, own body limit, no proxy X-Frame-Options; imported only with the flag"
else fail "proxy/git-server-*.caddy"; fi
dbinit="$bundle_dir/forgejo/db-init.sql"
if grep -q '^\\getenv forgejo_password FORGEJO_DB_PASSWORD$' "$dbinit" && grep -q "log_min_error_statement = 'panic'" "$dbinit" \
    && ! grep -Eq "PASSWORD '[^']" "$dbinit"; then
  pass "forgejo-db-init reads the password from the environment and logs no statement"
else fail "forgejo/db-init.sql"; fi
pyout="$(python3 "$bundle_dir/tests/git_bootstrap_test.py" 2>&1)" && rc=0 || rc=$?
printf '%s\n' "$pyout" | grep -E '^  (ok|FAIL) '
py_passed="$(sed -n 's/^git-bootstrap-test: \([0-9]*\) passed, \([0-9]*\) failed$/\1/p' <<<"$pyout")"
py_failed="$(sed -n 's/^git-bootstrap-test: \([0-9]*\) passed, \([0-9]*\) failed$/\2/p' <<<"$pyout")"
if [[ -n "$py_passed" ]]; then passed=$((passed + py_passed)); failed=$((failed + py_failed))
else fail "git_bootstrap_test.py did not run (rc=$rc): $(tail -n 2 <<<"$pyout" | tr '\n' ' ')"; fi

echo "ppm-deploy.sh — arguments"
expect_ok "--env-file after the command is honoured" "env $drill (--env-file)" "$deploy" config --env-file "$drill"
expect_ok "--env-file=FILE form is honoured" "env $drill (--env-file)" "$deploy" --env-file="$drill" config
expect_fail "--env-file twice is an error" "--env-file given twice" "$deploy" --env-file "$drill" status --env-file "$prod"
expect_fail "--env-file without a value is an error" "--env-file needs a path" "$deploy" status --env-file
expect_fail "unknown command" "unknown command 'frobnicate'" "$deploy" --env-file "$drill" frobnicate
expect_fail "unknown option of a command" "'status' takes no arguments" "$deploy" --env-file "$drill" status --all
expect_fail "unknown option of up" "'up' takes no arguments" "$deploy" --env-file "$drill" up --force
expect_fail "--env-file inside pass-through is ambiguous" "must come before 'compose'" \
  "$deploy" compose ps --env-file "$drill"
expect_fail "release needs a name" "release needs exactly one release name" "$deploy" --env-file "$drill" release
expect_fail "release name must be a tag" "must be a Docker tag" "$deploy" --env-file "$drill" release 'rc 1;'
expect_fail "logs: unknown service/option" "unknown service or option '--follow'" \
  "$deploy" --env-file "$drill" logs --follow
expect_fail "smoke needs a mode" "smoke needs a mode" "$deploy" --env-file "$drill" smoke
expect_fail "smoke: unknown mode" "unknown smoke mode 'nuke'" "$deploy" --env-file "$drill" smoke nuke
expect_fail "smoke extend needs a label" "smoke extend needs one label" "$deploy" --env-file "$drill" smoke extend
expect_fail "claim-admin: unknown option" "claim-admin: unknown option '--password'" \
  "$deploy" --env-file "$drill" claim-admin --password secret
expect_fail "claim-admin refuses without a terminal" "run it in a terminal" "$deploy" --env-file "$drill" claim-admin
expect_ok "scan-logs self-test catches every planted class" "self-test passed" \
  "$deploy" --env-file "$drill" scan-logs --self-test
expect_ok "  ... also with the Git server secrets of a Git env" "self-test passed" "$deploy" --env-file "$genv" scan-logs --self-test
out="$(run "$deploy" --env-file "$genv" scan-logs --self-test)" && rc=0 || rc=$?
((rc == 0)) && [[ "$out" == *"secret:PPM_OIDC_PRIVATE_KEY"* && "$out" == *"secret:PPM_OIDC_CLIENT_SECRET"* \
   && "$out" == *"pattern:oidc-continue-path"* ]] \
  && pass "  ... and with the sign-in keys (signing key, client secret) and the one-time sign-in link /auth/oidc/continue/<id>/" \
  || fail "  ... sign-in in the scan: rc=$rc, got: $(grep -E 'OIDC|continue' <<<"$out" | tr '\n' ' ')"
expect_fail "git-bootstrap: unknown option" "git-bootstrap: unknown option '--force'" "$deploy" --env-file "$genv" git-bootstrap --force
expect_fail "git-bootstrap refuses when the Git server is off" "the Git server is off" \
  fake "$deploy" --env-file "$tmp/rc1b.env" git-bootstrap
expect_fail "git-admin needs --username and --email" "git-admin needs --username" "$deploy" --env-file "$genv" git-admin
expect_fail "git-admin: invalid user name" "not a valid Forgejo user name" \
  "$deploy" --env-file "$genv" git-admin --username 'bad name' --email owner@example.test
expect_fail "git-admin: the service account name is reserved" "reserved for the PPM service account" \
  "$deploy" --env-file "$genv" git-admin --username ppm-bot --email owner@example.test
expect_fail "git-admin: invalid e-mail" "not an e-mail address" "$deploy" --env-file "$genv" git-admin --username owner --email nope
expect_fail "git-admin: unknown option" "git-admin: unknown option '--password'" \
  "$deploy" --env-file "$genv" git-admin --username owner --email owner@example.test --password x
expect_fail "git-admin refuses when the Git server is off" "the Git server is off" \
  fake "$deploy" --env-file "$tmp/rc1b.env" git-admin --username owner --email owner@example.test

touch "$tmp/x.tar.gz.gpg"
echo "ppm-deploy.sh — destroy (fake docker: nothing is ever removed)"
run "$envtool" init --domain ppm.example.test --output "$tmp/prodppm.env" --release cli >/dev/null
[[ "$("$envtool" get "$tmp/prodppm.env" PPM_PROJECT)" == ppm ]] && pass "production env defaults to project ppm" \
  || fail "production env project is not ppm"
: >"$fakelog"
expect_fail "destroy never uses the default env" "never uses a default env file" \
  fake "$deploy" destroy --confirm-project ppm
expect_fail "destroy ignores PPM_ENV_FILE (must be explicit)" "never uses a default env file" \
  fake env PPM_ENV_FILE="$drill" "$deploy" destroy --confirm-project ppm-cli-drill
expect_fail "destroy refuses the production project (production env)" "names the production project" \
  fake "$deploy" destroy --env-file "$tmp/prodppm.env" --confirm-project ppm
expect_fail "destroy refuses the production project name even on a *.localhost env" "names the production project" \
  fake "$deploy" destroy --env-file "$tmp/prodname.env" --confirm-project ppm
expect_fail "destroy refuses an env on a real domain, whatever name is typed" "only removes drill/test stacks on *.localhost" \
  fake "$deploy" destroy --env-file "$prod" --confirm-project ppm-cli-prod
echo "ppm-cli-drill 5 3 ppm.example.test" >"$fakestate"
expect_fail "destroy refuses when the project's containers serve another (real) domain" "containers of this project serve ppm.example.test" \
  fake "$deploy" destroy --env-file "$drill" --confirm-project ppm-cli-drill
echo "ppm-cli-drill 5 3 drill.localhost" >"$fakestate"
out="$(run fake "$deploy" destroy --env-file "$drill" --confirm-project ppm)" && rc=0 || rc=$?
if ((rc != 0)) && [[ "$out" == *"does not match the project of this env file"* && "$out" != *"match project"* \
      && "$(grep -c "ppm-cli-drill" <<<"$(grep -v '^ppm-deploy: project ppm-cli-drill, env ' <<<"$out")")" == 0 ]]; then
  pass "a wrong typed name is refused without revealing the project name"
else fail "wrong-name refusal: rc=$rc, got: $(tail -n 1 <<<"$out")"; fi
expect_fail "destroy without confirmation refuses when not interactive" "destroy needs --confirm-project" \
  fake "$deploy" destroy --env-file "$drill"
expect_fail "destroy: old flag is unknown" "destroy: unknown option '--yes-delete-all-data'" \
  fake "$deploy" destroy --env-file "$drill" --yes-delete-all-data
[[ "$(fake_calls ' down ')" == 0 ]] && pass "no refused destroy reached 'docker compose down'" \
  || fail "a refused destroy called docker compose down: $(grep ' down ' "$fakelog" | head -n 1)"
expect_ok "destroy of the verified drill project" "project ppm-cli-drill removed" \
  fake "$deploy" destroy --env-file "$drill" --confirm-project ppm-cli-drill
if [[ "$(fake_calls ' down ')" == 1 && "$(fake_calls 'compose -p ppm-cli-drill .* down -v --remove-orphans')" == 1 ]]; then
  pass "  ... exactly one 'down -v', for project ppm-cli-drill"
else fail "  ... unexpected down calls: $(grep ' down ' "$fakelog" | tr '\n' ';')"; fi
[[ "$(fake_calls ' -p ppm ')" == 0 ]] && pass "no docker call ever targeted project ppm" \
  || fail "a docker call targeted project ppm: $(grep -- ' -p ppm ' "$fakelog" | head -n 1)"

echo "project-name variants (N2): refused before ANY docker call"
i=0
for variant in PPM "ppm " Ppm $'ppm\t'; do
  i=$((i + 1)); v="$tmp/variant$i.env"
  cp -p "$drill" "$v"; cp -p "$tmp/drill.backup-passphrase" "$tmp/variant$i.backup-passphrase"
  run "$envtool" set "$v" PPM_BACKUP_PASSPHRASE_FILE "variant$i.backup-passphrase" >/dev/null
  run "$envtool" set "$v" PPM_PROJECT "$variant" >/dev/null
  shown="$(printf '%q' "$variant")"
  expect_fail "check refuses PPM_PROJECT=$shown" "must be a Compose project name" "$envtool" check "$v"
  : >"$fakelog"
  expect_fail "destroy refuses PPM_PROJECT=$shown" "not a valid Compose project name" \
    fake "$deploy" --env-file "$v" destroy --confirm-project "$variant"
  expect_fail "status refuses PPM_PROJECT=$shown" "not a valid Compose project name" fake "$deploy" --env-file "$v" status
  expect_fail "backup refuses PPM_PROJECT=$shown" "not a valid Compose project name" fake "$backup" --env-file "$v"
  expect_fail "restore refuses PPM_PROJECT=$shown" "not a valid Compose project name" \
    fake "$restore" --env-file "$v" --backup "$tmp/x.tar.gz.gpg" --passphrase-file "$tmp/drill.backup-passphrase"
  [[ ! -s "$fakelog" ]] && pass "  ... no docker call at all for $shown" \
    || fail "  ... docker was called for $shown: $(head -n 1 "$fakelog")"
done
if bash -c 'source "$1/ppm-lib.sh"; for n in ppm PPM "ppm " Ppm " PPM" $'"'"'ppm\t'"'"'; do ppm_is_production_project "$n" || exit 1; done
            ! ppm_is_production_project ppm-drill && ! ppm_is_production_project ppmx' _ "$bundle_dir"; then
  pass "the production name is recognised in any case and with whitespace (defence in depth)"
else fail "case-insensitive production-name check"; fi

echo "ppm-deploy.sh — drill copies stay without workers (m3)"
: >"$fakelog"; : >"$fakestate"
expect_ok "up --no-workers" "worker and beat-worker are OFF" fake "$deploy" --env-file "$drill" up --no-workers
[[ -f "$PPM_RUNTIME_DIR/ppm-cli-drill/no-workers" ]] && pass "  ... is remembered for the project" \
  || fail "  ... marker missing"
: >"$fakelog"
expect_ok "restart of a drill copy" "worker and beat-worker are OFF" fake "$deploy" --env-file "$drill" restart
[[ "$(fake_calls 'up -d --remove-orphans --scale worker=0 --scale beat-worker=0')" == 1 && "$(fake_calls 'up -d --remove-orphans$')" == 0 ]] \
  && pass "  ... starts without worker/beat-worker" || fail "  ... restart started workers: $(grep ' up ' "$fakelog" | tr '\n' ';')"
: >"$fakelog"
expect_ok "release on a drill copy" "worker and beat-worker are OFF" fake "$deploy" --env-file "$drill" release cli2
[[ "$(fake_calls 'up -d --remove-orphans --scale worker=0 --scale beat-worker=0')" == 1 ]] \
  && pass "  ... keeps workers off" || fail "  ... release started workers"
run "$envtool" set "$drill" PPM_RELEASE cli >/dev/null
echo "ppm-cli-drill 5 3 drill.localhost" >"$fakestate"
run fake "$deploy" destroy --env-file "$drill" --confirm-project ppm-cli-drill >/dev/null
[[ ! -e "$PPM_RUNTIME_DIR/ppm-cli-drill/no-workers" ]] && pass "  ... destroy clears the marker" || fail "  ... marker left after destroy"

echo "ppm-backup.sh / ppm-restore.sh"
expect_fail "backup needs an explicit env" "pass --env-file explicitly" "$backup"
expect_fail "backup: unknown argument" "unknown argument: --tar" "$backup" --env-file "$drill" --tar
expect_fail "backup: --keep must be positive" "--keep needs a positive number" "$backup" --env-file "$drill" --keep 0
expect_fail "restore needs an explicit target env" "pass --env-file of the TARGET deployment" \
  "$restore" --backup "$tmp/x.tar.gz.gpg"
expect_fail "restore: backup must be an encrypted archive" "is not an encrypted PPM backup" \
  "$restore" --env-file "$drill" --backup "$tmp"
expect_fail "restore: removed --force-non-empty is unknown" "unknown argument: --force-non-empty" \
  "$restore" --env-file "$drill" --backup "$tmp/x.tar.gz.gpg" --force-non-empty
expect_fail "restore: missing passphrase file" "not found" \
  "$restore" --env-file "$drill" --backup "$tmp/x.tar.gz.gpg" --passphrase-file "$tmp/none"

echo "ppm-restore.sh — the target project must not exist (fake docker)"
: >"$fakelog"
printf '%s\n' "$(run "$envtool" get "$drill" PPM_PROJECT) 4 3 drill.localhost" >"$fakestate"
expect_fail "restore refuses a project that has containers" "already exists (4 containers, 3 volumes)" \
  fake "$restore" --env-file "$drill" --backup "$tmp/x.tar.gz.gpg" --passphrase-file "$tmp/drill.backup-passphrase"
echo "ppm-cli-drill 0 2 -" >"$fakestate"
expect_fail "restore refuses a project that has only volumes" "already exists (0 containers, 2 volumes)" \
  fake "$restore" --env-file "$drill" --backup "$tmp/x.tar.gz.gpg" --passphrase-file "$tmp/drill.backup-passphrase"
[[ "$(fake_calls 'docker compose')" == 0 ]] && pass "  ... refused before ANY docker compose call (no up, no run)" \
  || fail "  ... a compose call happened first: $(grep 'docker compose' "$fakelog" | head -n 1)"
: >"$fakestate"; : >"$fakelog"
run fake "$restore" --env-file "$drill" --backup "$tmp/x.tar.gz.gpg" --passphrase-file "$tmp/drill.backup-passphrase" >/dev/null
first_compose="$(grep -m1 'docker compose' "$fakelog" || true)"
[[ "$first_compose" == *" run --rm -T "* && "$(fake_calls ' up ')" == 0 ]] \
  && pass "a new project passes the check; the first compose call is the decryption run, not up" \
  || fail "fresh project: first compose call '$first_compose'"

echo "ppm-backup.sh — rotation and working directory (m1, m2)"
bk="$tmp/backups"; mkdir -p "$bk"
for stamp in 20260901T000000Z 20260902T000000Z 20260903T000000Z 20260904T000000Z; do
  touch "$bk/ppm-$stamp.tar.gz.gpg" "$bk/ppm-$stamp.manifest.json" "$bk/ppm-$stamp.tar.gz.gpg.sha256"
done
touch "$bk/ppm-drill-20260927T000000Z.tar.gz.gpg" "$bk/ppm-drill-20260928T000000Z.tar.gz.gpg" "$bk/ppm-notes.tar.gz.gpg"
removed="$(bash -c 'source "$1/ppm-lib.sh"; ppm_rotate_backups "$2" ppm 2 ppm-20260904T000000Z.tar.gz.gpg' _ "$bundle_dir" "$bk")"
left="$(find "$bk" -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort | tr '\n' ' ')"
if [[ "$removed" == 2 && "$left" == *"ppm-20260903T000000Z.tar.gz.gpg "* && "$left" == *"ppm-20260904T000000Z.tar.gz.gpg "* \
      && "$left" != *"20260901"* && "$left" != *"20260902"* && "$left" == *"ppm-drill-20260928T000000Z"* \
      && "$left" == *"ppm-drill-20260927T000000Z"* && "$left" == *"ppm-notes.tar.gz.gpg"* ]]; then
  pass "rotation keep 2: the new + 1 older ppm archive stay (with manifest/sha256); ppm-drill-* and others untouched"
else fail "rotation keep 2: removed=$removed left: $left"; fi
removed="$(bash -c 'source "$1/ppm-lib.sh"; ppm_rotate_backups "$2" ppm 1 ppm-20260904T000000Z.tar.gz.gpg' _ "$bundle_dir" "$bk")"
[[ -f "$bk/ppm-20260904T000000Z.tar.gz.gpg" && ! -e "$bk/ppm-20260903T000000Z.tar.gz.gpg" && "$removed" == 1 ]] \
  && pass "rotation keep 1 never removes the archive just written" || fail "rotation keep 1: removed=$removed"
removed="$(bash -c 'source "$1/ppm-lib.sh"; ppm_rotate_backups "$2" ppm-drill 1 ppm-drill-20260928T000000Z.tar.gz.gpg' _ "$bundle_dir" "$bk")"
[[ "$removed" == 1 && -f "$bk/ppm-20260904T000000Z.tar.gz.gpg" ]] \
  && pass "rotation of ppm-drill never touches ppm archives" || fail "ppm-drill rotation: removed=$removed"
sd="$tmp/state"; mkdir -p "$sd/.backup.999999999.dead" "$sd/.backup.$$.alive"
made="$(bash -c 'state_dir="$1"; source "$2/ppm-lib.sh"; ppm_workdir backup' _ "$sd" "$bundle_dir" 2>/dev/null)"
if [[ ! -e "$sd/.backup.999999999.dead" && -d "$sd/.backup.$$.alive" && -d "$made" && "$made" == "$sd/.backup."* \
      && "$(stat -c %a "$made" 2>/dev/null || stat -f %Lp "$made")" == 700 ]]; then
  pass "working directory: 700 under the state dir; leftovers of dead runs removed, live runs kept"
else fail "working directory handling (made=$made)"; fi

echo "Git server — git-bootstrap / git-admin (fake docker: order of steps, secrets only through pipes)"
gb="$tmp/gb.env"
run "$envtool" init --domain gb.localhost --output "$gb" --project ppm-cli-gb --release cli >/dev/null
# The G2.1 flow (sign-in through PPM off); the sign-in flow is checked below with its own env.
run "$envtool" set "$gb" PPM_GIT_SSO_ENABLED 0 >/dev/null
boot="$(openssl rand -hex 20)" newtok="$(openssl rand -hex 20)" resetpw="$(openssl rand -hex 10)" adminpw="$(openssl rand -hex 10)"
hooksecret="$(rawget "$gb" PPM_FORGEJO_WEBHOOK_SECRET)"
gfake() { fake env FAKE_BOOT_TOKEN="$boot" FAKE_NEW_TOKEN="$newtok" FAKE_RESET_PASSWORD="$resetpw" FAKE_ADMIN_PASSWORD="$adminpw" "$@"; }
line_of() { grep -n -- "$1" "$fakelog" | head -n1 | cut -d: -f1; }
no_secret_in() { # text, values... — true when none of the values occurs in the text or in any docker argument
  local text="$1" value; shift
  for value in "$@"; do [[ "$text" == *"$value"* ]] && return 1; grep -qF -- "$value" "$fakelog" && return 1; done
  return 0
}
: >"$fakelog"
out="$(run gfake "$deploy" --env-file "$gb" git-bootstrap)" && rc=0 || rc=$?
if ((rc == 0)) && [[ "$(rawget "$gb" PPM_FORGEJO_TOKEN)" == "$newtok" && "$(file_mode "$gb")" == 600 ]]; then
  pass "git-bootstrap saves the new read-only token in the env file (600)"
else fail "git-bootstrap: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"; fi
p_line="$(line_of 'forgejo-bootstrap prepare')"; u_line="$(line_of 'up -d --no-deps api worker beat-worker')"
f_line="$(line_of 'forgejo-bootstrap finish')"
[[ -n "$p_line" && -n "$u_line" && -n "$f_line" ]] && ((p_line < u_line && u_line < f_line)) \
  && pass "  ... order: new token (prepare) → saved → api/worker/beat-worker restarted → old tokens revoked (finish)" \
  || fail "  ... order prepare=$p_line up=$u_line finish=$f_line"
[[ "$(sed -n 1p "$fakelog.stdin.prepare")" == "$boot" && "$(sed -n 3p "$fakelog.stdin.prepare")" == "$hooksecret" \
   && "$(sed -n 2p "$fakelog.stdin.finish")" == "$newtok" ]] \
  && pass "  ... the temporary token, the webhook secret and the new token reach the tool on stdin" || fail "  ... stdin of the tool"
no_secret_in "$out" "$boot" "$newtok" "$hooksecret" \
  && pass "  ... no secret in any docker command line or in the output" || fail "  ... a secret reached argv/output"
[[ "$(fake_calls 'forgejo-bootstrap cleanup')" == 0 ]] && pass "  ... nothing to clean up after a success" || fail "  ... cleanup after success"
pwarg='(^|[ "(])--password([ =]|$)|user change-password'
if ! grep -nE -- "$pwarg" "$deploy" "$bundle_dir/forgejo/git_bootstrap.py" >/dev/null; then
  pass "no Forgejo password is ever passed as an argument (no --password, no change-password) in the scripts"
else fail "a password argument in: $(grep -nE -- "$pwarg" "$deploy" "$bundle_dir/forgejo/git_bootstrap.py" | head -n1)"; fi
: >"$fakelog"
out="$(run gfake env FAKE_TOOL_FAIL=prepare "$deploy" --env-file "$gb" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"was not changed"* && "$(rawget "$gb" PPM_FORGEJO_TOKEN)" == "$newtok" \
   && "$(fake_calls 'forgejo-bootstrap cleanup')" == 1 && "$(fake_calls 'up -d --no-deps')" == 0 ]] \
  && pass "a failure before the new token: env unchanged, no restart, the temporary token is revoked (cleanup)" \
  || fail "prepare failure: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"; newtok2="$(openssl rand -hex 20)"
out="$(run gfake env FAKE_NEW_TOKEN="$newtok2" FAKE_TOOL_FAIL=finish "$deploy" --env-file "$gb" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"revoking the other tokens"* && "$(rawget "$gb" PPM_FORGEJO_TOKEN)" == "$newtok2" \
   && "$(fake_calls 'forgejo-bootstrap cleanup')" == 1 ]] \
  && pass "a failure while revoking: the new token stays in use and saved, the message says so, cleanup runs" \
  || fail "finish failure: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
out="$(run gfake env FAKE_NO_CONTAINERS=1 "$deploy" --env-file "$gb" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"Forgejo is not running"* && "$out" == *" up"* && "$(fake_calls 'inspect')" == 0 ]] \
  && pass "no Forgejo container: git-bootstrap refuses at once with the hint to run up (no waiting)" \
  || fail "fast refusal: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
out="$(run gfake "$deploy" --env-file "$gb" git-admin --username owner --email owner@gb.localhost --reset-password)" && rc=0 || rc=$?
creds="$PPM_RUNTIME_DIR/ppm-cli-gb/forgejo-admin-credentials.txt"
((rc == 0)) && [[ "$(sed -n 's/^password=//p' "$creds")" == "$resetpw" && "$(file_mode "$creds")" == 600 \
   && "$(sed -n 1p "$fakelog.stdin.reset-password")" == "$boot" ]] && no_secret_in "$out" "$boot" "$resetpw" \
  && pass "git-admin --reset-password: new one-time password only in the 600 file (through the API tool, stdin/stdout)" \
  || fail "reset-password: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"; rm -f "$creds"
out="$(run gfake "$deploy" --env-file "$gb" git-admin --username owner --email owner@gb.localhost)" && rc=0 || rc=$?
((rc == 0)) && [[ "$(sed -n 's/^password=//p' "$creds")" == "$adminpw" ]] && no_secret_in "$out" "$adminpw" \
  && pass "git-admin creates the administrator with Forgejo's own random password (no argument carries it)" \
  || fail "git-admin create: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
out="$(run gfake "$deploy" --env-file "$gb" git-bootstrap)" && rc=0 || rc=$?
((rc == 0)) && [[ "$(fake_calls 'ppm_oidc_client --disable')" == 1 && "$(fake_calls 'add-oauth')" == 0 \
   && "$(fake_calls 'forgejo-bootstrap prepare --admin-token')" == 0 && -z "$(sed -n 3p "$fakelog.stdin.finish")" \
   && "$(fake_calls 'manage.py shell')" == 0 ]] \
  && pass "sign-in through PPM off: git-bootstrap removes PPM's OAuth2 client, touches no login source, keeps no admin token" \
  || fail "git-bootstrap with sign-in off: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"

echo "Git server — sign-in through PPM in git-bootstrap, up, preflight (fake docker; R25, R26)"
sso="$tmp/sso.env"
run "$envtool" init --domain sso.localhost --output "$sso" --project ppm-cli-sso --release cli >/dev/null
ssodir="$tmp/fake-sso"; mkdir -p "$ssodir"
newadmin="$(openssl rand -hex 20)"
sfake() { gfake env FAKE_SSO_DIR="$ssodir" FAKE_NEW_ADMIN_TOKEN="$newadmin" "$@"; }
client_secret="$(rawget "$sso" PPM_OIDC_CLIENT_SECRET)" signing_key="$(rawget "$sso" PPM_OIDC_PRIVATE_KEY)"
sha() { printf '%s' "$1" | file_sum /dev/stdin; }
: >"$fakelog"
out="$(run sfake "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
if ((rc == 0)) && [[ "$(rawget "$sso" PPM_FORGEJO_TOKEN)" == "$newtok" && "$(rawget "$sso" PPM_FORGEJO_ADMIN_TOKEN)" == "$newadmin" \
      && "$(rawget "$sso" PPM_FORGEJO_SSO_SOURCE_ID)" == 7 && "$(file_mode "$sso")" == 600 ]]; then
  pass "first git-bootstrap with sign-in through PPM: read-only token, admin token and login source id in the env (600)"
else fail "git-bootstrap with sign-in: rc=$rc, got: $(tail -n 3 <<<"$out" | tr '\n' ' ')"; fi
order=""
for step in sso-check 'ppm_oidc_client --ensure' 'forgejo-script discovery' 'forgejo-script add' 'psql -X -q -tA' \
  'restart forgejo' 'forgejo-bootstrap prepare' 'up -d --no-deps api worker beat-worker' 'forgejo-bootstrap finish' \
  'manage.py shell'; do
  order+=" $(line_of "$step")"
done
# shellcheck disable=SC2086  # the line numbers, one argument each
if [[ "$(printf '%s\n' $order | wc -l | tr -d ' ')" == 10 && "$(printf '%s\n' $order | sort -n | tr '\n' ' ')" == "$(printf '%s\n' $order | tr '\n' ' ')" ]]; then
  pass "  ... order: running API checked → PPM's client → discovery reachable → source PPM added → its secret → Forgejo restarted → tokens → api/worker/beat restarted → old tokens revoked → first sync"
else fail "  ... order (line numbers):$order"; fi
# shellcheck disable=SC2016  # the literal text of the in-container script
grep -q 'forgejo-script add forgejo http://api:8000/auth/oidc/internal/.well-known/openid-configuration openid,profile,email,groups' "$fakelog" \
  && grep -q 'add-oauth --name PPM --provider openidConnect --key "$1" --auto-discover-url "$2"' "$fakelog" \
  && grep -q -- '--skip-local-2fa --scopes "$3"' "$fakelog" && ! grep -q -- '--secret' "$fakelog" \
  && ! grep -qE -- '--(admin-group|group-team-map|group-claim-name)' "$fakelog" \
  && pass "  ... add-oauth: name PPM, OpenID Connect, client forgejo, internal discovery, four scopes, local 2FA skipped; no --secret, no group mapping" \
  || fail "  ... add-oauth call: $(grep -m1 'forgejo-script add' "$fakelog" | tail -c 200)"
[[ "$(sed -n 's/^\\set sso_secret //p' "$fakelog.stdin.psql-sso")" == "$client_secret" ]] \
  && grep -q "^SET log_min_error_statement = 'panic';" "$fakelog.stdin.psql-sso" \
  && grep -q "WHERE id = 7 AND name = 'PPM' AND type = 6 AND cfg::jsonb ? 'ClientSecret' RETURNING id;" "$fakelog.stdin.psql-sso" \
  && pass "  ... the client secret reaches Forgejo's database only on psql's stdin, only for source 7 of type OAuth2 with a ClientSecret field" \
  || fail "  ... the secret write: $(grep -v sso_secret "$fakelog.stdin.psql-sso" | tr '\n' ' ' | cut -c1-200)"
# All five statement-logging guards come first, before the line that carries the secret.
awk '/^SET (log_statement|log_min_error_statement|log_min_duration_statement|log_min_duration_sample|log_transaction_sample_rate) / { n++; last = NR }
  /^\\set sso_secret / { at = NR } END { exit !(n == 5 && at && last < at && NR >= at) }' "$fakelog.stdin.psql-sso" \
  && [[ "$(head -n 1 "$fakelog.stdin.psql-sso")" == "SET "* ]] \
  && pass "  ... every SET that switches statement logging off precedes the secret" || fail "  ... order of the SET lines"
[[ "$(sed -n 1p "$fakelog.stdin.sso-check")" == "$client_secret" ]] && grep -q 'sso-check 1$' "$fakelog" \
  && pass "  ... the running API is compared with the env file (secret on stdin, compared inside the container)" \
  || fail "  ... the running-API check"
grep -q 'forgejo-bootstrap prepare --admin-token$' "$fakelog" && [[ -z "$(sed -n 4p "$fakelog.stdin.prepare")" \
   && "$(sed -n 3p "$fakelog.stdin.finish")" == "$newadmin" && "$(sed -n 2p "$fakelog.stdin.finish")" == "$newtok" ]] \
  && pass "  ... prepare issues the admin token too; finish keeps exactly the new read-only and admin tokens" \
  || fail "  ... tokens: $(grep 'forgejo-bootstrap' "$fakelog" | tail -c 200)"
no_secret_in "$out" "$boot" "$newtok" "$newadmin" "$client_secret" "$signing_key" "$(rawget "$sso" PPM_FORGEJO_WEBHOOK_SECRET)" \
  && pass "  ... no secret (client secret, signing key, tokens) in any docker command line or in the output" \
  || fail "  ... a secret reached argv/output"
[[ "$out" == *"login source PPM created in the Git server (id 7)"* && "$out" == *"code access synchronized"* ]] \
  && pass "  ... reports the new login source and the first synchronization" || fail "  ... output: $(tail -n 3 <<<"$out" | tr '\n' ' ')"
grep -q -- '-e PPM_GIT_SSO_SOURCE=ok api python -' "$fakelog" \
  && pass "  ... the preflight after the restart finds the login source in line with the env (git_sso_source ok)" \
  || fail "  ... preflight source state: $(grep -o 'PPM_GIT_SSO_SOURCE=[^ ]*' "$fakelog" | tail -n1)"

: >"$fakelog"
out="$(run sfake env FAKE_PREPARE_KEEP=1 "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc == 0)) && [[ "$(fake_calls 'forgejo-script add')" == 0 && "$(fake_calls 'forgejo-script update')" == 0 \
   && "$(fake_calls 'psql -X -q -tA')" == 0 && "$(fake_calls 'restart forgejo')" == 0 && "$(fake_calls 'up -d --no-deps')" == 0 \
   && "$(sed -n 4p "$fakelog.stdin.prepare")" == "$newadmin" && "$(fake_calls 'manage.py shell')" == 1 && "$out" == *"already in line"* ]] \
  && pass "git-bootstrap again: the source in line, tokens kept — nothing created, changed or restarted (only revocation and the sync)" \
  || fail "second run: rc=$rc, got: $(tail -n 3 <<<"$out" | tr '\n' ' ')"
sed -i.bak -e 's#^discovery=.*#discovery=http://ppm.example.test/other#' -e 's#^admin_group=.*#admin_group=ppm-admins#' "$ssodir/cfg"
rm -f "$ssodir/cfg.bak"; : >"$fakelog"
out="$(run sfake env FAKE_PREPARE_KEEP=1 "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
upd="$(grep 'forgejo-script update' "$fakelog" | sed 's/.*forgejo-script update //')"
((rc == 0)) && [[ "$upd" == "7 --auto-discover-url http://api:8000/auth/oidc/internal/.well-known/openid-configuration --admin-group " \
   && "$(fake_calls 'restart forgejo')" == 1 && "$(fake_calls 'psql -X -q -tA')" == 0 && "$out" == *"discovery admin_group"* ]] \
  && pass "a drifted source (discovery, admin group) is fixed with update-oauth of just those flags, then Forgejo restarts" \
  || fail "drift: rc=$rc, update='$upd', got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
run "$envtool" rotate-sso-secret "$sso" >/dev/null; : >"$fakelog"
out="$(run sfake env FAKE_PREPARE_KEEP=1 "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc == 0)) && [[ "$(sed -n 's/^\\set sso_secret //p' "$fakelog.stdin.psql-sso")" == "$(rawget "$sso" PPM_OIDC_CLIENT_SECRET)" \
   && "$(fake_calls 'forgejo-script update')" == 0 && "$(fake_calls 'restart forgejo')" == 1 \
   && "$(grep '^secret_sha256=' "$ssodir/cfg")" == "secret_sha256=$(sha "$(rawget "$sso" PPM_OIDC_CLIENT_SECRET)")" ]] \
  && no_secret_in "$out" "$(rawget "$sso" PPM_OIDC_CLIENT_SECRET)" \
  && pass "a new client secret (rotate-sso-secret): written into the source from stdin only, Forgejo restarts, no update-oauth" \
  || fail "secret rotation: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
out="$(run sfake "$deploy" --env-file "$sso" git-bootstrap --rotate-token)" && rc=0 || rc=$?
((rc == 0)) && grep -q 'forgejo-bootstrap prepare --rotate-token --admin-token$' "$fakelog" \
  && pass "git-bootstrap --rotate-token renews both tokens (read-only and admin)" || fail "rotate: rc=$rc"
: >"$fakelog"; before="$(file_sum "$sso")"
out="$(run sfake env FAKE_API_SSO_MISMATCH=1 "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"up first"* && "$(fake_calls 'ppm_oidc_client')" == 0 && "$(fake_calls 'forgejo-bootstrap')" == 0 \
   && "$(file_sum "$sso")" == "$before" ]] \
  && pass "the running API started without the env's sign-in settings: refused (run up first), nothing changed" \
  || fail "API mismatch: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
out="$(run sfake env FAKE_ENSURE_FAIL=1 "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"PPM_OIDC_PRIVATE_KEY"* && "$out" == *"nothing in the Git server was changed"* \
   && "$(fake_calls 'add-oauth')" == 0 && "$(fake_calls 'forgejo-bootstrap')" == 0 ]] \
  && pass "PPM cannot set up its OpenID Connect client: refused with its reason before the Git server is touched" \
  || fail "ensure failure: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
rm -f "$ssodir/source" "$ssodir/cfg"; : >"$fakelog"
out="$(run sfake env FAKE_SSO_DISCOVERY=000 "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"cannot read PPM's discovery"* && "$(fake_calls 'forgejo-script add')" == 0 && ! -e "$ssodir/source" ]] \
  && pass "the Git server cannot read PPM's discovery: refused before add-oauth (which would fail on it)" \
  || fail "discovery: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
printf '7\tPPM\tOAuth2\tfalse\n' >"$ssodir/source"; : >"$fakelog"
out="$(run sfake "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"switched off in the Git server"* && "$(fake_calls 'forgejo-bootstrap')" == 0 ]] \
  && pass "a login source PPM switched off in Forgejo: refused with how to switch it on (or sign-in off)" \
  || fail "inactive source: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
printf '7\tPPM\tLDAP (via BindDN)\ttrue\n' >"$ssodir/source"; : >"$fakelog"
out="$(run sfake "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"of another type"* && "$(fake_calls 'forgejo-script update')" == 0 ]] \
  && pass "a login source named PPM of another type is never changed: refused with the reason" \
  || fail "foreign source: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
rm -f "$ssodir/source" "$ssodir/cfg"
: >"$fakelog"
out="$(run sfake env FAKE_SYNC_STATUS=partial "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc == 0)) && [[ "$out" == *"WARNING: the first synchronization"*"partial"* && "$out" == *"вне организации пространства"* ]] \
  && pass "a first synchronization with problems: reported (the problems listed), sign-in stays set up (exit 0)" \
  || fail "partial sync: rc=$rc, got: $(tail -n 3 <<<"$out" | tr '\n' ' ')"
ssostate="$PPM_RUNTIME_DIR/ppm-cli-sso"
run "$envtool" rotate-sso-secret "$sso" >/dev/null; : >"$fakelog"
out="$(run sfake env FAKE_PREPARE_KEEP=1 FAKE_RESTART_FAIL=1 "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"compose restart forgejo"* && -s "$ssostate/forgejo-restart-pending" \
   && "$(fake_calls 'forgejo-bootstrap')" == 0 ]] \
  && pass "interrupted before Forgejo restarted (its source already changed): stopped with the advice, the pending restart remembered" \
  || fail "restart failure: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
run sfake "$deploy" --env-file "$sso" preflight >/dev/null
grep -q -- '-e PPM_GIT_SSO_SOURCE=fail (a change of the login source PPM waits for a restart of the Git server: run git-bootstrap) api python -' "$fakelog" \
  && pass "  ... meanwhile preflight reports it (git_sso_source fail) instead of ok" \
  || fail "  ... preflight: $(grep -o 'PPM_GIT_SSO_SOURCE=[^)]*)' "$fakelog" | tail -n1)"
: >"$fakelog"
out="$(run sfake env FAKE_PREPARE_KEEP=1 "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc == 0)) && [[ "$(fake_calls 'restart forgejo')" == 1 && "$(fake_calls 'psql -X -q -tA')" == 0 && "$out" == *"already in line"* \
   && ! -e "$ssostate/forgejo-restart-pending" ]] \
  && pass "  ... the next git-bootstrap finds the source in line, still restarts Forgejo, then forgets the pending restart" \
  || fail "  ... after the interruption: rc=$rc restarts=$(fake_calls 'restart forgejo') writes=$(fake_calls 'psql -X -q -tA') marker=$(cat "$ssostate/forgejo-restart-pending" 2>&1), got: $(grep -E 'login source|restart' <<<"$out" | tr '\n' ' ')"
echo "started-of-a-container-that-is-gone" >"$ssostate/forgejo-restart-pending"; : >"$fakelog"
run sfake "$deploy" --env-file "$sso" preflight >/dev/null
grep -q -- '-e PPM_GIT_SSO_SOURCE=ok api python -' "$fakelog" && [[ ! -e "$ssostate/forgejo-restart-pending" ]] \
  && pass "  ... a restart of Forgejo any other way (compose restart, up, reboot) settles it too" \
  || fail "  ... a restart elsewhere: $(grep -o 'PPM_GIT_SSO_SOURCE=[^ ]*' "$fakelog" | tail -n1)"
: >"$fakelog"
out="$(run sfake env FAKE_UP_FAIL=1 "$deploy" --env-file "$sso" git-bootstrap --rotate-token)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"did not come up healthy"* && "$(fake_calls 'forgejo-bootstrap finish')" == 0 ]] \
  && pass "interrupted after new tokens were saved, before api/worker/beat-worker restarted: nothing revoked" \
  || fail "up failure: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
out="$(run sfake env FAKE_PREPARE_KEEP=1 FAKE_API_STALE=1 "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
u_line="$(line_of 'up -d --no-deps api worker beat-worker')"; f_line="$(line_of 'forgejo-bootstrap finish')"
((rc == 0)) && [[ -n "$u_line" && -n "$f_line" ]] && ((u_line < f_line)) && [[ "$out" == *"interrupted"* \
   && "$(sed -n 1p "$fakelog.stdin.env-check")" == "$newtok" && "$(sed -n 2p "$fakelog.stdin.env-check")" == "$newadmin" \
   && "$(sed -n 3p "$fakelog.stdin.env-check")" == 7 ]] && no_secret_in "$out" "$newtok" "$newadmin" \
  && pass "  ... the next run sees the services hold other tokens/source id than the env file and restarts them before revoking" \
  || fail "  ... stale services: rc=$rc up=$u_line finish=$f_line, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
lockdir="$ssostate/git-bootstrap.lock"; mkdir -p "$lockdir"; echo "$$" >"$lockdir/pid"; : >"$fakelog"
out="$(run sfake "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"is running (pid $$)"* && -d "$lockdir" && "$(fake_calls 'ppm_oidc_client')" == 0 \
   && "$(fake_calls 'forgejo-bootstrap')" == 0 ]] \
  && pass "a second git-bootstrap while one runs (its lock alive): refused, nothing touched, the other run's lock kept" \
  || fail "live lock: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
echo 999999999 >"$lockdir/pid"; : >"$fakelog"
out="$(run sfake env FAKE_PREPARE_KEEP=1 "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc == 0)) && [[ ! -e "$lockdir" && "$out" == *"taken over"* ]] \
  && pass "  ... the lock of a killed run is taken over, and released at the end" || fail "  ... stale lock: rc=$rc, lock left: $(ls "$lockdir" 2>&1)"
: >"$fakelog"
out="$(run sfake env FAKE_FORGEJO_VERSION='forgejo version 16.0.1+gitea-1.22.0 (release name 16.0.1)' "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"16.0.1"* && "$out" == *"15.x"* && "$(fake_calls 'forgejo-script add')" == 0 \
   && "$(fake_calls 'forgejo-script update')" == 0 && "$(fake_calls 'psql -X -q -tA')" == 0 ]] \
  && pass "a Git server other than Forgejo 15.x: git-bootstrap changes nothing of the sign-in (the database format is verified on 15.x)" \
  || fail "version: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
printf 'x7\tPPM\tOAuth2\ttrue\n' >"$ssodir/source"; : >"$fakelog"
out="$(run sfake "$deploy" --env-file "$sso" git-bootstrap)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"unexpected"* && "$(fake_calls 'login_source')" == 0 && "$(fake_calls 'psql -X -q -tA')" == 0 ]] \
  && pass "an id that is not a number in forgejo admin auth list: refused before any query of Forgejo's database" \
  || fail "non-numeric id: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
printf '7\tPPM\tOAuth2\ttrue\n' >"$ssodir/source"
ssooffenv="$tmp/ssooff2.env"; cp -p "$sso" "$ssooffenv"; cp -p "$tmp/sso.backup-passphrase" "$tmp/ssooff2.backup-passphrase"
rawput "$ssooffenv" PPM_BACKUP_PASSPHRASE_FILE ssooff2.backup-passphrase; rawput "$ssooffenv" PPM_PROJECT ppm-cli-ssooff
run "$envtool" set "$ssooffenv" PPM_GIT_SSO_ENABLED 0 >/dev/null
: >"$fakelog"
out="$(run sfake env FAKE_PREPARE_KEEP=1 "$deploy" --env-file "$ssooffenv" git-bootstrap)" && rc=0 || rc=$?
((rc == 0)) && grep -q '^PPM_FORGEJO_ADMIN_TOKEN=$' "$ssooffenv" && [[ -z "$(sed -n 3p "$fakelog.stdin.finish")" \
   && "$(fake_calls 'ppm_oidc_client --disable')" == 1 && "$(fake_calls 'add-oauth')" == 0 && "$out" == *"admin token was revoked"* ]] \
  && pass "switched off (PPM_GIT_SSO_ENABLED=0): the admin token is revoked and cleared from the env, PPM's client removed" \
  || fail "switch off: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
out="$(run sfake "$deploy" --env-file "$ssooffenv" up)" && rc=0 || rc=$?
((rc == 0)) && [[ "$(fake_calls 'ppm_oidc_client --disable')" == 1 ]] \
  && pass "up with sign-in through PPM off removes PPM's OAuth2 client (R26)" || fail "up off: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
out="$(run sfake env FAKE_DISABLE_UNKNOWN=1 "$deploy" --env-file "$ssooffenv" up)" && rc=0 || rc=$?
((rc == 0)) && [[ "$out" != *WARNING* ]] \
  && pass "  ... a release without the sign-in (no such command) is fine: nothing to remove, no warning" \
  || fail "  ... unknown command: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
out="$(run sfake "$deploy" --env-file "$sso" up)" && rc=0 || rc=$?
((rc == 0)) && [[ "$(fake_calls 'ppm_oidc_client')" == 0 && "$out" == *"sign-in through PPM"* ]] \
  && pass "up with sign-in through PPM on leaves PPM's client to git-bootstrap and names the sign-in" \
  || fail "up on: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
emergency="$tmp/emergency.env"; cp -p "$sso" "$emergency"; cp -p "$tmp/sso.backup-passphrase" "$tmp/emergency.backup-passphrase"
rawput "$emergency" PPM_BACKUP_PASSPHRASE_FILE emergency.backup-passphrase; run "$envtool" set "$emergency" PPM_GIT_LOCAL_SIGNIN 1 >/dev/null
out="$(run sfake "$deploy" --env-file "$emergency" up)" && rc=0 || rc=$?
((rc == 0)) && [[ "$out" == *"аварийный вход"* && "$out" == *"PPM_GIT_LOCAL_SIGNIN 0"* ]] \
  && pass "up with the emergency password form on warns (in Russian) until it is switched off again" \
  || fail "emergency up: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
fresh="$tmp/fresh.env"; run "$envtool" init --domain fresh.localhost --output "$fresh" --project ppm-cli-fresh --release cli >/dev/null
: >"$fakelog"
out="$(run sfake "$deploy" --env-file "$fresh" up)" && rc=0 || rc=$?
((rc == 0)) && grep -q -- '-e PPM_GIT_SSO_SOURCE=missing (run git-bootstrap) api python -' "$fakelog" \
   && [[ "$(fake_calls 'add-oauth')" == 0 && "$out" == *"git-bootstrap"* ]] \
  && pass "a fresh install: preflight reports the login source as missing (run git-bootstrap) without asking Forgejo, up names the next step" \
  || fail "fresh up: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"

echo "ppm-deploy.sh release — the Git site of the proxy (fake docker)"
: >"$fakelog"
out="$(run fake env FAKE_NO_GIT_SITE=proxy:cli2 "$deploy" --env-file "$gb" release cli2)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"нет сайта Git-сервера"* && "$out" == *"--allow-git-site-loss"* \
   && "$(rawget "$gb" PPM_RELEASE)" == cli && "$(fake_calls ' up ')" == 0 ]] \
  && pass "release to a proxy without the Git site is refused (explained in Russian), nothing switched" \
  || fail "release guard: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
out="$(run fake env FAKE_NO_GIT_SITE=proxy:cli2 "$deploy" --env-file "$gb" release cli2 --allow-git-site-loss)" && rc=0 || rc=$?
((rc == 0)) && [[ "$out" == *"ВНИМАНИЕ"* && "$(rawget "$gb" PPM_RELEASE)" == cli2 ]] \
  && pass "  ... --allow-git-site-loss switches with a warning" || fail "  ... allow: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
run "$envtool" set "$gb" PPM_RELEASE cli >/dev/null
out="$(run fake "$deploy" --env-file "$gb" release cli2)" && rc=0 || rc=$?
((rc == 0)) && pass "  ... a proxy with the Git site switches as before" || fail "  ... release with the site: rc=$rc"
run "$envtool" set "$gb" PPM_RELEASE cli >/dev/null
: >"$fakelog"
run fake env FAKE_NO_GIT_SITE=proxy:cli2 "$deploy" --env-file "$tmp/rc1b.env" release cli2 >/dev/null
[[ "$(fake_calls 'git-server-1.caddy')" == 0 ]] && pass "  ... with the Git server off the proxy is not even probed" || fail "  ... probed without Git"
run "$envtool" set "$tmp/rc1b.env" PPM_RELEASE cli >/dev/null
cfg="$(compose_json "$gb" | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
print(",".join(s[n]["environment"].get("PPM_FORGEJO_SSH_ENABLED", "-") for n in ("api", "worker", "beat-worker")))')"
cfg0="$(compose_json "$nossh" | python3 -c '
import json, sys
print(json.load(sys.stdin)["services"]["api"]["environment"].get("PPM_FORGEJO_SSH_ENABLED", "-"))')"
[[ "$cfg" == "1,1,1" && "$cfg0" == 0 ]] && pass "API gets PPM_FORGEJO_SSH_ENABLED (1, or 0 when git over SSH is off)" \
  || fail "PPM_FORGEJO_SSH_ENABLED: $cfg / $cfg0"
dbinit="$bundle_dir/forgejo/db-init.sql"
grep -q "log_min_duration_statement = -1" "$dbinit" && grep -q "log_min_duration_sample = -1" "$dbinit" \
  && grep -q "log_transaction_sample_rate = 0" "$dbinit" \
  && pass "forgejo-db-init: no duration or sampled logging of its statements either" || fail "db-init duration logging"

echo "ppm-backup.sh / ppm-restore.sh with the Git server (fake docker; tar.gz stands in for GnuPG)"
bdir="$tmp/gbackups"; mkdir -p "$bdir"
newest() { # dir pattern — the newest matching file (names are <project>-<UTC>…, so they sort by time)
  find "$1" -maxdepth 1 -name "$2" | LC_ALL=C sort | tail -n1
}
backup_manifest() { newest "$1" '*.manifest.json'; }
: >"$fakelog"
out="$(run fake env FAKE_FORGEJO_DB=1 "$backup" --env-file "$gb" --output-dir "$bdir")" && rc=0 || rc=$?
m="$(backup_manifest "$bdir")"
if ((rc == 0)) && [[ -n "$m" ]] && python3 -c 'import json, sys; m = json.load(open(sys.argv[1])); sys.exit(not (m["schema"] == "ppm-backup/3" and m["git_server"] and m["git_server"]["server_enabled"]))' "$m"; then
  pass "backup with the Git server on: ppm-backup/3 with the git_server section"
else fail "backup git on: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"; fi
s_line="$(line_of 'stop forgejo')"; t_line="$(line_of 'start forgejo')"
[[ -n "$s_line" && -n "$t_line" ]] && ((s_line < t_line)) && [[ ! -e "$PPM_RUNTIME_DIR/ppm-cli-gb/forgejo-stopped-by-backup" ]] \
  && pass "  ... Forgejo stopped for the copy and started again; no marker left" || fail "  ... stop=$s_line start=$t_line"
gitarchive="$(newest "$bdir" '*.tar.gz.gpg')"
: >"$fakelog"; n_before="$(find "$bdir" -maxdepth 1 -name '*.tar.gz.gpg' | wc -l | tr -d ' ')"
out="$(run fake env FAKE_FORGEJO_DB=1 FAKE_FAIL_FORGEJO_DUMP=1 "$backup" --env-file "$gb" --output-dir "$bdir")" && rc=0 || rc=$?
s_line="$(line_of 'stop forgejo')"; t_line="$(line_of 'start forgejo')"
((rc != 0)) && [[ -n "$s_line" && -n "$t_line" ]] && ((s_line < t_line)) \
  && [[ "$(find "$bdir" -maxdepth 1 -name '*.tar.gz.gpg' | wc -l | tr -d ' ')" == "$n_before" && ! -e "$PPM_RUNTIME_DIR/ppm-cli-gb/forgejo-stopped-by-backup" ]] \
  && pass "a failure after Forgejo was stopped: the backup fails, Forgejo is started again, no archive" \
  || fail "failure after stop: rc=$rc stop=$s_line start=$t_line"
: >"$fakelog"; echo 999999999 >"$PPM_RUNTIME_DIR/ppm-cli-gb/forgejo-stopped-by-backup"
out="$(run fake env FAKE_FORGEJO_DB=1 "$backup" --env-file "$gb" --output-dir "$bdir")" && rc=0 || rc=$?
t_line="$(line_of 'start forgejo')"; d_line="$(line_of 'pg_dump')"
((rc == 0)) && [[ "$out" == *"interrupted"* && -n "$t_line" && -n "$d_line" ]] && ((t_line < d_line)) \
  && pass "an interrupted backup (marker of a dead run): the next backup starts Forgejo first and warns" \
  || fail "marker: rc=$rc start=$t_line dump=$d_line, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
out="$(run fake env FAKE_FORGEJO_DB=1 FAKE_FORGEJO_RUNNING=false "$backup" --env-file "$gb" --output-dir "$bdir")" && rc=0 || rc=$?
((rc == 0)) && [[ "$out" == *"WARNING: the Git server is on, but Forgejo was not running"* && "$out" == *" up"* \
   && "$(fake_calls 'stop forgejo')" == 0 ]] \
  && pass "Git server on but Forgejo not running: copied as it is, with a WARNING and the hint to run up" \
  || fail "not running: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
goff="$tmp/goff.env"; cp -p "$gb" "$goff"; cp -p "$tmp/gb.backup-passphrase" "$tmp/goff.backup-passphrase"
rawput "$goff" PPM_BACKUP_PASSPHRASE_FILE goff.backup-passphrase; rawput "$goff" PPM_PROJECT ppm-cli-goff
rawput "$goff" PPM_GIT_SERVER_ENABLED 0
odir="$tmp/goffbackups"; mkdir -p "$odir"; : >"$fakelog"
out="$(run fake env FAKE_FORGEJO_DB=1 FAKE_FORGEJO_VOLUME=1 "$backup" --env-file "$goff" --output-dir "$odir")" && rc=0 || rc=$?
m="$(backup_manifest "$odir")"
if ((rc == 0)) && python3 -c 'import json, sys; g = json.load(open(sys.argv[1]))["git_server"]; sys.exit(not (g and g["server_enabled"] is False))' "$m" \
   && grep -q 'run --rm --network none -v ppm-cli-goff_forgejo_data:/var/lib/gitea' "$fakelog" && [[ "$(fake_calls 'stop forgejo')" == 0 ]]; then
  pass "Git server switched off but its database and volume kept: they are still backed up (nothing stopped)"
else fail "git off with data: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"; fi
rm -f "$odir"/*; : >"$fakelog"
out="$(run fake env FAKE_FORGEJO_DB=1 FAKE_FORGEJO_VOLUME=1 FAKE_RUN_FAIL=1 "$backup" --env-file "$goff" --output-dir "$odir")" && rc=0 || rc=$?
m="$(backup_manifest "$odir")"
((rc == 0)) && [[ "$out" == *"WARNING: THE GIT SERVER IS NOT IN THIS BACKUP"* ]] \
  && python3 -c 'import json, sys; sys.exit(json.load(open(sys.argv[1]))["git_server"] is not None)' "$m" \
  && pass "  ... when that copy is impossible: a loud WARNING (the PPM part is still backed up)" \
  || fail "  ... impossible copy: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
rm -f "$odir"/*
out="$(run fake env FAKE_FORGEJO_DB=1 "$backup" --env-file "$goff" --output-dir "$odir")" && rc=0 || rc=$?
((rc == 0)) && [[ "$out" == *"WARNING: THE GIT SERVER IS NOT IN THIS BACKUP"*"only its database"* ]] \
  && pass "  ... only the database left (volume gone): WARNING, no half copy" || fail "  ... db only: rc=$rc"
rm -f "$odir"/*
out="$(run fake env FAKE_FORGEJO_DB=0 FAKE_FORGEJO_VOLUME=0 "$backup" --env-file "$goff" --output-dir "$odir")" && rc=0 || rc=$?
plainarchive="$(newest "$odir" '*.tar.gz.gpg')"
((rc == 0)) && [[ "$out" != *WARNING* && -n "$plainarchive" ]] \
  && pass "  ... nothing of the Git server on the server: no warning, no git_server" || fail "  ... nothing left: rc=$rc"

tar -tzf "$plainarchive" | grep -qE '^\./objects/uploads/$' \
  && pass "an empty bucket still leaves objects/uploads/ in the archive (restore needs it)" \
  || fail "empty bucket: no objects/uploads/ in the archive"
rgit="$tmp/rgit.env"; run "$envtool" init --domain rgit.localhost --output "$rgit" --project ppm-cli-rgit --release cli >/dev/null
rnog="$tmp/rnog.env"; run "$envtool" init --domain rnog.localhost --output "$rnog" --project ppm-cli-rnog --release cli >/dev/null
# The Git server off: sign-in through PPM (its sign-in) goes off with it (RUNBOOK §17.11).
run "$envtool" set "$rnog" PPM_GIT_SERVER_ENABLED 0 >/dev/null; run "$envtool" set "$rnog" PPM_GIT_SSO_ENABLED 0 >/dev/null
: >"$fakelog"; : >"$fakestate"
out="$(run fake "$restore" --env-file "$rnog" --backup "$gitarchive" --passphrase-file "$tmp/gb.backup-passphrase" --drill)" && rc=0 || rc=$?
((rc != 0)) && [[ "$out" == *"contains the Git server (Forgejo) but it is off"* && "$(fake_calls ' up ')" == 0 ]] \
  && pass "restore: an archive with the Git server into an env where it is off is refused before any up" \
  || fail "restore git→off: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"
out="$(run fake "$restore" --env-file "$rgit" --backup "$gitarchive" --passphrase-file "$tmp/gb.backup-passphrase" --drill)" && rc=0 || rc=$?
((rc == 0)) && [[ "$out" == *"Git server restored"* ]] && grep -q 'forgejo-db-init' "$fakelog" && grep -q 'tar -xf -' "$fakelog" \
  && pass "restore: an archive with the Git server restores it (database, data, checks) into an env where it is on" \
  || fail "restore git→on: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
v2="$tmp/v2"; rm -rf "$v2"; mkdir -p "$v2/x"; tar -xzf "$plainarchive" -C "$v2/x"
rm -rf "$v2/x/objects/uploads"  # like RC.1 archives of an empty bucket: mc mirror created no directory
sed -i.bak -e 's#"schema": "ppm-backup/3"#"schema": "ppm-backup/2"#' -e '/"git_server": null,/d' "$v2/x/manifest.json"; rm -f "$v2/x/manifest.json.bak"
(cd "$v2/x" && find db objects objects.jsonl manifest.json -type f | LC_ALL=C sort | while read -r f; do file_sum "$f" | sed "s#\$#  $f#"; done >SHA256SUMS)
(cd "$v2/x" && tar -czf "$v2/ppm-cli-rc1-20260901T000000Z.tar.gz.gpg" .)
: >"$fakelog"
out="$(run fake "$restore" --env-file "$rgit" --backup "$v2/ppm-cli-rc1-20260901T000000Z.tar.gz.gpg" --passphrase-file "$tmp/gb.backup-passphrase" --drill)" && rc=0 || rc=$?
((rc == 0)) && [[ "$out" == *"no Git server data in this archive"* && "$(fake_calls 'mc mirror')" == 0 ]] \
  && pass "restore: an RC.1 archive (ppm-backup/2, no Git server, empty bucket) is accepted; the target's Forgejo starts empty" \
  || fail "restore /2: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
rm -rf "$PPM_RUNTIME_DIR/ppm-cli-rnog"
out="$(run fake "$restore" --env-file "$rnog" --backup "$v2/ppm-cli-rc1-20260901T000000Z.tar.gz.gpg" --passphrase-file "$tmp/gb.backup-passphrase" --drill)" && rc=0 || rc=$?
((rc == 0)) && pass "  ... and into an env with the Git server off" || fail "  ... /2 into git off: rc=$rc, got: $(tail -n 2 <<<"$out" | tr '\n' ' ')"
: >"$fakelog"; : >"$fakestate"

echo "proxy/Caddyfile"
blocks="$(awk '/fields \{/ { n++; grab = 1; next } grab && /^[ \t]*\}/ { grab = 0; next }
  grab { sub(/^[ \t]+/, ""); print n "\t" $0 }' "$bundle_dir/proxy/Caddyfile")"
if [[ -n "$blocks" && "$(awk -F'\t' '$1 == 1 { print $2 }' <<<"$blocks")" == "$(awk -F'\t' '$1 == 2 { print $2 }' <<<"$blocks")" \
      && "$(awk -F'\t' '{ print $1 }' <<<"$blocks" | sort -u | wc -l | tr -d ' ')" == 2 ]]; then
  pass "the error-log and access-log redaction filters are identical"
else fail "the two Caddy log filters differ"; fi
# PPM's internal discovery (token/userinfo/jwks at http://api:8000) is for the Git server inside the network only.
closed="$(awk '
  /^\thandle \/auth\/oidc\/internal\/\* \{$/ { start = NR; inside = 1; next }
  inside && /^\t\}$/ { inside = 0; next }
  inside && /^\t\trespond 404$/ { answer = NR }
  inside && !/^\t\t#/ && !/^\t\trespond 404$/ { other = 1 }
  /^\thandle \/auth\/\* \{$/ { auth = NR }
  END { print (start && answer && !other && auth > start) ? "closed" : "open " start " " answer " " other " " auth }' \
  "$bundle_dir/proxy/Caddyfile")"
[[ "$closed" == closed ]] \
  && pass "Caddy answers 404 to /auth/oidc/internal/* on the PPM site, ahead of the /auth/* route to the API (R24)" \
  || fail "Caddy internal discovery: $closed"
[[ "$(grep -c 'request>uri regexp ".*(/auth/oidc/continue/)\[^/?#\]+|' "$bundle_dir/proxy/Caddyfile")" == 2 ]] \
  && pass "both log filters mask the one-time id of the sign-in link (/auth/oidc/continue/REDACTED/)" \
  || fail "the Caddy log filters do not mask /auth/oidc/continue/<id>"

echo "cli-checks: $passed passed, $failed failed"
((failed == 0))
