#!/usr/bin/env bash
# Checks for ppm-monitor.sh (O-5) and for ppm-backup.sh's result marker (O-1.4) it reads. Same spirit as
# cli-checks.sh (throw-away env files, fake docker in PATH, nothing real started) but kept in its own file and its
# own fake binaries so neither test suite can leak state into the other. Fakes docker, curl, df and openssl —
# real Telegram/SMTP delivery is never attempted (curl is always fake here). Exit 1 on any failure.
#
#   deployments/ppm/tests/monitor-checks.sh
set -uo pipefail

bundle_dir="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ppm-monitor-checks.XXXXXX")"; tmp="$(cd "$tmp" && pwd)"
trap 'rm -rf -- "$tmp"' EXIT
unset PPM_ENV_FILE
export PPM_RUNTIME_DIR="$tmp/runtime"
passed=0 failed=0
pass() { passed=$((passed + 1)); printf '  ok    %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf '  FAIL  %s\n' "$1"; }
run() { "$@" </dev/null 2>&1; }

expect_fail() { local name="$1" want="$2" out rc; shift 2; out="$(run "$@")" && rc=0 || rc=$?
  if ((rc != 0)) && [[ "$out" == *"$want"* ]]; then pass "$name"; else fail "$name — rc=$rc, got: $(tail -n 3 <<<"$out" | tr '\n' ' ')"; fi; }
expect_ok() { local name="$1" want="$2" out rc; shift 2; out="$(run "$@")" && rc=0 || rc=$?
  if ((rc == 0)) && [[ "$out" == *"$want"* ]]; then pass "$name"; else fail "$name — rc=$rc, got: $(tail -n 3 <<<"$out" | tr '\n' ' ')"; fi; }
# Exit code only (message content checked separately when it matters — several checks can be active at once).
expect_rc() { local name="$1" want_rc="$2" out rc; shift 2; out="$(run "$@")" && rc=0 || rc=$?
  if ((rc == want_rc)); then pass "$name"; else fail "$name — rc=$rc (wanted $want_rc), got: $(tail -n 3 <<<"$out" | tr '\n' ' ')"; fi
  printf '%s' "$out"; }

monitor="$bundle_dir/ppm-monitor.sh" backup="$bundle_dir/ppm-backup.sh" envtool="$bundle_dir/ppm-env.sh"

# ---- fake docker / curl / df / openssl -------------------------------------------------------------------------
fakebin="$tmp/fakebin"; mkdir -p "$fakebin"
fakelog="$tmp/fake.log"; : >"$fakelog"; : >"$fakelog.stdin"

cat >"$fakebin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
all=" $* "
contains() { [[ "$all" == *"$1"* ]]; }
last="${*: -1}"
mount_of() { # container path -> host path of the -v mapping to it (same trick as tests/cli-checks.sh)
  local prev="" arg
  for arg in "$@"; do
    if [[ "$prev" == -v ]]; then case "$arg" in *:"$MOUNT"|*:"$MOUNT":ro) echo "${arg%%:*}"; return;; esac; fi
    prev="$arg"
  done
}
case "$1" in
  info) echo "${FAKE_DOCKER_ROOT:-$FAKE_STATE_DIR/fake-docker-root}"; exit 0 ;;
  inspect)
    template="$3"; id="$4"; svc="${id#fake-}"
    case "$template" in
      *RestartCount*) var="FAKE_RESTART_${svc//-/_}"; echo "${!var:-0}" ;;
      *ExitCode*) var="FAKE_EXIT_${svc//-/_}"; echo "exited ${!var:-0}" ;;
      *) var="FAKE_STATE_${svc//-/_}"; echo "${!var:-healthy}" ;;
    esac
    exit 0 ;;
  volume) exit 1 ;;  # no Forgejo data volume in these fixtures
  compose)
    # "dc run ...": docker COMPOSE run, so this (not the bare "run" case, only used for forgejo-tools) is where
    # ppm-backup.sh's mc/gpg-encryption and object-mirror steps actually land.
    if contains ":/backup:ro" && contains ":/out"; then  # "encryption" stand-in: tar the work dir into the output
      work="$(MOUNT=/backup mount_of "$@")"; out="$(MOUNT=/out mount_of "$@")"
      tar -czf "$out/$last.tar.gz.gpg" -C "$work" . && exit 0; exit 1
    fi
    if contains "mc ls --recursive --json"; then exit 0; fi   # empty bucket listing
    if contains "mc mirror"; then exit 0; fi
    if contains " ps -q " || contains " ps -a -q "; then
      svc="$last"; absent_var="FAKE_ABSENT_${svc//-/_}"
      [[ -n "${!absent_var:-}" ]] && exit 0   # no output = no container
      echo "fake-$svc"; exit 0
    fi
    if contains "exec -T proxy cat"; then exit 1; fi
    if contains "pg_dump"; then [[ -n "${FAKE_PGDUMP_FAIL:-}" ]] && exit 1; printf 'FAKE-DUMP'; exit 0; fi
    if contains "pg_restore --list"; then cat >/dev/null; echo "1; 0 0 TABLE fake t plane"; exit 0; fi
    if contains "pg_restore --data-only"; then cat >/dev/null; printf 'COPY public.fake_t (id) FROM stdin;\n1\n\\.\n'; exit 0; fi
    if contains "show server_version"; then echo "15.7"; exit 0; fi
    if contains "datname = 'forgejo'"; then echo 0; exit 0; fi
    exit 0 ;;
