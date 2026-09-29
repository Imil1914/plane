#!/usr/bin/env bash
# PPM monitoring and alerts (RUNBOOK §14): one poll of the deployment's health, meant for cron every few minutes.
#
#   ppm-monitor.sh --env-file FILE [--once] [--backup-dir DIR]
#   ppm-monitor.sh --env-file FILE --test
#
#   --once            one run and exit (the default; accepted explicitly for a self-documenting cron line)
#   --test            send one test message to every CONFIGURED alert channel, print where it went, exit; runs no
#                     health checks at all
#   --backup-dir DIR  where ppm-backup.sh writes archives, if not the default (PPM_BACKUP_DIR in the env, else
#                     <runtime>/backups) — pass the same --output-dir the backup cron line uses (RUNBOOK §10)
#
# Checks each run (O-1): every expected service is running and healthy, including one-shot migrations (absent or
# failed = a problem) and services climbing their Docker restart count (crash-looping, even if briefly "healthy"
# between restarts); PPM and, if enabled, the Git server (Forgejo) answer from outside through the same public
# address a browser uses; free disk space at the Docker data root and at the backups directory (percentage OR
# absolute, whichever trips first); the newest backup archive's age and whether the last ppm-backup.sh run failed
# (its own result marker, RUNBOOK §10); and, only with Let's Encrypt (not tls internal), days left on the PPM and
# Git certificates.
#
# Alerts (O-2) go to whichever channels the owner configured in the env (both optional, off when empty): a
# Telegram bot (PPM_ALERT_TELEGRAM_BOT_TOKEN/_CHAT_ID) and/or e-mail via SMTP (PPM_ALERT_SMTP_*) — set with
# `ppm-env.sh set` (plain settings) and `ppm-env.sh set-secret` (the bot token, the SMTP password). Secrets are
# read only from the env file and handed to curl through its --config on stdin — never a command-line argument,
# so they never appear in `ps`, in this script's own output or in the log it is run under. One combined message is
# sent per run, at most, only when something changed (a check went bad or recovered) or a still-bad check has not
# been mentioned in the last PPM_MONITOR_REMIND_HOURS (default 6): never one message per problem. No channel
# configured: the run still logs and exits with the same status (O-2/O-3).
#
# State (O-3) — last status/since/last-notified per check, and the last seen Docker restart count per service — is
# kept in .runtime/<project>/ (mode 600); a lock file there refuses a second run of the same project's monitor
# while one is in progress (stale locks of a dead pid are cleared automatically).
#
# Env file: --env-file, else $PPM_ENV_FILE, else <bundle>/.runtime/ppm.env (ppm-lib.sh); the choice is always
# printed. Exit code: 0 nothing wrong, 1 a warning is active, 2 a critical problem is active (independent of
# whether any alert could be sent).
set -euo pipefail
umask 077

bundle_dir="$(cd "$(dirname "$0")" && pwd)"
PPM_SCRIPT_NAME=ppm-monitor
fail() { echo "ppm-monitor: $*" >&2; exit 2; }
usage() { sed -n '2,36p' "$0"; }

