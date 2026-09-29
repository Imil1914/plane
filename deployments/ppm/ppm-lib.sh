# shellcheck shell=bash disable=SC2154  # bundle_dir and env_file are set by the sourcing script
# Shared helpers for ppm-deploy.sh, ppm-backup.sh and ppm-restore.sh (sourced, not executed).
# Expects: bundle_dir, env_file. Defines: project, runtime_dir, state_dir, compose_files, git_enabled, sso_enabled,
# dc(), env_get(), die().

die() { echo "${PPM_SCRIPT_NAME:-ppm}: $*" >&2; exit 1; }
note() { echo "${PPM_SCRIPT_NAME:-ppm}: $*" >&2; }
env_get() { awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$env_file"; }
sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
abs_path() { (cd "$(dirname "$1")" && echo "$(pwd)/$(basename "$1")"); }

# Resolve the env file: --env-file (explicit) > $PPM_ENV_FILE > <bundle>/.runtime/ppm.env. The choice is always
# announced; callers that must never fall back to a default (destroy, restore) check `env_file_source`.
ppm_resolve_env_file() { # explicit_value
  if [[ -n "$1" ]]; then env_file="$1"; env_file_source="--env-file"
  elif [[ -n "${PPM_ENV_FILE:-}" ]]; then env_file="$PPM_ENV_FILE"; env_file_source="PPM_ENV_FILE"
  else env_file="$bundle_dir/.runtime/ppm.env"; env_file_source="default"; fi
}

# The production Compose project (RUNBOOK §4). Drill/test envs on *.localhost never use it, and neither destroy nor
# restore ever acts on it.
# shellcheck disable=SC2034  # used by the sourcing scripts
PPM_PRODUCTION_PROJECT=ppm

# Compose project names (the only form Docker Compose accepts): lowercase letters, digits, "_" and "-", starting with
# a letter or digit — no capitals, spaces or tabs. The one rule for ppm-env.sh check and every script passing -p.
ppm_valid_project_name() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; }

# Git server image (Forgejo 15 LTS, rootless), pinned by its multi-arch index digest (linux/amd64, arm64, arm/v6);
# ppm-env.sh writes it into new env files as PPM_FORGEJO_IMAGE. The mirror data.forgejo.org/forgejo/forgejo serves
# the same digest. Updating = a newer 15.x digest in PPM_FORGEJO_IMAGE (RUNBOOK §17.9), not a PPM release.
# shellcheck disable=SC2034  # used by the sourcing scripts
PPM_FORGEJO_IMAGE_DEFAULT="codeberg.org/forgejo/forgejo:15-rootless@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413"

# Restore-drill copies (marker <state>/no-workers, written by `ppm-deploy.sh up --no-workers`) must not reach out:
# Compose reads these shell variables before the env file, so a drill copy's Forgejo sends every outgoing HTTP
# request (webhooks, migrations) to a closed local port, has migrations and external-user sync off
# (docker-compose.git.yml). Production never sets them.
ppm_git_drill_exports() {
  export PPM_GIT_DRILL_COPY=true PPM_GIT_DISABLE_MIGRATIONS=true PPM_GIT_EXTERNAL_USER_SYNC=false
}

# Defence in depth: the production name in any letter case, with any whitespace around or inside it.
ppm_is_production_project() {
  local name; name="$(printf '%s' "$1" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  [[ "$name" == "$PPM_PRODUCTION_PROJECT" ]]
}

