#!/usr/bin/env bash
# PPM backup, ENCRYPTED: PostgreSQL custom-format dump + mirror of the object bucket (Plane attachments AND Vault
# files live in the same private bucket `uploads`) + the Git server (Forgejo: its database and data volume, when
# PPM_GIT_SERVER_ENABLED=1) + manifest + SHA-256, packed and encrypted with GnuPG (AES256, passphrase file from
# ppm.env) inside the pinned tools image, running as the invoking user.
#
#   ppm-backup.sh --env-file FILE [--output-dir DIR] [--keep N]
#
# Output in <output-dir> (default: PPM_BACKUP_DIR from the env, else <runtime>/backups), directory mode 700:
#   <project>-<UTC>.tar.gz.gpg          encrypted archive: db/plane.pgdump (pg_dump -Fc of the whole database: Work
#                                       Items, boards with all versions, Vault metadata/versions, Brain index, users,
#                                       sessions), objects/uploads/… (attachments + ppm-vault/…), objects.jsonl,
#                                       with the Git server: db/forgejo.pgdump (+ row counts) and forgejo/data.tar
#                                       (repositories, LFS, attachments, avatars, SSH host keys — no caches, queues,
#                                       sessions or indexes; no app.ini: it holds nothing but ppm.env values),
#                                       manifest.json, SHA256SUMS (all verified again on restore)
#   <project>-<UTC>.manifest.json       the same manifest, readable without the passphrase — no secrets
#   <project>-<UTC>.tar.gz.gpg.sha256   checksum of the encrypted archive (integrity of off-site copies)
# Plain data exists only in a temporary 700 directory under .runtime/<project>/ during the run (not in the output
# directory). Rotation keeps the newest N archives of this project (--keep, default PPM_BACKUP_KEEP or 7). NOT included: ppm.env and the passphrase file (keep BOTH in a
# password manager, apart from the backups — without the passphrase there is no restore), Redis/RabbitMQ (cache,
# realtime and queues are rebuilt), Caddy certificates (re-issued). A backup counts only after a restore drill.
# The Git server is STOPPED for the seconds of its copy (database + repositories from the same instant: a push or a
# new repository in between would make the two disagree); git clients see "unavailable" meanwhile and Forgejo is
# started again right after, also when the backup fails (a run killed in between leaves a marker: the next run
# starts Forgejo and warns). With the Git server switched off, its database and data volume — kept on the server —
# are still copied; a copy that cannot be made is a WARNING on every run.
set -euo pipefail
umask 077

