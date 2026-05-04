-- =============================================================================
-- Migration 0094: Parameterized RPC for issuer matching
-- Story: DB-AUDIT SEC-2 — PostgREST filter injection in issuer matching
-- Date: 2026-03-23
--
-- PURPOSE
-- -------
-- The integrity scoring service uses string interpolation inside a PostgREST
-- .or() filter to match issuer names against institution_ground_truth.
-- Even with sanitization, this is a second-order injection risk.
--
-- Fix: Create a parameterized RPC function that performs both exact and fuzzy
-- matching server-side, eliminating client-side filter construction.
--
-- CHANGES
-- -------
-- 1. Create search_issuer_ground_truth(p_issuer_name text) RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION search_issuer_ground_truth(p_issuer_name text)
RETURNS TABLE(id uuid, name text, match_strategy text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_normalized text;
BEGIN
  -- Input validation
  IF p_issuer_name IS NULL OR length(trim(p_issuer_name)) < 2 THEN
    RETURN;
  END IF;

  -- Strategy A: exact match (case-insensitive)
  RETURN QUERY
    SELECT igt.id, igt.name, 'exact'::text AS match_strategy
    FROM institution_ground_truth igt
    WHERE igt.name ILIKE p_issuer_name
    LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  -- Strategy B: fuzzy contains match
  -- Normalize: strip common prefixes, trim whitespace
  v_normalized := regexp_replace(trim(p_issuer_name), '^(The|A)\s+', '', 'i');

  IF length(v_normalized) < 2 THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT igt.id, igt.name, 'fuzzy'::text AS match_strategy
    FROM institution_ground_truth igt
    WHERE igt.name ILIKE '%' || v_normalized || '%'
    LIMIT 1;
END;
$$;

-- Grant to service_role only (called from worker, not browser)
GRANT EXECUTE ON FUNCTION search_issuer_ground_truth(text) TO service_role;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP FUNCTION IF EXISTS search_issuer_ground_truth(text);
