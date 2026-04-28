-- Migration 0279: SCRUM-1276 (R3-3) — public-schema views security_invoker audit
--
-- Background. PG15+ views default to security_definer. A view without
-- WITH (security_invoker = true) runs as the view OWNER (typically a
-- superuser or the migration runner), so RLS on the underlying tables
-- is bypassed for the view's caller. The supabase advisor reports this
-- as `security_definer_view` (ERROR-level).
--
-- Migration 0112 swept all public-schema views once, but views CREATED
-- AFTER 0112 were never re-swept. This migration is the second sweep
-- and pins the audit going forward via scripts/ci/check-view-security-invoker.ts.
--
-- View-by-view status (audited 2026-04-28 by reading all migrations 0001..0278):
--
--   payment_ledger          — fixed in 0274_audit06_payment_ledger_security_invoker.
--   public_org_profiles     — DROPPED in 0161_security_hardening_followup CR-4
--                             (replaced with SECURITY DEFINER function
--                             get_public_org_profiles()). Defensive DROP IF EXISTS
--                             below in case any branch / hand-applied state
--                             re-introduced it.
--   v_slow_queries          — service_role only since 0192. security_invoker
--                             added here as defense-in-depth (any future regrant
--                             to authenticated will fail-safe through RLS).
--   calibration_features    — service_role only since 0222. Same defense-in-depth.
--
-- ROLLBACK:
--   ALTER VIEW IF EXISTS public.v_slow_queries SET (security_invoker = false);
--   ALTER VIEW IF EXISTS public.calibration_features SET (security_invoker = false);
--   -- Re-creating public_org_profiles is intentionally NOT in rollback;
--   -- the function replacement is the canonical interface.

BEGIN;

-- ============================================================================
-- Defense-in-depth: drop public_org_profiles if any branch state re-created it.
-- 0161 already dropped it; this is a no-op in the current canonical lineage.
-- ============================================================================
DROP VIEW IF EXISTS public.public_org_profiles;

-- ============================================================================
-- v_slow_queries: pg_stat_statements convenience view (admin dashboard).
-- service_role only post-0192; flag flipped here so any accidental regrant
-- still enforces RLS on the underlying pg_stat_statements view.
-- ============================================================================
ALTER VIEW IF EXISTS public.v_slow_queries SET (security_invoker = true);

COMMENT ON VIEW public.v_slow_queries IS
  'PERF-05 / SCRUM-1276 (R3-3): security_invoker = true. Top 50 slowest '
  'queries by mean execution time. Requires pg_stat_statements extension. '
  'service_role only via REVOKE in 0192.';

-- ============================================================================
-- calibration_features: anchors → extraction_manifests → ai_usage_events join.
-- service_role only post-0222 (cron-only consumer); flag flipped for the
-- same defense-in-depth reason as v_slow_queries.
-- ============================================================================
ALTER VIEW IF EXISTS public.calibration_features SET (security_invoker = true);

COMMENT ON VIEW public.calibration_features IS
  'GME7.3 / SCRUM-1276 (R3-3): security_invoker = true. Flattened view for '
  'the weekly calibration-refit cron. Joins anchors → extraction_manifests '
  '(confidence_scores.overall) and ai_usage_events (confidence). service_role '
  'only via REVOKE in 0222.';

NOTIFY pgrst, 'reload schema';

COMMIT;