bundle_dir="$(cd "$(dirname "$0")" && pwd)"
env_file_arg="" output_dir="" keep=""
while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 && -z "$env_file_arg" ]] || { echo "ppm-backup: --env-file needs a path (once)" >&2; exit 2; }; env_file_arg="$2"; shift 2 ;;
    --output-dir) [[ $# -ge 2 ]] || { echo "ppm-backup: --output-dir needs a path" >&2; exit 2; }; output_dir="$2"; shift 2 ;;
    --keep) [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || { echo "ppm-backup: --keep needs a positive number" >&2; exit 2; }; keep="$2"; shift 2 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "ppm-backup: unknown argument: $1" >&2; exit 2 ;;
  esac
done
PPM_SCRIPT_NAME=ppm-backup
# shellcheck source=ppm-lib.sh
source "$bundle_dir/ppm-lib.sh"
[[ -n "$env_file_arg" ]] || die "pass --env-file explicitly (the backup names the deployment it copies)"
ppm_resolve_env_file "$env_file_arg"
ppm_init_context

passphrase_file="$(ppm_passphrase_file)"
[[ -f "$passphrase_file" ]] || die "backup passphrase file $passphrase_file is missing (restore it from the password manager)"
passphrase_file="$(abs_path "$passphrase_file")"
keep="${keep:-$(env_get PPM_BACKUP_KEEP)}"; keep="${keep:-7}"
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || die "PPM_BACKUP_KEEP must be a positive number"
output_dir="${output_dir:-$(env_get PPM_BACKUP_DIR)}"; output_dir="${output_dir:-$runtime_dir/backups}"
mkdir -p "$output_dir"; chmod 700 "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
name="$project-$(date -u +%Y%m%dT%H%M%SZ)"
# Plain data lives only in a private working directory under the runtime state (never in the backup directory that
# is copied off the server); it is removed right after encryption, and by the trap on any failure.
work="$(ppm_workdir backup)"
# The Git server's stop for its copy is marked on disk (pid inside): a run killed in between is detected next time.
forgejo_marker="$state_dir/forgejo-stopped-by-backup"
forgejo_stopped=0
start_forgejo_again() {
  if dc start forgejo >/dev/null 2>&1; then rm -f -- "$forgejo_marker"; return 0; fi
  note "WARNING: Forgejo did not start again — run ./ppm-deploy.sh --env-file $env_file up"
  return 1
}
cleanup() {
  rm -rf -- "$work"
  if ((forgejo_stopped)); then start_forgejo_again || true; fi
}
trap cleanup EXIT
if [[ -f "$forgejo_marker" ]]; then
  marker_pid="$(tr -dc '0-9' <"$forgejo_marker")"
  if [[ -n "$marker_pid" ]] && kill -0 "$marker_pid" 2>/dev/null; then
    die "another backup of project $project (pid $marker_pid) is copying the Git server right now; nothing was done"
  fi
  note "WARNING: an earlier backup was interrupted while the Git server was stopped for its copy"
  if ((git_enabled)); then
    start_forgejo_again && note "Forgejo started again"
  else
    rm -f -- "$forgejo_marker"
  fi
fi
for stale in "$output_dir"/.work-*; do  # working directories of earlier script versions (kept in the backup dir)
  [[ -d "$stale" ]] && rm -rf -- "$stale" && note "removed a leftover plain working directory from $output_dir"
done
# objects/uploads exists even for an empty bucket (mc mirror creates nothing then; restore mirrors this directory).
mkdir -p "$work/db" "$work/objects/uploads"
started=$SECONDS

wait_healthy plane-db plane-minio
note "backup $name → $output_dir (plain data only in a temporary 700 directory)"

# 1. Database (consistent snapshot: pg_dump runs in one repeatable-read transaction).
dc exec -T plane-db pg_dump -U plane -d plane -Fc -Z 6 >"$work/db/plane.pgdump"
dump_entries="$(dc exec -T plane-db pg_restore --list <"$work/db/plane.pgdump" | grep -c '^[0-9]' || true)"
((dump_entries > 0)) || die "the dump is unreadable (pg_restore --list found no entries)"
pg_version="$(dc exec -T plane-db psql -U plane -d plane -tAc 'show server_version' | tr -d '\r')"
# Exact rows per table OF THE DUMP (its COPY blocks; one row per line in COPY text format) — restore compares
# the restored database against these numbers, independent of writes that happened after the snapshot.
dc exec -T plane-db pg_restore --data-only -f - <"$work/db/plane.pgdump" | awk '
  /^COPY / { table = $2; rows = 0; copying = 1; next }
  copying && $0 == "\\." { print table "=" rows; copying = 0; next }
  copying { rows++ }' | LC_ALL=C sort >"$work/db/row-counts.txt"
table_count="$(wc -l <"$work/db/row-counts.txt" | tr -d ' ')"
((table_count > 0)) || die "no table data found in the dump"
counts="$(grep -E '^public\.(users|workspaces|projects|issues|file_assets|ppm_[a-z_]+)=' "$work/db/row-counts.txt" | sed 's/^public\.//' || true)"
note "database dump ok ($dump_entries entries, $table_count tables, PostgreSQL $pg_version)"

# 2. Objects (Plane attachments + Vault) — the preflight probe prefix is transient and skipped.
dc run --rm -T -v "$work:/backup" mc ls --recursive --json ppm/uploads >"$work/objects.jsonl"
dc run --rm -T -v "$work:/backup" mc mirror --quiet --overwrite --exclude "_ppm-preflight/*" ppm/uploads /backup/objects/uploads >/dev/null
object_count="$(find "$work/objects" -type f | wc -l | tr -d ' ')"
vault_count="$( { find "$work/objects/uploads/ppm-vault" -type f 2>/dev/null || true; } | wc -l | tr -d ' ')"
listed_count="$(grep -c '"key"' "$work/objects.jsonl" || true)"
listed_probe="$(grep -c '"key":"_ppm-preflight/' "$work/objects.jsonl" || true)"
[[ "$object_count" == "$((listed_count - listed_probe))" ]] \
  || die "object mirror incomplete: $object_count files, bucket listed $((listed_count - listed_probe))"
object_bytes="$(find "$work/objects" -type f -exec cat {} + | wc -c | tr -d ' ')"
note "objects ok ($object_count files, $vault_count Vault, $((object_count - vault_count)) attachments/other)"

# 3. Git server (Forgejo): its own database and data volume. On: stopped for the copy (see the header). Off, but its
#    database or volume still on the server (switched off after use): copied as they are — nothing runs. A copy
#    that cannot be made fails the backup when the Git server is on, and is a loud WARNING when it is off.
git_json="null"
forgejo_image="$(env_get PPM_FORGEJO_IMAGE)"; forgejo_image="${forgejo_image:-$PPM_FORGEJO_IMAGE_DEFAULT}"
forgejo_db="$(dc exec -T plane-db psql -U plane -d plane -tAc "select count(*) from pg_database where datname = 'forgejo'" | tr -d '\r')"
forgejo_volume=0
docker volume inspect "${project}_forgejo_data" >/dev/null 2>&1 && forgejo_volume=1
# tar / find on the data volume: the Forgejo image itself (uid 1000 owns the files), without network.
forgejo_tools() { # sh arguments...
  if ((git_enabled)); then dc run --rm -T forgejo-tools "$@"
  else docker run --rm --network none -v "${project}_forgejo_data:/var/lib/gitea" --entrypoint sh "$forgejo_image" "$@"; fi
}
backup_git_server() { # returns non-zero on any failure (the caller decides: fail or warn)
  local forgejo_id git_started git_seconds row_counts_json version
  git_started=$SECONDS
  if ((git_enabled)); then
    forgejo_id="$(dc ps -q forgejo 2>/dev/null | head -n1)"
    if [[ -n "$forgejo_id" && "$(docker inspect -f '{{.State.Running}}' "$forgejo_id")" == true ]]; then
      echo "$$" >"$forgejo_marker"
      forgejo_stopped=1
      dc stop forgejo >/dev/null 2>&1 || return 1
      note "Git server stopped for a consistent copy"
    else
      note "WARNING: the Git server is on, but Forgejo was not running — copied as it is; start it: ./ppm-deploy.sh --env-file $env_file up"
    fi
  fi
  mkdir -p "$work/forgejo"
  dc exec -T plane-db pg_dump -U plane -d forgejo -Fc -Z 6 >"$work/db/forgejo.pgdump" || return 1
  forgejo_entries="$(dc exec -T plane-db pg_restore --list <"$work/db/forgejo.pgdump" | grep -c '^[0-9]' || true)"
  ((forgejo_entries > 0)) || { note "the Forgejo dump is unreadable (pg_restore --list found no entries)"; return 1; }
  dc exec -T plane-db pg_restore --data-only -f - <"$work/db/forgejo.pgdump" | awk '
    /^COPY / { table = $2; rows = 0; copying = 1; next }
    copying && $0 == "\\." { print table "=" rows; copying = 0; next }
    copying { rows++ }' | LC_ALL=C sort >"$work/db/forgejo-row-counts.txt"
  forgejo_tables="$(wc -l <"$work/db/forgejo-row-counts.txt" | tr -d ' ')"
  repos_db="$(sed -n 's/^public\.repository=//p' "$work/db/forgejo-row-counts.txt")"; repos_db="${repos_db:-0}"
  # Repositories, LFS objects, attachments, avatars, SSH host keys. Not: queues, search indexes, the archive cache,
  # Actions/packages storage (off), sessions, logs, temp files — Forgejo rebuilds or never needs them — and not
  # app.ini (ppm.env values only). Paths as in the rootless image: APP_DATA_PATH=/var/lib/gitea.
  forgejo_tools -c 'cd /var/lib/gitea && exec tar -cf - --exclude=./custom/conf/app.ini --exclude=./queues \
    --exclude=./indexers --exclude=./repo-archive --exclude=./actions_log --exclude=./actions_artifacts \
    --exclude=./packages --exclude=./data/sessions --exclude=./data/log --exclude=./data/tmp --exclude=./tmp .' \
    >"$work/forgejo/data.tar" || return 1
  # shellcheck disable=SC2016  # counted inside the container
  read -r repos_disk wikis_disk lfs_objects attachments <<<"$(forgejo_tools -c 'cd /var/lib/gitea
    count() { if [ -d "$1" ]; then dir="$1"; shift; find "$dir" "$@" | wc -l; else echo 0; fi; }
    echo "$(count git/repositories -mindepth 2 -maxdepth 2 -type d -name "*.git" ! -name "*.wiki.git") $(count git/repositories -mindepth 2 -maxdepth 2 -type d -name "*.wiki.git") $(count git/lfs -type f) $(count data/attachments -type f)"' | tr -d '\r')"
  [[ "$repos_disk" =~ ^[0-9]+$ ]] || return 1
  git_seconds=$((SECONDS - git_started))
  if ((forgejo_stopped)); then
    start_forgejo_again || return 1
    forgejo_stopped=0
    wait_healthy forgejo
    note "Git server copied in ${git_seconds}s and running again after $((SECONDS - git_started))s"
  else
    note "Git server copied in ${git_seconds}s$( ((git_enabled)) || echo " (the Git server is off; its data are kept and copied)")"
  fi
  note "Git server: $repos_disk repositories on disk, $repos_db in the database, $wikis_disk wikis, $lfs_objects LFS objects, $attachments attachments"
  [[ "$repos_disk" == "$repos_db" ]] \
    || note "WARNING: repositories on disk ($repos_disk) differ from the Forgejo database ($repos_db) — the copy keeps both as they are; check Site administration → Repositories → unadopted"
  printf 'repositories=%s\nrepositories_in_database=%s\nwikis=%s\nlfs_objects=%s\nattachments=%s\n' \
    "$repos_disk" "$repos_db" "$wikis_disk" "$lfs_objects" "$attachments" >"$work/forgejo/counts.txt"
  row_counts_json="$(grep -E '^public\.("?)(repository|user|team|pull_request|webhook|lfs_meta_object|attachment)("?)=' "$work/db/forgejo-row-counts.txt" \
    | sed -e 's/^public\.//' -e 's/"//g' | awk -F= 'NF == 2 { printf "%s\"%s\": %s", (n++ ? ", " : ""), $1, $2 }')"
  version="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$forgejo_image" 2>/dev/null || true)"
  git_json="{\"product\": \"Forgejo\", \"image\": \"$forgejo_image\", \"version\": \"$version\",
                 \"server_enabled\": $( ((git_enabled)) && echo true || echo false),
                 \"database\": {\"file\": \"db/forgejo.pgdump\", \"format\": \"pg_dump custom (-Fc)\", \"entries\": $forgejo_entries,
                              \"tables\": $forgejo_tables, \"bytes\": $(wc -c <"$work/db/forgejo.pgdump" | tr -d ' '),
                              \"row_counts_file\": \"db/forgejo-row-counts.txt\", \"row_counts\": {$row_counts_json}},
                 \"data\": {\"file\": \"forgejo/data.tar\", \"bytes\": $(wc -c <"$work/forgejo/data.tar" | tr -d ' '),
                          \"repositories\": $repos_disk, \"wikis\": $wikis_disk, \"lfs_objects\": $lfs_objects,
                          \"attachments\": $attachments, \"counts_file\": \"forgejo/counts.txt\"},
                 \"repositories_in_database\": $repos_db, \"copy_seconds\": $git_seconds}"
}
if [[ "$forgejo_db" == 1 ]] && { ((git_enabled)) || ((forgejo_volume)); }; then
  if ! backup_git_server; then
    ((git_enabled)) && die "the copy of the Git server failed (above); no archive was written"
    rm -rf -- "$work/forgejo" "$work/db/forgejo.pgdump" "$work/db/forgejo-row-counts.txt"; git_json="null"
    note "WARNING: THE GIT SERVER IS NOT IN THIS BACKUP — it is switched off, but its database and data are still on the server and could not be copied (above). Switch it on (PPM_GIT_SERVER_ENABLED=1, up) or fix the cause; this warning repeats on every backup."
  fi
elif ((forgejo_volume)) || [[ "$forgejo_db" == 1 ]]; then
  note "WARNING: THE GIT SERVER IS NOT IN THIS BACKUP — only its $( [[ "$forgejo_db" == 1 ]] && echo "database" || echo "data volume") is left on the server (the other part is gone), so no consistent copy is possible. Check with the RUNBOOK §17.11; this warning repeats on every backup."
elif ((git_enabled)); then
  note "Git server enabled but never started (no database forgejo yet): nothing of it to copy"
fi

# 4. Manifest (no secrets) and checksums.
api_image="$(env_get PPM_IMAGE_REPO)/api:$(env_get PPM_RELEASE)"
revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$api_image" 2>/dev/null || true)"
counts_json="$(printf '%s\n' "$counts" | awk -F= 'NF == 2 { printf "%s\"%s\": %s", (n++ ? ", " : ""), $1, $2 }')"
cat >"$work/manifest.json" <<JSON
{
  "schema": "ppm-backup/3",
  "name": "$name",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "project": "$project",
  "public_url": "$(env_get PPM_PUBLIC_URL)",
  "release": "$(env_get PPM_RELEASE)",
  "api_image": "$api_image",
  "source_revision": "$revision",
  "encryption": "OpenPGP symmetric, AES256 (gpg --symmetric --cipher-algo AES256), passphrase file kept apart",
  "database": {"file": "db/plane.pgdump", "format": "pg_dump custom (-Fc)", "postgres_version": "$pg_version",
               "entries": $dump_entries, "tables": $table_count, "bytes": $(wc -c <"$work/db/plane.pgdump" | tr -d ' '),
               "row_counts_file": "db/row-counts.txt", "row_counts": {$counts_json}},
  "objects": {"bucket": "uploads", "dir": "objects/uploads", "files": $object_count, "bytes": $object_bytes,
              "vault_files": $vault_count, "listing": "objects.jsonl"},
  "git_server": $git_json,
  "not_included": ["ppm.env and the backup passphrase file (keep both in a password manager, apart from backups)",
                   "Redis/Valkey (cache, realtime)", "RabbitMQ (queues; Brain jobs are recovered from the DB)",
                   "Caddy certificates (re-issued)",
                   "Forgejo app.ini, queues, sessions, search indexes, archive cache (rebuilt from ppm.env / on start)"]
}
JSON
sum_paths=(db objects objects.jsonl manifest.json)
[[ -d "$work/forgejo" ]] && sum_paths+=(forgejo)
(cd "$work" && find "${sum_paths[@]}" -type f | LC_ALL=C sort | while read -r file; do sha256_file "$file"; done >SHA256SUMS)
(cd "$work" && sha256_file -c SHA256SUMS >/dev/null) || die "checksum self-test failed"

