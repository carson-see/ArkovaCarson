-- SCRUM-1668 / PR #700 fresh-baseline reconciliation.
--
-- The Path C baseline is schema-faithful to prod, including a few historical
-- RLS/security regressions that the archived migrations intended to close:
--   * memberships_select_org_members self-selects memberships and recurses
--   * audit_events_insert_own leaves browser-direct audit inserts forgeable
--   * get_anchor_tx_stats has a service_role grant but no in-body guard
--
-- Keep this as a forward migration so existing prod can be reconciled with the
-- same SQL that makes fresh Supabase resets pass the security contract.
--
-- ROLLBACK:
--   BEGIN;
--   CREATE POLICY memberships_select_org_members ON public.memberships
--     FOR SELECT TO authenticated
--     USING (EXISTS (
--       SELECT 1
--       FROM public.memberships m_self
--       WHERE m_self.user_id = (SELECT auth.uid())
--         AND m_self.org_id = memberships.org_id
--     ));
--   CREATE POLICY audit_events_insert_own ON public.audit_events
--     FOR INSERT TO authenticated
--     WITH CHECK (actor_id = (SELECT auth.uid()));
--   CREATE OR REPLACE FUNCTION public.get_anchor_tx_stats()
--   RETURNS json
--   LANGUAGE plpgsql
--   STABLE
--   SECURITY DEFINER
--   SET search_path = public
--   AS $rollback$
--   DECLARE v_cached jsonb;
--   BEGIN
--     SELECT cache_value INTO v_cached
--     FROM public.pipeline_dashboard_cache
--     WHERE cache_key = 'anchor_tx_stats';
--     IF v_cached IS NOT NULL THEN RETURN v_cached::json; END IF;
--     RETURN json_build_object('distinct_tx_count', 0, 'anchors_with_tx', 0,
--       'total_anchors', 0, 'last_anchor_time', NULL, 'last_tx_time', NULL,
--       'cache_miss', true);
--   END;
--   $rollback$;
--   REVOKE EXECUTE ON FUNCTION public.get_anchor_tx_stats() FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.get_anchor_tx_stats() TO service_role;
--   COMMIT;

BEGIN;

-- Membership visibility is already covered by memberships_select_org
-- (ORG_ADMIN + same org through SECURITY DEFINER helpers) and self policies.
-- This older self-referential policy causes 42P17 infinite recursion.
DROP POLICY IF EXISTS memberships_select_org_members ON public.memberships;

-- SCRUM-1270 / Forensic 7: audit_events is append-only and worker-written.
-- Drop every known browser-side INSERT policy name, including the older one
-- that survived the Path C pg_dump.
DROP POLICY IF EXISTS audit_events_insert ON public.audit_events;
DROP POLICY IF EXISTS audit_events_insert_own ON public.audit_events;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.audit_events FROM anon, authenticated;

-- SEC-RECON-7: service_role-only treasury anchor transaction stats. The grant
-- is also restricted below, but the body guard keeps the RPC fail-closed if a
-- future grant/default-privilege mistake exposes EXECUTE again.
CREATE OR REPLACE FUNCTION public.get_anchor_tx_stats()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cached jsonb;
BEGIN
  IF public.get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required'
      USING ERRCODE = '42501';
  END IF;

  SELECT cache_value
  INTO v_cached
  FROM public.pipeline_dashboard_cache
  WHERE cache_key = 'anchor_tx_stats';

  IF v_cached IS NOT NULL THEN
    RETURN v_cached::json;
  END IF;

  RETURN json_build_object(
    'distinct_tx_count', 0,
    'anchors_with_tx', 0,
    'total_anchors', 0,
    'last_anchor_time', NULL,
    'last_tx_time', NULL,
    'cache_miss', true
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_anchor_tx_stats() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_anchor_tx_stats() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_anchor_tx_stats() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_anchor_tx_stats() TO service_role;

-- SCRUM-1284: materialized dashboard views remain worker/service-role only.
REVOKE ALL ON TABLE public.mv_anchor_status_counts FROM anon, authenticated;
REVOKE ALL ON TABLE public.mv_public_records_source_counts FROM anon, authenticated;
GRANT ALL ON TABLE public.mv_anchor_status_counts TO service_role;
GRANT ALL ON TABLE public.mv_public_records_source_counts TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
