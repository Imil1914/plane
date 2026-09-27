#!/usr/bin/env bash
# PPM restore of an ENCRYPTED backup into a deployment WITHOUT data (a drill copy, or a fresh server after a loss).
#
#   ppm-restore.sh --env-file TARGET_ENV --backup FILE.tar.gz.gpg [--passphrase-file FILE] [--drill]
#                  [--allow-release-mismatch] [--db-only]
#
#   --env-file         the TARGET deployment (always explicit). The target project must not exist yet: the script
#                      refuses — before starting or touching anything — a project that already has containers or
#                      volumes (a live project is never stopped, recreated or overwritten), and the production
#                      project name on a *.localhost env; after the start it re-checks that database and bucket are empty
#   --passphrase-file  passphrase the backup was encrypted with (default: the target env's
#                      PPM_BACKUP_PASSPHRASE_FILE); for drills use the copy kept in the password manager
#   --drill            restore drill: the application starts WITHOUT worker/beat-worker, so a copy of real data
#                      never sends e-mails, notifications or webhooks (RUNBOOK §11); destroy the copy afterwards
#   --allow-release-mismatch
#                      restore although the target PPM_RELEASE differs from the backup's release (only when the
#                      old images are gone; a newer target release then migrates the restored schema forward)
#   --db-only          ONLY for the negative drill: objects are not restored (proves the gap is detected)
#
# Order: outer SHA-256 (if the .sha256 file is next to the archive) → decrypt into a temporary 700 directory →
# inner SHA256SUMS → release check → start PostgreSQL/Valkey/RabbitMQ/MinIO only → refuse non-empty targets →
# pg_restore → exact row counts per table vs the dump → mirror objects back → object count → application up →
# preflight. The decrypted copy is deleted on exit. Real recovery keeps SECRET_KEY of the source (RUNBOOK §11).
set -euo pipefail
umask 077

bundle_dir="$(cd "$(dirname "$0")" && pwd)"
env_file_arg="" backup="" passphrase_arg="" drill=0 db_only=0 allow_release_mismatch=0
while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 && -z "$env_file_arg" ]] || { echo "ppm-restore: --env-file needs a path (once)" >&2; exit 2; }; env_file_arg="$2"; shift 2 ;;
    --backup) [[ $# -ge 2 && -z "$backup" ]] || { echo "ppm-restore: --backup needs a file (once)" >&2; exit 2; }; backup="$2"; shift 2 ;;
    --passphrase-file) [[ $# -ge 2 ]] || { echo "ppm-restore: --passphrase-file needs a path" >&2; exit 2; }; passphrase_arg="$2"; shift 2 ;;
    --drill) drill=1; shift ;;
    --db-only) db_only=1; shift ;;
    --allow-release-mismatch) allow_release_mismatch=1; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "ppm-restore: unknown argument: $1" >&2; exit 2 ;;
  esac
done
PPM_SCRIPT_NAME=ppm-restore
# shellcheck source=ppm-lib.sh
source "$bundle_dir/ppm-lib.sh"
[[ -n "$env_file_arg" ]] || die "pass --env-file of the TARGET deployment explicitly (restore never guesses it)"
[[ -n "$backup" ]] || die "--backup FILE.tar.gz.gpg is required"
[[ -f "$backup" && "$backup" == *.tar.gz.gpg ]] || die "$backup is not an encrypted PPM backup (*.tar.gz.gpg)"
ppm_resolve_env_file "$env_file_arg"
ppm_init_context
"$bundle_dir/ppm-env.sh" check "$env_file" >/dev/null || die "target env is invalid: ppm-env.sh check $env_file"
# 0. The target project must not exist — checked BEFORE any docker compose call: `up` on an existing project would
#    recreate its services with this env (e.g. restart a live MinIO with the drill's credentials).
read -r existing_containers existing_volumes <<<"$(ppm_project_resources "$project")"
if ((existing_containers + existing_volumes > 0)); then
  die "project $project already exists ($existing_containers containers, $existing_volumes volumes) — restore only into a new project (RUNBOOK §11); nothing was started or changed"
fi
backup="$(abs_path "$backup")"; backup_dir="$(dirname "$backup")"; backup_name="$(basename "$backup")"
passphrase_file="${passphrase_arg:-$(ppm_passphrase_file)}"
[[ -f "$passphrase_file" ]] || die "passphrase file $passphrase_file not found"
passphrase_file="$(abs_path "$passphrase_file")"
started=$SECONDS

# 1. Integrity of the encrypted file (off-site copies carry the .sha256 next to them).
if [[ -f "$backup.sha256" ]]; then
  expected_sum="$(awk '{print $1; exit}' "$backup.sha256")"
  actual_sum="$(sha256_file "$backup" | awk '{print $1}')"
  [[ "$expected_sum" == "$actual_sum" ]] || die "SHA-256 of $backup_name does NOT match $backup_name.sha256 — do not use this copy"
  note "encrypted archive checksum ok"
else
  note "no $backup_name.sha256 next to the archive: integrity is still checked by GnuPG and the inner SHA256SUMS"
fi

