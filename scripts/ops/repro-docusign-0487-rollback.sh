#!/usr/bin/env bash
# AR20-93: isolated, synthetic rehearsal only. No database URL, network
# target, or production credential is accepted by this script.
set -euo pipefail
umask 077

if [[ $# -ne 0 ]]; then
  echo "usage: scripts/ops/repro-docusign-0487-rollback.sh" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$repo_root/scripts/ops/fixtures/docusign-0487-rollback.sql"
index_migration="$repo_root/supabase/migrations/0343_scrum2348_connector_artifact_queue_schema.sql"
backfill_migration="$repo_root/supabase/migrations/0487_docusign_content_addressed_external_revision_backfill.sql"

source_index="$(sed -n '/^CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_artifact_dedupe$/,+1p' "$index_migration")"
fixture_index="$(sed -n '/^CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_artifact_dedupe$/,+1p' "$fixture")"
if [[ -z "$source_index" || "$source_index" != "$fixture_index" ]]; then
  echo "AR20-93 fixture index differs from migration 0343; stop before PostgreSQL starts" >&2
  exit 1
fi
if ! rg -q "^SET external_revision = fingerprint_sha256$" "$backfill_migration"; then
  echo "AR20-93 source migration 0487 changed; review fixture before running" >&2
  exit 1
fi

for binary in initdb pg_ctl psql shasum; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "missing local PostgreSQL fixture tool: $binary" >&2
    exit 2
  fi
done
for binary in initdb pg_ctl psql; do
  if [[ ! "$("$binary" --version)" =~ PostgreSQL\)\ 17\. ]]; then
    echo "AR20-93 requires PostgreSQL 17 tools for this fixture" >&2
    exit 2
  fi
done
# Ignore all ambient libpq selectors, including PGHOSTADDR and PGSERVICE.
# The psql invocation below supplies its newly created socket explicitly.
for variable in $(compgen -e); do
  case "$variable" in PG*) unset "$variable" ;; esac
done

fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/ar20-93-pg.XXXXXXXX")"
mkdir -m 700 "$fixture_dir/socket"
server_attempted=0
cleanup() {
  if [[ "$server_attempted" -eq 1 ]]; then
    # A timed-out start may still have launched postgres. Probe our own data
    # directory before cleanup even if pg_ctl start did not return success.
    local running=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if pg_ctl -D "$fixture_dir/data" status >/dev/null 2>&1; then
        running=1
        break
      fi
      sleep 0.5
    done
    if [[ "$running" -eq 1 ]]; then
      if ! pg_ctl -D "$fixture_dir/data" -w -t 10 -m fast stop >/dev/null 2>&1; then
        echo "AR20-93 dedicated fixture did not stop cleanly; inspect $fixture_dir before manual cleanup" >&2
        return 1
      fi
    elif [[ -e "$fixture_dir/data/postmaster.pid" ]]; then
      echo "AR20-93 dedicated fixture may still be starting; retained $fixture_dir for manual process check" >&2
      return 1
    fi
    server_attempted=0
  fi
  if [[ "$fixture_dir" == "${TMPDIR:-/tmp}/ar20-93-pg."* ]]; then
    rm -rf -- "$fixture_dir"
  fi
}
trap 'status=$?; cleanup || status=1; exit "$status"' EXIT

initdb -D "$fixture_dir/data" -A trust --no-instructions --no-sync >"$fixture_dir/initdb.log" 2>&1
# No TCP listener, no host target: only this new private Unix socket directory.
server_attempted=1
pg_ctl -D "$fixture_dir/data" -l "$fixture_dir/postgres.log" -w -t 10 \
  -o "-c listen_addresses= -c unix_socket_directories=$fixture_dir/socket -p 59393" start >/dev/null

export PGCONNECT_TIMEOUT=3
export PGOPTIONS='-c statement_timeout=10000 -c lock_timeout=1000'
if ! psql -X -qAt -v ON_ERROR_STOP=1 -h "$fixture_dir/socket" -p 59393 \
  -U "$(id -un)" -d postgres -f "$fixture" \
  >"$fixture_dir/sql.out" 2>"$fixture_dir/sql.err"; then
  echo "AR20-93 isolated SQL rehearsal failed:" >&2
  tail -30 "$fixture_dir/sql.err" >&2
  exit 1
fi
if ! rg -q '^AR20_93_PASS:blanket_3_conflict:scoped_1:post_2:reapply_1:missing_snapshot_stop:collision_stop:reapply_collision_stop$' "$fixture_dir/sql.out"; then
  echo "AR20-93 isolated SQL rehearsal omitted its exact pass marker" >&2
  exit 1
fi

source_head="$(git -C "$repo_root" rev-parse HEAD)"
index_sha="$(shasum -a 256 "$index_migration" | awk '{print $1}')"
backfill_sha="$(shasum -a 256 "$backfill_migration" | awk '{print $1}')"
fixture_sha="$(shasum -a 256 "$fixture" | awk '{print $1}')"
postgres_version="$(psql --version | awk '{print $3}')"
cleanup
trap - EXIT
printf '{"schema":"arkova.ar20_93.local_rollback.v2","status":"PASS","target":"dedicated-unix-socket-postgres","postgresVersion":"%s","sourceHead":"%s","indexMigrationSha256":"%s","backfillMigrationSha256":"%s","fixtureSha256":"%s","blanketPredicateRows":3,"blanketUniqueConflict":true,"boundedTransactionRehearsed":true,"scopedRows":1,"postCutoverRowsPreserved":2,"reapplyRows":1,"reapplyCollisionStops":true,"missingSnapshotStops":true,"wrongIdentityStops":true,"sameEnvelopeCohortStops":true,"mixedWriterCollisionStops":true,"fixtureRemoved":true}\n' \
  "$postgres_version" "$source_head" "$index_sha" "$backfill_sha" "$fixture_sha"
