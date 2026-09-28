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
        prepare) echo "token=$FAKE_NEW_TOKEN" ;;
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
grep -v -E '^(PPM_GIT_|PPM_FORGEJO_|FORGEJO_|# ---- Git server)' "$rc1" >"$rc1.tmp" && mv -f "$rc1.tmp" "$rc1" && chmod 600 "$rc1"
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
run "$envtool" set "$rnog" PPM_GIT_SERVER_ENABLED 0 >/dev/null
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

echo "cli-checks: $passed passed, $failed failed"
((failed == 0))
