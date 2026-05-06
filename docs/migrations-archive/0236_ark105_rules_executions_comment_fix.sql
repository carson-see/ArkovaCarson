-- =============================================================================
-- Migration 0236 — CIBA-HARDEN-06 (SCRUM-1119): correct idempotency-window
-- wording on organization_rule_executions
-- =============================================================================
--
-- Migration 0224 set this comment:
--   '...24h unique (rule_id, trigger_event_id) enforces ARK-106 idempotency.'
-- The unique index idx_organization_rule_executions_idempotency is a plain
-- UNIQUE(rule_id, trigger_event_id) with no time predicate — it enforces
-- uniqueness **permanently**, not for 24 hours. A background purge that
-- would have implemented the 24h window was never scheduled.
--
-- This migration rewrites the COMMENT to match reality. Per CLAUDE.md §1.2
-- (never modify an existing migration), we do not touch 0224 — this is the
-- compensating migration.
--
-- ROLLBACK:
--   COMMENT ON TABLE organization_rule_executions IS
--     'Per-execution record for every rule firing. 24h unique (rule_id, trigger_event_id) enforces ARK-106 idempotency.';

COMMENT ON TABLE organization_rule_executions IS
  'Per-execution record for every rule firing. Permanent UNIQUE(rule_id, trigger_event_id) enforces ARK-106 idempotency — same external event never replays, even months later. See migration 0224 for the index.';

-- Reload PostgREST schema cache so comment-aware introspection tools (e.g.
-- Supabase Studio, pg_dump) see the update immediately.
NOTIFY pgrst, 'reload schema';
