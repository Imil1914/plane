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

# Fake docker: records every call in $FAKE_DOCKER_LOG, runs nothing. $FAKE_DOCKER_STATE lists projects that "exist":
# "<project> <containers> <volumes> <domain their containers serve>" per line.
fakebin="$tmp/fakebin" fakelog="$tmp/fake-docker.log" fakestate="$tmp/fake-docker.state"
mkdir -p "$fakebin"; : >"$fakelog"; : >"$fakestate"
cat >"$fakebin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_DOCKER_LOG"
state_line() { [[ -f "${FAKE_DOCKER_STATE:-}" ]] && awk -v p="$1" '$1 == p' "$FAKE_DOCKER_STATE"; return 0; }
label_project() {
  local arg
  for arg in "$@"; do [[ "$arg" == label=com.docker.compose.project=* ]] && echo "${arg#label=com.docker.compose.project=}"; done
  return 0
}
case "$1" in
  ps)
    p="$(label_project "$@")"; read -r _ n _ _ <<<"$(state_line "$p")"
    for ((i = 1; i <= ${n:-0}; i++)); do echo "fake-$p-$i"; done ;;
  volume)
    p="$(label_project "$@")"; read -r _ _ n _ <<<"$(state_line "$p")"
    for ((i = 1; i <= ${n:-0}; i++)); do echo "${p}_volume$i"; done ;;
  inspect)
    case "$3" in
      *ExitCode*) echo "exited 0" ;;
      *Health*) echo "healthy" ;;
      *Config.Env*)
        for id in "${@:4}"; do
          p="${id#fake-}"; p="${p%-*}"; read -r _ _ _ d <<<"$(state_line "$p")"
          [[ -n "$d" ]] && echo "PPM_DOMAIN=$d"
        done ;;
    esac ;;
  compose) printf '%s\n' "$@" | grep -qx ps && echo "fake-service" ;;
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

echo "proxy/Caddyfile"
blocks="$(awk '/fields \{/ { n++; grab = 1; next } grab && /^[ \t]*\}/ { grab = 0; next }
  grab { sub(/^[ \t]+/, ""); print n "\t" $0 }' "$bundle_dir/proxy/Caddyfile")"
if [[ -n "$blocks" && "$(awk -F'\t' '$1 == 1 { print $2 }' <<<"$blocks")" == "$(awk -F'\t' '$1 == 2 { print $2 }' <<<"$blocks")" \
      && "$(awk -F'\t' '{ print $1 }' <<<"$blocks" | sort -u | wc -l | tr -d ' ')" == 2 ]]; then
  pass "the error-log and access-log redaction filters are identical"
else fail "the two Caddy log filters differ"; fi

echo "cli-checks: $passed passed, $failed failed"
((failed == 0))
