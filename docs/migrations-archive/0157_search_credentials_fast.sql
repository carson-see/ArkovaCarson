-- Migration: 0157_search_credentials_fast.sql
-- Description: Fix search_public_credentials statement timeout (PG 57014).
--
-- Problem: Migration 0156 introduced a correlated EXISTS subquery for the
--   privacy gate that runs once per matching row, causing timeouts on
--   the 1.39M+ row anchors table even with GIN trigram indexes in place.
--
-- Fix: Replace the correlated EXISTS with a MATERIALIZED CTE that builds the
--   set of public org IDs once, then filter with IN (...). Also sets
--   statement_timeout = 15s on the function to give complex queries headroom.
--
-- Task: SCRUM-IDT-TASK3 — Privacy-Aware Search (performance fix)
-- Depends on: 0150 (GIN trigram indexes), 0156 (privacy gate logic)
--
-- ROLLBACK: Re-apply the 0156 function body (see 0156 for definition).

CREATE OR REPLACE FUNCTION search_public_credentials(p_query text, p_limit integer DEFAULT 10)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
DECLARE
  v_limit  integer;
  v_pattern text;
BEGIN
  v_limit  := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

  IF p_query IS NULL OR length(trim(p_query)) < 2 THEN
    RETURN;
  END IF;

  v_pattern := '%' || trim(p_query) || '%';

  RETURN QUERY
  -- Materialise the small set of org IDs whose admin has a public profile.
  -- This runs once and is joined in-memory, avoiding a correlated subquery
  -- per row.  GIN trigram indexes on anchors.filename / .description
  -- (added in 0150) are used for the ILIKE conditions.
  WITH public_org_ids AS MATERIALIZED (
    SELECT DISTINCT p.org_id
    FROM   profiles p
    WHERE  p.role             = 'ORG_ADMIN'
      AND  p.is_public_profile = true
      AND  p.org_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'public_id',       a.public_id,
    'title',           a.filename,
    'credential_type', a.credential_type,
    'status',          a.status,
    'created_at',      a.created_at,
    'org_id',          a.org_id
  )
  FROM  anchors a
  WHERE a.status IN ('SECURED', 'SUBMITTED')
    AND a.deleted_at IS NULL
    -- Privacy gate: org-issued anchors visible only if org has a public admin.
    -- Org-less personal anchors always visible (a.org_id IS NULL).
    AND (
      a.org_id IS NULL
      OR a.org_id IN (SELECT org_id FROM public_org_ids)
    )
    -- Text match — uses idx_anchors_filename_trgm + idx_anchors_description_trgm
    AND (
      a.filename    ILIKE v_pattern
      OR a.description ILIKE v_pattern
    )
  ORDER BY a.created_at DESC
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION search_public_credentials(text, integer) IS
  'Privacy-gated credential search. Org-issued anchors hidden unless org has a
   public-profile admin. Uses materialized CTE for privacy gate (avoids correlated
   subquery timeout). GIN trigram indexes (0150) used for ILIKE. Task SCRUM-IDT-TASK3.';

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- ROLLBACK: Re-apply 0156 function body.
-- ---------------------------------------------------------------------------
