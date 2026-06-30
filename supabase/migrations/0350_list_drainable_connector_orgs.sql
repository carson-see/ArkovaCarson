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
--   fairness across passes). The RPC has NO org_id predicate and needs
--   created_at for `min(created_at)`, so the existing 0343
--   `idx_connector_artifact_org_status (org_id, status)` canNOT cheaply serve
--   the status-only filter or the created_at ordering — once the table fills
--   with `anchored`/`failed` history, that would devolve into a full table
--   scan + heap-fetch every 5 minutes just to find org ids. This migration
--   therefore adds a PARTIAL index over ONLY drainable rows, keyed
--   `(org_id, created_at)`, so the whole `WHERE status IN ('pending','queued')
--   GROUP BY org_id ORDER BY min(created_at)` access pattern is an index scan
--   of a small partial set (the partial predicate excludes the large
--   anchored/failed tail entirely).
--
--   EXPLAIN intuition: without the partial index the planner picks
--   `Seq Scan on connector_artifact (Filter: status = ANY(...))` → `HashAggregate`
--   → `Sort`, touching every history row. With it the planner can use
--   `Index Scan using idx_connector_artifact_drainable` (drainable rows only,
--   already org-clustered + created_at-ordered) feeding a `GroupAggregate`,
--   so cost scales with the drainable backlog, not total table size.
--
--   CONCURRENTLY is intentionally OFF: `connector_artifact` (0343) is a fresh,
--   small table and the index must be created inside this migration's
--   transaction (CREATE INDEX CONCURRENTLY cannot run in a txn block). A plain
--   partial index is correct here — there is no large-table write-lock concern
--   like the 0342/0335 hot-anchors-table convention.
--
-- SECURITY (§1.4):
--   - SECURITY DEFINER + SET search_path = public (no search-path hijack).
--   - REVOKE ALL from PUBLIC/anon/authenticated; only service_role may EXECUTE.
--     The worker runs as service_role; this is read-only enumeration.
--
-- ROLLBACK:
--   BEGIN;
--   DROP INDEX IF EXISTS public.idx_connector_artifact_drainable;
--   DROP FUNCTION IF EXISTS public.list_drainable_connector_orgs(integer);
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;
-- =============================================================================

-- Partial index serving the drain enumeration access pattern over ONLY the
-- drainable ('pending'|'queued') rows. Keyed (org_id, created_at) so the RPC's
-- GROUP BY org_id + min(created_at) is an index scan of the small partial set,
-- not a scan over the anchored/failed history tail. Plain (non-CONCURRENT)
-- index: fresh small table, must build inside this migration txn.
CREATE INDEX IF NOT EXISTS idx_connector_artifact_drainable
  ON public.connector_artifact (org_id, created_at)
  WHERE status IN ('pending', 'queued');

COMMENT ON INDEX public.idx_connector_artifact_drainable IS
  'QUEUE-09 (SCRUM-2352): partial index over drainable connector_artifact rows '
  '(status pending|queued) keyed (org_id, created_at) — serves '
  'list_drainable_connector_orgs (GROUP BY org_id ORDER BY min(created_at)) '
  'without scanning the anchored/failed history tail.';

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
