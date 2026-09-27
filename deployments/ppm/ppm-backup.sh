#!/usr/bin/env bash
# PPM backup, ENCRYPTED: PostgreSQL custom-format dump + mirror of the object bucket (Plane attachments AND Vault
# files live in the same private bucket `uploads`) + manifest + SHA-256, packed and encrypted with GnuPG
# (AES256, passphrase file from ppm.env) inside the pinned tools image, running as the invoking user.
#
#   ppm-backup.sh --env-file FILE [--output-dir DIR] [--keep N]
#
# Output in <output-dir> (default: PPM_BACKUP_DIR from the env, else <runtime>/backups), directory mode 700:
#   <project>-<UTC>.tar.gz.gpg          encrypted archive: db/plane.pgdump (pg_dump -Fc of the whole database: Work
#                                       Items, boards with all versions, Vault metadata/versions, Brain index, users,
#                                       sessions), objects/uploads/… (attachments + ppm-vault/…), objects.jsonl,
#                                       manifest.json, SHA256SUMS (all verified again on restore)
#   <project>-<UTC>.manifest.json       the same manifest, readable without the passphrase — no secrets
#   <project>-<UTC>.tar.gz.gpg.sha256   checksum of the encrypted archive (integrity of off-site copies)
# Plain data exists only in a temporary 700 directory under .runtime/<project>/ during the run (not in the output
# directory). Rotation keeps the newest N archives of this project (--keep, default PPM_BACKUP_KEEP or 7). NOT included: ppm.env and the passphrase file (keep BOTH in a
# password manager, apart from the backups — without the passphrase there is no restore), Redis/RabbitMQ (cache,
# realtime and queues are rebuilt), Caddy certificates (re-issued). A backup counts only after a restore drill.
set -euo pipefail
umask 077

bundle_dir="$(cd "$(dirname "$0")" && pwd)"
env_file_arg="" output_dir="" keep=""
while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 && -z "$env_file_arg" ]] || { echo "ppm-backup: --env-file needs a path (once)" >&2; exit 2; }; env_file_arg="$2"; shift 2 ;;
    --output-dir) [[ $# -ge 2 ]] || { echo "ppm-backup: --output-dir needs a path" >&2; exit 2; }; output_dir="$2"; shift 2 ;;
    --keep) [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || { echo "ppm-backup: --keep needs a positive number" >&2; exit 2; }; keep="$2"; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
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
trap 'rm -rf -- "$work"' EXIT
for stale in "$output_dir"/.work-*; do  # working directories of earlier script versions (kept in the backup dir)
  [[ -d "$stale" ]] && rm -rf -- "$stale" && note "removed a leftover plain working directory from $output_dir"
done
mkdir -p "$work/db" "$work/objects"
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

# 3. Manifest (no secrets) and checksums.
api_image="$(env_get PPM_IMAGE_REPO)/api:$(env_get PPM_RELEASE)"
revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$api_image" 2>/dev/null || true)"
counts_json="$(printf '%s\n' "$counts" | awk -F= 'NF == 2 { printf "%s\"%s\": %s", (n++ ? ", " : ""), $1, $2 }')"
cat >"$work/manifest.json" <<JSON
{
  "schema": "ppm-backup/2",
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
  "not_included": ["ppm.env and the backup passphrase file (keep both in a password manager, apart from backups)",
                   "Redis/Valkey (cache, realtime)", "RabbitMQ (queues; Brain jobs are recovered from the DB)",
                   "Caddy certificates (re-issued)"]
}
JSON
(cd "$work" && find db objects objects.jsonl manifest.json -type f | LC_ALL=C sort | while read -r file; do sha256_file "$file"; done >SHA256SUMS)
(cd "$work" && sha256_file -c SHA256SUMS >/dev/null) || die "checksum self-test failed"

# 4. Encrypt (tools container as the invoking user; the passphrase is read from a file, never from argv), then prove
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

# 5. Rotation: the new archive plus the newest (keep - 1) older archives of exactly this project.
removed="$(ppm_rotate_backups "$output_dir" "$project" "$keep" "$name.tar.gz.gpg")"
note "rotation: keep $keep, removed $removed old archive(s)"
note "done in $((SECONDS - started))s → $output_dir/$name.tar.gz.gpg (copy it with .manifest.json and .sha256 off the server)"
