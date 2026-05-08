-- Migration 0232: ARK-104 follow-up — get_anchor_lineage uses public_id + returns safe fields only.
--
-- Context (CodeRabbit review of PR #474, 2026-04-23):
--   The original get_anchor_lineage(uuid) (migration 0226) exposed internal
--   anchor UUIDs via the jsonb `id` + `parent_anchor_id` fields and accepted
--   an internal UUID as its parameter. Per CLAUDE.md §1.4 the public boundary
--   must only expose `public_id` + derived fields. It also leaked
--   `revocation_reason` (free-text, may contain org-admin notes).
--
-- This migration:
--   1. DROPs the old get_anchor_lineage(uuid) overload.
--   2. CREATEs get_anchor_lineage(text) taking p_public_id.
--   3. Returns a safer JSON shape: public_id + parent_public_id (no UUIDs),
--      no revocation_reason.
--   4. Keeps fingerprint + chain_* fields (already public via /verify).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS get_anchor_lineage(text);
--   Re-run migration 0226 section 2 (CREATE OR REPLACE FUNCTION
--   get_anchor_lineage(uuid) ...) to restore the original UUID-keyed,
--   sensitive-field-exposing version.

BEGIN;

DROP FUNCTION IF EXISTS get_anchor_lineage(uuid);

CREATE OR REPLACE FUNCTION get_anchor_lineage(p_public_id TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_anchor_id UUID;
  v_root_id   UUID;
  v_result    jsonb;
BEGIN
  -- Resolve the public_id → internal id. Same not-found + deleted_at guard
  -- as the original. We never expose v_anchor_id beyond this function.
  SELECT id INTO v_anchor_id
  FROM anchors
  WHERE public_id = p_public_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anchor not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Walk to the root by following parent_anchor_id. Capped at 100 hops.
  WITH RECURSIVE ancestry AS (
    SELECT id, parent_anchor_id, 1 AS hop
    FROM anchors
    WHERE id = v_anchor_id
    UNION ALL
    SELECT a.id, a.parent_anchor_id, ancestry.hop + 1
    FROM anchors a
    INNER JOIN ancestry ON a.id = ancestry.parent_anchor_id
    WHERE ancestry.hop < 100
      AND a.deleted_at IS NULL
  )
  SELECT id INTO v_root_id
  FROM ancestry
  WHERE parent_anchor_id IS NULL
  LIMIT 1;

  IF v_root_id IS NULL THEN
    v_root_id := v_anchor_id;
  END IF;

  -- Fetch descendants. Join back to anchors on parent_anchor_id so we can
  -- emit `parent_public_id` instead of a raw UUID — the internal id never
  -- crosses the function boundary.
  --
  -- Fields emitted (safe-only, matches the /verify surface):
  --   public_id, version_number, parent_public_id, status,
  --   fingerprint, chain_tx_id, chain_block_height, chain_timestamp,
  --   created_at, revoked_at, is_current
  -- Deliberately stripped:
  --   id                  (internal UUID — CLAUDE.md §1.4)
  --   parent_anchor_id    (internal UUID — use parent_public_id)
  --   revocation_reason   (free-text from org admin — may contain PII)
  WITH RECURSIVE descendants AS (
    SELECT a.*, 1 AS hop FROM anchors a
    WHERE a.id = v_root_id AND a.deleted_at IS NULL
    UNION ALL
    SELECT a.*, d.hop + 1 FROM anchors a
    INNER JOIN descendants d ON a.parent_anchor_id = d.id
    WHERE a.deleted_at IS NULL AND d.hop < 100
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'public_id', d.public_id,
      'version_number', d.version_number,
      'parent_public_id', parent.public_id,
      'status', d.status::text,
      'fingerprint', d.fingerprint,
      'chain_tx_id', d.chain_tx_id,
      'chain_block_height', d.chain_block_height,
      'chain_timestamp', d.chain_timestamp,
      'created_at', d.created_at,
      'revoked_at', d.revoked_at,
      'is_current', (d.status NOT IN ('REVOKED', 'SUPERSEDED'))
    )
    ORDER BY d.version_number ASC
  ) INTO v_result
  FROM descendants d
  LEFT JOIN anchors parent ON parent.id = d.parent_anchor_id AND parent.deleted_at IS NULL;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION get_anchor_lineage(text) TO authenticated, anon;

COMMENT ON FUNCTION get_anchor_lineage(text) IS
  'ARK-104 (migration 0232 replaces 0226 version): return lineage for the chain containing p_public_id. Root-first by version_number. Emits only public_id-keyed + /verify-safe fields; no internal UUIDs, no revocation_reason.';

COMMIT;

-- Post-migration work required (NOT part of this SQL file):
--   1. npm run gen:types in both src/ and services/worker/ to regenerate
--      database.types.ts.
--   2. Update services/worker/src/api/anchor-lineage.ts to call with
--      p_public_id (TEXT) and strip LineageItem.id / revocation_reason.
--   3. Update services/worker/src/api/anchor-lineage.test.ts fixtures.
