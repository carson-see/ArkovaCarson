-- Migration 0191: BRIN indexes for time-series tables (PERF-07)
--
-- BRIN (Block Range INdex) is compact and efficient for columns with natural
-- ordering (like created_at on append-mostly tables). Much smaller than btree
-- for timestamp columns on large tables.
--
-- Tables: audit_events, anchors (created_at), credit_transactions.
-- (The original header also listed `payments` but that table is never
-- created anywhere in supabase/migrations/ — it was a stale reference
-- from the original planning notes. Removed to keep `supabase db reset`
-- working on fresh boots.)

-- =============================================================================
-- 1. audit_events — time-range filtering on dashboards
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_brin_audit_events_created
  ON audit_events USING brin(created_at);

-- =============================================================================
-- 2. anchors — timestamp filtering for lists and reports
--    (btree idx already exists on user_id/created_at combo; BRIN covers
--     pure time-range scans like "last 24h" used in admin dashboards)
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_brin_anchors_created
  ON anchors USING brin(created_at);

-- =============================================================================
-- 3. credit_transactions — billing period lookups
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_brin_credit_transactions_created
  ON credit_transactions USING brin(created_at);

-- =============================================================================
-- ROLLBACK:
-- DROP INDEX IF EXISTS idx_brin_audit_events_created;
-- DROP INDEX IF EXISTS idx_brin_anchors_created;
-- DROP INDEX IF EXISTS idx_brin_credit_transactions_created;
-- =============================================================================
