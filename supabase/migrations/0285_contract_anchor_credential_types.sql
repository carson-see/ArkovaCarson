-- =============================================================================
-- Migration 0285: Add CONTRACT_PRESIGNING + CONTRACT_POSTSIGNING credential_type values
-- Story: SCRUM-863 (GME10.5) → SCRUM-1623 (pre-signing) + SCRUM-1624 (post-signing)
-- Subtask: SCRUM-1629 [Spec] — pins the DB shape that SCRUM-1631 [Build] uses.
-- Date: 2026-05-03
--
-- PURPOSE
-- -------
-- The new contract anchor endpoints (POST /api/v1/contracts/anchor-pre-signing
-- and POST /api/v1/contracts/anchor-post-signing) reuse the existing `anchors`
-- table rather than introducing a parallel `contract_anchors` table. Two new
-- enum values isolate the contract-anchor lifecycle from regular credential
-- anchors so the verification UI + audit reports can filter/render them
-- without parsing metadata.
--
-- WHY enum values + reuse `anchors` (rather than a new table):
--
--   1. The `parent_anchor_id` self-FK already gives us the pre→post
--      relationship for free. Post-signing inserts with
--      parent_anchor_id = <pre-signing anchor.id>; existing lineage
--      checks (idx_anchors_parent_anchor_id, anchors_parent_anchor_id_fkey
--      with ON DELETE RESTRICT) inherit at no cost.
--
--   2. The verification UI, evidence package, extraction-manifest endpoints
--      and webhook delivery already operate on `anchors`. A parallel table
--      would require duplicating all of that surface — months of work
--      for no functional difference vs. an enum tag.
--
--   3. Org-credit deduction, fingerprint idempotency, public_id format
--      (ARK-{YEAR}-{8hex}), Bitcoin batching, audit_events writes,
--      anchors_actor_id_protection trigger — all reuse without change.
--
-- CHANGES
-- -------
-- 1. Add CONTRACT_PRESIGNING to credential_type enum
-- 2. Add CONTRACT_POSTSIGNING to credential_type enum
-- 3. Index for `parent_anchor_id WHERE credential_type = 'CONTRACT_POSTSIGNING'`
--    so the post-signing webhook (SCRUM-1624) can resolve "is this a
--    duplicate post-signing for an envelope already linked?" in O(log n).
--
-- ROLLBACK
-- --------
-- Cannot remove enum values in Postgres without rebuilding the type. The
-- compensating migration (if ever needed) is to UPDATE anchors back to
-- 'OTHER' and then `DROP TYPE / CREATE TYPE / ALTER TABLE ... USING`. For
-- now we treat enum-add as additive-only.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Add the two new enum values. ALTER TYPE ... ADD VALUE cannot run inside
--    a transaction in some Postgres versions (< 12) — Supabase is on 15+, so
--    this is fine, but keeping it as a single ALTER per value preserves the
--    standard pattern other migrations in this repo use (0091, 0103, 0118,
--    0127, 0212).
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'CONTRACT_PRESIGNING';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'CONTRACT_POSTSIGNING';

COMMIT;

-- 2. Partial index for post-signing → pre-signing parent lookups. The
--    SCRUM-1624 webhook receiver calls
--      SELECT id FROM anchors
--      WHERE parent_anchor_id = <pre-id> AND credential_type = 'CONTRACT_POSTSIGNING'
--    on every webhook event to enforce single-post-signing-per-pre-signing.
--    Outside this transaction so the partial-index predicate sees the new
--    enum value already committed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_parent_anchor_id_contract_post
  ON anchors (parent_anchor_id)
  WHERE credential_type = 'CONTRACT_POSTSIGNING';

COMMENT ON INDEX idx_anchors_parent_anchor_id_contract_post IS
  'SCRUM-1624: O(log n) lookup of post-signing anchors by parent (pre-signing) anchor. Used by DocuSign + Adobe Sign webhook receivers to enforce single-post-signing-per-envelope.';

-- 3. Reload PostgREST schema cache so the new enum values are queryable
--    immediately via REST. Without this, `?credential_type=eq.CONTRACT_PRESIGNING`
--    would 400 until PostgREST's TTL refresh ticks (up to 10 minutes).
NOTIFY pgrst, 'reload schema';
