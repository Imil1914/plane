#!/usr/bin/env bash
set -euo pipefail

# AF1.2: disposable database, synthetic accounts and real browser/API processes.
# Requires the normal local .env files and installed pnpm/browser dependencies.
# --browser-only skips the backup/restore drill, never its full-gate default.

cd "$(dirname "$0")/.."

browser_only=false
if [[ "${1:-}" == "--browser-only" ]]; then
  browser_only=true
  shift
fi

for required in .env apps/api/.env apps/web/.env; do
  if [[ ! -f "$required" ]]; then
    printf 'Missing %s. Prepare local .env files without overwriting existing ones.\n' "$required" >&2
    exit 1
  fi
done

for binary in docker pnpm node openssl curl; do
  command -v "$binary" >/dev/null || { printf 'Missing required command: %s\n' "$binary" >&2; exit 1; }
done

select_browser() {
  case "$1" in
    chrome)
      export PPM_E2E_BROWSER_CHANNEL=chrome
      playwright_browser=chromium
      ;;
    chromium|firefox|webkit)
      unset PPM_E2E_BROWSER_CHANNEL || true
      playwright_browser="$1"
      ;;
    *)
      printf 'Unsupported browser: %s\n' "$1" >&2
      exit 1
      ;;
  esac
}
if [[ "$#" == 0 ]]; then set -- chrome; fi
for browser in "$@"; do select_browser "$browser"; done
# build (default): production bundle served statically; dev: Vite dev server for local debugging only.
web_mode="${PPM_E2E_WEB_MODE:-build}"
if [[ "$web_mode" != "build" && "$web_mode" != "dev" ]]; then
  printf 'Unsupported PPM_E2E_WEB_MODE: %s\n' "$web_mode" >&2
  exit 1
fi

export PPM_E2E_API_PORT="${PPM_E2E_API_PORT:-8100}"
export PPM_E2E_WEB_PORT="${PPM_E2E_WEB_PORT:-3100}"
export PPM_E2E_BASE_URL="http://localhost:${PPM_E2E_WEB_PORT}"
export PPM_E2E_API_BASE_URL="http://localhost:${PPM_E2E_API_PORT}"
export PPM_E2E_REVOKE_GUEST=1
export PPM_E2E_ALLOW_SEED=1
export PPM_E2E_ASSET_SOURCE_BUCKET=ppm-af12-source
export PPM_E2E_ASSET_RESTORE_BUCKET=ppm-af12-restore
export PPM_E2E_OWNER_PASSWORD="$(openssl rand -hex 20)"
export PPM_E2E_MEMBER_PASSWORD="$(openssl rand -hex 20)"
export PPM_E2E_GUEST_PASSWORD="$(openssl rand -hex 20)"
export PPM_E2E_GLOBAL_PASSWORD="$(openssl rand -hex 20)"

run_suffix="$(openssl rand -hex 5)"
compose_project="ppm-af12-${run_suffix}"
fixture_slug="af12-ci-${run_suffix}"
web_pid=""
web_log="$(mktemp -t ppm-af12-web.XXXXXXXX)"
# RC-1: optionally reuse an already built API test image (same apps/api/Dockerfile.dev and requirements) instead of
# building a fresh one per disposable project; the code itself is always mounted from this checkout.
api_image="${PPM_E2E_API_IMAGE:-}"
api_image_tags=("${compose_project}-api-tests" "${compose_project}-api-browser-gate")

cleanup() {
  if [[ -n "$web_pid" ]]; then
    kill "$web_pid" 2>/dev/null || true
    wait "$web_pid" 2>/dev/null || true
  fi
  docker compose -p "$compose_project" -f docker-compose-test.yml down -v --remove-orphans >/dev/null
  if [[ -n "$api_image" ]]; then
    docker image rm "${api_image_tags[@]}" >/dev/null 2>&1 || true
  fi
  rm -f -- "$web_log"
}
trap cleanup EXIT

if [[ -n "$api_image" ]]; then
  docker image inspect "$api_image" >/dev/null
  for tag in "${api_image_tags[@]}"; do docker tag "$api_image" "$tag"; done
fi

services=(test-db test-redis test-mq)
if [[ "$browser_only" == "false" ]]; then
  services+=(test-minio test-minio-restore)
fi
docker compose -p "$compose_project" -f docker-compose-test.yml up -d "${services[@]}"
docker compose -p "$compose_project" -f docker-compose-test.yml run --rm --no-deps \
  --entrypoint python api-tests manage.py migrate --noinput --verbosity 0