env_file_arg="" backup_dir_arg="" test_mode=0 once_given=0
while (($#)); do
  case "$1" in
    --env-file)
      [[ $# -ge 2 && -n "$2" && "$2" != -* && -z "$env_file_arg" ]] || fail "--env-file needs a path (once)"
      env_file_arg="$2"; shift 2 ;;
    --env-file=*)
      [[ -z "$env_file_arg" ]] || fail "--env-file given twice"
      env_file_arg="${1#--env-file=}"; [[ -n "$env_file_arg" ]] || fail "--env-file needs a path"; shift ;;
    --backup-dir)
      [[ $# -ge 2 && -n "$2" && -z "$backup_dir_arg" ]] || fail "--backup-dir needs a path (once)"
      backup_dir_arg="$2"; shift 2 ;;
    --once) ((test_mode == 0)) || fail "--once and --test are mutually exclusive"; once_given=1; shift ;;
    --test) ((once_given == 0)) || fail "--once and --test are mutually exclusive"; test_mode=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1 (see --help)" ;;
  esac
done

# shellcheck source=ppm-lib.sh
source "$bundle_dir/ppm-lib.sh"
[[ -n "$env_file_arg" ]] || die "pass --env-file explicitly (there is no default for a script cron runs unattended)"
ppm_resolve_env_file "$env_file_arg"
ppm_init_context

# ---- lock: refuse a second run of the same project while one is in progress; a lock of a dead pid is stale -----
lock_file="$state_dir/monitor.lock"
release_lock() { rm -f -- "$lock_file"; }
if [[ -f "$lock_file" ]]; then
  lock_pid="$(tr -dc '0-9' <"$lock_file" 2>/dev/null || true)"
  if [[ "$lock_pid" =~ ^[0-9]+$ ]] && kill -0 "$lock_pid" 2>/dev/null; then
    die "another run (pid $lock_pid) is in progress for project $project; nothing was done"
  fi
  note "removing a stale lock (pid ${lock_pid:-?})"
  rm -f -- "$lock_file"
fi
echo "$$" >"$lock_file"; chmod 600 "$lock_file"
trap release_lock EXIT

# ---- settings: thresholds default here when the key is absent (older env, no migration needed); the alert
# channels are read straight from the env at send time so a value changed mid-run is never used stale -----------
threshold() { local v; v="$(env_get "$1")"; echo "${v:-$2}"; }
disk_warn_pct="$(threshold PPM_MONITOR_DISK_WARN_PERCENT 15)"
disk_warn_gb="$(threshold PPM_MONITOR_DISK_WARN_GB 10)"
disk_crit_pct="$(threshold PPM_MONITOR_DISK_CRIT_PERCENT 5)"
disk_crit_gb="$(threshold PPM_MONITOR_DISK_CRIT_GB 3)"
backup_max_age_hours="$(threshold PPM_MONITOR_BACKUP_MAX_AGE_HOURS 26)"
cert_warn_days="$(threshold PPM_MONITOR_CERT_WARN_DAYS 14)"
remind_hours="$(threshold PPM_MONITOR_REMIND_HOURS 6)"
http_timeout="$(threshold PPM_MONITOR_HTTP_TIMEOUT 5)"

domain="$(env_get PPM_DOMAIN)"
git_domain="$(env_get PPM_GIT_DOMAIN)"
https_port="$(env_get PPM_HTTPS_PORT)"
tls_mode="$(env_get PPM_TLS)"
backup_dir="${backup_dir_arg:-$(env_get PPM_BACKUP_DIR)}"; backup_dir="${backup_dir:-$runtime_dir/backups}"

# Caddy's local CA (private phase / *.localhost drills only): same extraction ppm-deploy.sh's smoke_run uses, so
# the HTTP checks below can verify the certificate instead of skipping validation.
ca_bundle=""
if [[ "$tls_mode" == internal ]]; then
  ca_bundle="$state_dir/internal-ca.crt"
  dc exec -T proxy cat /data/caddy/pki/authorities/local/root.crt >"$ca_bundle" 2>/dev/null || ca_bundle=""
fi

# ---- small portable helpers --------------------------------------------------------------------------------
# ISO8601 UTC ("YYYY-MM-DDTHH:MM:SSZ") -> epoch seconds; empty on failure. GNU date first, then BSD/macOS date
# (same dual-implementation idiom as sha256_file/file_mode elsewhere in this bundle).
to_epoch() { date -u -d "$1" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || true; }
hhmm() { printf '%s' "${1:11:5}"; }  # "...THH:MM:SSZ" -> "HH:MM"
# Safe inside a double-quoted value on one line of a curl --config file.
curl_cfg_escape() { local v="$1"; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; v="${v//$'\n'/\\n}"; printf '%s' "$v"; }

# ---- alert channels (O-2): secrets go from the env straight into curl's stdin config, never argv -----------
telegram_configured() { [[ -n "$(env_get PPM_ALERT_TELEGRAM_BOT_TOKEN)" && -n "$(env_get PPM_ALERT_TELEGRAM_CHAT_ID)" ]]; }
smtp_configured() { [[ -n "$(env_get PPM_ALERT_SMTP_HOST)" ]]; }

send_telegram() { # text -> 0 sent, 1 failed, 2 not configured
  local token chat_id text cfg out rc
  token="$(env_get PPM_ALERT_TELEGRAM_BOT_TOKEN)"; chat_id="$(env_get PPM_ALERT_TELEGRAM_CHAT_ID)"
  [[ -n "$token" && -n "$chat_id" ]] || return 2
  text="$(curl_cfg_escape "$1")"
  cfg="$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\ndata-urlencode = "text=%s"\nsilent\nshow-error\nmax-time = %s\n' \
    "$token" "$chat_id" "$text" "$http_timeout")"
  if out="$(curl --config - <<<"$cfg" 2>&1)"; then rc=0; else rc=$?; fi
  if ((rc != 0)); then note "Telegram: curl exited $rc"; return 1; fi
  [[ "$out" == *'"ok":true'* ]] && return 0
  note "Telegram: the API did not confirm delivery"
  return 1
}

send_email() { # subject body -> 0 sent, 1 failed, 2 not configured
  local host port security user pass from to msgfile cfg addr rc url
  host="$(env_get PPM_ALERT_SMTP_HOST)"
  [[ -n "$host" ]] || return 2
  port="$(env_get PPM_ALERT_SMTP_PORT)"; port="${port:-587}"
  security="$(env_get PPM_ALERT_SMTP_SECURITY)"; security="${security:-starttls}"
  user="$(env_get PPM_ALERT_SMTP_USER)"; pass="$(env_get PPM_ALERT_SMTP_PASSWORD)"
  from="$(env_get PPM_ALERT_SMTP_FROM)"; to="$(env_get PPM_ALERT_SMTP_TO)"
  if [[ -z "$from" || -z "$to" ]]; then note "SMTP: PPM_ALERT_SMTP_FROM/PPM_ALERT_SMTP_TO is not set"; return 1; fi
  if [[ "$security" == tls ]]; then url="smtps://$host:$port"; else url="smtp://$host:$port"; fi
  msgfile="$(mktemp "$state_dir/.mail.XXXXXX")"; chmod 600 "$msgfile"
  { printf 'From: %s\r\n' "$from"
    printf 'To: %s\r\n' "${to//,/, }"
    printf 'Subject: %s\r\n' "$1"
    printf 'Date: %s\r\n' "$(date -u +'%a, %d %b %Y %H:%M:%S +0000')"
    printf 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
    printf '%s\r\n' "$2"
  } >"$msgfile"
  cfg="$(printf 'url = "%s"\nmail-from = "%s"\n' "$(curl_cfg_escape "$url")" "$(curl_cfg_escape "$from")")"
  for addr in ${to//,/ }; do cfg+="$(printf 'mail-rcpt = "%s"\n' "$(curl_cfg_escape "$addr")")"; done
  [[ "$security" == starttls ]] && cfg+=$'ssl-reqd\n'
  [[ -n "$user" ]] && cfg+="$(printf 'user = "%s:%s"\n' "$(curl_cfg_escape "$user")" "$(curl_cfg_escape "$pass")")"
  cfg+="$(printf 'upload-file = "%s"\nsilent\nshow-error\nmax-time = %s\n' "$msgfile" "$http_timeout")"
  # Output discarded, not merely unlogged: with --show-error curl's own error text can echo back pieces of the
  # config it just read from stdin (up to and including the password) — only the exit code is ever inspected.
  if curl --config - <<<"$cfg" >/dev/null 2>&1; then rc=0; else rc=$?; fi
  rm -f -- "$msgfile"
  if ((rc != 0)); then note "SMTP: curl exited $rc"; return 1; fi
  return 0
}

# Tries every configured channel, logs each result (no secrets); return: 0 at least one sent, 1 all configured
# channels failed, 2 nothing is configured.
notify_all() { # message subject
  local configured=0 sent=0
  if telegram_configured; then
    configured=1
    if send_telegram "$1"; then note "Telegram: sent"; sent=1; else note "Telegram: FAILED"; fi
  fi
  if smtp_configured; then
    configured=1
    if send_email "$2" "$1"; then note "SMTP: sent"; sent=1; else note "SMTP: FAILED"; fi
  fi
  ((configured)) || return 2
  ((sent)) && return 0 || return 1
}

if ((test_mode)); then
  message="PPM: тестовое сообщение мониторинга ($project, $(date -u +%Y-%m-%dT%H:%M:%SZ))"
  any=0 test_failed=0
  if telegram_configured; then
    any=1
    if send_telegram "$message"; then echo "ppm-monitor --test: Telegram -> chat $(env_get PPM_ALERT_TELEGRAM_CHAT_ID): OK"
    else echo "ppm-monitor --test: Telegram -> chat $(env_get PPM_ALERT_TELEGRAM_CHAT_ID): FAILED" >&2; test_failed=1; fi
  fi
  if smtp_configured; then
    any=1
    if send_email "PPM: тестовое сообщение мониторинга" "$message"; then echo "ppm-monitor --test: SMTP -> $(env_get PPM_ALERT_SMTP_TO): OK"
    else echo "ppm-monitor --test: SMTP -> $(env_get PPM_ALERT_SMTP_TO): FAILED" >&2; test_failed=1; fi
  fi
  ((any)) || { echo "ppm-monitor --test: no alert channel is configured (PPM_ALERT_TELEGRAM_*/PPM_ALERT_SMTP_*)" >&2; exit 1; }
  ((test_failed)) && exit 1
  exit 0
fi

# ---- checks (O-1): each appends "id|severity|message" (severity: ok/warn/crit; message empty when ok) ----------
results=()
add_result() { results+=("$1|$2|$3"); }

# A service is fine while "healthy", "running" (no healthcheck configured — same rule wait_healthy already uses)
# or "starting" (inside its start_period: a normal restart looks like this for a few seconds, and Docker itself
# will call it "unhealthy" if it never recovers, which the next poll then catches). Anything else — unhealthy,
# restarting, exited, dead, paused, or no container at all — is down. A climbing restart count is reported even
# for an otherwise "healthy" service: Compose restarts a crashing container in place, so health can look fine
# between crashes while the service is actually flapping.
new_restarts=""
check_service() { # service
  local svc="$1" state count prev_count
  state="$(ppm_service_status "$svc")"
  count="$(ppm_service_restart_count "$svc")"
  prev_count="$(awk -v s="$svc" '$1 == s { print $2 }' <<<"$old_restarts")"
  new_restarts+="$svc ${count:-0}"$'\n'
  case "$state" in
    healthy|running|starting)
      if [[ -n "$prev_count" && -n "$count" ]] && ((count > prev_count)); then
        add_result "svc:$svc" crit "сервис $svc перезапускается по кругу"
      else
        add_result "svc:$svc" ok ""
      fi ;;
    *) add_result "svc:$svc" crit "не отвечает сервис $svc" ;;
  esac
}

