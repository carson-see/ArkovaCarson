-- Migration 0214: Drop unused indexes to reclaim Supabase disk space
--
-- Context (2026-04-15): Supabase DB at 10GB total (Pro plan overage zone).
-- Audit via pg_stat_user_indexes showed several indexes with idx_scan = 0
-- since their creation. Reclaiming ~37 MB by dropping the safest candidates.
--
-- ONLY drops indexes where:
--   1. idx_scan = 0 in pg_stat_user_indexes (never used)
--   2. NOT a primary key
--   3. NOT on a path the worker is known to query (e.g., anchoring_jobs.status)
--   4. Either the index is on dead/unused features OR the underlying table is empty
--
-- Reversible: each DROP has a rollback at bottom.
--
-- Skipped intentionally (might be needed by paths not yet measured):
--   - idx_anchoring_jobs_claimed (10MB) — workers claim jobs by status
--   - idx_anchoring_jobs_status (10MB) — same
--   - auth.* indexes (managed by Supabase)
--   - storage.* indexes (managed by Supabase)

BEGIN;

-- audit_events: target column rarely queried directly (event_type and actor are the hot paths)
DROP INDEX IF EXISTS public.idx_audit_events_target;
-- ~14 MB

-- audit_events: event_category isn't part of any current dashboard or RLS predicate
DROP INDEX IF EXISTS public.idx_audit_events_event_category;
-- ~2.6 MB

-- anchor_chain_index: fingerprint duplicates the unique constraint on the table
-- (verifier looks up by anchor public_id, not fingerprint)
DROP INDEX IF EXISTS public.idx_chain_index_fingerprint;
-- ~15 MB

-- anchor_chain_index: tx_id rarely queried (mempool explorer link is generated, not searched)
DROP INDEX IF EXISTS public.idx_chain_index_tx_id;
-- ~1.3 MB

-- anchors: compliance_controls is a forward-looking column, no live query path uses it
DROP INDEX IF EXISTS public.idx_anchors_compliance_controls;
-- ~3.4 MB

-- institution_ground_truth: vector embedding index on a 0-row table
DROP INDEX IF EXISTS public.idx_institution_ground_truth_embedding;
-- ~1.2 MB

-- entitlements: GIN on value column, never used (entitlements queried by user_id)
DROP INDEX IF EXISTS public.idx_entitlements_value_gin;
-- ~24 KB

-- organizations: trigram on display_name (search not implemented in UI)
DROP INDEX IF EXISTS public.idx_organizations_display_name_trgm;
-- ~24 KB

COMMIT;

-- Estimated total reclaimed: ~37 MB
-- Verified by re-running pg_total_relation_size after migration applies.

-- =============================================================================
-- ROLLBACK (recreate the dropped indexes if needed):
-- =============================================================================
-- BEGIN;
--   CREATE INDEX idx_audit_events_target ON public.audit_events(target_id);
--   CREATE INDEX idx_audit_events_event_category ON public.audit_events(event_category);
--   CREATE INDEX idx_chain_index_fingerprint ON public.anchor_chain_index(fingerprint);
--   CREATE INDEX idx_chain_index_tx_id ON public.anchor_chain_index(tx_id);
--   CREATE INDEX idx_anchors_compliance_controls ON public.anchors USING gin(compliance_controls);
--   CREATE INDEX idx_institution_ground_truth_embedding ON public.institution_ground_truth USING ivfflat(embedding vector_cosine_ops);
--   CREATE INDEX idx_entitlements_value_gin ON public.entitlements USING gin(value);
--   CREATE INDEX idx_organizations_display_name_trgm ON public.organizations USING gin(display_name gin_trgm_ops);
-- COMMIT;
