-- =============================================================================
-- Migration 0066: Audit Compensating Fixes (AUDIT-01)
-- Date: 2026-03-17
--
-- Fixes 6 SQL bugs found in the comprehensive codebase audit:
--   SQL-01: audit_events CHECK constraint missing 'ORGANIZATION', 'WEBHOOK'
--   SQL-02: check_ai_credits() operator precedence bug (AND/OR)
--   SQL-03: search_public_credential_embeddings() references o.name (should be o.display_name)
--   SQL-04: search_public_credentials() references a.title (should be a.label)
--   SQL-05: Migration 0064 switchboard INSERT uses wrong column names
--   SQL-06: Missing GRANT on search_public_issuers() and get_public_issuer_registry()
--
-- ROLLBACK:
--   -- SQL-01: Re-add the old constraint (but it was already broken, so just revert)
--   ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_category_valid_v2;
--   ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_category_valid
--     CHECK (event_category IN ('AUTH', 'ANCHOR', 'PROFILE', 'ORG', 'ADMIN', 'SYSTEM'));
--   -- SQL-02: Revert check_ai_credits to original (but the original is buggy)
--   -- SQL-03: Revert search_public_credential_embeddings to use o.name (but it's wrong)
--   -- SQL-04: Revert search_public_credentials to use a.title (but it's wrong)
--   -- SQL-05: DELETE FROM switchboard_flags WHERE id = 'ENABLE_AI_REPORTS';
--   -- SQL-06: REVOKE EXECUTE ON search_public_issuers/get_public_issuer_registry
-- =============================================================================

-- ---------------------------------------------------------------------------
-- SQL-01: Fix audit_events CHECK constraint
-- The original constraint (migration 0006) only allows:
--   'AUTH', 'ANCHOR', 'PROFILE', 'ORG', 'ADMIN', 'SYSTEM'
-- But later migrations insert rows with 'ORGANIZATION' (0013), 'WEBHOOK' (0046),
-- 'API' (P4.5), and 'AI' (P8). Add all known categories.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_category_valid;

ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_category_valid CHECK (
  event_category IN (
    'AUTH', 'ANCHOR', 'PROFILE', 'ORG', 'ADMIN', 'SYSTEM',
    'ORGANIZATION', 'WEBHOOK', 'API', 'AI', 'BILLING', 'VERIFICATION'
  )
);

-- ---------------------------------------------------------------------------
-- SQL-02: Fix check_ai_credits() operator precedence bug
-- The original WHERE clause reads:
--   (p_org_id IS NOT NULL AND ac.org_id = p_org_id)
--   OR (p_user_id IS NOT NULL AND ac.user_id = p_user_id)
--   AND ac.period_start <= now()
--   AND ac.period_end > now()
--
-- Because AND binds tighter than OR, the period checks only apply to
-- the user_id branch. Org credits with expired periods still match.
-- Fix: wrap the OR clause in parentheses.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION check_ai_credits(
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE(
  monthly_allocation integer,
  used_this_month integer,
  remaining integer,
  has_credits boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ac.monthly_allocation,
    ac.used_this_month,
    (ac.monthly_allocation - ac.used_this_month) AS remaining,
    (ac.used_this_month < ac.monthly_allocation) AS has_credits
  FROM ai_credits ac
  WHERE
    (
      (p_org_id IS NOT NULL AND ac.org_id = p_org_id)
      OR (p_user_id IS NOT NULL AND ac.user_id = p_user_id)
    )
    AND ac.period_start <= now()
    AND ac.period_end > now()
  LIMIT 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- SQL-03: Fix search_public_credential_embeddings() — o.name → o.display_name
-- The organizations table uses display_name, not name.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_public_credential_embeddings(
  p_query_embedding vector(768),
  p_match_threshold float DEFAULT 0.75,
  p_match_count int DEFAULT 5
)
RETURNS TABLE(
  public_id text,
  status text,
  issuer_name text,
  credential_type text,
  issued_date text,
  expiry_date text,
  anchor_timestamp timestamptz,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.public_id::text,
    a.status::text,
    o.display_name::text AS issuer_name,
    a.credential_type::text,
    (a.metadata->>'issuedDate')::text AS issued_date,
    (a.metadata->>'expiryDate')::text AS expiry_date,
    a.created_at AS anchor_timestamp,
    (1 - (ce.embedding <=> p_query_embedding))::float AS similarity
  FROM credential_embeddings ce
  JOIN anchors a ON a.id = ce.anchor_id
  JOIN organizations o ON o.id = a.org_id
  WHERE a.public_id IS NOT NULL
    AND (1 - (ce.embedding <=> p_query_embedding)) > p_match_threshold
  ORDER BY ce.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- SQL-04: Fix search_public_credentials() — a.title → a.label
-- The anchors table uses label, not title.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_public_credentials(
  p_query text,
  p_limit integer DEFAULT 10
)
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

  -- Build ILIKE pattern from sanitized input
  v_pattern := '%' || p_query || '%';

  RETURN QUERY
  SELECT jsonb_build_object(
    'public_id', a.public_id,
    'label', a.label,
    'credential_type', a.credential_type,
    'status', a.status,
    'created_at', a.created_at,
    'org_id', a.org_id
  )
  FROM anchors a
  WHERE a.status IN ('SECURED', 'ACTIVE')
    AND a.deleted_at IS NULL
    AND (a.label ILIKE v_pattern OR a.credential_type::text ILIKE v_pattern)
  ORDER BY a.created_at DESC
  LIMIT v_limit;
END;
$$;

-- Re-grant (idempotent)
GRANT EXECUTE ON FUNCTION search_public_credentials(text, integer) TO anon;
GRANT EXECUTE ON FUNCTION search_public_credentials(text, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- SQL-05: Fix migration 0064 switchboard INSERT
-- The switchboard_flags table (migration 0021) uses columns: id, value,
-- description, default_value, is_dangerous — NOT flag_key/enabled.
-- The original INSERT from 0064 silently failed. Re-insert correctly.
-- ---------------------------------------------------------------------------

INSERT INTO switchboard_flags (id, value, default_value, description, is_dangerous)
VALUES ('ENABLE_AI_REPORTS', false, false, 'Enable AI report generation (P8-S16)', false)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SQL-06: Missing GRANT on search_public_issuers and get_public_issuer_registry
-- These SECURITY DEFINER functions (migration 0055) are unreachable without
-- GRANT EXECUTE to anon/authenticated.
-- ---------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION search_public_issuers(text) TO anon;
GRANT EXECUTE ON FUNCTION search_public_issuers(text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_public_issuer_registry(uuid, integer, integer) TO anon;
GRANT EXECUTE ON FUNCTION get_public_issuer_registry(uuid, integer, integer) TO authenticated;

-- Also grant the new P8 functions that may be missing grants
GRANT EXECUTE ON FUNCTION check_ai_credits(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION deduct_ai_credits(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION search_credential_embeddings(uuid, vector, float, int) TO authenticated;
GRANT EXECUTE ON FUNCTION search_public_credential_embeddings(vector, float, int) TO anon;
GRANT EXECUTE ON FUNCTION search_public_credential_embeddings(vector, float, int) TO authenticated;
GRANT EXECUTE ON FUNCTION get_extraction_accuracy(text, uuid, integer) TO authenticated;