esac
exit 0
FAKE
chmod +x "$fakebin/docker"

cat >"$fakebin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >>"$FAKE_LOG"
all=" $* "
contains() { [[ "$all" == *"$1"* ]]; }
if contains "--write-out"; then
  url="${*: -1}"
  [[ -n "${FAKE_HTTP_FAIL_MATCH:-}" && "$url" == *"$FAKE_HTTP_FAIL_MATCH"* ]] && exit 7
  printf '%s' "${FAKE_HTTP_CODE:-200}"
  exit 0
fi
if contains "--config"; then
  cfg="$(cat)"
  # The config (stdin) legitimately carries the secret — that is the point of --config over argv — so it is logged
  # to its OWN file, never to $FAKE_LOG (which the tests grep to prove nothing reached any process's ARGV).
  printf '%s\n' "$cfg" >>"$FAKE_LOG.stdin"
  if [[ "$cfg" == *"api.telegram.org"* ]]; then
    [[ -n "${FAKE_TELEGRAM_FAIL:-}" ]] && { echo '{"ok":false,"description":"fake failure"}'; exit 0; }
    echo '{"ok":true,"result":{"message_id":1}}'; exit 0
  fi
  if [[ "$cfg" == *"mail-rcpt"* ]]; then
    [[ -n "${FAKE_SMTP_FAIL:-}" ]] && exit 35
    exit 0
  fi
fi
exit 0
FAKE
chmod +x "$fakebin/curl"

cat >"$fakebin/df" <<'FAKE'
#!/usr/bin/env bash
echo "df $*" >>"$FAKE_LOG"
size="${FAKE_DF_SIZE_KB:-104857600}" avail="${FAKE_DF_AVAIL_KB:-52428800}"
echo "Filesystem 1024-blocks Used Available Capacity Mounted-on"
echo "fakefs $size 0 $avail 50% ${*: -1}"
FAKE
chmod +x "$fakebin/df"

cat >"$fakebin/openssl" <<'FAKE'
#!/usr/bin/env bash
echo "openssl $*" >>"$FAKE_LOG"
case "$1" in
  s_client) cat >/dev/null 2>&1; echo "FAKE-CERT-PEM-BYTES"; exit 0 ;;
  x509) cat >/dev/null 2>&1; [[ -n "${FAKE_CERT_EXPIRING:-}" ]] && exit 1; exit 0 ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$fakebin/openssl"

