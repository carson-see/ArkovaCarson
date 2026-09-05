#!/usr/bin/env bash
#
# BUG-2026-08-22-001 — reproduce the nightly `cleanup_expired_data()` deadlock,
# and demonstrate that migration 0417 closes it.
#
# WHY A SCRIPT AND NOT A VITEST. The defect is a lock-ORDER cycle between a
# table lock on `audit_events` and a catalog-object lock on `pg_trigger`. It
# cannot be reproduced against a mock, and it needs genuinely concurrent
# backends — not a single connection. `src/tests/0417-cleanup-expired-data-singleton.test.ts`
# pins the SHAPE of the fix in CI; this script is how the BEHAVIOUR was
# established, kept runnable so the claim can be re-checked rather than trusted.
#
# ISOLATION. Everything runs in a throwaway `postgres:15` container on a private
# port. It NEVER touches the shared local Supabase stack (whose containers are
# shared across worktrees), any staging rig, or prod. Nothing here needs
# credentials for anything.
#
#   ./scripts/ops/repro-cleanup-expired-data-concurrency.sh [concurrency] [rounds]
#
# Measured 2026-08-22 on Postgres 15.18, concurrency 6, 5 rounds:
#
#   0411 only   deadlocks=24  duplicate DATA_RETENTION_CLEANUP rows observed
#   0411+0417   deadlocks=0   exactly one DATA_RETENTION_CLEANUP row per round
#
set -euo pipefail

N=${1:-6}
ROUNDS=${2:-5}
CONTAINER=ark-cleanup-repro-$$
REPO_ROOT=$(git rev-parse --show-toplevel)
WORK=$(mktemp -d)

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

psql_c() { docker exec "$CONTAINER" psql -U postgres "$@"; }

echo "==> starting throwaway postgres:15 (container $CONTAINER)"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pw postgres:15 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

cat > "$WORK/setup.sql" <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;

CREATE TABLE anchors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), legal_hold boolean DEFAULT false);
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY, event_type text, event_category text,
  actor_id uuid, target_id text, details text, created_at timestamptz DEFAULT now());
CREATE TABLE webhook_delivery_logs (id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now());
CREATE TABLE verification_events (id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now());
CREATE TABLE ai_usage_events (id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now());

CREATE OR REPLACE FUNCTION public.reject_audit_modification() RETURNS trigger
  LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are immutable. % operations are not allowed.', TG_OP USING ERRCODE = 'check_violation';
  RETURN NULL;
END; $$;

CREATE TRIGGER reject_audit_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_modification();
SQL

docker cp "$WORK/setup.sql" "$CONTAINER:/tmp/setup.sql" >/dev/null
psql_c -q -f /tmp/setup.sql

# Strip the statements a throwaway container has no roles or extensions for.
# The FUNCTION BODY — the thing under test — is untouched.
strip() {
  sed -E '/^NOTIFY pgrst/d; /^REVOKE ALL ON FUNCTION/d; /^GRANT EXECUTE ON FUNCTION/d; /^ALTER FUNCTION .*OWNER TO/d'
}

# 0411 lands via PR #2235 and may not be on this branch. Fall back to the
# branch that owns it so the A-side is always the real prior definition.
if [ -f "$REPO_ROOT/supabase/migrations/0411_bug019_cleanup_expired_data_lock_timeout.sql" ]; then
  strip < "$REPO_ROOT/supabase/migrations/0411_bug019_cleanup_expired_data_lock_timeout.sql" > "$WORK/a.sql"
else
  echo "==> 0411 not on this branch; reading it from origin/fix/data-integrity-soak-cluster"
  git -C "$REPO_ROOT" show \
    origin/fix/data-integrity-soak-cluster:supabase/migrations/0411_bug019_cleanup_expired_data_lock_timeout.sql \
    | strip > "$WORK/a.sql"
fi
strip < "$REPO_ROOT/supabase/migrations/0417_cleanup_expired_data_singleton_advisory_lock.sql" > "$WORK/b.sql"

docker cp "$WORK/a.sql" "$CONTAINER:/tmp/a.sql" >/dev/null
docker cp "$WORK/b.sql" "$CONTAINER:/tmp/b.sql" >/dev/null

measure() {
  local label=$1 mig=$2 deadlocks=0 skips=0
  psql_c -q -f "$mig" >/dev/null
  echo "==> $label  (concurrency=$N, rounds=$ROUNDS)"
  for r in $(seq 1 "$ROUNDS"); do
    # Reset to a known state: purgeable history, no cleanup rows. The trigger is
    # disabled around the reset because the fixture delete is not the thing
    # under test.
    psql_c -q -c "ALTER TABLE audit_events DISABLE TRIGGER reject_audit_delete;
                  DELETE FROM audit_events;
                  ALTER TABLE audit_events ENABLE TRIGGER reject_audit_delete;
                  INSERT INTO audit_events (event_type,event_category,created_at)
                    SELECT 'OLD','SYSTEM', now()-INTERVAL '3 years' FROM generate_series(1,3000);" >/dev/null

    # Synchronize on a wall-clock boundary so the callers enter the DDL section
    # together — the prod shape, where N warm instances all fire at 02:00:00.
    local start=$(( $(date +%s) + 2 )) out
    out=$(for _ in $(seq 1 "$N"); do
      docker exec "$CONTAINER" psql -U postgres -tAc \
        "SELECT pg_sleep(GREATEST(0, $start - extract(epoch from clock_timestamp())));
         SELECT public.cleanup_expired_data();" 2>&1 | tr '\n' ' ' &
    done; wait)

    # `grep` exits 1 on no-match, which under `set -e -o pipefail` would abort
    # the run on exactly the outcome we are hoping for. Count without grep's
    # exit status participating.
    local n_dead n_skip
    n_dead=$(awk 'BEGIN{n=0} {n+=gsub(/deadlock detected/,"")} END{print n+0}' <<<"$out")
    n_skip=$(awk 'BEGIN{n=0} {n+=gsub(/"skipped_concurrent_run": true/,"")} END{print n+0}' <<<"$out")
    deadlocks=$(( deadlocks + n_dead ))
    skips=$(( skips + n_skip ))
    local rows
    rows=$(psql_c -tAc "SELECT count(*) FROM audit_events WHERE event_type='DATA_RETENTION_CLEANUP'" | tr -d ' ')
    printf '    round %s: DATA_RETENTION_CLEANUP rows written = %s\n' "$r" "$rows"
  done
  printf '    RESULT %s: deadlocks=%s skips=%s\n\n' "$label" "$deadlocks" "$skips"
}

measure "A: 0411 only (the definition 0417 builds on)" /tmp/a.sql
measure "B: 0411 + 0417 (this change)"                 /tmp/b.sql

echo "Expected: A shows deadlocks and can write >1 cleanup row per round."
echo "          B shows deadlocks=0 and exactly 1 cleanup row per round."