# 2. Decrypt into a temporary directory (700, removed on exit) as the invoking user, inside the tools image.
work="$(ppm_workdir restore)"
trap 'rm -rf -- "$work"' EXIT
# shellcheck disable=SC2016  # $GNUPGHOME and $1 expand inside the container
if ! dc run --rm -T -v "$backup_dir:/in:ro" -v "$work:/work" -v "$passphrase_file:/run/ppm-backup-passphrase:ro" \
  --entrypoint sh mc -c 'set -eo pipefail; umask 077; mkdir -p -m 700 "$GNUPGHOME"
    gpg --batch --quiet --no-tty --pinentry-mode loopback --passphrase-file /run/ppm-backup-passphrase --decrypt "/in/$1" \
      2>/tmp/gpg.err | tar -xzf - -C /work || { grep -v "^gpg: AES256" /tmp/gpg.err >&2; exit 1; }' sh "$backup_name"; then
  die "cannot decrypt $backup_name (wrong passphrase file, or the file is damaged); nothing was restored"
fi
[[ -f "$work/manifest.json" && -f "$work/SHA256SUMS" && -f "$work/db/row-counts.txt" ]] \
  || die "decrypted archive is not a PPM backup (manifest.json/SHA256SUMS/db/row-counts.txt missing)"
grep -q '"schema": "ppm-backup/2"' "$work/manifest.json" || die "unknown backup format (expected ppm-backup/2)"
(cd "$work" && sha256_file -c --quiet SHA256SUMS) || die "inner checksum verification FAILED — do not restore this copy"
note "decrypted and verified ($(wc -l <"$work/SHA256SUMS" | tr -d ' ') files) — target project $project"

# 3. Release: restore into the release that wrote the backup (then upgrade with ppm-deploy.sh release).
backup_release="$(sed -n 's/^  "release": "\([^"]*\)",$/\1/p' "$work/manifest.json")"
target_release="$(env_get PPM_RELEASE)"
if [[ "$backup_release" != "$target_release" ]]; then
  ((allow_release_mismatch)) || die "backup is from release '$backup_release', target env runs '$target_release': set PPM_RELEASE=$backup_release in the target env (then upgrade after the restore), or pass --allow-release-mismatch"
  note "release mismatch accepted: backup $backup_release → target $target_release"
fi

# 4. Infrastructure only; the application must not start (or migrate) before the data is in place.
dc up -d plane-db plane-redis plane-mq plane-minio
wait_healthy plane-db plane-redis plane-mq plane-minio
tables="$(dc exec -T plane-db psql -U plane -d plane -tAc "select count(*) from pg_tables where schemaname = 'public'" | tr -d '\r')"
[[ "$tables" == "0" ]] || die "target database already has $tables tables — refusing to restore over existing data (use a new project, see RUNBOOK §11)"
existing_objects="$( { dc run --rm -T mc ls --recursive ppm/uploads 2>/dev/null || true; } | grep -vc '_ppm-preflight/' || true)"
[[ "$existing_objects" == "0" ]] || die "target bucket already holds $existing_objects objects — refusing to mix data"

# 5. Database, then exact row counts per table against the dump's own COPY rows.
dc exec -T plane-db pg_restore -U plane -d plane --no-owner --no-privileges --exit-on-error <"$work/db/plane.pgdump"
{
  echo "select t || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %s', t), false, true, '')))[1]::text"
  printf 'from unnest(array['
  awk -F= '$1 ~ /^public\.[a-z_][a-z0-9_]*$/ { printf "%s'"'"'%s'"'"'", (n++ ? "," : ""), $1 }' "$work/db/row-counts.txt"
  echo "]::text[]) as t order by 1;"
} >"$work/count.sql"
dc exec -T plane-db psql -U plane -d plane -tA -v ON_ERROR_STOP=1 <"$work/count.sql" | tr -d '\r' | sed '/^$/d' >"$work/restored-counts.txt"
grep -E '^public\.[a-z_][a-z0-9_]*=' "$work/db/row-counts.txt" | LC_ALL=C sort >"$work/expected-counts.txt"
LC_ALL=C sort -o "$work/restored-counts.txt" "$work/restored-counts.txt"
if ! diff -q "$work/expected-counts.txt" "$work/restored-counts.txt" >/dev/null; then
  diff "$work/expected-counts.txt" "$work/restored-counts.txt" | sed 's/^/  /' >&2 || true
  die "row counts after restore differ from the dump (above: < dump, > restored)"
fi
note "database restored: $(wc -l <"$work/restored-counts.txt" | tr -d ' ') tables, row counts equal to the dump"

# 6. Objects (Plane attachments + Vault).
if ((db_only)); then
  note "--db-only: objects NOT restored (negative drill) — attachments and Vault files must be missing"
else
  dc run --rm -T mc mb --ignore-existing ppm/uploads >/dev/null
  dc run --rm -T -v "$work:/backup:ro" mc mirror --quiet --overwrite /backup/objects/uploads ppm/uploads >/dev/null
  expected="$(find "$work/objects" -type f | wc -l | tr -d ' ')"
  actual="$(dc run --rm -T mc ls --recursive ppm/uploads | grep -vc '_ppm-preflight/' || true)"
  [[ "$expected" == "$actual" ]] || die "object restore incomplete: $actual objects in the bucket, backup has $expected"
  note "objects restored ($actual)"
fi
rm -rf -- "$work"

# 7. Application + preflight (a drill copy runs without background jobs).
if ((drill)); then
  "$bundle_dir/ppm-deploy.sh" --env-file "$env_file" up --no-workers
else
  "$bundle_dir/ppm-deploy.sh" --env-file "$env_file" up
fi
note "done in $((SECONDS - started))s. Verify: sign in, open a board (and an older version), a Vault file (and its"
note "older version), a Work Item with an attachment, search. Drill copies: ppm-deploy.sh destroy afterwards."