fake() { env PATH="$fakebin:$PATH" FAKE_LOG="$fakelog" FAKE_STATE_DIR="$tmp" "$@"; }
no_value_leaked() { # value... -> 0 when none of the values appear in $fakelog or in the given text (in $1)
  local text="$1" v; shift
  for v in "$@"; do [[ "$text" == *"$v"* ]] && return 1; grep -qF -- "$v" "$fakelog" && return 1; done
  return 0
}

# ---- fixture: one env, ACME (so certificate checks run), Git server on (default) --------------------------------
envfile="$tmp/ppm.env"
run "$envtool" init --domain ppm-mon.example.test --tls owner@example.test --bind 0.0.0.0 \
  --project ppm-mon-test --release cli --output "$envfile" >/dev/null
run "$envtool" check "$envfile" >/dev/null || { echo "FATAL: fixture env is invalid"; run "$envtool" check "$envfile"; exit 1; }
state_dir="$PPM_RUNTIME_DIR/ppm-mon-test"
reset_state() { rm -f "$state_dir"/monitor-state.txt "$state_dir"/monitor-restarts.txt "$state_dir"/monitor.lock; : >"$fakelog"; : >"$fakelog.stdin"; }

echo "ppm-monitor.sh — arguments"
expect_fail "needs --env-file" "pass --env-file explicitly" fake "$monitor"
expect_fail "unknown argument" "unknown argument: --bogus" fake "$monitor" --env-file "$envfile" --bogus
expect_fail "--once and --test are exclusive" "mutually exclusive" fake "$monitor" --env-file "$envfile" --once --test
expect_fail "--test and --once are exclusive (either order)" "mutually exclusive" fake "$monitor" --env-file "$envfile" --test --once

echo "ppm-monitor.sh --test — no channel configured"
reset_state
expect_fail "no channel configured: refuses and says so" "no alert channel is configured" fake "$monitor" --env-file "$envfile" --test
[[ "$(grep -c 'curl ' "$fakelog" || true)" == 0 ]] && pass "  ... curl was never called" || fail "  ... curl was called: $(cat "$fakelog")"

echo "ppm-monitor.sh --test — configured channels, secrets never in argv/output"
token="123456789:AAfakeTelegramToken1234567890abcd" chat_id="-100123456789"
smtp_pass="s3cret-smtp-app-password"
run "$envtool" set "$envfile" PPM_ALERT_TELEGRAM_CHAT_ID "$chat_id" >/dev/null
"$envtool" set-secret "$envfile" PPM_ALERT_TELEGRAM_BOT_TOKEN <<<"$token" >/dev/null 2>&1
run "$envtool" set "$envfile" PPM_ALERT_SMTP_HOST smtp.example.test >/dev/null
run "$envtool" set "$envfile" PPM_ALERT_SMTP_FROM ppm@example.test >/dev/null
run "$envtool" set "$envfile" PPM_ALERT_SMTP_TO owner@example.test >/dev/null
run "$envtool" set "$envfile" PPM_ALERT_SMTP_USER bot@example.test >/dev/null
"$envtool" set-secret "$envfile" PPM_ALERT_SMTP_PASSWORD <<<"$smtp_pass" >/dev/null 2>&1
run "$envtool" check "$envfile" >/dev/null || fail "fixture became invalid after configuring alert channels"
: >"$fakelog"; : >"$fakelog.stdin"
out="$(run fake "$monitor" --env-file "$envfile" --test)"; rc=$?
if ((rc == 0)) && [[ "$out" == *"chat $chat_id: OK"* && "$out" == *"owner@example.test: OK"* ]]; then
  pass "--test: both configured channels report OK, chat id and address are shown"