# Exports the IDs, slugs and e-mails a seed command printed as JSON (never passwords); $1 is the only allowed prefix.
export_fixture() {
  local fixture_env
  fixture_env="$(printf '%s' "$2" | FIXTURE_PREFIX="$1" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const values = JSON.parse(input);
      const allowed = new RegExp(`^${process.env.FIXTURE_PREFIX}_[A-Z_]+$`);
      for (const [key, value] of Object.entries(values)) {
        if (!allowed.test(key) || typeof value !== "string" || /[\r\n=]/.test(value)) {
          throw new Error("Invalid browser gate fixture output");
        }
        process.stdout.write(`${key}=${value}\n`);
      }
    });
  ')"
  while IFS='=' read -r name value; do
    export "$name=$value"
  done <<< "$fixture_env"
}

fixture_json="$(docker compose -p "$compose_project" -f docker-compose-test.yml run --rm --no-deps \
  --entrypoint python -e PPM_E2E_ALLOW_SEED -e PPM_E2E_OWNER_PASSWORD \
  -e PPM_E2E_MEMBER_PASSWORD -e PPM_E2E_GUEST_PASSWORD -e PPM_E2E_GLOBAL_PASSWORD \
  api-tests manage.py seed_ppm_canvas_browser_gate --slug "$fixture_slug")"
export_fixture PPM_E2E "$fixture_json"

docker compose -p "$compose_project" -f docker-compose-test.yml up -d api-browser-gate
for attempt in {1..40}; do
  if curl -fsS "$PPM_E2E_API_BASE_URL/api/instances/" >/dev/null; then break; fi
  if [[ "$attempt" == 40 ]]; then printf 'AF1.2 API did not start.\n' >&2; exit 1; fi
  sleep 1
done

# RC-1: synthetic ROBOT/BIO demo space (doc 16, five roles) for e2e/ppm-demo.spec.ts. The seed runs inside the API
# container so its Vault files land in the same disposable storage that the API and the Brain worker below read.
demo_roles=(OWNER ROBOT_MEMBER BIO_MEMBER ROBOT_VIEWER OUTSIDER)
demo_password_args=()
for role in "${demo_roles[@]}"; do
  export "PPM_DEMO_${role}_PASSWORD=$(openssl rand -hex 20)"
  demo_password_args+=(-e "PPM_DEMO_${role}_PASSWORD")
done
demo_json="$(docker compose -p "$compose_project" -f docker-compose-test.yml exec -T -e PPM_E2E_ALLOW_SEED \
  "${demo_password_args[@]}" api-browser-gate python manage.py seed_ppm_demo_gate --slug "ppm-demo-${run_suffix}")"
export_fixture PPM_DEMO "$demo_json"
# Brain indexing runs in Celery: the demo waits for the sources it creates in the browser to become ready.
docker compose -p "$compose_project" -f docker-compose-test.yml exec -d api-browser-gate \
  sh -c 'exec celery -A plane worker --loglevel=WARNING --concurrency=1 >/tmp/ppm-e2e-worker.log 2>&1'

if [[ "$web_mode" == "build" ]]; then
  # RC-1: the gate tests the production bundle. In a clean checkout the dev server re-optimizes dependencies while
  # the first pages load and can keep serving mismatched modules (the app stays on «Открываем PPM»), which failed
  # the gate for reasons unrelated to PPM. The build takes seconds and goes to the gitignored apps/web/build.
  if ! VITE_API_BASE_URL="$PPM_E2E_API_BASE_URL" VITE_WEB_BASE_URL="$PPM_E2E_BASE_URL" \
    pnpm --dir apps/web exec react-router build >"$web_log" 2>&1; then
    printf 'AF1.2 web build failed. Last 4000 log bytes:\n' >&2
    tail -c 4000 "$web_log" >&2
    exit 1
  fi
  NO_UPDATE_CHECK=1 pnpm --dir apps/web exec serve --single --no-clipboard --no-request-logging \
    --listen "tcp://127.0.0.1:${PPM_E2E_WEB_PORT}" build/client >>"$web_log" 2>&1 &
else
  VITE_API_BASE_URL="$PPM_E2E_API_BASE_URL" VITE_WEB_BASE_URL="$PPM_E2E_BASE_URL" \
    pnpm --dir apps/web exec react-router dev --port "$PPM_E2E_WEB_PORT" >"$web_log" 2>&1 &
fi
web_pid="$!"
for attempt in {1..80}; do
  if curl -fsS "$PPM_E2E_BASE_URL/sign-in" >/dev/null; then break; fi
  if [[ "$attempt" == 80 ]]; then
    printf 'AF1.2 web app did not start. Last 4000 log bytes:\n' >&2
    tail -c 4000 "$web_log" >&2
    exit 1
  fi
  sleep 1
