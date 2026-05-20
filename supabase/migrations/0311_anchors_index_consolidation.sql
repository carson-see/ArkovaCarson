-- Migration 0311: SCRUM-1286 anchors index consolidation
--
-- MANUAL APPLICATION REQUIRED.
--
-- These statements use DROP INDEX CONCURRENTLY, which must run outside a
-- transaction. Apply each statement standalone from an operator SQL session
-- before marking this migration applied in the Supabase migration ledger.
--
-- Confirmed redundant / barely-used indexes to drop:
--
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_anchors_status;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_anchors_user_created;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_anchors_credential_type_btree;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_anchors_sub_type;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_anchors_pipeline_source_id;
--
-- Keep:
--   - public.anchors_unique_active_child_per_parent (lineage correctness)
--   - public.idx_anchors_pipeline_status (pipeline dashboard cache support)
--
-- ROLLBACK:
--   Recreate only the index(es) whose missing plan causes a verified
--   regression. Run each CREATE INDEX CONCURRENTLY statement standalone:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_status
--     ON public.anchors (status);
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_user_created
--     ON public.anchors (user_id, created_at DESC);
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_credential_type_btree
--     ON public.anchors (credential_type);
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_sub_type
--     ON public.anchors (sub_type)
--     WHERE sub_type IS NOT NULL;
--
--   idx_anchors_pipeline_source_id is absent from the active baseline and is
--   tracked as invalid production drift; restore it only from a verified
--   production definition if an operator confirms a real dependency.

DO $$
BEGIN
  RAISE NOTICE 'Migration 0311 recorded. Apply SCRUM-1286 concurrent index drops manually; see file header.';
END $$;