ppm_init_context() {
  [[ -f "$env_file" ]] || die "env file $env_file not found (create it with ppm-env.sh init)"
  env_file="$(abs_path "$env_file")"
  project="$(env_get PPM_PROJECT)"
  # Validated before anything else (no directory, no docker call): every command passes it to Compose as -p.
  ppm_valid_project_name "$project" \
    || die "PPM_PROJECT in $env_file is missing or not a valid Compose project name (a-z 0-9 _ -; no capitals, spaces or tabs); nothing was done"
  runtime_dir="${PPM_RUNTIME_DIR:-$bundle_dir/.runtime}"
  state_dir="$runtime_dir/$project"
  mkdir -p "$state_dir/smoke"
  chmod 700 "$state_dir" 2>/dev/null || true
  export PPM_SMOKE_DIR="$state_dir/smoke"
  # Tool containers run as the invoking user: files they write into bind mounts belong to the operator (Linux).
  PPM_HOST_UID="$(id -u)"; PPM_HOST_GID="$(id -g)"
  export PPM_HOST_UID PPM_HOST_GID
  compose_files=(-f "$bundle_dir/docker-compose.yml")
  if [[ "$(env_get PPM_TLS)" == "internal" ]]; then
    compose_files+=(-f "$bundle_dir/docker-compose.internal-tls.yml")
  fi
  # Git server (Forgejo): only with PPM_GIT_SERVER_ENABLED=1 (absent in an RC.1 env = off, see ppm-env.sh check).
  git_enabled=0 sso_enabled=0
  if [[ "$(env_get PPM_GIT_SERVER_ENABLED)" == 1 ]]; then
    git_enabled=1
    compose_files+=(-f "$bundle_dir/docker-compose.git.yml")
    [[ "$(env_get PPM_GIT_SSH_ENABLED)" == 1 ]] && compose_files+=(-f "$bundle_dir/docker-compose.git-ssh.yml")
    # Sign-in through PPM (G2.2): only on top of the Git server; absent in an RC.2 env = off (the G2.1 sign-in).
    if [[ "$(env_get PPM_GIT_SSO_ENABLED)" == 1 ]]; then
      sso_enabled=1
      compose_files+=(-f "$bundle_dir/docker-compose.git-sso.yml")
    fi
  fi
  [[ -f "$state_dir/no-workers" ]] && ppm_git_drill_exports
  # Services every project is expected to run: single source of truth for ppm-deploy.sh (wait/status) and
  # ppm-monitor.sh (O-1.1) alike, so a service added to the Compose files is never missed by one of the two.
  # shellcheck disable=SC2034  # used by the sourcing scripts
  HEALTHY_SERVICES=(plane-db plane-redis plane-mq plane-minio proxy api worker beat-worker live web admin space)
  # shellcheck disable=SC2034  # used by the sourcing scripts
  ONESHOT_SERVICES=(minio-init migrator)
  if ((git_enabled)); then HEALTHY_SERVICES+=(forgejo); ONESHOT_SERVICES+=(forgejo-db-init); fi
  note "project $project, env $env_file (${env_file_source:-given})$( ((git_enabled)) && echo "; Git server $(env_get PPM_GIT_PUBLIC_URL)$( ((sso_enabled)) && echo " with sign-in through PPM")")"
}

dc() { docker compose -p "$project" --env-file "$env_file" "${compose_files[@]}" "$@"; }

# Existing Docker resources of a project, whatever env file created them: "<containers> <volumes>".
ppm_project_resources() { # project
  local containers volumes
  containers="$(docker ps -a -q --filter "label=com.docker.compose.project=$1" | wc -l | tr -d ' ')"
  volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$1" | wc -l | tr -d ' ')"
  echo "$containers $volumes"
}

# Domains the project's existing containers actually serve (PPM_DOMAIN of the proxy, WEB_URL of the app services),
# one per line — who owns the project, independent of the env file at hand.
ppm_project_domains() { # project
  local ids
  ids="$(docker ps -a -q --filter "label=com.docker.compose.project=$1")"
  [[ -n "$ids" ]] || return 0
  # shellcheck disable=SC2086  # one argument per container id
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $ids \
    | sed -n -e 's/^PPM_DOMAIN=//p' -e 's#^WEB_URL=https\{0,1\}://\([^/:]*\).*#\1#p' | LC_ALL=C sort -u
}

