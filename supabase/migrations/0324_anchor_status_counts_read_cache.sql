-- SCRUM-2189 — get_anchor_status_counts_fast() reads pipeline_dashboard_cache.
--
-- The baseline definition ran a per-status COUNT with a 1s budget on the
-- ~3.3M-row anchors table. Every bucket exceeded that budget in production, so
-- PENDING/SUBMITTED/BROADCASTING/REVOKED all returned the -1 sentinel and the
-- admin dashboard rendered "—" for live pipeline state.
--
-- The SCRUM-1708 cron (refresh_cache_anchor_status_counts) already maintains
-- correct counts in pipeline_dashboard_cache under key 'anchor_status_counts',
-- in the exact JSON shape this RPC returns. Redefine the RPC to read that cache.
--
-- Contract preserved: identical access guard (service_role OR platform admin),
-- identical JSON shape and key set. Missing/empty cache row (cron not yet run)
-- returns -1 sentinels, matching the prior "unavailable" semantics — callers
-- already treat -1 as "—". No age-based staleness rejection here; surfacing
-- cache age in the UI is a separate story.
--
-- ROLLBACK:
--   Restore the baseline definition (the live per-status COUNT path with the 1s
--   sub-budget) from 00000000000000_baseline_at_main_HEAD.sql, then
--   NOTIFY pgrst, 'reload schema'.

CREATE OR REPLACE FUNCTION public.get_anchor_status_counts_fast() RETURNS json
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    SET statement_timeout TO '8s'
    AS $$
DECLARE
  v_cache jsonb;
BEGIN
  IF NOT (
    get_caller_role() = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = (SELECT auth.uid()) AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  SELECT cache_value INTO v_cache
  FROM pipeline_dashboard_cache
  WHERE cache_key = 'anchor_status_counts';

  -- Cache row absent (cron has not populated it yet): emit -1 sentinels so the
  -- caller renders "—" rather than a misleading zero.
  IF v_cache IS NULL THEN
    RETURN json_build_object(
      'PENDING', -1,
      'SUBMITTED', -1,
      'BROADCASTING', -1,
      'SECURED', -1,
      'REVOKED', -1,
      'total', -1
    );
  END IF;

  RETURN json_build_object(
    'PENDING',      COALESCE((v_cache->>'PENDING')::bigint, -1),
    'SUBMITTED',    COALESCE((v_cache->>'SUBMITTED')::bigint, -1),
    'BROADCASTING', COALESCE((v_cache->>'BROADCASTING')::bigint, -1),
    'SECURED',      COALESCE((v_cache->>'SECURED')::bigint, -1),
    'REVOKED',      COALESCE((v_cache->>'REVOKED')::bigint, -1),
    'total',        COALESCE((v_cache->>'total')::bigint, -1)
  );
END;
$$;

ALTER FUNCTION public.get_anchor_status_counts_fast() OWNER TO postgres;

NOTIFY pgrst, 'reload schema';