else fail "--test with channels: rc=$rc, got: $out"; fi
if no_value_leaked "$out" "$token" "$smtp_pass"; then pass "  ... bot token and SMTP password never appear in output or in any subprocess argv"
else fail "  ... a secret leaked into output or argv"; fi
[[ "$(grep -c 'api.telegram.org' "$fakelog.stdin")" -ge 1 && "$(grep -c 'mail-rcpt' "$fakelog.stdin")" -ge 1 ]] \
  && pass "  ... both curl config bodies were actually sent (telegram + smtp)" || fail "  ... a channel was not attempted: $(cat "$fakelog")"

echo "ppm-monitor.sh --test — a channel that fails is reported and the command fails"
: >"$fakelog"; : >"$fakelog.stdin"
out="$(run fake env FAKE_TELEGRAM_FAIL=1 "$monitor" --env-file "$envfile" --test)"; rc=$?
if ((rc == 1)) && [[ "$out" == *"chat $chat_id: FAILED"* ]]; then pass "--test: a failed channel is reported and the command exits non-zero"
else fail "--test failure path: rc=$rc, got: $out"; fi

echo "ppm-monitor.sh --once — everything healthy: quiet, exit 0, no alert sent"
reset_state
mkdir -p "$tmp/backups"
touch "$tmp/backups/ppm-mon-test-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.gpg"
{ echo "status=ok"; echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "archive=ppm-mon-test-x.tar.gz.gpg"; } >"$state_dir/last-backup.txt" 2>/dev/null \
  || { mkdir -p "$state_dir"; echo "status=ok" >"$state_dir/last-backup.txt"; echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$state_dir/last-backup.txt"; }
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups")"; rc=$?
if ((rc == 0)) && [[ "$out" == *"0 problem(s)"* ]]; then pass "all healthy: exit 0, 0 problems"
else fail "all healthy: rc=$rc, got: $(tail -n 5 <<<"$out")"; fi
[[ "$(grep -c 'api.telegram.org\|mail-rcpt' "$fakelog.stdin")" == 0 ]] && pass "  ... nothing was sent (nothing to report)" || fail "  ... an alert was sent while everything was healthy"

echo "ppm-monitor.sh — a down service: crit, alert sent, names the service and since-time"
: >"$fakelog"; : >"$fakelog.stdin"
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_STATE_api=unhealthy "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups")"; rc=$?
if ((rc == 2)) && [[ "$out" == *"не отвечает сервис api (с "* ]]; then pass "down service: exit 2, message names it with a time"
else fail "down service: rc=$rc, got: $(tail -n 6 <<<"$out")"; fi
[[ "$(grep -c 'api.telegram.org' "$fakelog.stdin")" -ge 1 ]] && pass "  ... alert was sent (new problem)" || fail "  ... no alert sent for a brand-new problem"
if no_value_leaked "$out" "$token" "$smtp_pass"; then pass "  ... still no secret in output/argv while alerting on a real problem"
else fail "  ... a secret leaked while alerting"; fi

echo "ppm-monitor.sh — SMTP delivery failure: exit code only, never curl's own output (password stays hidden)"
: >"$fakelog"; : >"$fakelog.stdin"
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_SMTP_FAIL=1 "$monitor" --env-file "$envfile" --test)"; rc=$?
if no_value_leaked "$out" "$smtp_pass" && ! grep -qF -- "$smtp_pass" "$fakelog"; then
  pass "a failing SMTP send logs only the curl exit code — the password is not in the output or in any argv"
else fail "SMTP failure path leaked the password: $out"; fi

echo "ppm-monitor.sh — same problem, same run soon after: no repeat alert (not due yet)"
: >"$fakelog"; : >"$fakelog.stdin"
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_STATE_api=unhealthy "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups")"; rc=$?
[[ $rc == 2 ]] && [[ "$(grep -c 'api.telegram.org\|mail-rcpt' "$fakelog.stdin")" == 0 ]] \
  && pass "unchanged problem, no reminder due: no alert sent, exit code still reflects it (2)" \
  || fail "unchanged problem: rc=$rc, sent=$(grep -c 'api.telegram.org' "$fakelog.stdin")"

