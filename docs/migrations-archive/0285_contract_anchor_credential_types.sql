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
--      checks (anchors_parent_anchor_id_fkey with ON DELETE RESTRICT,
--      lineage triggers from migration 0032) inherit at no cost.
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
--
-- WHAT THIS MIGRATION INTENTIONALLY DOES NOT ADD
-- ----------------------------------------------
-- A separate partial index `(parent_anchor_id) WHERE credential_type =
-- 'CONTRACT_POSTSIGNING'` was considered for the SCRUM-1624 webhook
-- receiver's "is this envelope already linked?" duplicate-check. Migration
-- 0233 (ARK-104 supersede lock) already creates a UNIQUE partial index
-- `anchors_unique_active_child_per_parent ON anchors(parent_anchor_id)
-- WHERE parent_anchor_id IS NOT NULL AND deleted_at IS NULL AND status
-- NOT IN ('REVOKED')` that subsumes the contract-anchor case for ALL
-- credential types — the post-signing-as-child enforcement is already a
-- DB-level invariant, not a webhook-only one. Adding a contract-specific
-- partial index would be redundant indexes on the same column.
--
-- (Per CodeRabbit P1 + Major review on PR #679: the deferred-index pattern
-- in migration 0255 also documents that CONCURRENTLY index builds on the
-- 1.4M-row anchors table exceed Supabase's pooler timeout. Even if the
-- partial-index were not redundant, it would have to ship via 0255-style
-- deferred-manual-apply, not in-line here.)
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

-- 1. Add the two new enum values. Supabase runs Postgres 15+, so ALTER
--    TYPE ... ADD VALUE inside a transaction is supported. Keeping it as a
--    single ALTER per value preserves the standard pattern other migrations
--    in this repo use (0091, 0103, 0118, 0127, 0212).
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'CONTRACT_PRESIGNING';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'CONTRACT_POSTSIGNING';

-- 2. Reload PostgREST schema cache so the new enum values are queryable
--    immediately via REST. Without this, `?credential_type=eq.CONTRACT_PRESIGNING`
--    would 400 until PostgREST's TTL refresh ticks (up to 10 minutes).
NOTIFY pgrst, 'reload schema';

COMMIT;
