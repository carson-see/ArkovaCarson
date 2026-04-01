-- Migration: 0156_search_privacy_gate.sql
-- Description: Add privacy gate to search_public_credentials so that
--   anchors issued by organizations whose admin has is_public_profile=false
--   are excluded from person-name searches. Ensures "Fox Mulder" (private)
--   returns 0 results while "Dana Scully" (public) is discoverable.
--
-- Task: SCRUM-IDT-TASK3 — Privacy-Aware Search
--
-- ROLLBACK: DROP the updated function and re-create from 0152 definition.

-- =============================================================================
-- 1. Optimized privacy-gated search_public_credentials
-- =============================================================================
-- A credential is discoverable via name search ONLY when:
--   (a) it belongs to an org AND that org has at least one public-profile admin
-- Org-less personal anchors remain visible regardless (no issuer to gate on).

CREATE OR REPLACE FUNCTION search_public_credentials(p_query text, p_limit integer DEFAULT 10)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
  v_pattern text;
BEGIN
  -- Clamp limit to [1, 50]
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

  -- Reject empty or too-short queries
  IF p_query IS NULL OR length(trim(p_query)) < 2 THEN
    RETURN;
  END IF;

  v_pattern := '%' || trim(p_query) || '%';

  RETURN QUERY
  SELECT jsonb_build_object(
    'public_id',       a.public_id,
    'title',           a.filename,
    'credential_type', a.credential_type,
    'status',          a.status,
    'created_at',      a.created_at,
    'org_id',          a.org_id
  )
  FROM anchors a
  WHERE a.status IN ('SECURED', 'SUBMITTED')
    AND a.deleted_at IS NULL
    -- *** PRIVACY GATE ***
    -- Org-issued anchors: only show if the org has a public-profile admin
    AND (
      a.org_id IS NULL  -- personal anchor: always visible
      OR EXISTS (
        SELECT 1 FROM profiles p
        WHERE p.org_id = a.org_id
          AND p.role = 'ORG_ADMIN'
          AND p.is_public_profile = true
      )
    )
    -- Text match on filename or description only.
    -- NOTE: credential_type::text ILIKE is intentionally omitted — that cast
    -- prevents trigram GIN index use and causes statement timeout (PG 57014)
    -- on the 1.39M+ row anchors table.
    AND (
      a.filename ILIKE v_pattern
      OR a.description ILIKE v_pattern
    )
  ORDER BY a.created_at DESC
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION search_public_credentials(text, integer) IS
  'Privacy-gated public credential search. Org-issued anchors are hidden unless
   the org has at least one admin with is_public_profile=true. Task SCRUM-IDT-TASK3.';

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- ROLLBACK (restore 0152 version without privacy gate):
-- CREATE OR REPLACE FUNCTION search_public_credentials(p_query text, p_limit integer DEFAULT 10)
-- RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
-- AS $$ ... [0152 body without org privacy EXISTS clause] ... $$;
-- ---------------------------------------------------------------------------