echo "ppm-monitor.sh — reminder fires once PPM_MONITOR_REMIND_HOURS has elapsed since the last notification"
reset_state
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_STATE_api=unhealthy "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups")"; rc=$?
[[ $rc == 2 && "$(grep -c 'api.telegram.org' "$fakelog.stdin")" -ge 1 ]] \
  && pass "first sighting of the problem alerts (baseline for the reminder test)" \
  || fail "reminder test setup: rc=$rc, sent=$(grep -c 'api.telegram.org' "$fakelog.stdin")"
# Back-date "notified" (4th field) on the svc:api line by 7h (> the fixture's default 6h reminder) — the same
# effect PPM_MONITOR_REMIND_HOURS=0 would have, without needing a 0 value the validator (rightly) rejects as a
# threshold for the other keys sharing MONITOR_THRESHOLD_KEYS.
seven_hours_ago="$(date -u -v-7H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '7 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
awk -v t="$seven_hours_ago" '{ if ($1 == "svc:api") { $4 = t }; print }' "$state_dir/monitor-state.txt" >"$state_dir/monitor-state.txt.new" \
  && mv "$state_dir/monitor-state.txt.new" "$state_dir/monitor-state.txt"
: >"$fakelog"; : >"$fakelog.stdin"
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_STATE_api=unhealthy "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups")"; rc=$?
[[ $rc == 2 && "$(grep -c 'api.telegram.org' "$fakelog.stdin")" -ge 1 ]] \
  && pass "a problem last mentioned >PPM_MONITOR_REMIND_HOURS ago is re-sent, unchanged or not" \
  || fail "reminder did not fire: rc=$rc, sent=$(grep -c 'api.telegram.org' "$fakelog.stdin")"
# No reset_state here: svc:api is left crit in the state, same as before this block existed — the very next test
# ("recovery") relies on that to see the ok-transition and send the all-clear message.

echo "ppm-monitor.sh — recovery: all-clear message, exit 0"
: >"$fakelog"; : >"$fakelog.stdin"
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups")"; rc=$?
if ((rc == 0)) && [[ "$out" == *"PPM: всё снова в порядке"* ]]; then pass "recovery: exit 0, exact all-clear message"
else fail "recovery: rc=$rc, got: $(tail -n 5 <<<"$out")"; fi

echo "ppm-monitor.sh — restart-loop detection needs a baseline, then flags a climbing count"
reset_state
run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_RESTART_proxy=1 "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups" >/dev/null
first_rc=$?
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_RESTART_proxy=4 "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups")"; rc=$?
if ((first_rc == 0)) && ((rc == 2)) && [[ "$out" == *"сервис proxy перезапускается по кругу"* ]]; then
  pass "restart-loop: first poll only seeds the baseline (no false alarm), a later climb is flagged"
else fail "restart-loop: first_rc=$first_rc rc=$rc, got: $(tail -n 5 <<<"$out")"; fi

echo "ppm-monitor.sh — disk thresholds (warn then critical), by percentage-or-absolute"
reset_state
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_DF_SIZE_KB=104857600 FAKE_DF_AVAIL_KB=9437184 "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups")"; rc=$?
[[ $rc == 1 && "$out" == *"на диске (данные Docker) осталось 9 ГБ (9 %)"* ]] \
  && pass "disk warn: exit 1, GB and percent both shown" || fail "disk warn: rc=$rc, got: $(tail -n 5 <<<"$out")"
reset_state
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_DF_SIZE_KB=104857600 FAKE_DF_AVAIL_KB=2097152 "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups")"; rc=$?
[[ $rc == 2 && "$out" == *"на диске (данные Docker) осталось 2 ГБ"* ]] \
  && pass "disk critical: exit 2" || fail "disk critical: rc=$rc, got: $(tail -n 5 <<<"$out")"