check_oneshot() { # service — expected to have run once and exited 0 (restart: "no"; migrator, minio-init, …)
  local svc="$1" id state
  id="$(dc ps -a -q "$svc" 2>/dev/null | head -n1)"
  if [[ -z "$id" ]]; then add_result "oneshot:$svc" warn "задача $svc не найдена"; return; fi
  state="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$id" 2>/dev/null || true)"
  if [[ "$state" == "exited 0" ]]; then add_result "oneshot:$svc" ok ""
  else add_result "oneshot:$svc" crit "задача $svc завершилась с ошибкой"; fi
}

http_check() { # id url label
  local id="$1" url="$2" label="$3" code opts=(--silent --show-error --max-time "$http_timeout" --output /dev/null --write-out '%{http_code}')
  [[ -n "$ca_bundle" ]] && opts+=(--cacert "$ca_bundle")
  if code="$(curl "${opts[@]}" "$url" 2>/dev/null)" && [[ "$code" =~ ^[23][0-9][0-9]$ ]]; then
    add_result "$id" ok ""
  else
    add_result "$id" crit "не отвечает $label"
  fi
}

disk_check() { # id path label
  local id="$1" path="$2" label="$3" line size_kb avail_kb avail_gb pct
  if [[ ! -d "$path" ]]; then add_result "$id" warn "диск ($label): каталог не найден"; return; fi
  line="$(df -Pk "$path" 2>/dev/null | tail -n1)"
  size_kb="$(awk '{print $2}' <<<"$line")"; avail_kb="$(awk '{print $4}' <<<"$line")"
  if [[ ! "$size_kb" =~ ^[0-9]+$ || ! "$avail_kb" =~ ^[0-9]+$ || "$size_kb" -eq 0 ]]; then
    add_result "$id" warn "диск ($label): df не вернул числа"; return
  fi
  avail_gb=$((avail_kb / 1024 / 1024)); pct=$((avail_kb * 100 / size_kb))
  if ((avail_gb < disk_crit_gb || pct < disk_crit_pct)); then
    add_result "$id" crit "на диске ($label) осталось ${avail_gb} ГБ (${pct} %)"
  elif ((avail_gb < disk_warn_gb || pct < disk_warn_pct)); then
    add_result "$id" warn "на диске ($label) осталось ${avail_gb} ГБ (${pct} %)"
  else
    add_result "$id" ok ""
  fi
}

