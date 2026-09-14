#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
psql_bin="${PSQL_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}"
createdb_bin="${CREATEDB_BIN:-/opt/homebrew/opt/postgresql@17/bin/createdb}"
dropdb_bin="${DROPDB_BIN:-/opt/homebrew/opt/postgresql@17/bin/dropdb}"
database="${UAT24_DATABASE:-arkova_uat24_5142_${USER:-local}_$$}"
database="$(printf '%s' "$database" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_' '_')"
database="${database:0:63}"
evidence_dir="$repo_root/docs/staging/uat24-2026-09-14"
created=false
first_log=""
second_log=""

if [[ ! "$database" =~ ^arkova_uat24_[a-z0-9_]+$ ]]; then
  echo "UAT24_DATABASE must use the arkova_uat24_ prefix" >&2
  exit 2
fi
cleanup() {
  [[ -n "$first_log" ]] && rm -f "$first_log"
  [[ -n "$second_log" ]] && rm -f "$second_log"
  if [[ "$created" == true ]]; then "$dropdb_bin" --if-exists "$database" >/dev/null; fi
}
trap cleanup EXIT

# createdb refuses an existing name. Only after it succeeds does the cleanup
# trap own that database, so this runner can never reset a shared fixture.
"$createdb_bin" "$database"
created=true
"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" -f "$evidence_dir/native-fixture-before-0462.sql"
"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" -f "$repo_root/supabase/migrations/0445_connector_artifact_materialize_link_atomic.sql"
"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" -f "$repo_root/supabase/migrations/0365_scrum2940_folders_table_and_anchor_link.sql"
"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" -f "$evidence_dir/native-seed-before-0462.sql"
"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" -f "$repo_root/supabase/migrations/0462_scrum5142_folder_hierarchy_authority.sql"
"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" -f "$evidence_dir/native-rollback-0462.sql"
"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" -f "$repo_root/supabase/migrations/0365_scrum2940_folders_table_and_anchor_link.sql"
"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" -f "$evidence_dir/native-after-rollback.sql"
"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" -f "$repo_root/supabase/migrations/0462_scrum5142_folder_hierarchy_authority.sql"
"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" -f "$evidence_dir/native-assertions.sql"

first_log="$(mktemp)"
second_log="$(mktemp)"

"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" >"$first_log" 2>&1 <<'SQL' &
SELECT set_config('request.jwt.claim.role','service_role',false);
BEGIN;
UPDATE public.folders SET parent_folder_id='f0000000-0000-4000-8000-000000000011'
 WHERE id='f0000000-0000-4000-8000-000000000010';
SELECT pg_sleep(2);
COMMIT;
SQL
first_pid=$!
sleep 0.25

set +e
"$psql_bin" -X -v ON_ERROR_STOP=1 -d "$database" >"$second_log" 2>&1 <<'SQL'
SELECT set_config('request.jwt.claim.role','service_role',false);
UPDATE public.folders SET parent_folder_id='f0000000-0000-4000-8000-000000000010'
 WHERE id='f0000000-0000-4000-8000-000000000011';
SQL
second_status=$?
set -e
wait "$first_pid"

if [[ "$second_status" -eq 0 ]] || ! grep -q 'folder hierarchy cycle' "$second_log"; then
  cat "$first_log"
  cat "$second_log"
  echo 'concurrent cycle guard failed' >&2
  exit 1
fi

echo 'uat24-concurrent-cycle-ok'