done

for browser in "$@"; do
  select_browser "$browser"
  printf 'Running isolated AF1.2 browser gate in %s (fixture %s)\n' "$browser" "$fixture_slug"
  playwright_args=(
    e2e/ppm-canvas-collaboration.spec.ts
    e2e/ppm-canvas-performance.spec.ts
    e2e/ppm-auth-csrf.spec.ts
    e2e/ppm-demo.spec.ts
    --browser "$playwright_browser" --workers=1 --reporter=line
  )
  if [[ -n "${PPM_E2E_TEST_GREP:-}" ]]; then
    playwright_args+=(--grep "$PPM_E2E_TEST_GREP")
  fi
  pnpm --dir apps/web exec playwright test \
    "${playwright_args[@]}"
done

if [[ "$browser_only" == "true" ]]; then
  printf 'AF1.2 browser-only gate passed; PostgreSQL/Vault/Plane attachment restore was not run.\n'
  exit 0
fi

# Check the actual PostgreSQL backup path after browsers have saved Canvas data.
# The dump, Vault files and restored copies exist only in this disposable stack.
verify_args=(
  --workspace-id "$PPM_E2E_WORKSPACE_ID"
  --project-id "$PPM_E2E_PROJECT_ID"
  --other-project-id "$PPM_E2E_OTHER_PROJECT_ID"
)
docker compose -p "$compose_project" -f docker-compose-test.yml run --rm --no-deps \
  --entrypoint python -e PPM_E2E_ALLOW_SEED \
  -e PPM_LOCAL_ASSET_UPLOADS=1 -e PPM_VAULT_STORAGE_ROOT=/tmp/ppm-af12-vault-source \
  api-tests manage.py seed_ppm_vault_restore_gate \
  --workspace-id "$PPM_E2E_WORKSPACE_ID" --project-id "$PPM_E2E_PROJECT_ID"
docker compose -p "$compose_project" -f docker-compose-test.yml run --rm --no-deps \
  --entrypoint python -e PPM_E2E_ALLOW_SEED \
  api-tests manage.py seed_ppm_work_item_restore_gate \
  --workspace-id "$PPM_E2E_WORKSPACE_ID" --project-id "$PPM_E2E_PROJECT_ID"
docker compose -p "$compose_project" -f docker-compose-test.yml run --rm --no-deps \
  --entrypoint python -e PPM_E2E_ALLOW_SEED \
  api-tests manage.py seed_ppm_asset_restore_gate \
  --workspace-id "$PPM_E2E_WORKSPACE_ID" --project-id "$PPM_E2E_PROJECT_ID"
before_restore="$(docker compose -p "$compose_project" -f docker-compose-test.yml run --rm --no-deps \
  --entrypoint python -e PPM_E2E_ALLOW_SEED \
  -e PPM_LOCAL_ASSET_UPLOADS=1 -e PPM_VAULT_STORAGE_ROOT=/tmp/ppm-af12-vault-source \
  api-tests manage.py verify_ppm_canvas_restore_gate "${verify_args[@]}")"

docker compose -p "$compose_project" -f docker-compose-test.yml exec -T test-db sh -ec '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  pg_dump --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --format=custom --file=/tmp/ppm-af12-canvas-backup.dump
  createdb -U "$POSTGRES_USER" test_af12_restore
  pg_restore --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" \
    -d test_af12_restore /tmp/ppm-af12-canvas-backup.dump
'

restore_database_url="$(docker compose -p "$compose_project" -f docker-compose-test.yml config --format json | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const configured = JSON.parse(input).services["api-tests"].environment.DATABASE_URL;
    const url = new URL(configured);
    if (url.hostname !== "test-db") throw new Error("Backup drill requires disposable test-db only");
    url.pathname = "/test_af12_restore";
    process.stdout.write(url.href);
  });
')"
if missing_vault_output="$(DATABASE_URL="$restore_database_url" docker compose -p "$compose_project" \
  -f docker-compose-test.yml run --rm --no-deps --entrypoint python \
  -e PPM_E2E_ALLOW_SEED -e DATABASE_URL \
  -e PPM_LOCAL_ASSET_UPLOADS=1 -e PPM_VAULT_STORAGE_ROOT=/tmp/ppm-af12-vault-restore \
  api-tests manage.py verify_ppm_canvas_restore_gate \
  "${verify_args[@]}" --expected-database test_af12_restore --vault-storage restore 2>&1)"; then
  printf 'AF1.2 database-only restore unexpectedly recovered Vault files.\n' >&2
  exit 1