# Only with a real (Let's Encrypt) certificate — `tls internal` is Caddy's own local CA and never "expires" in a
# way an owner needs paging for. -checkend gives a portable pass/fail at the exact threshold without any
# cross-platform date arithmetic (macOS/LibreSSL and Linux/OpenSSL agree on it).
cert_check() { # id sni label
  local id="$1" sni="$2" label="$3"
  if openssl s_client -connect "127.0.0.1:$https_port" -servername "$sni" </dev/null 2>/dev/null \
      | openssl x509 -noout -checkend $((cert_warn_days * 86400)) >/dev/null 2>&1; then
    add_result "$id" ok ""
  else
    add_result "$id" warn "сертификат $label скоро истекает (осталось меньше $cert_warn_days дн.)"
  fi
}

check_backup() {
  local archive_line compact iso epoch="" now age_h marker status finished marker_epoch="" recent_failure
  marker="$state_dir/last-backup.txt"
  archive_line="$(for f in "$backup_dir/$project"-*.tar.gz.gpg; do [[ -f "$f" ]] && basename "$f"; done 2>/dev/null \
    | grep -E "^${project}-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.gpg\$" | LC_ALL=C sort -r | head -n1 || true)"
  now="$(date -u +%s)"
  if [[ -z "$archive_line" ]]; then
    if [[ ! -f "$marker" ]]; then
      # Never attempted yet (no marker either) — a fresh install before the first backup, not an outage: WARN, not
      # CRIT (RUNBOOK §14 tells the owner to make one by hand right after turning monitoring on).
      add_result backup:age warn "Резервных копий ещё не было: запустите ppm-backup.sh один раз или дождитесь ночного запуска"
    else
      add_result backup:age crit "нет резервной копии в $backup_dir"
    fi
  else
    compact="${archive_line#"$project"-}"; compact="${compact%.tar.gz.gpg}"
    iso="${compact:0:4}-${compact:4:2}-${compact:6:2}T${compact:9:2}:${compact:11:2}:${compact:13:2}Z"
    epoch="$(to_epoch "$iso")"
    if [[ -z "$epoch" ]]; then
      add_result backup:age warn "не удалось разобрать время в имени копии $archive_line"
    else
      age_h=$(( (now - epoch) / 3600 ))
      if ((age_h > backup_max_age_hours)); then add_result backup:age crit "резервной копии нет ${age_h} ч"
      else add_result backup:age ok ""; fi
    fi
  fi
  if [[ -f "$marker" ]]; then
    status="$(awk -F= '$1 == "status" { print $2 }' "$marker")"
    finished="$(awk -F= '$1 == "finished_at" { print $2 }' "$marker")"
    [[ -n "$finished" ]] && marker_epoch="$(to_epoch "$finished")"
    # A failed run only matters here if it is more recent than the good archive found above (or there is no good
    # archive at all): an old, already-superseded failure must not re-alert forever once backups are healthy again.
    recent_failure=0
    if [[ "$status" == error ]]; then
      if [[ -z "$epoch" ]]; then recent_failure=1
      elif [[ -n "$marker_epoch" ]] && ((marker_epoch > epoch)); then recent_failure=1
      fi
    fi
    if ((recent_failure)); then
      add_result backup:run crit "последний бэкап завершился ошибкой"
    else
      add_result backup:run ok ""
    fi
  else
    add_result backup:run ok ""
  fi
}

