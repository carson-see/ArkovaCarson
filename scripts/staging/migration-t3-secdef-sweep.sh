#!/usr/bin/env bash
# scripts/staging/migration-t3-secdef-sweep.sh
#
# Live has_function_privilege sweep for the sixteen functions replayed by
# 0414_sec_replay_missing_anon_revokes.sql, plus the http* negative control
# and the PM-1 ordering control (0411/0414 interaction on
# cleanup_expired_data). Re-runnable at any point during the migration-t3
# 48h soak window (docs/staging/migration-t3-soak-2026-08/) to catch a
# regression introduced by a later migration on the same rig.
#
# Usage:
#   SUPABASE_DB_PASSWORD=... ./scripts/staging/migration-t3-secdef-sweep.sh fizyjojbebyalirtjjht
#
# Requires: psql, network access to the Supabase pooler
# (aws-0-<region>.pooler.supabase.com:5432) — the direct db.<ref>.supabase.co
# host is IPv6-only and unreachable from some networks (observed 2026-08-20).

set -euo pipefail

PROJECT_REF="${1:?Usage: $0 <project-ref>}"
REGION="${SUPABASE_POOLER_REGION:-us-east-2}"
DB_PASSWORD="${SUPABASE_DB_PASSWORD:?Set SUPABASE_DB_PASSWORD (gcloud secrets versions access latest --secret=supabase-db-password-<ref>)}"

export PGPASSWORD="$DB_PASSWORD"
PSQL=(psql -h "aws-0-${REGION}.pooler.supabase.com" -p 5432 -U "postgres.${PROJECT_REF}" -d postgres -q -t -A)

echo "=== 16-function anon/authenticated sweep (project ${PROJECT_REF}) ==="
"${PSQL[@]}" -c "
WITH fns(sig) AS (VALUES
  ('public.activate_user(text, text)'),('public.admin_change_user_role(uuid, text)'),
  ('public.admin_set_platform_admin(uuid, boolean)'),('public.admin_set_user_org(uuid, uuid, text)'),
  ('public.anonymize_user_data(uuid)'),('public.can_export_user_data(uuid)'),
  ('public.cleanup_expired_data()'),('public.get_agents_for_user(uuid)'),
  ('public.get_anchor_lineage(text)'),('public.get_pipeline_stats()'),
  ('public.get_user_monthly_anchor_count(uuid)'),('public.refresh_pipeline_dashboard_cache()'),
  ('public.release_advisory_lock(bigint)'),('public.set_webhook_delivery_log_public_id()'),
  ('public.set_webhook_endpoint_public_id()'),('public.try_advisory_lock(bigint)')
)
SELECT sig || ' | anon=' || has_function_privilege('anon', sig::regprocedure, 'EXECUTE')
           || ' | authenticated=' || has_function_privilege('authenticated', sig::regprocedure, 'EXECUTE')
FROM fns ORDER BY sig;
"

echo ""
echo "=== Violations (anon=true on any, OR authenticated=true outside the 2 deliberate exceptions) ==="
VIOLATIONS=$("${PSQL[@]}" -c "
WITH fns(sig) AS (VALUES
  ('public.activate_user(text, text)'),('public.admin_change_user_role(uuid, text)'),
  ('public.admin_set_platform_admin(uuid, boolean)'),('public.admin_set_user_org(uuid, uuid, text)'),
  ('public.anonymize_user_data(uuid)'),('public.can_export_user_data(uuid)'),
  ('public.cleanup_expired_data()'),('public.get_agents_for_user(uuid)'),
  ('public.get_anchor_lineage(text)'),('public.get_pipeline_stats()'),
  ('public.get_user_monthly_anchor_count(uuid)'),('public.refresh_pipeline_dashboard_cache()'),
  ('public.release_advisory_lock(bigint)'),('public.set_webhook_delivery_log_public_id()'),
  ('public.set_webhook_endpoint_public_id()'),('public.try_advisory_lock(bigint)')
)
SELECT sig FROM fns
WHERE has_function_privilege('anon', sig::regprocedure, 'EXECUTE') = true
   OR (has_function_privilege('authenticated', sig::regprocedure, 'EXECUTE') = true
       AND sig NOT IN ('public.get_pipeline_stats()','public.get_user_monthly_anchor_count(uuid)'));
")
if [ -n "$VIOLATIONS" ]; then
  echo "FAIL — regression detected:"
  echo "$VIOLATIONS"
  exit 1
fi
echo "none — all sixteen closed correctly on both axes"

echo ""
echo "=== PM-1 ordering control: cleanup_expired_data anon EXECUTE must be false ==="
"${PSQL[@]}" -c "SELECT has_function_privilege('anon', 'cleanup_expired_data()'::regprocedure, 'EXECUTE');"

echo ""
echo "=== http* negative control (extensions.http* must remain anon-executable — 0414 does not touch these) ==="
"${PSQL[@]}" -c "
SELECT p.proname || ' anon_exec=' || has_function_privilege('anon', p.oid, 'EXECUTE')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'extensions' AND p.proname LIKE 'http%'
ORDER BY p.proname;
"

echo ""
echo "Sweep complete."
