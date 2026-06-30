BEGIN;

-- =============================================================================
-- 0350 — Fair server-side org enumeration for the connector_artifact drain
--        (QUEUE-09, SCRUM-2352 follow-up; stacked on QUEUE-06 PR #1366)
--
-- WHY THIS EXISTS (the starvation bug):
--   The drain cron enumerates orgs-with-drainable-work via
--   `defaultListDrainableOrgIds`, which did a flat row scan:
--     SELECT org_id FROM connector_artifact
--       WHERE status IN ('pending','queued') LIMIT 5000   -- then dedup in memory
--   A single org with >5000 drainable rows fills the entire 5000-row window, so
--   every OTHER org with drainable work is never enumerated and never drained —
--   one noisy org STARVES the rest of the fleet.
--
-- THE FIX (mirrors the document-queue scheduler's RPC style — 0294
--   `claim_due_org_queue_runs`): enumerate DISTINCT orgs server-side, not by
--   scanning rows. `list_drainable_connector_orgs` returns each distinct org_id
--   that has at least one drainable ('pending'|'queued') row, ordered by oldest
--   pending work first, capped at a LIMIT on ORGS (not rows). One noisy org now
--   contributes exactly ONE row to the result, so it can never crowd out a
--   quiet org. The per-row compare-and-set claim in the drain already provides
--   exactly-once concurrency, so — unlike 0294 — NO run-state/lock tables are
--   needed here; this is purely a fair DISTINCT-org list.
--
-- ORDERING / INDEX:
--   `GROUP BY org_id ORDER BY min(created_at) ASC` surfaces the org whose
--   oldest unprocessed artifact has waited longest first (anti-starvation
--   fairness across passes). The aggregate filters on the partial set of
--   drainable rows and is served by the existing 0343
--   `idx_connector_artifact_org_status (org_id, status)` index for the
--   status predicate.
--
-- SECURITY (§1.4):
--   - SECURITY DEFINER + SET search_path = public (no search-path hijack).
--   - REVOKE ALL from PUBLIC/anon/authenticated; only service_role may EXECUTE.
--     The worker runs as service_role; this is read-only enumeration.
--
-- ROLLBACK:
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.list_drainable_connector_orgs(integer);
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;
-- =============================================================================

CREATE OR REPLACE FUNCTION public.list_drainable_connector_orgs(
  p_limit integer DEFAULT 100
)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ca.org_id
  FROM public.connector_artifact ca
  WHERE ca.status IN ('pending', 'queued')
  GROUP BY ca.org_id
  ORDER BY min(ca.created_at) ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.list_drainable_connector_orgs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_drainable_connector_orgs(integer) TO service_role;

COMMENT ON FUNCTION public.list_drainable_connector_orgs(integer) IS
  'QUEUE-09 (SCRUM-2352): fair server-side enumeration of DISTINCT org_ids with '
  'at least one drainable connector_artifact row (status pending|queued), ordered '
  'by oldest pending work first, capped on ORGS not rows. Replaces the 5000-row '
  'in-memory dedup scan that let one >5000-row org starve all other orgs. '
  'service_role only.';

NOTIFY pgrst, 'reload schema';

COMMIT;