old_restarts="$(cat "$state_dir/monitor-restarts.txt" 2>/dev/null || true)"

for svc in "${HEALTHY_SERVICES[@]}"; do check_service "$svc"; done
for svc in "${ONESHOT_SERVICES[@]}"; do check_oneshot "$svc"; done
http_check "http:ppm" "$(env_get PPM_PUBLIC_URL)" "сайт PPM"
((git_enabled)) && http_check "http:git" "$(env_get PPM_GIT_PUBLIC_URL)/api/healthz" "Git-сервер"
docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
if [[ -n "$docker_root" ]]; then disk_check "disk:docker" "$docker_root" "данные Docker"
else add_result "disk:docker" warn "не удалось определить каталог данных Docker"; fi
disk_check "disk:backups" "$backup_dir" "бэкапы"
check_backup
if [[ -n "$tls_mode" && "$tls_mode" != internal ]]; then
  cert_check "cert:ppm" "$domain" "PPM"
  ((git_enabled)) && cert_check "cert:git" "$git_domain" "Git-сервера"
fi

# ---- diff against the previous run, decide notifications (O-2/O-3) --------------------------------------------
state_file="$state_dir/monitor-state.txt"
old_state_content="$(cat "$state_file" 2>/dev/null || true)"
now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
now_epoch="$(date -u +%s)"
changed=0 any_due=0 worst=ok
bad_entries=()