echo "ppm-monitor.sh — backup: fresh install (no archive, no marker either) is a WARNING, not a critical"
reset_state
rm -f "$state_dir/last-backup.txt"
fresh_backups="$tmp/fresh-backups"; mkdir -p "$fresh_backups"
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" "$monitor" --env-file "$envfile" --backup-dir "$fresh_backups")"; rc=$?
if ((rc == 1)) && [[ "$out" == *"Резервных копий ещё не было"* ]]; then
  pass "never having backed up yet is a warning (exit 1) with its own message, not the generic critical"
else fail "fresh install: rc=$rc, got: $(tail -n 5 <<<"$out")"; fi
[[ "$(grep -c 'нет резервной копии в' <<<"$out")" == 0 ]] \
  && pass "  ... the generic 'no archive' critical text is not also shown" || fail "  ... both messages fired at once: $out"

echo "ppm-monitor.sh — backup: no archive at all but a marker exists (an attempt was made) IS critical, and a stale one"
reset_state
mkdir -p "$state_dir"
{ echo "status=ok"; echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "archive=ppm-mon-test-x.tar.gz.gpg"; } >"$state_dir/last-backup.txt"
empty_backups="$tmp/empty-backups"; mkdir -p "$empty_backups"
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" "$monitor" --env-file "$envfile" --backup-dir "$empty_backups")"; rc=$?
[[ $rc -ge 1 && "$out" == *"нет резервной копии"* ]] && pass "backup: no archive at all is reported" \
  || fail "backup: no archive: rc=$rc, got: $(tail -n 5 <<<"$out")"
reset_state
stale_backups="$tmp/stale-backups"; mkdir -p "$stale_backups"
touch "$stale_backups/ppm-mon-test-20200101T000000Z.tar.gz.gpg"
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" "$monitor" --env-file "$envfile" --backup-dir "$stale_backups")"; rc=$?
[[ $rc -ge 1 && "$out" == *"резервной копии нет "*" ч"* ]] && pass "backup: a >26h-old archive is reported as stale, with hours" \
  || fail "backup: stale: rc=$rc, got: $(tail -n 5 <<<"$out")"

echo "ppm-monitor.sh — backup: last ppm-backup.sh run failed (marker), even with an old good archive present"
reset_state
mkdir -p "$state_dir"
{ echo "status=error"; echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "archive="; } >"$state_dir/last-backup.txt"
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" "$monitor" --env-file "$envfile" --backup-dir "$stale_backups")"; rc=$?
[[ "$out" == *"последний бэкап завершился ошибкой"* ]] && pass "backup: a failed last run is reported" \
  || fail "backup: failed marker: rc=$rc, got: $(tail -n 5 <<<"$out")"
rm -f "$state_dir/last-backup.txt"

echo "ppm-monitor.sh — certificate close to expiry (ACME only; this fixture is ACME)"
reset_state
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_CERT_EXPIRING=1 "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups")"; rc=$?
[[ "$out" == *"сертификат PPM скоро истекает"* && "$out" == *"сертификат Git-сервера скоро истекает"* ]] \
  && pass "certificate: both PPM and the Git server are checked and reported" || fail "certificate: rc=$rc, got: $(tail -n 6 <<<"$out")"

