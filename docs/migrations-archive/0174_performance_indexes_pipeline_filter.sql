-- Migration 0174: Performance indexes for actual slow query patterns
--
-- Problem: Dashboard/listing queries are slow despite sub-100 users because:
-- 1. metadata->pipeline_source IS NULL filter has no supporting index (scans 1.4M rows)
-- 2. Existing idx_anchors_pipeline_source covers IS NOT NULL (minority), not IS NULL (majority)
-- 3. useEntitlements count query lacks optimal (user_id, created_at) index
-- 4. No covering index for the common user dashboard pattern:
--      WHERE user_id = X AND deleted_at IS NULL AND metadata->>'pipeline_source' IS NULL
--      ORDER BY created_at DESC LIMIT 100
--
-- Fix: Add targeted partial indexes matching the actual query patterns from
-- useAnchors.ts, OrgRegistryTable.tsx, OrgProfilePage.tsx, and useEntitlements.ts.

-- =========================================================================
-- 1. User dashboard listing (useAnchors.ts)
--    Pattern: WHERE user_id = ? AND deleted_at IS NULL
--             AND metadata->>'pipeline_source' IS NULL
--             ORDER BY created_at DESC LIMIT 100
-- =========================================================================
CREATE INDEX IF NOT EXISTS idx_anchors_user_nopipeline_created
  ON anchors (user_id, created_at DESC)
  WHERE deleted_at IS NULL
  AND (metadata->>'pipeline_source') IS NULL;

-- =========================================================================
-- 2. Org registry listing (OrgRegistryTable.tsx, OrgProfilePage.tsx)
--    Pattern: WHERE org_id = ? AND deleted_at IS NULL
--             AND metadata->>'pipeline_source' IS NULL
--             ORDER BY created_at DESC
-- =========================================================================
CREATE INDEX IF NOT EXISTS idx_anchors_org_nopipeline_created
  ON anchors (org_id, created_at DESC)
  WHERE deleted_at IS NULL
  AND (metadata->>'pipeline_source') IS NULL;

-- =========================================================================
-- 3. Entitlements monthly count (useEntitlements.ts)
--    Pattern: WHERE user_id = ? AND created_at >= month_start
--             SELECT count(*)
-- =========================================================================
CREATE INDEX IF NOT EXISTS idx_anchors_user_created
  ON anchors (user_id, created_at DESC);

-- =========================================================================
-- 4. Status count queries (useAnchorStats, BillingPage, health checks)
--    Pattern: WHERE status = ? SELECT count(*)
--    Existing idx_anchors_status is a basic B-tree — add a covering index
--    that includes created_at for ORDER BY queries too.
-- =========================================================================
CREATE INDEX IF NOT EXISTS idx_anchors_status_created
  ON anchors (status, created_at DESC)
  WHERE deleted_at IS NULL;

-- =========================================================================
-- 5. ANALYZE to update planner statistics for new indexes
-- =========================================================================
ANALYZE anchors;

-- =========================================================================
-- ROLLBACK:
-- DROP INDEX IF EXISTS idx_anchors_user_nopipeline_created;
-- DROP INDEX IF EXISTS idx_anchors_org_nopipeline_created;
-- DROP INDEX IF EXISTS idx_anchors_user_created;
-- DROP INDEX IF EXISTS idx_anchors_status_created;
-- =========================================================================