for entry in "${results[@]}"; do
  id="${entry%%|*}"; rest="${entry#*|}"; sev="${rest%%|*}"; msg="${rest#*|}"
  old_line="$(grep -m1 "^$id " <<<"$old_state_content" || true)"
  old_sev="" old_since="" old_notified=""
  if [[ -n "$old_line" ]]; then
    old_sev="$(awk '{print $2}' <<<"$old_line")"; old_since="$(awk '{print $3}' <<<"$old_line")"
    old_notified="$(awk '{print $4}' <<<"$old_line")"
  fi
  if [[ "$sev" == ok ]]; then
    [[ -n "$old_sev" ]] && changed=1
    continue
  fi
  [[ "$sev" == crit ]] && worst=crit
  [[ "$sev" == warn && "$worst" == ok ]] && worst=warn
  since="$old_since"
  if [[ "$sev" != "$old_sev" || -z "$old_since" ]]; then since="$now_iso"; changed=1; fi
  due_this=0
  if [[ -z "$old_notified" ]]; then
    due_this=1
  else
    notified_epoch="$(to_epoch "$old_notified")"
    if [[ -z "$notified_epoch" ]] || (( (now_epoch - notified_epoch) / 3600 >= remind_hours )); then due_this=1; fi
  fi
  ((due_this)) && any_due=1
  display="$msg"
  case "$id" in svc:*|http:*|oneshot:*) display="$msg (с $(hhmm "$since"))" ;; esac
  bad_entries+=("$id|$sev|$since|$old_notified|$display")
done
send_needed=0; { ((changed)) || ((any_due)); } && send_needed=1

problem_lines=() new_state=""
for entry in ${bad_entries[@]+"${bad_entries[@]}"}; do
  IFS='|' read -r id sev since old_notified display <<<"$entry"
  problem_lines+=("$display")
  if ((send_needed)); then notified="$now_iso"; else notified="${old_notified:-$now_iso}"; fi
  new_state+="$id $sev $since $notified"$'\n'
done

printf '%s' "$new_restarts" >"$state_dir/monitor-restarts.txt.tmp" && mv -f "$state_dir/monitor-restarts.txt.tmp" "$state_dir/monitor-restarts.txt"
chmod 600 "$state_dir/monitor-restarts.txt"
printf '%s' "$new_state" >"$state_file.tmp" && mv -f "$state_file.tmp" "$state_file"
chmod 600 "$state_file"

if ((send_needed)); then
  if ((${#problem_lines[@]} == 0)); then
    body="PPM: всё снова в порядке"; subject="$body"
  elif ((${#problem_lines[@]} == 1)); then
    body="PPM: ${problem_lines[0]}"; subject="$body"
  else
    body="PPM: обнаружены проблемы:"
    for line in "${problem_lines[@]}"; do body+=$'\n'"- $line"; done
    subject="PPM: обнаружены проблемы (${#problem_lines[@]})"
  fi
  note "notification: $body"
  if notify_all "$body" "$subject"; then note "notification sent"
  else note "notification NOT sent (no channel configured, or every configured channel failed — see above)"; fi
fi

ok_count=0
for entry in "${results[@]}"; do
  sev="${entry#*|}"; sev="${sev%%|*}"
  [[ "$sev" == ok ]] && ok_count=$((ok_count + 1))
done
note "checks: ${#results[@]} total, $ok_count ok, $((${#results[@]} - ok_count)) problem(s); worst=$worst$( ((send_needed)) || echo "; nothing new to report" )"

case "$worst" in
  ok) exit 0 ;;
  warn) exit 1 ;;
  *) exit 2 ;;
esac