# Private working directory for plain data (backup/restore): <state_dir>/.<prefix>.<pid>.XXXXXX, mode 700, never in
# the backup directory that is copied off the server. Leftovers of runs that died without their trap (SIGKILL,
# power loss) are removed first; directories of runs that are still alive are kept.
ppm_workdir() { # prefix
  local prefix="$1" stale pid
  for stale in "$state_dir"/."$prefix".*; do
    [[ -d "$stale" ]] || continue
    pid="${stale##*/."$prefix".}"; pid="${pid%%.*}"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then continue; fi
    rm -rf -- "$stale"
    note "removed the working directory of an interrupted run ($(basename "$stale"))"
  done
  (umask 077 && mktemp -d "$state_dir/.$prefix.$$.XXXXXX")
}

# Backup rotation: keep the archive just written plus the newest (keep - 1) others OF THIS PROJECT. Only names that
# are exactly <project>-<UTC timestamp>.tar.gz.gpg match, so e.g. ppm-drill-* never counts as a ppm archive.
# Prints the number of archives removed.
ppm_rotate_backups() { # dir project keep current_archive_name
  local dir="$1" project="$2" keep="$3" current="$4" removed=0 path name
  local pattern="^${project}-[0-9]{8}T[0-9]{6}Z[.]tar[.]gz[.]gpg\$"
  while read -r name; do
    [[ -n "$name" ]] || continue
    rm -f -- "$dir/$name" "$dir/${name%.tar.gz.gpg}.manifest.json" "$dir/$name.sha256"
    removed=$((removed + 1))
  done < <(for path in "$dir/$project"-*.tar.gz.gpg; do [[ -f "$path" ]] && basename "$path"; done \
             | grep -E "$pattern" | grep -vxF "$current" | LC_ALL=C sort -r | tail -n +"$keep")
  echo "$removed"
}

# Backup passphrase file from the env (relative paths are relative to the env file's directory).
ppm_passphrase_file() {
  local value; value="$(env_get PPM_BACKUP_PASSPHRASE_FILE)"
  [[ -n "$value" ]] || die "PPM_BACKUP_PASSPHRASE_FILE is not set in $env_file (ppm-env.sh init creates it)"
  [[ "$value" == /* ]] || value="$(dirname "$env_file")/$value"
  echo "$value"
}

wait_healthy() { # service... — waits for health (or running when no healthcheck)
  local deadline=$((SECONDS + ${PPM_WAIT_TIMEOUT:-600})) service id state pending
  while :; do
    pending=()
    for service in "$@"; do
      id="$(dc ps -q "$service" 2>/dev/null | head -n1)"
      [[ -n "$id" ]] || { pending+=("$service:absent"); continue; }
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")"
      [[ "$state" == "healthy" || "$state" == "running" ]] || pending+=("$service:$state")
    done
    ((${#pending[@]} == 0)) && return 0
    ((SECONDS > deadline)) && die "timeout waiting for: ${pending[*]}"
    sleep 3
  done
}

# One-shot snapshot of a service's first container, no waiting/retrying (see wait_healthy for that): its health
# state ("healthy"/"unhealthy"/"starting"), or its run state when the service has no healthcheck ("running" is
# then the good outcome, exactly as wait_healthy already treats it), or "absent" when no container exists. Used by
# ppm-monitor.sh (O-1.1): a live poll must return quickly, never block for minutes on a stuck service.
ppm_service_status() { # service
  local id state
  id="$(dc ps -q "$1" 2>/dev/null | head -n1)"
  [[ -n "$id" ]] || { echo absent; return 0; }
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null)" \
    || { echo absent; return 0; }
  echo "${state:-absent}"
}

# RestartCount of a service's first container ("" when the container is absent): Compose/Docker restarts it in
# place on crash (restart: unless-stopped) without recreating the container, so this keeps climbing across polls
# while a service is crash-looping even if it is briefly "healthy" between restarts (ppm-monitor.sh O-1.1).
ppm_service_restart_count() { # service
  local id
  id="$(dc ps -q "$1" 2>/dev/null | head -n1)"
  [[ -n "$id" ]] || return 0
  docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || true
}
