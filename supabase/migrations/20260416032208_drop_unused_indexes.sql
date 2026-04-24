-- Migration 0214: Drop unused indexes to reclaim Supabase disk space
-- Safety: only drops indexes with idx_scan=0, NOT primary keys, NOT on hot paths
-- Reversible via the rollback in 0214_drop_unused_indexes.sql

DROP INDEX IF EXISTS public.idx_audit_events_target;
DROP INDEX IF EXISTS public.idx_audit_events_event_category;
DROP INDEX IF EXISTS public.idx_chain_index_fingerprint;
DROP INDEX IF EXISTS public.idx_chain_index_tx_id;
DROP INDEX IF EXISTS public.idx_anchors_compliance_controls;
DROP INDEX IF EXISTS public.idx_institution_ground_truth_embedding;
DROP INDEX IF EXISTS public.idx_entitlements_value_gin;
DROP INDEX IF EXISTS public.idx_organizations_display_name_trgm;;