# 5. Encrypt (tools container as the invoking user; the passphrase is read from a file, never from argv), then prove
#    the archive decrypts with the same passphrase before it counts.
gpg_opts='--batch --yes --quiet --no-tty --pinentry-mode loopback --passphrase-file /run/ppm-backup-passphrase'
dc run --rm -T -v "$work:/backup:ro" -v "$output_dir:/out" -v "$passphrase_file:/run/ppm-backup-passphrase:ro" \
  --entrypoint sh mc -c "set -eo pipefail; umask 077; mkdir -p -m 700 \"\$GNUPGHOME\"
    tar -C /backup -cf - . | gzip -6 | gpg $gpg_opts --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 \
      --compress-algo none -o \"/out/\$1.tar.gz.gpg.partial\"
    gpg $gpg_opts --decrypt \"/out/\$1.tar.gz.gpg.partial\" | gzip -t
    mv \"/out/\$1.tar.gz.gpg.partial\" \"/out/\$1.tar.gz.gpg\"" sh "$name"
cp "$work/manifest.json" "$output_dir/$name.manifest.json"
rm -rf -- "$work"  # no plain data remains once the encrypted archive is verified
(cd "$output_dir" && sha256_file "$name.tar.gz.gpg" >"$name.tar.gz.gpg.sha256")
chmod 600 "$output_dir/$name.tar.gz.gpg" "$output_dir/$name.manifest.json" "$output_dir/$name.tar.gz.gpg.sha256"
note "encrypted archive $name.tar.gz.gpg ($(wc -c <"$output_dir/$name.tar.gz.gpg" | tr -d ' ') bytes) decrypts with the passphrase"

# 6. Rotation: the new archive plus the newest (keep - 1) older archives of exactly this project.
removed="$(ppm_rotate_backups "$output_dir" "$project" "$keep" "$name.tar.gz.gpg")"
note "rotation: keep $keep, removed $removed old archive(s)"
note "done in $((SECONDS - started))s → $output_dir/$name.tar.gz.gpg (copy it with .manifest.json and .sha256 off the server)"