echo "ppm-monitor.sh — empty channels: a real problem still exits non-zero, logs only, nothing sent"
noalert="$tmp/noalert.env"; cp "$envfile" "$noalert"
run "$envtool" set "$noalert" PPM_ALERT_SMTP_HOST "" >/dev/null 2>&1
# PPM_ALERT_TELEGRAM_BOT_TOKEN/PPM_ALERT_SMTP_PASSWORD are secrets: clear them by editing the file directly (set/get refuse).
sed -i.bak -E 's/^(PPM_ALERT_TELEGRAM_BOT_TOKEN=).*/\1/; s/^(PPM_ALERT_TELEGRAM_CHAT_ID=).*/\1/' "$noalert" && rm -f "$noalert.bak"
run "$envtool" check "$noalert" >/dev/null || fail "noalert fixture became invalid"
reset_state
: >"$fakelog"; : >"$fakelog.stdin"
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_STATE_web=unhealthy "$monitor" --env-file "$noalert" --backup-dir "$tmp/backups")"; rc=$?
[[ $rc == 2 && "$(grep -c 'api.telegram.org\|mail-rcpt' "$fakelog.stdin")" == 0 ]] \
  && pass "no channels configured: exit code still reflects the problem, nothing was sent" \
  || fail "no channels: rc=$rc, sent=$(grep -c 'api.telegram.org\|mail-rcpt' "$fakelog.stdin")"

echo "ppm-monitor.sh — lock: a stale lock (dead pid) is cleared; a live lock refuses a second run"
reset_state
mkdir -p "$state_dir"; echo 999999999 >"$state_dir/monitor.lock"
out="$(run fake env FAKE_DOCKER_ROOT="$tmp" "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups")"; rc=$?
((rc == 0)) && pass "a lock left by a dead pid is cleared and the run proceeds" || fail "stale lock: rc=$rc, got: $(tail -n 5 <<<"$out")"
echo $$ >"$state_dir/monitor.lock"   # our own pid: always alive for the duration of this script
expect_fail "a lock held by a live pid refuses a second run" "is in progress" fake env FAKE_DOCKER_ROOT="$tmp" "$monitor" --env-file "$envfile" --backup-dir "$tmp/backups"
rm -f "$state_dir/monitor.lock"

echo "ppm-backup.sh — result marker on success and on failure (O-1.4)"
bkenv="$tmp/backup.env"
run "$envtool" init --domain ppm-bk.example.test --project ppm-bk-test --release cli --output "$bkenv" >/dev/null
run "$envtool" set "$bkenv" PPM_GIT_SERVER_ENABLED 0 >/dev/null
bk_state="$PPM_RUNTIME_DIR/ppm-bk-test"
: >"$fakelog"; : >"$fakelog.stdin"
run fake env FAKE_DOCKER_ROOT="$tmp" "$backup" --env-file "$bkenv" --output-dir "$tmp/bk-out" >/dev/null 2>&1
marker="$bk_state/last-backup.txt"
if [[ -f "$marker" ]] && grep -q '^status=ok$' "$marker" && grep -q '^archive=ppm-bk-test-' "$marker" && [[ "$(stat -c %a "$marker" 2>/dev/null || stat -f %Lp "$marker")" == 600 ]]; then
  pass "successful backup writes status=ok with the archive name, mode 600"
else fail "success marker missing/wrong: $(cat "$marker" 2>/dev/null || echo '<no file>')"; fi
ok_finished="$(awk -F= '$1=="finished_at"{print $2}' "$marker")"
sleep 1
run fake env FAKE_DOCKER_ROOT="$tmp" FAKE_PGDUMP_FAIL=1 "$backup" --env-file "$bkenv" --output-dir "$tmp/bk-out" >/dev/null 2>&1
if [[ -f "$marker" ]] && grep -q '^status=error$' "$marker" && grep -q '^archive=$' "$marker"; then
  pass "a failed backup (pg_dump fails) overwrites the marker with status=error and no archive name"
else fail "error marker missing/wrong: $(cat "$marker" 2>/dev/null || echo '<no file>')"; fi
err_finished="$(awk -F= '$1=="finished_at"{print $2}' "$marker")"
[[ -n "$ok_finished" && -n "$err_finished" && "$err_finished" > "$ok_finished" ]] \
  && pass "  ... the error marker is newer than the earlier success" || fail "  ... marker timestamps: ok=$ok_finished error=$err_finished"

echo "monitor-checks: $passed passed, $failed failed"
((failed == 0)) || exit 1