fi
if [[ "$missing_vault_output" != *"AF1.2 Vault object missing after restore."* ]]; then
  printf 'AF1.2 database-only restore failed for an unexpected reason:\n%s\n' "$missing_vault_output" >&2
  exit 1
fi

docker compose -p "$compose_project" -f docker-compose-test.yml run --rm --no-deps --entrypoint sh \
  api-tests -ec '
    tar -cf /tmp/ppm-af12-vault-backup.tar -C /tmp/ppm-af12-vault-source ppm-vault
    tar -xf /tmp/ppm-af12-vault-backup.tar -C /tmp/ppm-af12-vault-restore
  '
if missing_asset_output="$(DATABASE_URL="$restore_database_url" \
  AWS_S3_ENDPOINT_URL=http://test-minio-restore:9000 AWS_S3_BUCKET_NAME="$PPM_E2E_ASSET_RESTORE_BUCKET" \
  docker compose -p "$compose_project" -f docker-compose-test.yml run --rm --no-deps \
  --entrypoint python -e PPM_E2E_ALLOW_SEED -e DATABASE_URL \
  -e AWS_S3_ENDPOINT_URL -e AWS_S3_BUCKET_NAME \
  -e PPM_LOCAL_ASSET_UPLOADS=1 -e PPM_VAULT_STORAGE_ROOT=/tmp/ppm-af12-vault-restore \
  api-tests manage.py verify_ppm_canvas_restore_gate \
  "${verify_args[@]}" --expected-database test_af12_restore --vault-storage restore \
  --asset-storage restore 2>&1)"; then
  printf 'AF1.2 database and Vault restore unexpectedly recovered Plane attachments.\n' >&2
  exit 1
fi
if [[ "$missing_asset_output" != *"AF1.2 Plane attachment object missing after restore."* ]]; then
  printf 'AF1.2 missing-attachment check failed unexpectedly:\n%s\n' "$missing_asset_output" >&2
  exit 1
fi

docker compose -p "$compose_project" -f docker-compose-test.yml exec -T test-minio sh -ec '
  mc mirror local/ppm-af12-source /tmp/ppm-af12-asset-backup/export
  tar -cf /tmp/ppm-af12-asset-backup/objects.tar -C /tmp/ppm-af12-asset-backup export
'
docker compose -p "$compose_project" -f docker-compose-test.yml exec -T test-minio-restore sh -ec '
  mkdir -p /tmp/ppm-af12-asset-backup/import
  tar -xf /tmp/ppm-af12-asset-backup/objects.tar -C /tmp/ppm-af12-asset-backup/import
  mc mirror /tmp/ppm-af12-asset-backup/import/export local/ppm-af12-restore
'
after_restore="$(DATABASE_URL="$restore_database_url" \
  AWS_S3_ENDPOINT_URL=http://test-minio-restore:9000 AWS_S3_BUCKET_NAME="$PPM_E2E_ASSET_RESTORE_BUCKET" \
  docker compose -p "$compose_project" \
  -f docker-compose-test.yml run --rm --no-deps --entrypoint python \
  -e PPM_E2E_ALLOW_SEED -e DATABASE_URL -e AWS_S3_ENDPOINT_URL -e AWS_S3_BUCKET_NAME \
  -e PPM_LOCAL_ASSET_UPLOADS=1 -e PPM_VAULT_STORAGE_ROOT=/tmp/ppm-af12-vault-restore \
  api-tests manage.py verify_ppm_canvas_restore_gate \
  "${verify_args[@]}" --expected-database test_af12_restore --vault-storage restore --asset-storage restore)"
if [[ "$before_restore" != "$after_restore" ]]; then
  printf 'AF1.2 backup/restore integrity mismatch.\n' >&2
  exit 1
fi
printf 'AF1.2 PostgreSQL + local Vault + Plane attachment backup/restore verified: %s\n' "$after_restore"

# Authentication must work through the ordinary CSRF-protected password/session
# route against the restored database, not only APIClient.force_authenticate.
DATABASE_URL="$restore_database_url" docker compose -p "$compose_project" \
  -f docker-compose-test.yml run --rm --no-deps --entrypoint python \
  -e PPM_E2E_ALLOW_SEED -e DATABASE_URL \
  -e PPM_E2E_OWNER_PASSWORD -e PPM_E2E_MEMBER_PASSWORD -e PPM_E2E_GUEST_PASSWORD \
  -e PPM_E2E_GLOBAL_PASSWORD \
  api-tests manage.py verify_ppm_restore_login_gate \
  "${verify_args[@]}" --expected-database test_af12_restore
